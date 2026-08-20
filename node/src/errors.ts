export type AlertStreamErrorCode =
  | "AUTHENTICATION"
  | "AUTHORIZATION"
  | "RATE_LIMIT"
  | "CONNECTION"
  | "PROTOCOL"
  | "FETCH"
  | "REDIRECT_REJECTED"
  | "BACKPRESSURE"
  | "HANDLER"
  | "CONFIGURATION"
  | "STREAM_CLOSED";

export interface SerializedAlertStreamError {
  readonly code: AlertStreamErrorCode;
  readonly message: string;
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly articleId?: string;
  readonly articleUrl?: string;
  readonly reason?: string;
  readonly retryable?: boolean;
}

export interface AlertStreamErrorOptions {
  readonly statusCode?: number;
  readonly retryAfterMs?: number;
  readonly articleId?: string;
  readonly articleUrl?: string;
  readonly reason?: string;
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

/**
 * Base class for errors surfaced by {@link AlertStream}.
 *
 * Error messages are deliberately URL-free. Where an article could not be
 * accepted, `articleUrl` is exposed as a separate field so callers can refetch
 * it without accidentally writing a signed URL to ordinary logs.
 */
export class AlertStreamError extends Error {
  public readonly code: AlertStreamErrorCode;
  public readonly statusCode: number | undefined;
  public readonly retryAfterMs: number | undefined;
  public readonly articleId: string | undefined;
  public readonly articleUrl: string | undefined;
  public readonly reason: string | undefined;
  public readonly retryable: boolean;

  constructor(
    code: AlertStreamErrorCode,
    message: string,
    options: AlertStreamErrorOptions = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AlertStreamError";
    this.code = code;
    this.statusCode = options.statusCode;
    this.retryAfterMs = options.retryAfterMs;
    this.articleId = options.articleId;
    this.articleUrl = options.articleUrl;
    Object.defineProperty(this, "articleUrl", { enumerable: false });
    this.reason = options.reason;
    this.retryable = options.retryable ?? false;
  }
}

export class AuthenticationError extends AlertStreamError {
  constructor(message = "RTPR rejected the API key", retryAfterMs?: number) {
    super("AUTHENTICATION", message, { statusCode: 401, retryAfterMs });
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends AlertStreamError {
  constructor(message = "The API key is not authorized for alert streaming") {
    super("AUTHORIZATION", message, { statusCode: 403 });
    this.name = "AuthorizationError";
  }
}

export class RateLimitError extends AlertStreamError {
  constructor(
    message = "RTPR rate-limited the alert stream connection",
    retryAfterMs?: number,
  ) {
    super("RATE_LIMIT", message, {
      statusCode: 429,
      retryAfterMs,
      retryable: true,
    });
    this.name = "RateLimitError";
  }
}

export class ConnectionError extends AlertStreamError {
  constructor(
    message = "The RTPR alert stream connection failed",
    retryAfterMs?: number,
  ) {
    super("CONNECTION", message, { retryAfterMs, retryable: true });
    this.name = "ConnectionError";
  }
}

export class ProtocolError extends AlertStreamError {
  constructor(message = "RTPR sent an invalid alert frame") {
    super("PROTOCOL", message);
    this.name = "ProtocolError";
  }
}

export class FetchError extends AlertStreamError {
  constructor(
    articleId: string,
    articleUrl: string,
    options: {
      readonly message?: string;
      readonly statusCode?: number;
      readonly reason?: string;
      readonly retryable?: boolean;
      readonly cause?: unknown;
    } = {},
  ) {
    super("FETCH", options.message ?? "The raw article fetch failed", {
      articleId,
      articleUrl,
      statusCode: options.statusCode,
      reason: options.reason,
      retryable: options.retryable,
      cause: options.cause,
    });
    this.name = "FetchError";
  }
}

export class RedirectRejectedError extends AlertStreamError {
  constructor(articleId: string, articleUrl: string, statusCode: number) {
    super("REDIRECT_REJECTED", "The raw article endpoint returned a redirect", {
      articleId,
      articleUrl,
      statusCode,
      reason: "redirect",
    });
    this.name = "RedirectRejectedError";
  }
}

export class BackpressureError extends AlertStreamError {
  constructor(articleId: string, articleUrl: string, reason: string) {
    super("BACKPRESSURE", "The SDK dropped an article because a bounded queue was full", {
      articleId,
      articleUrl,
      reason,
      retryable: true,
    });
    this.name = "BackpressureError";
  }
}

export class HandlerError extends AlertStreamError {
  constructor(message = "An AlertStream customer handler failed", cause?: unknown) {
    super("HANDLER", message, { cause });
    this.name = "HandlerError";
  }
}

export class ConfigurationError extends AlertStreamError {
  constructor(message: string) {
    super("CONFIGURATION", message);
    this.name = "ConfigurationError";
  }
}

export class StreamClosedError extends AlertStreamError {
  constructor(message = "The AlertStream is closed") {
    super("STREAM_CLOSED", message);
    this.name = "StreamClosedError";
  }
}

export function serializeAlertStreamError(
  error: AlertStreamError,
): SerializedAlertStreamError {
  return {
    code: error.code,
    message: error.message,
    statusCode: error.statusCode,
    retryAfterMs: error.retryAfterMs,
    articleId: error.articleId,
    articleUrl: error.articleUrl,
    reason: error.reason,
    retryable: error.retryable,
  };
}

export function deserializeAlertStreamError(
  error: SerializedAlertStreamError,
): AlertStreamError {
  switch (error.code) {
    case "AUTHENTICATION":
      return new AuthenticationError(error.message, error.retryAfterMs);
    case "AUTHORIZATION":
      return new AuthorizationError(error.message);
    case "RATE_LIMIT":
      return new RateLimitError(error.message, error.retryAfterMs);
    case "CONNECTION":
      return new ConnectionError(error.message, error.retryAfterMs);
    case "PROTOCOL":
      return new ProtocolError(error.message);
    case "REDIRECT_REJECTED":
      return new RedirectRejectedError(
        error.articleId ?? "unknown",
        error.articleUrl ?? "",
        error.statusCode ?? 302,
      );
    case "BACKPRESSURE":
      return new BackpressureError(
        error.articleId ?? "unknown",
        error.articleUrl ?? "",
        error.reason ?? "bounded_queue",
      );
    case "HANDLER":
      return new HandlerError(error.message);
    case "CONFIGURATION":
      return new ConfigurationError(error.message);
    case "STREAM_CLOSED":
      return new StreamClosedError(error.message);
    case "FETCH":
      return new FetchError(error.articleId ?? "unknown", error.articleUrl ?? "", {
        message: error.message,
        statusCode: error.statusCode,
        reason: error.reason,
        retryable: error.retryable,
      });
  }
}
