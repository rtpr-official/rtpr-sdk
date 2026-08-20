import type { AlertStreamError } from "./errors";
import type { RawArticleEvent } from "./events";

export const SDK_NAME = "@rtpr-io/rtpr";
export const SDK_VERSION = "0.2.0";
export const SUPPORT_SCHEMA = "RTPR_SUPPORT_DIAGNOSTIC_V1";

export const DIAGNOSTIC_HEADER_NAMES = Object.freeze([
  "cf-ray",
  "cf-cache-status",
  "age",
  "content-type",
  "x-rtpr-auth-mode",
  "x-rtpr-origin-ms",
  "x-rtpr-storage-tier",
  "server-timing",
] as const);

export type DiagnosticHeaderName = (typeof DIAGNOSTIC_HEADER_NAMES)[number];
export type DiagnosticHeaders = Readonly<Partial<Record<DiagnosticHeaderName, string>>>;

export interface AlertStreamOptions {
  /** Concurrent warm HTTP connections and article fetches. Default: 8. */
  readonly fetchConcurrency?: number;
  /** Maximum queued plus active article fetches. Default: 256. */
  readonly maxPendingFetches?: number;
  /** Maximum delivered/queued raw results awaiting customer acknowledgement. Default: 32. */
  readonly maxResultItems?: number;
  /** Maximum raw result bytes awaiting customer acknowledgement. Default: 32 MiB. */
  readonly maxResultBytes?: number;
  /** Maximum size of one raw article. Default: 16 MiB. */
  readonly maxArticleBytes?: number;
  /** Maximum errors retained for polling or callback delivery. Default: 64. */
  readonly maxErrorItems?: number;
  /** Successful article-ID dedupe lifetime. Default: 5 minutes. */
  readonly dedupeTtlMs?: number;
  /** Maximum successful article IDs retained for dedupe. Default: 10,000. */
  readonly dedupeMaxEntries?: number;
  /** Total deadline across all attempts for one article. Default: 15 seconds. */
  readonly fetchDeadlineMs?: number;
  /** Maximum article GET attempts within the deadline. Default: 4. */
  readonly fetchMaxAttempts?: number;
  /** Initial fetch retry backoff. Default: 75 ms. */
  readonly fetchRetryBaseMs?: number;
  /** Maximum fetch retry backoff. Default: 1 second. */
  readonly fetchRetryMaxMs?: number;
  /** Initial WebSocket reconnect backoff. Default: 250 ms. */
  readonly reconnectBaseMs?: number;
  /** Maximum WebSocket reconnect backoff. Default: 30 seconds. */
  readonly reconnectMaxMs?: number;
  /** Worker keepalive HEAD interval. Default: 30 seconds. */
  readonly keepaliveIntervalMs?: number;
  /** Maximum time for the initial WebSocket handshake. Default: 15 seconds. */
  readonly connectTimeoutMs?: number;
  /** Fixed diagnostic metadata history. Default: 512 records. */
  readonly diagnosticRingSize?: number;
}

export type AlertEventHandler = (
  event: RawArticleEvent,
) => void | Promise<void>;

export type AlertErrorHandler = (
  error: AlertStreamError,
) => void | Promise<void>;

export type AlertStreamState =
  | "idle"
  | "starting"
  | "connected"
  | "reconnecting"
  | "closing"
  | "closed"
  | "failed";

export interface EventTiming {
  readonly fetchStartDelayMs: number;
  readonly timeToHeadersMs: number;
  readonly bodyReadMs: number;
  readonly fetchRoundTripMs: number;
  readonly resultQueueLagMs: number;
  readonly handlerStartLagMs: number | null;
  readonly handlerDurationMs: number | null;
}

export interface EventMilestones {
  readonly alertReceivedAtUtc: string;
  readonly fetchStartedAtUtc: string;
  readonly headersReceivedAtUtc: string;
  readonly bodyCompletedAtUtc: string;
  readonly deliveredAtUtc: string;
  readonly handlerStartedAtUtc: string | null;
  readonly handlerCompletedAtUtc: string | null;
}

export interface WallClockEstimates {
  readonly label: "wall-clock estimates; RTPR and customer clocks may differ";
  readonly publishToDispatchMs: number | null;
  readonly dispatchToReceiveMs: number | null;
}

export interface EventBurstSnapshot {
  readonly fetchQueueDepth: number;
  readonly resultQueueItems: number;
  readonly resultQueueBytes: number;
  readonly activeFetches: number;
  readonly configuredConcurrency: number;
  readonly workerLoopLagMs: number;
  readonly reconnectCount: number;
  readonly lastPingAgeMs: number | null;
  readonly retryCount: number;
  readonly overloadCount: number;
}

export type EventBurstState = Readonly<
  Record<string, Readonly<EventBurstSnapshot>>
>;

export interface KeepaliveStats {
  readonly healthy: boolean;
  readonly active: boolean;
  readonly attempts: number;
  readonly successes: number;
  readonly failures: number;
  readonly lastStatusCode: number | null;
  readonly lastCheckedAtUtc: string | null;
  readonly lastHealthyAtUtc: string | null;
  readonly headerPresent: boolean;
}

export interface StreamCounters {
  readonly connectionAttempts: number;
  readonly reconnects: number;
  readonly framesReceived: number;
  readonly alertsReceived: number;
  readonly pingsReceived: number;
  readonly pongsSent: number;
  readonly protocolErrors: number;
  readonly duplicateFrames: number;
  readonly duplicateRuleNamesMerged: number;
  readonly fetchesStarted: number;
  readonly fetchesSucceeded: number;
  readonly fetchesFailed: number;
  readonly fetchRetries: number;
  readonly fetchNetworkRetries: number;
  readonly fetch5xxRetries: number;
  readonly fetch404Retries: number;
  readonly redirectsRejected: number;
  readonly overloads: number;
  readonly pendingFetchOverloads: number;
  readonly resultItemOverloads: number;
  readonly resultByteOverloads: number;
  readonly articleSizeOverloads: number;
  readonly resultsDelivered: number;
  readonly resultsAcknowledged: number;
  readonly bytesFetched: number;
  readonly bytesDelivered: number;
  readonly errorsEmitted: number;
  readonly errorsSuppressed: number;
  readonly handlerCalls: number;
  readonly handlerFailures: number;
}

export interface QueueStats {
  readonly activeFetches: number;
  readonly pendingFetches: number;
  readonly pendingFetchesHighWater: number;
  readonly bufferedResultItems: number;
  readonly bufferedResultBytes: number;
  readonly bufferedResultItemsHighWater: number;
  readonly bufferedResultBytesHighWater: number;
  readonly workerResultQueueItems: number;
  readonly workerResultQueueBytes: number;
  readonly inFlightResultItems: number;
  readonly inFlightResultBytes: number;
  readonly bufferedErrors: number;
  readonly bufferedErrorsHighWater: number;
}

export interface WorkerHealthStats {
  readonly loopLagMs: number;
  readonly loopLagMaxMs: number;
  readonly lastPingAtUtc: string | null;
}

export interface StreamStats {
  readonly state: AlertStreamState;
  readonly generatedAtUtc: string;
  readonly counters: Readonly<StreamCounters>;
  readonly queues: Readonly<QueueStats>;
  readonly worker: Readonly<WorkerHealthStats>;
  readonly keepalive: Readonly<KeepaliveStats>;
}

export interface DurationPercentiles {
  readonly count: number;
  readonly p50: number | null;
  readonly p95: number | null;
  readonly p99: number | null;
  readonly max: number | null;
}

export interface SanitizedSdkEnvironment {
  readonly sdk: {
    readonly name: typeof SDK_NAME;
    readonly version: typeof SDK_VERSION;
  };
  readonly runtime: {
    readonly name: "node";
    readonly version: string;
  };
  readonly os: {
    readonly family: NodeJS.Platform;
    readonly arch: string;
  };
}

export interface SanitizedStreamConfig {
  readonly fetchConcurrency: number;
  readonly maxPendingFetches: number;
  readonly maxResultItems: number;
  readonly maxResultBytes: number;
  readonly maxArticleBytes: number;
  readonly maxErrorItems: number;
  readonly dedupeTtlMs: number;
  readonly dedupeMaxEntries: number;
  readonly fetchDeadlineMs: number;
  readonly fetchMaxAttempts: number;
  readonly reconnectBaseMs: number;
  readonly reconnectMaxMs: number;
  readonly keepaliveIntervalMs: number;
}
