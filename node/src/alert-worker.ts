import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import WebSocket, { type RawData } from "ws";
import { Agent, request, type Dispatcher } from "undici";
import {
  AuthenticationError,
  AuthorizationError,
  BackpressureError,
  ConnectionError,
  FetchError,
  ProtocolError,
  RateLimitError,
  RedirectRejectedError,
  serializeAlertStreamError,
  type AlertStreamError,
} from "./errors";
import {
  createPong,
  parseServerMessage,
  type ParsedAlertFrame,
} from "./protocol";
import {
  DIAGNOSTIC_HEADER_NAMES,
  type DiagnosticHeaders,
  type EventBurstSnapshot,
  type KeepaliveStats,
  type QueueStats,
  type StreamCounters,
  type StreamStats,
  type WorkerHealthStats,
} from "./types";
import type {
  AlertWorkerData,
  MainToWorkerMessage,
  WorkerResult,
  WorkerToMainMessage,
} from "./worker-protocol";

const PRODUCTION_WEBSOCKET_URL = "wss://ws.rtpr.io/ws-alerts";
const PRODUCTION_KEEPALIVE_URL = "https://rtpr.io/a/_sdk_keepalive";
const RETRYABLE_FETCH_STATUSES = new Set([500, 502, 503, 504]);
const MAX_404_RACE_MS = 2_000;
const LOOP_LAG_INTERVAL_MS = 1_000;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface PendingAlert {
  readonly alert: ParsedAlertFrame;
  readonly receivedMonoMs: number;
  readonly receivedEpochMs: number;
  readonly receivedAtUtc: string;
  readonly ruleNames: Set<string>;
  readonly receivedBurstState: EventBurstSnapshot;
}

interface BufferedResult {
  readonly deliveryId: number;
  readonly byteLength: number;
  result: WorkerResult;
}

interface BufferedError {
  readonly errorId: number;
  readonly error: ReturnType<typeof serializeAlertStreamError>;
}

class FinalFetchFailure extends Error {
  constructor(
    readonly statusCode: number | undefined,
    readonly reason: string,
    readonly retryable: boolean,
  ) {
    super(reason);
  }
}

class ArticleCapacityFailure extends Error {
  constructor(readonly reason: "article_size" | "result_bytes") {
    super(reason);
  }
}

class RedirectFailure extends Error {
  constructor(readonly statusCode: number) {
    super("redirect");
  }
}

function emptyCounters(): Mutable<StreamCounters> {
  return {
    connectionAttempts: 0,
    reconnects: 0,
    framesReceived: 0,
    alertsReceived: 0,
    pingsReceived: 0,
    pongsSent: 0,
    protocolErrors: 0,
    duplicateFrames: 0,
    duplicateRuleNamesMerged: 0,
    fetchesStarted: 0,
    fetchesSucceeded: 0,
    fetchesFailed: 0,
    fetchRetries: 0,
    fetchNetworkRetries: 0,
    fetch5xxRetries: 0,
    fetch404Retries: 0,
    redirectsRejected: 0,
    overloads: 0,
    pendingFetchOverloads: 0,
    resultItemOverloads: 0,
    resultByteOverloads: 0,
    articleSizeOverloads: 0,
    resultsDelivered: 0,
    resultsAcknowledged: 0,
    bytesFetched: 0,
    bytesDelivered: 0,
    errorsEmitted: 0,
    errorsSuppressed: 0,
    handlerCalls: 0,
    handlerFailures: 0,
  };
}

function emptyQueues(): Mutable<QueueStats> {
  return {
    activeFetches: 0,
    pendingFetches: 0,
    pendingFetchesHighWater: 0,
    bufferedResultItems: 0,
    bufferedResultBytes: 0,
    bufferedResultItemsHighWater: 0,
    bufferedResultBytesHighWater: 0,
    workerResultQueueItems: 0,
    workerResultQueueBytes: 0,
    inFlightResultItems: 0,
    inFlightResultBytes: 0,
    bufferedErrors: 0,
    bufferedErrorsHighWater: 0,
  };
}

function emptyKeepalive(): Mutable<KeepaliveStats> {
  return {
    healthy: false,
    active: false,
    attempts: 0,
    successes: 0,
    failures: 0,
    lastStatusCode: null,
    lastCheckedAtUtc: null,
    lastHealthyAtUtc: null,
    headerPresent: false,
  };
}

function emptyWorkerHealth(): Mutable<WorkerHealthStats> {
  return {
    loopLagMs: 0,
    loopLagMaxMs: 0,
    lastPingAtUtc: null,
  };
}

export function buildWebSocketUrl(apiKey: string, override?: string): string {
  if (override === undefined) {
    return `${PRODUCTION_WEBSOCKET_URL}?apiKey=${encodeURIComponent(apiKey)}`;
  }
  const url = new URL(override);
  url.searchParams.set("apiKey", apiKey);
  return url.toString();
}

export function parseRetryAfter(
  value: string | readonly string[] | undefined,
  nowEpochMs = Date.now(),
): number | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  if (first === undefined) {
    return undefined;
  }
  const seconds = Number(first);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1_000);
  }
  const date = Date.parse(first);
  if (!Number.isFinite(date)) {
    return undefined;
  }
  return Math.max(0, date - nowEpochMs);
}

export function reconnectDelayMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  jitterUnit: number,
  retryAfterMs?: number,
): number {
  const cap = Math.min(maxMs, baseMs * 2 ** Math.min(attempt, 30));
  const jittered = Math.floor(cap * Math.min(1, Math.max(0, jitterUnit)));
  return Math.max(jittered, retryAfterMs ?? 0);
}

function headersFromResponse(
  headers: Record<string, string | string[] | undefined>,
): DiagnosticHeaders {
  const result: Record<string, string> = {};
  for (const name of DIAGNOSTIC_HEADER_NAMES) {
    const value = headers[name];
    if (Array.isArray(value)) {
      result[name] = value.join(", ");
    } else if (value !== undefined) {
      result[name] = value;
    }
  }
  return Object.freeze(result) as DiagnosticHeaders;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data);
  }
  throw new TypeError("Unsupported WebSocket frame type");
}

function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class AlertWorkerRuntime {
  readonly #data: AlertWorkerData;
  readonly #port: NonNullable<typeof parentPort>;
  readonly #dispatcher: Agent;
  readonly #pendingAlerts: PendingAlert[] = [];
  readonly #activeArticles = new Map<string, PendingAlert>();
  readonly #activeTasks = new Set<Promise<void>>();
  readonly #dedupe = new Map<string, number>();
  readonly #resultQueue: BufferedResult[] = [];
  readonly #inFlightResults = new Map<number, number>();
  readonly #errorQueue: BufferedError[] = [];
  readonly #inFlightErrors = new Set<number>();
  readonly #shutdownController = new AbortController();
  readonly #counters = emptyCounters();
  readonly #queues = emptyQueues();
  readonly #keepalive = emptyKeepalive();
  readonly #workerHealth = emptyWorkerHealth();

  #state: StreamStats["state"] = "idle";
  #socket: WebSocket | null = null;
  #started = false;
  #everConnected = false;
  #closing = false;
  #reconnectAttempt = 0;
  #reconnectTimer: NodeJS.Timeout | null = null;
  #keepaliveTimer: NodeJS.Timeout | null = null;
  #loopLagTimer: NodeJS.Timeout | null = null;
  #keepaliveRunning = false;
  #resultItemCredits: number;
  #resultByteCredits: number;
  #errorCredits: number;
  #nextDeliveryId = 1;
  #nextErrorId = 1;
  #statsOutstanding = false;
  #statsDirty = false;

  constructor(
    data: AlertWorkerData,
    port: NonNullable<typeof parentPort>,
  ) {
    this.#data = data;
    this.#port = port;
    this.#resultItemCredits = data.initialResultItemCredits;
    this.#resultByteCredits = data.initialResultByteCredits;
    this.#errorCredits = data.initialErrorCredits;
    this.#dispatcher = new Agent({
      connections: data.config.fetchConcurrency,
      pipelining: 1,
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 120_000,
    });
  }

  run(): void {
    this.#port.on("message", (message: MainToWorkerMessage) => {
      this.#onMainMessage(message);
    });
  }

  #onMainMessage(message: MainToWorkerMessage): void {
    switch (message.type) {
      case "start":
        this.#start();
        break;
      case "close":
        void this.#close();
        break;
      case "ack-result":
        this.#ackResult(message.deliveryId, message.byteLength);
        break;
      case "ack-error":
        this.#ackError(message.errorId);
        break;
      case "ack-stats":
        this.#statsOutstanding = false;
        if (this.#statsDirty) {
          this.#statsDirty = false;
          this.#postStats();
        }
        break;
    }
  }

  #start(): void {
    if (this.#started || this.#closing) {
      return;
    }
    this.#started = true;
    this.#state = "starting";
    this.#startLoopLagMonitor();
    void this.#runKeepalive();
    this.#keepaliveTimer = setInterval(() => {
      void this.#runKeepalive();
    }, this.#data.config.keepaliveIntervalMs);
    this.#keepaliveTimer.unref();
    this.#connect();
    this.#postStats();
  }

  #connect(): void {
    if (this.#closing || this.#socket !== null) {
      return;
    }
    this.#counters.connectionAttempts += 1;
    const url = buildWebSocketUrl(
      this.#data.apiKey,
      this.#data.testOverrides?.websocketUrl,
    );
    const socket = new WebSocket(url, {
      followRedirects: false,
      handshakeTimeout: this.#data.config.connectTimeoutMs,
      perMessageDeflate: false,
      maxPayload: 64 * 1024,
    });
    this.#socket = socket;
    let handshakeFailureHandled = false;

    socket.on("open", () => {
      if (this.#socket !== socket || this.#closing) {
        socket.close(1000);
        return;
      }
      this.#state = "connected";
      this.#everConnected = true;
      this.#reconnectAttempt = 0;
      this.#port.postMessage({ type: "started" } satisfies WorkerToMainMessage);
      this.#postStats();
    });

    socket.on("message", (data, isBinary) => {
      if (this.#socket !== socket || this.#closing) {
        return;
      }
      this.#handleSocketMessage(data, isBinary);
    });

    socket.on("unexpected-response", (_request, response) => {
      if (this.#socket !== socket || this.#closing) {
        response.resume();
        return;
      }
      handshakeFailureHandled = true;
      const statusCode = response.statusCode ?? 0;
      const retryAfterMs = parseRetryAfter(response.headers["retry-after"]);
      response.resume();
      this.#socket = null;
      socket.terminate();
      this.#handleHandshakeFailure(statusCode, retryAfterMs);
    });

    socket.on("error", () => {
      if (
        this.#socket !== socket ||
        this.#closing ||
        handshakeFailureHandled
      ) {
        return;
      }
      this.#emitError(new ConnectionError());
    });

    socket.on("close", () => {
      if (this.#socket === socket) {
        this.#socket = null;
      }
      if (this.#closing || handshakeFailureHandled) {
        return;
      }
      this.#scheduleReconnect();
    });
    this.#postStats();
  }

  #handleHandshakeFailure(
    statusCode: number,
    retryAfterMs: number | undefined,
  ): void {
    let error: AlertStreamError;
    if (statusCode === 401) {
      error = new AuthenticationError();
    } else if (statusCode === 403) {
      error = new AuthorizationError();
    } else if (statusCode === 429) {
      error = new RateLimitError(undefined, retryAfterMs);
    } else {
      error = new ConnectionError(
        `RTPR rejected the WebSocket handshake with HTTP ${statusCode}`,
        retryAfterMs,
      );
    }
    this.#emitError(error);

    if (statusCode === 401 || statusCode === 403) {
      this.#state = "failed";
      this.#port.postMessage({
        type: "start-failed",
        error: serializeAlertStreamError(error),
      } satisfies WorkerToMainMessage);
      this.#postStats();
      return;
    }
    if (!this.#everConnected && statusCode === 429) {
      this.#port.postMessage({
        type: "start-delayed",
        retryAfterMs: retryAfterMs ?? this.#data.config.reconnectBaseMs,
      } satisfies WorkerToMainMessage);
    }
    this.#scheduleReconnect(retryAfterMs);
  }

  #scheduleReconnect(retryAfterMs?: number): void {
    if (this.#closing || this.#reconnectTimer !== null) {
      return;
    }
    this.#state = "reconnecting";
    this.#counters.reconnects += 1;
    const jitter =
      this.#data.testOverrides?.fixedJitter === undefined
        ? Math.random()
        : this.#data.testOverrides.fixedJitter;
    const delayMs = reconnectDelayMs(
      this.#reconnectAttempt,
      this.#data.config.reconnectBaseMs,
      this.#data.config.reconnectMaxMs,
      jitter,
      retryAfterMs,
    );
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delayMs);
    this.#reconnectTimer.unref();
    this.#postStats();
  }

  #handleSocketMessage(data: RawData, isBinary: boolean): void {
    this.#counters.framesReceived += 1;
    if (isBinary) {
      this.#counters.protocolErrors += 1;
      this.#emitError(new ProtocolError("RTPR sent a binary alert frame"));
      this.#postStats();
      return;
    }
    try {
      const message = parseServerMessage(rawDataToBuffer(data));
      if (message.kind === "ping") {
        this.#counters.pingsReceived += 1;
        this.#workerHealth.lastPingAtUtc = new Date().toISOString();
        if (this.#socket?.readyState === WebSocket.OPEN) {
          this.#socket.send(createPong(message));
          this.#counters.pongsSent += 1;
        }
        this.#postStats();
        return;
      }
      if (message.kind === "connected") {
        return;
      }
      this.#acceptAlert(message.alert);
    } catch (error) {
      this.#counters.protocolErrors += 1;
      this.#emitError(
        error instanceof ProtocolError
          ? error
          : new ProtocolError("RTPR sent an invalid alert frame"),
      );
      this.#postStats();
    }
  }

  #acceptAlert(alert: ParsedAlertFrame): void {
    this.#counters.alertsReceived += 1;
    const active = this.#activeArticles.get(alert.articleId);
    if (active !== undefined) {
      this.#counters.duplicateFrames += 1;
      for (const ruleName of alert.ruleNames) {
        if (!active.ruleNames.has(ruleName)) {
          active.ruleNames.add(ruleName);
          this.#counters.duplicateRuleNamesMerged += 1;
        }
      }
      this.#postStats();
      return;
    }

    if (this.#isDeduped(alert.articleId)) {
      this.#counters.duplicateFrames += 1;
      this.#postStats();
      return;
    }

    if (this.#activeArticles.size >= this.#data.config.maxPendingFetches) {
      this.#recordOverload("pending_fetches");
      this.#counters.pendingFetchOverloads += 1;
      this.#emitError(
        new BackpressureError(alert.articleId, alert.articleUrl, "pending_fetches"),
      );
      this.#postStats();
      return;
    }

    const nowEpochMs = Date.now();
    const pending: PendingAlert = {
      alert,
      receivedMonoMs: performance.now(),
      receivedEpochMs: nowEpochMs,
      receivedAtUtc: new Date(nowEpochMs).toISOString(),
      ruleNames: new Set(alert.ruleNames),
      receivedBurstState: this.#burstSnapshot(),
    };
    this.#activeArticles.set(alert.articleId, pending);
    this.#pendingAlerts.push(pending);
    this.#queues.pendingFetches = this.#pendingAlerts.length;
    this.#queues.pendingFetchesHighWater = Math.max(
      this.#queues.pendingFetchesHighWater,
      this.#queues.pendingFetches,
    );
    this.#pumpFetches();
    this.#postStats();
  }

  #pumpFetches(): void {
    while (
      !this.#closing &&
      this.#queues.activeFetches < this.#data.config.fetchConcurrency &&
      this.#pendingAlerts.length > 0
    ) {
      const pending = this.#pendingAlerts.shift();
      if (pending === undefined) {
        break;
      }
      this.#queues.pendingFetches = this.#pendingAlerts.length;
      this.#queues.activeFetches += 1;
      const task = this.#fetchArticle(pending)
        .catch(() => {
          // #fetchArticle converts every expected failure into a bounded SDK error.
        })
        .finally(() => {
          this.#activeTasks.delete(task);
          this.#activeArticles.delete(pending.alert.articleId);
          this.#queues.activeFetches -= 1;
          this.#pumpFetches();
          this.#postStats();
        });
      this.#activeTasks.add(task);
    }
  }

  async #fetchArticle(pending: PendingAlert): Promise<void> {
    this.#counters.fetchesStarted += 1;
    const fetchStartedMonoMs = performance.now();
    const fetchStartedEpochMs = Date.now();
    const fetchStartedAtUtc = new Date(fetchStartedEpochMs).toISOString();
    const attemptReasons = ["initial"];
    const burstState: Record<string, EventBurstSnapshot> = {
      alertReceived: pending.receivedBurstState,
      fetchSubmitted: this.#burstSnapshot(),
    };
    const deadlineAtMonoMs =
      pending.receivedMonoMs + this.#data.config.fetchDeadlineMs;
    const deadlineController = new AbortController();
    const onShutdown = (): void => {
      deadlineController.abort(this.#shutdownController.signal.reason);
    };
    this.#shutdownController.signal.addEventListener("abort", onShutdown, {
      once: true,
    });
    const deadlineTimer = setTimeout(() => {
      deadlineController.abort(new Error("fetch deadline"));
    }, Math.max(1, deadlineAtMonoMs - performance.now()));
    deadlineTimer.unref();

    let attempts = 0;
    try {
      this.#validateArticleUrl(pending.alert.articleUrl);
      while (attempts < this.#data.config.fetchMaxAttempts) {
        attempts += 1;
        const attemptStartedMonoMs = performance.now();
        const remainingMs = deadlineAtMonoMs - attemptStartedMonoMs;
        if (remainingMs <= 0) {
          throw new FinalFetchFailure(undefined, "deadline", false);
        }

        try {
          const response = await request(pending.alert.articleUrl, {
            method: "GET",
            headers: {
              "x-api-key": this.#data.apiKey,
              "accept-encoding": "identity",
            },
            dispatcher: this.#dispatcher,
            maxRedirections: 0,
            signal: deadlineController.signal,
            headersTimeout: Math.max(1, Math.ceil(remainingMs)),
            bodyTimeout: Math.max(1, Math.ceil(remainingMs)),
          });
          const headersReceivedMonoMs = performance.now();
          const headersReceivedAtUtc = new Date().toISOString();
          burstState.headersReceived = this.#burstSnapshot();

          if (response.statusCode >= 300 && response.statusCode < 400) {
            await response.body.dump();
            throw new RedirectFailure(response.statusCode);
          }

          const elapsedMs = headersReceivedMonoMs - pending.receivedMonoMs;
          const retryKind =
            response.statusCode === 404 && elapsedMs <= MAX_404_RACE_MS
              ? "404"
              : RETRYABLE_FETCH_STATUSES.has(response.statusCode)
                ? "5xx"
                : null;
          if (
            retryKind !== null &&
            attempts < this.#data.config.fetchMaxAttempts
          ) {
            await response.body.dump();
            const retried = await this.#waitForFetchRetry(
              attempts,
              deadlineAtMonoMs,
              deadlineController.signal,
              retryKind,
            );
            if (retried) {
              attemptReasons.push(
                retryKind === "404"
                  ? "availability_404"
                  : `retryable_http_${response.statusCode}`,
              );
              continue;
            }
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            await response.body.dump();
            throw new FinalFetchFailure(
              response.statusCode,
              `http_${response.statusCode}`,
              retryKind !== null,
            );
          }

          const contentLengthValue = response.headers["content-length"];
          const contentLength = Array.isArray(contentLengthValue)
            ? Number(contentLengthValue[0])
            : Number(contentLengthValue);
          if (
            Number.isFinite(contentLength) &&
            contentLength > this.#data.config.maxArticleBytes
          ) {
            await response.body.dump();
            throw new ArticleCapacityFailure("article_size");
          }

          const chunks: Uint8Array[] = [];
          let totalBytes = 0;
          for await (const chunk of response.body) {
            const bytes =
              chunk instanceof Uint8Array ? chunk : Buffer.from(chunk as ArrayBuffer);
            totalBytes += bytes.byteLength;
            if (totalBytes > this.#data.config.maxArticleBytes) {
              response.body.destroy();
              throw new ArticleCapacityFailure("article_size");
            }
            chunks.push(bytes);
          }
          const bodyCompletedMonoMs = performance.now();
          const bodyCompletedAtUtc = new Date().toISOString();
          burstState.bodyCompleted = this.#burstSnapshot();
          const raw = new Uint8Array(totalBytes);
          let offset = 0;
          for (const chunk of chunks) {
            raw.set(chunk, offset);
            offset += chunk.byteLength;
          }

          const articlePublishedEpochMs = Date.parse(
            pending.alert.articlePublishedAt,
          );
          const result: Omit<WorkerResult, "deliveryId" | "postedAtMonoMs" | "postedAtUtc"> = {
            alert: Object.freeze({
              ...pending.alert,
              ruleNames: Object.freeze([...pending.ruleNames]),
            }),
            raw: raw.buffer,
            statusCode: response.statusCode,
            attempts,
            attemptReasons: Object.freeze([...attemptReasons]),
            diagnosticHeaders: headersFromResponse(response.headers),
            timing: {
              fetchStartDelayMs: Math.max(
                0,
                fetchStartedMonoMs - pending.receivedMonoMs,
              ),
              timeToHeadersMs: Math.max(
                0,
                headersReceivedMonoMs - fetchStartedMonoMs,
              ),
              bodyReadMs: Math.max(
                0,
                bodyCompletedMonoMs - headersReceivedMonoMs,
              ),
              fetchRoundTripMs: Math.max(
                0,
                bodyCompletedMonoMs - fetchStartedMonoMs,
              ),
              bodyCompletedMonoMs,
            },
            milestones: {
              alertReceivedAtUtc: pending.receivedAtUtc,
              fetchStartedAtUtc,
              headersReceivedAtUtc,
              bodyCompletedAtUtc,
            },
            wallClockEstimates: Object.freeze({
              label: "wall-clock estimates; RTPR and customer clocks may differ",
              publishToDispatchMs: Number.isFinite(articlePublishedEpochMs)
                ? pending.alert.dispatchedAtMs - articlePublishedEpochMs
                : null,
              dispatchToReceiveMs:
                pending.receivedEpochMs - pending.alert.dispatchedAtMs,
            }),
            burstState: Object.freeze({
              ...burstState,
              resultOffered: this.#burstSnapshot(),
            }),
          };
          this.#counters.bytesFetched += totalBytes;
          if (this.#offerResult(result)) {
            this.#counters.fetchesSucceeded += 1;
            this.#rememberDedupe(pending.alert.articleId);
          } else {
            this.#counters.fetchesFailed += 1;
          }
          return;
        } catch (error) {
          if (
            error instanceof RedirectFailure ||
            error instanceof ArticleCapacityFailure ||
            error instanceof FinalFetchFailure
          ) {
            throw error;
          }
          if (deadlineController.signal.aborted) {
            if (this.#closing) {
              return;
            }
            throw new FinalFetchFailure(undefined, "deadline", false);
          }
          if (attempts < this.#data.config.fetchMaxAttempts) {
            const retried = await this.#waitForFetchRetry(
              attempts,
              deadlineAtMonoMs,
              deadlineController.signal,
              "network",
            );
            if (retried) {
              attemptReasons.push("network_error");
              continue;
            }
          }
          throw new FinalFetchFailure(undefined, "network", true);
        }
      }
      throw new FinalFetchFailure(undefined, "attempts_exhausted", false);
    } catch (error) {
      if (this.#closing) {
        return;
      }
      this.#counters.fetchesFailed += 1;
      if (error instanceof RedirectFailure) {
        this.#counters.redirectsRejected += 1;
        this.#emitError(
          new RedirectRejectedError(
            pending.alert.articleId,
            pending.alert.articleUrl,
            error.statusCode,
          ),
        );
      } else if (error instanceof ArticleCapacityFailure) {
        this.#recordOverload(error.reason);
        if (error.reason === "article_size") {
          this.#counters.articleSizeOverloads += 1;
        } else {
          this.#counters.resultByteOverloads += 1;
        }
        this.#emitError(
          new BackpressureError(
            pending.alert.articleId,
            pending.alert.articleUrl,
            error.reason,
          ),
        );
      } else {
        const failure =
          error instanceof FinalFetchFailure
            ? error
            : new FinalFetchFailure(undefined, "network", false);
        this.#emitError(
          new FetchError(pending.alert.articleId, pending.alert.articleUrl, {
            statusCode: failure.statusCode,
            reason: failure.reason,
            retryable: failure.retryable,
          }),
        );
      }
    } finally {
      clearTimeout(deadlineTimer);
      this.#shutdownController.signal.removeEventListener("abort", onShutdown);
    }
  }

  async #waitForFetchRetry(
    attempts: number,
    deadlineAtMonoMs: number,
    signal: AbortSignal,
    kind: "network" | "5xx" | "404",
  ): Promise<boolean> {
    const cap = Math.min(
      this.#data.config.fetchRetryMaxMs,
      this.#data.config.fetchRetryBaseMs * 2 ** Math.min(attempts - 1, 30),
    );
    const jitter =
      this.#data.testOverrides?.fixedJitter === undefined
        ? Math.random()
        : this.#data.testOverrides.fixedJitter;
    const delayMs = Math.floor(cap * Math.min(1, Math.max(0, jitter)));
    if (performance.now() + delayMs >= deadlineAtMonoMs) {
      return false;
    }
    this.#counters.fetchRetries += 1;
    if (kind === "network") {
      this.#counters.fetchNetworkRetries += 1;
    } else if (kind === "5xx") {
      this.#counters.fetch5xxRetries += 1;
    } else {
      this.#counters.fetch404Retries += 1;
    }
    await sleepWithSignal(delayMs, signal);
    return true;
  }

  #validateArticleUrl(articleUrl: string): void {
    let parsed: URL;
    try {
      parsed = new URL(articleUrl);
    } catch {
      throw new FinalFetchFailure(undefined, "invalid_url", false);
    }
    const insecureAllowed =
      this.#data.testOverrides?.allowInsecureArticleUrls === true;
    if (parsed.protocol !== "https:" && !(insecureAllowed && parsed.protocol === "http:")) {
      throw new FinalFetchFailure(undefined, "invalid_url_scheme", false);
    }
  }

  #offerResult(
    incomplete: Omit<WorkerResult, "deliveryId" | "postedAtMonoMs" | "postedAtUtc">,
  ): boolean {
    const byteLength = incomplete.raw.byteLength;
    if (byteLength > this.#data.config.maxResultBytes) {
      this.#recordOverload("result_bytes");
      this.#counters.resultByteOverloads += 1;
      this.#emitError(
        new BackpressureError(
          incomplete.alert.articleId,
          incomplete.alert.articleUrl,
          "result_bytes",
        ),
      );
      return false;
    }
    if (this.#queues.bufferedResultItems >= this.#data.config.maxResultItems) {
      this.#recordOverload("result_items");
      this.#counters.resultItemOverloads += 1;
      this.#emitError(
        new BackpressureError(
          incomplete.alert.articleId,
          incomplete.alert.articleUrl,
          "result_items",
        ),
      );
      return false;
    }
    if (
      this.#queues.bufferedResultBytes + byteLength >
      this.#data.config.maxResultBytes
    ) {
      this.#recordOverload("result_bytes");
      this.#counters.resultByteOverloads += 1;
      this.#emitError(
        new BackpressureError(
          incomplete.alert.articleId,
          incomplete.alert.articleUrl,
          "result_bytes",
        ),
      );
      return false;
    }

    const deliveryId = this.#nextDeliveryId;
    this.#nextDeliveryId += 1;
    const buffered: BufferedResult = {
      deliveryId,
      byteLength,
      result: {
        ...incomplete,
        deliveryId,
        postedAtMonoMs: 0,
        postedAtUtc: "",
      },
    };
    this.#queues.bufferedResultItems += 1;
    this.#queues.bufferedResultBytes += byteLength;
    this.#queues.bufferedResultItemsHighWater = Math.max(
      this.#queues.bufferedResultItemsHighWater,
      this.#queues.bufferedResultItems,
    );
    this.#queues.bufferedResultBytesHighWater = Math.max(
      this.#queues.bufferedResultBytesHighWater,
      this.#queues.bufferedResultBytes,
    );
    if (
      this.#resultItemCredits > 0 &&
      this.#resultByteCredits >= byteLength
    ) {
      this.#postResult(buffered);
    } else {
      this.#resultQueue.push(buffered);
      this.#refreshResultQueueStats();
    }
    this.#postStats();
    return true;
  }

  #postResult(buffered: BufferedResult): void {
    this.#resultItemCredits -= 1;
    this.#resultByteCredits -= buffered.byteLength;
    this.#inFlightResults.set(buffered.deliveryId, buffered.byteLength);
    this.#queues.inFlightResultItems = this.#inFlightResults.size;
    this.#queues.inFlightResultBytes += buffered.byteLength;
    const postedAtMonoMs = performance.now();
    buffered.result = {
      ...buffered.result,
      postedAtMonoMs,
      postedAtUtc: new Date().toISOString(),
      burstState: Object.freeze({
        ...buffered.result.burstState,
        workerPosted: this.#burstSnapshot(),
      }),
    };
    this.#counters.resultsDelivered += 1;
    this.#counters.bytesDelivered += buffered.byteLength;
    this.#port.postMessage(
      { type: "result", result: buffered.result } satisfies WorkerToMainMessage,
      [buffered.result.raw],
    );
  }

  #ackResult(deliveryId: number, reportedByteLength: number): void {
    const byteLength = this.#inFlightResults.get(deliveryId);
    if (byteLength === undefined) {
      return;
    }
    this.#inFlightResults.delete(deliveryId);
    this.#resultItemCredits += 1;
    this.#resultByteCredits += byteLength;
    this.#queues.inFlightResultItems = this.#inFlightResults.size;
    this.#queues.inFlightResultBytes = Math.max(
      0,
      this.#queues.inFlightResultBytes - byteLength,
    );
    this.#queues.bufferedResultItems = Math.max(
      0,
      this.#queues.bufferedResultItems - 1,
    );
    this.#queues.bufferedResultBytes = Math.max(
      0,
      this.#queues.bufferedResultBytes - byteLength,
    );
    if (reportedByteLength === byteLength) {
      this.#counters.resultsAcknowledged += 1;
    }
    this.#flushResultQueue();
    this.#postStats();
  }

  #flushResultQueue(): void {
    while (this.#resultQueue.length > 0 && this.#resultItemCredits > 0) {
      const next = this.#resultQueue[0];
      if (next.byteLength > this.#resultByteCredits) {
        break;
      }
      this.#resultQueue.shift();
      this.#postResult(next);
    }
    this.#refreshResultQueueStats();
  }

  #refreshResultQueueStats(): void {
    this.#queues.workerResultQueueItems = this.#resultQueue.length;
    this.#queues.workerResultQueueBytes = this.#resultQueue.reduce(
      (total, result) => total + result.byteLength,
      0,
    );
  }

  #recordOverload(_reason: string): void {
    this.#counters.overloads += 1;
  }

  #isDeduped(articleId: string): boolean {
    const timestamp = this.#dedupe.get(articleId);
    if (timestamp === undefined) {
      return false;
    }
    if (Date.now() - timestamp > this.#data.config.dedupeTtlMs) {
      this.#dedupe.delete(articleId);
      return false;
    }
    this.#dedupe.delete(articleId);
    this.#dedupe.set(articleId, timestamp);
    return true;
  }

  #rememberDedupe(articleId: string): void {
    this.#dedupe.delete(articleId);
    this.#dedupe.set(articleId, Date.now());
    while (this.#dedupe.size > this.#data.config.dedupeMaxEntries) {
      const oldest = this.#dedupe.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.#dedupe.delete(oldest);
    }
  }

  #emitError(error: AlertStreamError): void {
    if (this.#queues.bufferedErrors >= this.#data.config.maxErrorItems) {
      this.#counters.errorsSuppressed += 1;
      this.#postStats();
      return;
    }
    const buffered: BufferedError = {
      errorId: this.#nextErrorId,
      error: serializeAlertStreamError(error),
    };
    this.#nextErrorId += 1;
    this.#queues.bufferedErrors += 1;
    this.#queues.bufferedErrorsHighWater = Math.max(
      this.#queues.bufferedErrorsHighWater,
      this.#queues.bufferedErrors,
    );
    this.#counters.errorsEmitted += 1;
    if (this.#errorCredits > 0) {
      this.#postError(buffered);
    } else {
      this.#errorQueue.push(buffered);
    }
    this.#postStats();
  }

  #postError(buffered: BufferedError): void {
    this.#errorCredits -= 1;
    this.#inFlightErrors.add(buffered.errorId);
    this.#port.postMessage({
      type: "stream-error",
      errorId: buffered.errorId,
      error: buffered.error,
    } satisfies WorkerToMainMessage);
  }

  #ackError(errorId: number): void {
    if (!this.#inFlightErrors.delete(errorId)) {
      return;
    }
    this.#errorCredits += 1;
    this.#queues.bufferedErrors = Math.max(0, this.#queues.bufferedErrors - 1);
    const next = this.#errorQueue.shift();
    if (next !== undefined) {
      this.#postError(next);
    }
    this.#postStats();
  }

  async #runKeepalive(): Promise<void> {
    if (this.#closing || this.#keepaliveRunning) {
      return;
    }
    this.#keepaliveRunning = true;
    this.#keepalive.active = true;
    this.#keepalive.attempts += 1;
    this.#postStats();
    const checkedAtUtc = new Date().toISOString();
    try {
      const response = await request(
        this.#data.testOverrides?.keepaliveUrl ?? PRODUCTION_KEEPALIVE_URL,
        {
          method: "HEAD",
          dispatcher: this.#dispatcher,
          maxRedirections: 0,
          signal: this.#shutdownController.signal,
          headersTimeout: Math.min(
            this.#data.config.fetchDeadlineMs,
            this.#data.config.keepaliveIntervalMs,
          ),
          bodyTimeout: Math.min(
            this.#data.config.fetchDeadlineMs,
            this.#data.config.keepaliveIntervalMs,
          ),
        },
      );
      await response.body.dump();
      const headerPresent =
        response.headers["x-rtpr-sdk-keepalive"] !== undefined;
      const healthy = response.statusCode === 204 && headerPresent;
      this.#keepalive.lastStatusCode = response.statusCode;
      this.#keepalive.headerPresent = headerPresent;
      this.#keepalive.healthy = healthy;
      if (healthy) {
        this.#keepalive.successes += 1;
        this.#keepalive.lastHealthyAtUtc = checkedAtUtc;
      } else {
        this.#keepalive.failures += 1;
      }
    } catch {
      if (!this.#closing) {
        this.#keepalive.healthy = false;
        this.#keepalive.headerPresent = false;
        this.#keepalive.lastStatusCode = null;
        this.#keepalive.failures += 1;
      }
    } finally {
      this.#keepalive.lastCheckedAtUtc = checkedAtUtc;
      this.#keepalive.active = false;
      this.#keepaliveRunning = false;
      this.#postStats();
    }
  }

  #startLoopLagMonitor(): void {
    let expected = performance.now() + LOOP_LAG_INTERVAL_MS;
    this.#loopLagTimer = setInterval(() => {
      const now = performance.now();
      const lag = Math.max(0, now - expected);
      expected = now + LOOP_LAG_INTERVAL_MS;
      this.#workerHealth.loopLagMs = lag;
      this.#workerHealth.loopLagMaxMs = Math.max(
        this.#workerHealth.loopLagMaxMs,
        lag,
      );
      this.#postStats();
    }, LOOP_LAG_INTERVAL_MS);
    this.#loopLagTimer.unref();
  }

  #burstSnapshot(): EventBurstSnapshot {
    const lastPingEpochMs =
      this.#workerHealth.lastPingAtUtc === null
        ? Number.NaN
        : Date.parse(this.#workerHealth.lastPingAtUtc);
    return Object.freeze({
      fetchQueueDepth: this.#queues.pendingFetches,
      resultQueueItems: this.#queues.bufferedResultItems,
      resultQueueBytes: this.#queues.bufferedResultBytes,
      activeFetches: this.#queues.activeFetches,
      configuredConcurrency: this.#data.config.fetchConcurrency,
      workerLoopLagMs: this.#workerHealth.loopLagMs,
      reconnectCount: this.#counters.reconnects,
      lastPingAgeMs: Number.isFinite(lastPingEpochMs)
        ? Math.max(0, Date.now() - lastPingEpochMs)
        : null,
      retryCount: this.#counters.fetchRetries,
      overloadCount: this.#counters.overloads,
    });
  }

  #statsSnapshot(): StreamStats {
    return {
      state: this.#state,
      generatedAtUtc: new Date().toISOString(),
      counters: { ...this.#counters },
      queues: { ...this.#queues },
      worker: { ...this.#workerHealth },
      keepalive: { ...this.#keepalive },
    };
  }

  #postStats(): void {
    if (this.#closing && this.#state === "closed") {
      return;
    }
    if (this.#statsOutstanding) {
      this.#statsDirty = true;
      return;
    }
    this.#statsOutstanding = true;
    this.#port.postMessage({
      type: "stats",
      stats: this.#statsSnapshot(),
    } satisfies WorkerToMainMessage);
  }

  async #close(): Promise<void> {
    if (this.#closing) {
      return;
    }
    this.#closing = true;
    this.#state = "closing";
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#keepaliveTimer !== null) {
      clearInterval(this.#keepaliveTimer);
      this.#keepaliveTimer = null;
    }
    if (this.#loopLagTimer !== null) {
      clearInterval(this.#loopLagTimer);
      this.#loopLagTimer = null;
    }
    this.#shutdownController.abort(new Error("AlertStream shutdown"));
    this.#pendingAlerts.length = 0;
    this.#queues.pendingFetches = 0;

    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null) {
      if (
        socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING
      ) {
        socket.close(1000, "SDK shutdown");
        await Promise.race([
          new Promise<void>((resolve) => socket.once("close", () => resolve())),
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 250);
            timer.unref();
          }),
        ]);
      }
      if (socket.readyState !== WebSocket.CLOSED) {
        socket.terminate();
      }
    }

    await Promise.allSettled([...this.#activeTasks]);
    try {
      await Promise.race([
        this.#dispatcher.close(),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 500);
          timer.unref();
        }),
      ]);
    } finally {
      if (!this.#dispatcher.closed) {
        await this.#dispatcher.destroy();
      }
    }

    this.#resultQueue.length = 0;
    this.#errorQueue.length = 0;
    this.#inFlightResults.clear();
    this.#inFlightErrors.clear();
    this.#state = "closed";
    this.#port.postMessage({ type: "closed" } satisfies WorkerToMainMessage);
    setImmediate(() => this.#port.close());
  }
}

if (!isMainThread && parentPort !== null) {
  const runtime = new AlertWorkerRuntime(workerData as AlertWorkerData, parentPort);
  runtime.run();
}
