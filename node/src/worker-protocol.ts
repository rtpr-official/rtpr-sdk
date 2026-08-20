import type { ParsedAlertFrame } from "./protocol";
import type { SerializedAlertStreamError } from "./errors";
import type {
  DiagnosticHeaders,
  EventBurstState,
  EventMilestones,
  EventTiming,
  SanitizedStreamConfig,
  StreamStats,
  WallClockEstimates,
} from "./types";

export interface ResolvedAlertStreamConfig extends SanitizedStreamConfig {
  readonly fetchRetryBaseMs: number;
  readonly fetchRetryMaxMs: number;
  readonly connectTimeoutMs: number;
  readonly diagnosticRingSize: number;
}

export interface WorkerTestOverrides {
  readonly websocketUrl?: string;
  readonly keepaliveUrl?: string;
  readonly allowInsecureArticleUrls?: boolean;
  readonly fixedJitter?: number;
}

export interface AlertWorkerData {
  readonly apiKey: string;
  readonly config: ResolvedAlertStreamConfig;
  readonly initialResultItemCredits: number;
  readonly initialResultByteCredits: number;
  readonly initialErrorCredits: number;
  readonly testOverrides?: WorkerTestOverrides;
}

export interface WorkerResultTiming
  extends Omit<
    EventTiming,
    "resultQueueLagMs" | "handlerStartLagMs" | "handlerDurationMs"
  > {
  readonly bodyCompletedMonoMs: number;
}

export interface WorkerResult {
  readonly deliveryId: number;
  readonly alert: ParsedAlertFrame;
  readonly raw: ArrayBuffer;
  readonly statusCode: number;
  readonly attempts: number;
  readonly attemptReasons: readonly string[];
  readonly diagnosticHeaders: DiagnosticHeaders;
  readonly timing: WorkerResultTiming;
  readonly milestones: Omit<
    EventMilestones,
    "deliveredAtUtc" | "handlerStartedAtUtc" | "handlerCompletedAtUtc"
  >;
  readonly wallClockEstimates: WallClockEstimates;
  readonly burstState: EventBurstState;
  readonly postedAtMonoMs: number;
  readonly postedAtUtc: string;
}

export type MainToWorkerMessage =
  | { readonly type: "start" }
  | { readonly type: "close" }
  | {
      readonly type: "ack-result";
      readonly deliveryId: number;
      readonly byteLength: number;
    }
  | { readonly type: "ack-error"; readonly errorId: number }
  | { readonly type: "ack-stats" };

export type WorkerToMainMessage =
  | { readonly type: "started" }
  | { readonly type: "start-delayed"; readonly retryAfterMs: number }
  | {
      readonly type: "start-failed";
      readonly error: SerializedAlertStreamError;
    }
  | { readonly type: "result"; readonly result: WorkerResult }
  | {
      readonly type: "stream-error";
      readonly errorId: number;
      readonly error: SerializedAlertStreamError;
    }
  | { readonly type: "stats"; readonly stats: StreamStats }
  | { readonly type: "closed" };
