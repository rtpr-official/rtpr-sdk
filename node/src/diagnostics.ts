import { createHash } from "node:crypto";
import {
  SDK_NAME,
  SDK_VERSION,
  SUPPORT_SCHEMA,
  type DiagnosticHeaders,
  type DurationPercentiles,
  type EventBurstState,
  type EventMilestones,
  type EventTiming,
  type SanitizedSdkEnvironment,
  type SanitizedStreamConfig,
  type StreamStats,
  type KeepaliveStats,
  type WallClockEstimates,
} from "./types";

export function safeDiagnosticIdentifier(value: string): string {
  if (/^[A-Za-z0-9_.:@-]{1,96}$/u.test(value)) {
    return value;
  }
  return `redacted-id-${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

export interface EventDiagnosticRecord {
  readonly kind: "event";
  readonly atEpochMs: number;
  readonly articleId: string;
  readonly ticker: string;
  readonly dispatchedAtMs: number;
  readonly articlePath: string;
  readonly sessionId: string;
  readonly statusCode: number;
  readonly byteLength: number;
  readonly attempts: number;
  readonly headers: DiagnosticHeaders;
  readonly attemptReasons: readonly string[];
  readonly timing: EventTiming;
  readonly milestones: EventMilestones;
  readonly wallClockEstimates: WallClockEstimates;
  readonly burstState: EventBurstState;
  readonly keepalive: KeepaliveStats;
}

export interface ErrorDiagnosticRecord {
  readonly kind: "error";
  readonly atEpochMs: number;
  readonly code: string;
  readonly statusCode: number | null;
  readonly articleId: string | null;
  readonly reason: string | null;
}

export interface LifecycleDiagnosticRecord {
  readonly kind: "lifecycle";
  readonly atEpochMs: number;
  readonly state: string;
  readonly statusCode: number | null;
}

export type DiagnosticRecord =
  | EventDiagnosticRecord
  | ErrorDiagnosticRecord
  | LifecycleDiagnosticRecord;

export class FixedRing<T> {
  readonly #values: Array<T | undefined>;
  #next = 0;
  #length = 0;

  constructor(capacity: number) {
    this.#values = new Array<T | undefined>(capacity);
  }

  push(value: T): void {
    this.#values[this.#next] = value;
    this.#next = (this.#next + 1) % this.#values.length;
    this.#length = Math.min(this.#length + 1, this.#values.length);
  }

  values(): readonly T[] {
    const result: T[] = [];
    const first = (this.#next - this.#length + this.#values.length) % this.#values.length;
    for (let index = 0; index < this.#length; index += 1) {
      const value = this.#values[(first + index) % this.#values.length];
      if (value !== undefined) {
        result.push(value);
      }
    }
    return result;
  }
}

export function sdkEnvironment(): SanitizedSdkEnvironment {
  return Object.freeze({
    sdk: Object.freeze({ name: SDK_NAME, version: SDK_VERSION }),
    runtime: Object.freeze({ name: "node", version: process.versions.node }),
    os: Object.freeze({ family: process.platform, arch: process.arch }),
  });
}

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function durationPercentiles(
  input: readonly number[],
): DurationPercentiles {
  const values = input.filter(Number.isFinite).sort((left, right) => left - right);
  if (values.length === 0) {
    return Object.freeze({ count: 0, p50: null, p95: null, p99: null, max: null });
  }
  const percentile = (fraction: number): number => {
    const rank = Math.max(0, Math.ceil(fraction * values.length) - 1);
    return rounded(values[rank]);
  };
  return Object.freeze({
    count: values.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: rounded(values[values.length - 1]),
  });
}

/**
 * Defensive final-pass redaction for diagnostic strings. Reports never ingest
 * API keys, bodies, rules, or article URLs in the first place; this removes
 * accidental URLs, network addresses, hostnames, and query-like credentials
 * from allowlisted response-header values.
 */
export function redactDiagnosticText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'<>]+/giu, "[REDACTED_URL]")
    .replace(
      /\b(?:api[-_]?key|token|authorization|signature|sig)=[^&\s;,]+/giu,
      "[REDACTED_CREDENTIAL]",
    )
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu, "[REDACTED_IP]")
    .replace(/\b(?:[a-f0-9]{1,4}:){2,7}[a-f0-9]{1,4}\b/giu, "[REDACTED_IP]")
    .replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|cloud|local)\b/giu, "[REDACTED_HOST]");
}

export function sanitizeHeadersForReport(
  headers: DiagnosticHeaders,
): DiagnosticHeaders {
  const sanitized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) {
      sanitized[name] = redactDiagnosticText(value).slice(0, 512);
    }
  }
  return Object.freeze(sanitized) as DiagnosticHeaders;
}

function supportText(humanSummary: string, payload: object): string {
  return `${humanSummary}\n${SUPPORT_SCHEMA} ${JSON.stringify(payload)}`;
}

export function eventSupportReport(
  config: SanitizedStreamConfig,
  record: EventDiagnosticRecord,
): string {
  const articleId = safeDiagnosticIdentifier(record.articleId);
  const ticker = safeDiagnosticIdentifier(record.ticker);
  const diagnosticHeaders = sanitizeHeadersForReport(record.headers);
  const payload = {
    schema: SUPPORT_SCHEMA,
    scope: "event",
    generatedAtUtc: new Date().toISOString(),
    sdkSessionId: record.sessionId,
    environment: sdkEnvironment(),
    config,
    event: {
      articleId,
      statusCode: record.statusCode,
      byteLength: record.byteLength,
      attempts: record.attempts,
      attemptReasons: record.attemptReasons,
      diagnosticHeaders,
      timing: record.timing,
      milestones: record.milestones,
      wallClockEstimates: record.wallClockEstimates,
      correlation: {
        sdkSessionId: record.sessionId,
        articleId,
        ticker,
        dispatchedAtMs: record.dispatchedAtMs,
        articlePath: redactDiagnosticText(record.articlePath),
        cfRay: diagnosticHeaders["cf-ray"] ?? null,
      },
      http: {
        attemptCount: record.attempts,
        attemptReasons: record.attemptReasons,
        finalStatus: record.statusCode,
        responseByteCount: record.byteLength,
        contentType: diagnosticHeaders["content-type"] ?? null,
        cfCacheStatus: diagnosticHeaders["cf-cache-status"] ?? null,
        age: diagnosticHeaders.age ?? null,
        authMode: diagnosticHeaders["x-rtpr-auth-mode"] ?? null,
        originMs: diagnosticHeaders["x-rtpr-origin-ms"] ?? null,
        storageTier: diagnosticHeaders["x-rtpr-storage-tier"] ?? null,
        serverTiming: diagnosticHeaders["server-timing"] ?? null,
        redirectFollowed: false,
      },
      burstState: record.burstState,
      keepalive: record.keepalive,
    },
  };
  const summary =
    `RTPR event diagnostic: article ${articleId}, ${record.byteLength} raw bytes, ` +
    `${rounded(record.timing.fetchRoundTripMs)} ms fetch round trip.`;
  return supportText(summary, payload);
}

const TIMING_KEYS = [
  "fetchStartDelayMs",
  "timeToHeadersMs",
  "bodyReadMs",
  "fetchRoundTripMs",
  "resultQueueLagMs",
  "handlerStartLagMs",
  "handlerDurationMs",
] as const;

export function windowSupportReport(
  config: SanitizedStreamConfig,
  stats: StreamStats,
  records: readonly DiagnosticRecord[],
  windowSeconds: number,
  sessionId: string,
): string {
  const now = Date.now();
  const fromEpochMs = now - windowSeconds * 1000;
  const selected = records.filter((record) => record.atEpochMs >= fromEpochMs);
  const events = selected.filter(
    (record): record is EventDiagnosticRecord => record.kind === "event",
  );
  const errors = selected.filter(
    (record): record is ErrorDiagnosticRecord => record.kind === "error",
  );

  const durations: Record<string, DurationPercentiles> = {};
  for (const key of TIMING_KEYS) {
    durations[key] = durationPercentiles(
      events.flatMap((record) => {
        const value = record.timing[key];
        return value === null ? [] : [value];
      }),
    );
  }

  const slowArticleIds = [...events]
    .sort((left, right) => {
      const leftScore = Math.max(
        left.timing.fetchRoundTripMs,
        left.timing.resultQueueLagMs,
        left.timing.handlerStartLagMs ?? 0,
        left.timing.handlerDurationMs ?? 0,
      );
      const rightScore = Math.max(
        right.timing.fetchRoundTripMs,
        right.timing.resultQueueLagMs,
        right.timing.handlerStartLagMs ?? 0,
        right.timing.handlerDurationMs ?? 0,
      );
      return rightScore - leftScore;
    })
    .map((record) => safeDiagnosticIdentifier(record.articleId))
    .filter((articleId, index, all) => all.indexOf(articleId) === index)
    .slice(0, 10);

  const errorCounts: Record<string, number> = {};
  for (const error of errors) {
    errorCounts[error.code] = (errorCounts[error.code] ?? 0) + 1;
  }
  const internalValues = events.flatMap((record) =>
    record.wallClockEstimates.publishToDispatchMs === null
      ? []
      : [record.wallClockEstimates.publishToDispatchMs],
  );
  const transitValues = events.flatMap((record) =>
    record.wallClockEstimates.dispatchToReceiveMs === null
      ? []
      : [record.wallClockEstimates.dispatchToReceiveMs],
  );
  const arrivalValues = events.flatMap((record) => {
    const internal = record.wallClockEstimates.publishToDispatchMs;
    const transit = record.wallClockEstimates.dispatchToReceiveMs;
    return internal === null || transit === null ? [] : [internal + transit];
  });

  const payload = {
    schema: SUPPORT_SCHEMA,
    scope: "window",
    generatedAtUtc: new Date(now).toISOString(),
    sdkSessionId: sessionId,
    window: {
      seconds: windowSeconds,
      fromUtc: new Date(fromEpochMs).toISOString(),
      toUtc: new Date(now).toISOString(),
    },
    environment: sdkEnvironment(),
    config,
    stats,
    sample: {
      events: events.length,
      errors: errors.length,
      failures: stats.counters.fetchesFailed,
      retries: stats.counters.fetchRetries,
      overloads: stats.counters.overloads,
      errorCounts,
      durations,
      slowArticleIds,
    },
    queueHighWater: {
      pendingFetches: stats.queues.pendingFetchesHighWater,
      resultItems: stats.queues.bufferedResultItemsHighWater,
      resultBytes: stats.queues.bufferedResultBytesHighWater,
    },
    canaryBreakdownMs: {
      warning:
        "arrival/internal/transit use wall clocks that may differ; " +
        "fetch and SDK queue durations are monotonic",
      arrival: durationPercentiles(arrivalValues),
      internal: durationPercentiles(internalValues),
      transit: durationPercentiles(transitValues),
      fetch: durations.fetchRoundTripMs,
      fetchStartDelay: durations.fetchStartDelayMs,
      resultQueueLag: durations.resultQueueLagMs,
      handlerStartLag: durations.handlerStartLagMs,
    },
  };
  const summary =
    `RTPR stream diagnostic: ${events.length} events and ${errors.length} errors ` +
    `in the last ${windowSeconds} seconds; state ${stats.state}.`;
  return supportText(summary, payload);
}
