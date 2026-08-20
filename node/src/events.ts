import { performance } from "node:perf_hooks";
import type { ParsedAlertFrame } from "./protocol";
import {
  eventSupportReport,
  type EventDiagnosticRecord,
} from "./diagnostics";
import type {
  DiagnosticHeaders,
  EventBurstSnapshot,
  EventBurstState,
  EventMilestones,
  EventTiming,
  KeepaliveStats,
  SanitizedStreamConfig,
  StreamStats,
  WallClockEstimates,
} from "./types";
import type { WorkerResult } from "./worker-protocol";

interface MutableEventState {
  readonly config: SanitizedStreamConfig;
  readonly sessionId: string;
  readonly atEpochMs: number;
  readonly deliveredMonoMs: number;
  readonly timing: {
    fetchStartDelayMs: number;
    timeToHeadersMs: number;
    bodyReadMs: number;
    fetchRoundTripMs: number;
    resultQueueLagMs: number;
    handlerStartLagMs: number | null;
    handlerDurationMs: number | null;
  };
  readonly milestones: {
    alertReceivedAtUtc: string;
    fetchStartedAtUtc: string;
    headersReceivedAtUtc: string;
    bodyCompletedAtUtc: string;
    deliveredAtUtc: string;
    handlerStartedAtUtc: string | null;
    handlerCompletedAtUtc: string | null;
  };
  handlerStartedMonoMs: number | null;
  readonly attemptReasons: readonly string[];
  readonly burstState: Record<string, Readonly<EventBurstSnapshot>>;
  readonly keepalive: KeepaliveStats;
}

const eventState = new WeakMap<RawArticleEvent, MutableEventState>();

function frozenTiming(state: MutableEventState): EventTiming {
  return Object.freeze({ ...state.timing });
}

function frozenMilestones(state: MutableEventState): EventMilestones {
  return Object.freeze({ ...state.milestones });
}

function burstSnapshot(
  stats: StreamStats,
  config: SanitizedStreamConfig,
): EventBurstSnapshot {
  const lastPingEpochMs =
    stats.worker.lastPingAtUtc === null
      ? Number.NaN
      : Date.parse(stats.worker.lastPingAtUtc);
  return Object.freeze({
    fetchQueueDepth: stats.queues.pendingFetches,
    resultQueueItems: stats.queues.bufferedResultItems,
    resultQueueBytes: stats.queues.bufferedResultBytes,
    activeFetches: stats.queues.activeFetches,
    configuredConcurrency: config.fetchConcurrency,
    workerLoopLagMs: stats.worker.loopLagMs,
    reconnectCount: stats.counters.reconnects,
    lastPingAgeMs: Number.isFinite(lastPingEpochMs)
      ? Math.max(0, Date.now() - lastPingEpochMs)
      : null,
    retryCount: stats.counters.fetchRetries,
    overloadCount: stats.counters.overloads,
  });
}

export class AlertEvent {
  public readonly articleId: string;
  public readonly ticker: string;
  public readonly ruleNames: readonly string[];
  public readonly rules: readonly Readonly<{ ruleName: string }>[];
  public readonly articlePublishedAt: string;
  public readonly articleUrl: string;
  public readonly dispatchedAtMs: number;
  public readonly receivedAtUtc: string;

  protected constructor(alert: ParsedAlertFrame, receivedAtUtc: string) {
    this.articleId = alert.articleId;
    this.ticker = alert.ticker;
    this.ruleNames = Object.freeze([...alert.ruleNames]);
    this.rules = Object.freeze(
      alert.ruleNames.map((ruleName) => Object.freeze({ ruleName })),
    );
    this.articlePublishedAt = alert.articlePublishedAt;
    this.articleUrl = alert.articleUrl;
    Object.defineProperty(this, "articleUrl", { enumerable: false });
    this.dispatchedAtMs = alert.dispatchedAtMs;
    this.receivedAtUtc = receivedAtUtc;
  }
}

/**
 * A saved-rule alert plus the exact bytes returned by its signed article URL.
 *
 * The event and all metadata containers are frozen. `raw` is a Node.js Buffer
 * backed directly by the ArrayBuffer transferred from the fetch worker. As with
 * every Buffer, callers can mutate bytes they own; the SDK never parses,
 * normalizes, or persists them.
 */
export class RawArticleEvent extends AlertEvent {
  public readonly raw: Buffer;
  public readonly byteLength: number;
  public readonly statusCode: number;
  public readonly contentType: string | null;
  public readonly fetchAttempts: number;
  public readonly diagnosticHeaders: DiagnosticHeaders;
  public readonly wallClockEstimates: WallClockEstimates;

  public get timing(): EventTiming {
    const state = eventState.get(this);
    if (state === undefined) {
      throw new Error("RawArticleEvent timing state is unavailable");
    }
    return frozenTiming(state);
  }

  public get milestones(): EventMilestones {
    const state = eventState.get(this);
    if (state === undefined) {
      throw new Error("RawArticleEvent milestone state is unavailable");
    }
    return frozenMilestones(state);
  }

  /** Returns a copy-ready, redacted diagnostic report containing no body or URL. */
  public supportReport(): string {
    const state = eventState.get(this);
    if (state === undefined) {
      throw new Error("RawArticleEvent diagnostic state is unavailable");
    }
    return eventSupportReport(state.config, eventDiagnosticRecord(this));
  }

  /** @internal Constructed only by AlertStream from a transferred worker result. */
  public constructor(
    result: WorkerResult,
    config: SanitizedStreamConfig,
    sessionId: string,
    deliveredStats: StreamStats,
  ) {
    super(result.alert, result.milestones.alertReceivedAtUtc);
    const deliveredMonoMs = performance.now();
    this.raw = Buffer.from(result.raw);
    Object.defineProperty(this, "raw", { enumerable: false });
    this.byteLength = this.raw.byteLength;
    this.statusCode = result.statusCode;
    this.contentType = result.diagnosticHeaders["content-type"] ?? null;
    this.fetchAttempts = result.attempts;
    this.diagnosticHeaders = Object.freeze({ ...result.diagnosticHeaders });
    this.wallClockEstimates = Object.freeze({ ...result.wallClockEstimates });

    eventState.set(this, {
      config,
      sessionId,
      atEpochMs: Date.now(),
      deliveredMonoMs,
      timing: {
        fetchStartDelayMs: result.timing.fetchStartDelayMs,
        timeToHeadersMs: result.timing.timeToHeadersMs,
        bodyReadMs: result.timing.bodyReadMs,
        fetchRoundTripMs: result.timing.fetchRoundTripMs,
        resultQueueLagMs: Math.max(
          0,
          deliveredMonoMs - result.timing.bodyCompletedMonoMs,
        ),
        handlerStartLagMs: null,
        handlerDurationMs: null,
      },
      milestones: {
        ...result.milestones,
        deliveredAtUtc: new Date().toISOString(),
        handlerStartedAtUtc: null,
        handlerCompletedAtUtc: null,
      },
      handlerStartedMonoMs: null,
      attemptReasons: Object.freeze([...result.attemptReasons]),
      burstState: {
        ...result.burstState,
        mainDelivered: burstSnapshot(deliveredStats, config),
      },
      keepalive: Object.freeze({ ...deliveredStats.keepalive }),
    });
    Object.freeze(this);
  }
}

/** @internal */
export function markHandlerStarted(
  event: RawArticleEvent,
  stats: StreamStats,
): void {
  const state = eventState.get(event);
  if (state === undefined || state.handlerStartedMonoMs !== null) {
    return;
  }
  const nowMonoMs = performance.now();
  state.handlerStartedMonoMs = nowMonoMs;
  state.timing.handlerStartLagMs = Math.max(0, nowMonoMs - state.deliveredMonoMs);
  state.milestones.handlerStartedAtUtc = new Date().toISOString();
  state.burstState.handlerStarted = burstSnapshot(stats, state.config);
}

/** @internal */
export function markHandlerCompleted(event: RawArticleEvent): void {
  const state = eventState.get(event);
  if (state === undefined || state.handlerStartedMonoMs === null) {
    return;
  }
  state.timing.handlerDurationMs = Math.max(
    0,
    performance.now() - state.handlerStartedMonoMs,
  );
  state.milestones.handlerCompletedAtUtc = new Date().toISOString();
}

/** @internal */
export function eventDiagnosticRecord(
  event: RawArticleEvent,
): EventDiagnosticRecord {
  const state = eventState.get(event);
  if (state === undefined) {
    throw new Error("RawArticleEvent diagnostic state is unavailable");
  }
  return {
    kind: "event",
    atEpochMs: state.atEpochMs,
    articleId: event.articleId,
    ticker: event.ticker,
    dispatchedAtMs: event.dispatchedAtMs,
    articlePath: new URL(event.articleUrl).pathname,
    sessionId: state.sessionId,
    statusCode: event.statusCode,
    byteLength: event.byteLength,
    attempts: event.fetchAttempts,
    headers: event.diagnosticHeaders,
    attemptReasons: state.attemptReasons,
    get timing(): EventTiming {
      return frozenTiming(state);
    },
    get milestones(): EventMilestones {
      return frozenMilestones(state);
    },
    wallClockEstimates: event.wallClockEstimates,
    get burstState(): EventBurstState {
      return Object.freeze({ ...state.burstState });
    },
    keepalive: state.keepalive,
  };
}
