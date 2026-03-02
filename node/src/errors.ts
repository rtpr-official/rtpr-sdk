export class RtprError extends Error {
  public readonly statusCode: number | undefined;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "RtprError";
    this.statusCode = statusCode;
  }
}

export class AuthenticationError extends RtprError {
  constructor(message = "Invalid or missing API key") {
    super(message, 401);
    this.name = "AuthenticationError";
  }
}

export class RateLimitError extends RtprError {
  constructor(message = "Rate limit exceeded (60 requests/minute)") {
    super(message, 429);
    this.name = "RateLimitError";
  }
}

export class ConnectionError extends RtprError {
  constructor(message = "Failed to connect to RTPR WebSocket") {
    super(message);
    this.name = "ConnectionError";
  }
}
