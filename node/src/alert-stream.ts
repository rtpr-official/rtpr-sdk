import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import {
  AlertStreamError,
  ConfigurationError,
  ConnectionError,
  HandlerError,
  StreamClosedError,
  deserializeAlertStreamError,
} from "./errors";
import {
  FixedRing,
  safeDiagnosticIdentifier,
  windowSupportReport,
  type DiagnosticRecord,
} from "./diagnostics";
import {
  RawArticleEvent,
  eventDiagnosticRecord,
  markHandlerCompleted,
  markHandlerStarted,
} from "./events";
import {
  type AlertErrorHandler,
  type AlertEventHandler,
  type AlertStreamOptions,
  type AlertStreamState,
  type SanitizedStreamConfig,
  type StreamStats,
} from "./types";
import type {
  AlertWorkerData,
  MainToWorkerMessage,
  ResolvedAlertStreamConfig,
  WorkerResult,
  WorkerTestOverrides,
  WorkerToMainMessage,
} from "./worker-protocol";

const DEFAULTS: ResolvedAlertStreamConfig = Object.freeze({
  fetchConcurrency: 8,
  maxPendingFetches: 256,
  maxResultItems: 32,
  maxResultBytes: 32 * 1024 * 1024,
  maxArticleBytes: 16 * 1024 * 1024,
  maxErrorItems: 64,
  dedupeTtlMs: 5 * 60 * 1_000,
  dedupeMaxEntries: 10_000,
  fetchDeadlineMs: 15_000,
  fetchMaxAttempts: 4,
  fetchRetryBaseMs: 75,
  fetchRetryMaxMs: 1_000,
  reconnectBaseMs: 250,
  reconnectMaxMs: 30_000,
  keepaliveIntervalMs: 30_000,
  connectTimeoutMs: 15_000,
  diagnosticRingSize: 512,
});

type ConsumptionMode = "callback" | "iterator";

interface QueuedResult {
  readonly deliveryId: number;
  readonly byteLength: number;
  readonly event: RawArticleEvent;
}

interface QueuedError {
  readonly workerErrorId: number | null;
  readonly error: AlertStreamError;
}

interface InternalOptions extends AlertStreamOptions {
  readonly __test?: WorkerTestOverrides;
}

function positiveInteger(
  name: string,
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximum) {
    throw new ConfigurationError(
      `${name} must be a positive integer no greater than ${maximum}`,
    );
  }
  return resolved;
}

function resolveConfig(options: AlertStreamOptions): ResolvedAlertStreamConfig {
  const config: ResolvedAlertStreamConfig = {
    fetchConcurrency: positiveInteger(
      "fetchConcurrency",
      options.fetchConcurrency,
      DEFAULTS.fetchConcurrency,
      64,
    ),
    maxPendingFetches: positiveInteger(
      "maxPendingFetches",
      options.maxPendingFetches,
      DEFAULTS.maxPendingFetches,
      100_000,
    ),
    maxResultItems: positiveInteger(
      "maxResultItems",
      options.maxResultItems,
      DEFAULTS.maxResultItems,
      10_000,
    ),
    maxResultBytes: positiveInteger(
      "maxResultBytes",
      options.maxResultBytes,
      DEFAULTS.maxResultBytes,
      1024 * 1024 * 1024,
    ),
    maxArticleBytes: positiveInteger(
      "maxArticleBytes",
      options.maxArticleBytes,
      DEFAULTS.maxArticleBytes,
      1024 * 1024 * 1024,
    ),
    maxErrorItems: positiveInteger(
      "maxErrorItems",
      options.maxErrorItems,
      DEFAULTS.maxErrorItems,
      10_000,
    ),
    dedupeTtlMs: positiveInteger(
      "dedupeTtlMs",
      options.dedupeTtlMs,
      DEFAULTS.dedupeTtlMs,
      24 * 60 * 60 * 1_000,
    ),
    dedupeMaxEntries: positiveInteger(
      "dedupeMaxEntries",
      options.dedupeMaxEntries,
      DEFAULTS.dedupeMaxEntries,
      1_000_000,
    ),
    fetchDeadlineMs: positiveInteger(
      "fetchDeadlineMs",
      options.fetchDeadlineMs,
      DEFAULTS.fetchDeadlineMs,
      5 * 60 * 1_000,
    ),
    fetchMaxAttempts: positiveInteger(
      "fetchMaxAttempts",
      options.fetchMaxAttempts,
      DEFAULTS.fetchMaxAttempts,
      20,
    ),
    fetchRetryBaseMs: positiveInteger(
      "fetchRetryBaseMs",
      options.fetchRetryBaseMs,
      DEFAULTS.fetchRetryBaseMs,
      60_000,
    ),
    fetchRetryMaxMs: positiveInteger(
      "fetchRetryMaxMs",
      options.fetchRetryMaxMs,
      DEFAULTS.fetchRetryMaxMs,
      5 * 60 * 1_000,
    ),
    reconnectBaseMs: positiveInteger(
      "reconnectBaseMs",
      options.reconnectBaseMs,
      DEFAULTS.reconnectBaseMs,
      60_000,
    ),
    reconnectMaxMs: positiveInteger(
      "reconnectMaxMs",
      options.reconnectMaxMs,
      DEFAULTS.reconnectMaxMs,
      15 * 60 * 1_000,
    ),
    keepaliveIntervalMs: positiveInteger(
      "keepaliveIntervalMs",
      options.keepaliveIntervalMs,
      DEFAULTS.keepaliveIntervalMs,
      60 * 60 * 1_000,
    ),
    connectTimeoutMs: positiveInteger(
      "connectTimeoutMs",
      options.connectTimeoutMs,
      DEFAULTS.connectTimeoutMs,
      5 * 60 * 1_000,
    ),
    diagnosticRingSize: positiveInteger(
      "diagnosticRingSize",
      options.diagnosticRingSize,
      DEFAULTS.diagnosticRingSize,
      100_000,
    ),
  };
  if (config.maxArticleBytes > config.maxResultBytes) {
    throw new ConfigurationError(
      "maxArticleBytes cannot exceed maxResultBytes",
    );
  }
  if (config.fetchRetryBaseMs > config.fetchRetryMaxMs) {
    throw new ConfigurationError(
      "fetchRetryBaseMs cannot exceed fetchRetryMaxMs",
    );
  }
  if (config.reconnectBaseMs > config.reconnectMaxMs) {
    throw new ConfigurationError(
      "reconnectBaseMs cannot exceed reconnectMaxMs",
    );
  }
  return Object.freeze(config);
}

function safeConfig(
  config: ResolvedAlertStreamConfig,
): SanitizedStreamConfig {
  return Object.freeze({
    fetchConcurrency: config.fetchConcurrency,
    maxPendingFetches: config.maxPendingFetches,
    maxResultItems: config.maxResultItems,
    maxResultBytes: config.maxResultBytes,
    maxArticleBytes: config.maxArticleBytes,
    maxErrorItems: config.maxErrorItems,
    dedupeTtlMs: config.dedupeTtlMs,
    dedupeMaxEntries: config.dedupeMaxEntries,
    fetchDeadlineMs: config.fetchDeadlineMs,
    fetchMaxAttempts: config.fetchMaxAttempts,
    reconnectBaseMs: config.reconnectBaseMs,
    reconnectMaxMs: config.reconnectMaxMs,
    keepaliveIntervalMs: config.keepaliveIntervalMs,
  });
}

function workerFile(): string {
  const candidates = [
    join(__dirname, "alert-worker.js"),
    resolve(__dirname, "..", "dist", "alert-worker.js"),
  ];
  const match = candidates.find(existsSync);
  if (match === undefined) {
    throw new ConfigurationError(
      "The compiled AlertStream worker was not found; rebuild the package",
    );
  }
  return match;
}

function initialStats(): StreamStats {
  return {
    state: "idle",
    generatedAtUtc: new Date().toISOString(),
    counters: {
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
    },
    queues: {
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
    },
    worker: {
      loopLagMs: 0,
      loopLagMaxMs: 0,
      lastPingAtUtc: null,
    },
    keepalive: {
      healthy: false,
      active: false,
      attempts: 0,
      successes: 0,
      failures: 0,
      lastStatusCode: null,
      lastCheckedAtUtc: null,
      lastHealthyAtUtc: null,
      headerPresent: false,
    },
  };
}

function frozenStats(stats: StreamStats, state: AlertStreamState): StreamStats {
  return Object.freeze({
    ...stats,
    state,
    counters: Object.freeze({ ...stats.counters }),
    queues: Object.freeze({ ...stats.queues }),
    worker: Object.freeze({ ...stats.worker }),
    keepalive: Object.freeze({ ...stats.keepalive }),
  });
}

/**
 * Push-only saved-rule alert stream.
 *
 * WebSocket, HTTP, keepalive, retry, and raw-body work all run in a dedicated
 * worker thread. Choose either `onEvent()` callbacks or AsyncIterable
 * consumption; attempting to mix them throws a ConfigurationError.
 */
export class AlertStream implements AsyncIterable<RawArticleEvent> {
  readonly #apiKey: string;
  readonly #config: ResolvedAlertStreamConfig;
  readonly #safeConfig: SanitizedStreamConfig;
  readonly #testOverrides: WorkerTestOverrides | undefined;
  readonly #eventHandlers = new Set<AlertEventHandler>();
  readonly #errorHandlers = new Set<AlertErrorHandler>();
  readonly #eventQueue: QueuedResult[] = [];
  readonly #errorQueue: QueuedError[] = [];
  readonly #diagnostics: FixedRing<DiagnosticRecord>;
  readonly #sessionId = randomUUID();

  #worker: Worker | null = null;
  #state: AlertStreamState = "idle";
  #latestStats: StreamStats = initialStats();
  #consumptionMode: ConsumptionMode | null = null;
  #iteratorClaimed = false;
  #pendingIterator:
    | {
        readonly resolve: (result: IteratorResult<RawArticleEvent>) => void;
        readonly reject: (error: unknown) => void;
      }
    | undefined;
  #iteratorOutstanding: QueuedResult | null = null;
  #callbackDrainRunning = false;
  #errorDrainRunning = false;
  #startPromise: Promise<void> | null = null;
  #resolveStart: (() => void) | null = null;
  #rejectStart: ((error: unknown) => void) | null = null;
  #startTimer: NodeJS.Timeout | null = null;
  #closePromise: Promise<void> | null = null;
  #resolveClose: (() => void) | null = null;
  #lastError: AlertStreamError | null = null;
  #handlerCalls = 0;
  #handlerFailures = 0;
  #latencyWarningEmitted = false;

  constructor(apiKey?: string, options: AlertStreamOptions = {}) {
    const resolvedApiKey = apiKey ?? process.env.RTPR_API_KEY;
    if (resolvedApiKey === undefined || resolvedApiKey.trim().length === 0) {
      throw new ConfigurationError(
        "An API key is required (argument or RTPR_API_KEY environment variable)",
      );
    }
    this.#apiKey = resolvedApiKey;
    this.#config = resolveConfig(options);
    this.#safeConfig = safeConfig(this.#config);
    this.#diagnostics = new FixedRing(this.#config.diagnosticRingSize);

    const testOverrides = (options as InternalOptions).__test;
    if (testOverrides !== undefined) {
      const testMode =
        process.env.NODE_ENV === "test" ||
        process.env.VITEST === "true" ||
        process.env.VITEST_WORKER_ID !== undefined;
      if (!testMode) {
        throw new ConfigurationError(
          "Internal endpoint overrides are available only under a test runner",
        );
      }
      this.#testOverrides = Object.freeze({ ...testOverrides });
    }
  }

  public get state(): AlertStreamState {
    return this.#state;
  }

  public get lastError(): AlertStreamError | null {
    return this.#lastError;
  }

  public onEvent(handler: AlertEventHandler): this {
    if (typeof handler !== "function") {
      throw new ConfigurationError("onEvent requires a function");
    }
    if (this.#consumptionMode === "iterator") {
      throw new ConfigurationError(
        "AlertStream callback and AsyncIterable consumption cannot be mixed",
      );
    }
    this.#consumptionMode = "callback";
    this.#eventHandlers.add(handler);
    void this.#drainCallbacks();
    return this;
  }

  public onError(handler: AlertErrorHandler): this {
    if (typeof handler !== "function") {
      throw new ConfigurationError("onError requires a function");
    }
    this.#errorHandlers.add(handler);
    void this.#drainErrorsToCallbacks();
    return this;
  }

  public async start(): Promise<void> {
    if (this.#state === "connected") {
      return;
    }
    if (this.#startPromise !== null) {
      return this.#startPromise;
    }
    if (this.#state !== "idle") {
      throw new StreamClosedError(
        `AlertStream cannot start from state ${this.#state}`,
      );
    }
    this.#state = "starting";
    this.#recordLifecycle("starting", null);
    this.#startPromise = new Promise<void>((resolveStart, rejectStart) => {
      this.#resolveStart = resolveStart;
      this.#rejectStart = rejectStart;
    });

    const data: AlertWorkerData = {
      apiKey: this.#apiKey,
      config: this.#config,
      initialResultItemCredits: this.#config.maxResultItems,
      initialResultByteCredits: this.#config.maxResultBytes,
      initialErrorCredits: this.#config.maxErrorItems,
      testOverrides: this.#testOverrides,
    };
    try {
      const worker = new Worker(workerFile(), { workerData: data });
      this.#worker = worker;
      worker.on("message", (message: WorkerToMainMessage) => {
        this.#handleWorkerMessage(message);
      });
      worker.on("error", () => {
        this.#handleWorkerFailure(
          new ConnectionError("The AlertStream worker failed"),
        );
      });
      worker.on("exit", (exitCode) => {
        if (this.#state !== "closing" && this.#state !== "closed") {
          this.#handleWorkerFailure(
            new ConnectionError(
              `The AlertStream worker exited unexpectedly with code ${exitCode}`,
            ),
          );
        }
      });
      this.#postToWorker({ type: "start" });
      this.#armStartTimer(this.#config.connectTimeoutMs);
    } catch (error) {
      this.#state = "failed";
      this.#rejectPendingStart(error);
    }
    return this.#startPromise;
  }

  public async close(): Promise<void> {
    if (this.#closePromise !== null) {
      return this.#closePromise;
    }
    if (this.#state === "closed") {
      return;
    }
    if (this.#worker === null) {
      this.#state = "closed";
      this.#recordLifecycle("closed", null);
      this.#finishIterator();
      return;
    }
    this.#state = "closing";
    this.#recordLifecycle("closing", null);
    if (this.#startTimer !== null) {
      clearTimeout(this.#startTimer);
      this.#startTimer = null;
    }
    if (this.#rejectStart !== null) {
      this.#rejectPendingStart(new StreamClosedError());
    }
    this.#closePromise = new Promise<void>((resolveClose) => {
      this.#resolveClose = resolveClose;
    });
    this.#postToWorker({ type: "close" });

    const worker = this.#worker;
    const fallback = setTimeout(() => {
      void worker.terminate().finally(() => this.#completeClose());
    }, 2_000);
    fallback.unref();
    await this.#closePromise;
    clearTimeout(fallback);
  }

  public stats(): StreamStats {
    const withMainCounters: StreamStats = {
      ...this.#latestStats,
      counters: {
        ...this.#latestStats.counters,
        handlerCalls: this.#handlerCalls,
        handlerFailures: this.#handlerFailures,
      },
    };
    return frozenStats(withMainCounters, this.#state);
  }

  public supportReport(windowSeconds = 600): string {
    if (
      !Number.isFinite(windowSeconds) ||
      windowSeconds <= 0 ||
      windowSeconds > 24 * 60 * 60
    ) {
      throw new ConfigurationError(
        "windowSeconds must be between 0 and 86400",
      );
    }
    return windowSupportReport(
      this.#safeConfig,
      this.stats(),
      this.#diagnostics.values(),
      windowSeconds,
      this.#sessionId,
    );
  }

  /**
   * Removes and returns the oldest retained error. Polling acknowledges its
   * bounded worker credit; with an error callback installed, callbacks consume
   * errors instead.
   */
  public pollError(): AlertStreamError | undefined {
    const queued = this.#errorQueue.shift();
    if (queued === undefined) {
      return undefined;
    }
    this.#ackError(queued.workerErrorId);
    return queued.error;
  }

  public drainErrors(): readonly AlertStreamError[] {
    const errors = this.#errorQueue.splice(0);
    for (const queued of errors) {
      this.#ackError(queued.workerErrorId);
    }
    return Object.freeze(errors.map((queued) => queued.error));
  }

  public [Symbol.asyncIterator](): AsyncIterator<RawArticleEvent> {
    if (this.#consumptionMode === "callback") {
      throw new ConfigurationError(
        "AlertStream callback and AsyncIterable consumption cannot be mixed",
      );
    }
    if (this.#iteratorClaimed) {
      throw new ConfigurationError("AlertStream supports one AsyncIterator consumer");
    }
    this.#consumptionMode = "iterator";
    this.#iteratorClaimed = true;
    return {
      next: () => this.#iteratorNext(),
      return: () => this.#iteratorReturn(),
    };
  }

  async #iteratorNext(): Promise<IteratorResult<RawArticleEvent>> {
    if (this.#iteratorOutstanding !== null) {
      markHandlerCompleted(this.#iteratorOutstanding.event);
      this.#ackResult(this.#iteratorOutstanding);
      this.#iteratorOutstanding = null;
    }
    if (this.#eventQueue.length > 0) {
      const queued = this.#eventQueue.shift() as QueuedResult;
      markHandlerStarted(queued.event, this.stats());
      this.#handlerCalls += 1;
      this.#iteratorOutstanding = queued;
      return { done: false, value: queued.event };
    }
    if (this.#state === "closed" || this.#state === "failed") {
      return { done: true, value: undefined };
    }
    if (this.#pendingIterator !== undefined) {
      throw new ConfigurationError("Concurrent AsyncIterator.next() calls are unsupported");
    }
    return new Promise<IteratorResult<RawArticleEvent>>((resolve, reject) => {
      this.#pendingIterator = { resolve, reject };
    });
  }

  async #iteratorReturn(): Promise<IteratorResult<RawArticleEvent>> {
    if (this.#iteratorOutstanding !== null) {
      markHandlerCompleted(this.#iteratorOutstanding.event);
      this.#ackResult(this.#iteratorOutstanding);
      this.#iteratorOutstanding = null;
    }
    await this.close();
    return { done: true, value: undefined };
  }

  #handleWorkerMessage(message: WorkerToMainMessage): void {
    switch (message.type) {
      case "started":
        if (this.#startTimer !== null) {
          clearTimeout(this.#startTimer);
          this.#startTimer = null;
        }
        this.#state = "connected";
        this.#recordLifecycle("connected", null);
        this.#resolveStart?.();
        this.#resolveStart = null;
        this.#rejectStart = null;
        break;
      case "start-delayed":
        this.#armStartTimer(
          Math.min(
            15 * 60 * 1_000,
            message.retryAfterMs + this.#config.connectTimeoutMs,
          ),
        );
        break;
      case "start-failed": {
        const error = deserializeAlertStreamError(message.error);
        this.#state = "failed";
        this.#recordLifecycle("failed", error.statusCode ?? null);
        this.#rejectPendingStart(error);
        void this.close();
        break;
      }
      case "result":
        this.#acceptWorkerResult(message.result);
        break;
      case "stream-error":
        this.#acceptWorkerError(
          message.errorId,
          deserializeAlertStreamError(message.error),
        );
        break;
      case "stats": {
        const priorState = this.#latestStats.state;
        this.#latestStats = message.stats;
        if (
          this.#state !== "closing" &&
          this.#state !== "closed" &&
          this.#state !== "failed"
        ) {
          this.#state = message.stats.state;
        }
        if (priorState !== message.stats.state) {
          this.#recordLifecycle(message.stats.state, null);
        }
        this.#postToWorker({ type: "ack-stats" });
        break;
      }
      case "closed":
        this.#completeClose();
        break;
    }
  }

  #acceptWorkerResult(result: WorkerResult): void {
    const event = new RawArticleEvent(
      result,
      this.#safeConfig,
      this.#sessionId,
      this.stats(),
    );
    const queued: QueuedResult = {
      deliveryId: result.deliveryId,
      byteLength: event.byteLength,
      event,
    };
    this.#diagnostics.push(eventDiagnosticRecord(event));
    if (
      !this.#latencyWarningEmitted &&
      (event.timing.fetchStartDelayMs >= 5 ||
        event.timing.fetchRoundTripMs >= 500)
    ) {
      this.#latencyWarningEmitted = true;
      console.warn(
        `RTPR latency threshold crossed for articleId=${JSON.stringify(
          safeDiagnosticIdentifier(event.articleId),
        )}; ` +
          "copy diagnostics with event.supportReport()",
      );
    }
    if (
      this.#consumptionMode === "iterator" &&
      this.#pendingIterator !== undefined
    ) {
      const pending = this.#pendingIterator;
      this.#pendingIterator = undefined;
      markHandlerStarted(event, this.stats());
      this.#handlerCalls += 1;
      this.#iteratorOutstanding = queued;
      pending.resolve({ done: false, value: event });
      return;
    }
    this.#eventQueue.push(queued);
    if (this.#consumptionMode === "callback") {
      void this.#drainCallbacks();
    }
  }

  async #drainCallbacks(): Promise<void> {
    if (
      this.#callbackDrainRunning ||
      this.#consumptionMode !== "callback" ||
      this.#eventHandlers.size === 0
    ) {
      return;
    }
    this.#callbackDrainRunning = true;
    try {
      while (this.#eventQueue.length > 0 && this.#state !== "closed") {
        const queued = this.#eventQueue.shift() as QueuedResult;
        markHandlerStarted(queued.event, this.stats());
        this.#handlerCalls += this.#eventHandlers.size;
        const outcomes = await Promise.allSettled(
          [...this.#eventHandlers].map((handler) =>
            Promise.resolve().then(() => handler(queued.event)),
          ),
        );
        markHandlerCompleted(queued.event);
        for (const outcome of outcomes) {
          if (outcome.status === "rejected") {
            this.#handlerFailures += 1;
            this.#acceptLocalError(new HandlerError(undefined, outcome.reason));
          }
        }
        this.#ackResult(queued);
      }
    } finally {
      this.#callbackDrainRunning = false;
    }
  }

  #acceptWorkerError(workerErrorId: number, error: AlertStreamError): void {
    this.#lastError = error;
    this.#diagnostics.push({
      kind: "error",
      atEpochMs: Date.now(),
      code: error.code,
      statusCode: error.statusCode ?? null,
      articleId: error.articleId ?? null,
      reason: error.reason ?? null,
    });
    if (this.#errorQueue.length >= this.#config.maxErrorItems) {
      const displaced = this.#errorQueue.shift();
      if (displaced !== undefined) {
        this.#ackError(displaced.workerErrorId);
      }
    }
    this.#errorQueue.push({ workerErrorId, error });
    if (this.#errorHandlers.size > 0) {
      void this.#drainErrorsToCallbacks();
    }
  }

  #acceptLocalError(error: AlertStreamError): void {
    this.#lastError = error;
    this.#diagnostics.push({
      kind: "error",
      atEpochMs: Date.now(),
      code: error.code,
      statusCode: error.statusCode ?? null,
      articleId: error.articleId ?? null,
      reason: error.reason ?? null,
    });
    if (this.#errorQueue.length >= this.#config.maxErrorItems) {
      const displaced = this.#errorQueue.shift();
      if (displaced !== undefined) {
        this.#ackError(displaced.workerErrorId);
      }
    }
    this.#errorQueue.push({ workerErrorId: null, error });
    if (this.#errorHandlers.size > 0) {
      void this.#drainErrorsToCallbacks();
    }
  }

  async #drainErrorsToCallbacks(): Promise<void> {
    if (this.#errorDrainRunning || this.#errorHandlers.size === 0) {
      return;
    }
    this.#errorDrainRunning = true;
    try {
      while (this.#errorQueue.length > 0 && this.#errorHandlers.size > 0) {
        const queued = this.#errorQueue.shift() as QueuedError;
        await Promise.allSettled(
          [...this.#errorHandlers].map((handler) =>
            Promise.resolve().then(() => handler(queued.error)),
          ),
        );
        this.#ackError(queued.workerErrorId);
      }
    } finally {
      this.#errorDrainRunning = false;
    }
  }

  #ackResult(queued: QueuedResult): void {
    this.#postToWorker({
      type: "ack-result",
      deliveryId: queued.deliveryId,
      byteLength: queued.byteLength,
    });
  }

  #ackError(workerErrorId: number | null): void {
    if (workerErrorId !== null) {
      this.#postToWorker({ type: "ack-error", errorId: workerErrorId });
    }
  }

  #postToWorker(message: MainToWorkerMessage): void {
    this.#worker?.postMessage(message);
  }

  #armStartTimer(delayMs: number): void {
    if (this.#startTimer !== null) {
      clearTimeout(this.#startTimer);
    }
    this.#startTimer = setTimeout(() => {
      const error = new ConnectionError(
        "The RTPR WebSocket handshake did not complete before the connection deadline",
      );
      this.#handleWorkerFailure(error);
      void this.close();
    }, delayMs);
    this.#startTimer.unref();
  }

  #handleWorkerFailure(error: AlertStreamError): void {
    if (this.#state === "closing" || this.#state === "closed") {
      return;
    }
    this.#state = "failed";
    this.#acceptLocalError(error);
    this.#rejectPendingStart(error);
    this.#finishIterator(error);
  }

  #rejectPendingStart(error: unknown): void {
    if (this.#startTimer !== null) {
      clearTimeout(this.#startTimer);
      this.#startTimer = null;
    }
    this.#rejectStart?.(error);
    this.#resolveStart = null;
    this.#rejectStart = null;
  }

  #completeClose(): void {
    if (this.#state === "closed") {
      return;
    }
    this.#state = "closed";
    this.#worker = null;
    this.#eventQueue.length = 0;
    this.#recordLifecycle("closed", null);
    this.#finishIterator();
    this.#resolveClose?.();
    this.#resolveClose = null;
  }

  #finishIterator(error?: unknown): void {
    if (this.#pendingIterator === undefined) {
      return;
    }
    const pending = this.#pendingIterator;
    this.#pendingIterator = undefined;
    if (error === undefined) {
      pending.resolve({ done: true, value: undefined });
    } else {
      pending.reject(error);
    }
  }

  #recordLifecycle(state: string, statusCode: number | null): void {
    this.#diagnostics.push({
      kind: "lifecycle",
      atEpochMs: Date.now(),
      state,
      statusCode,
    });
  }
}
