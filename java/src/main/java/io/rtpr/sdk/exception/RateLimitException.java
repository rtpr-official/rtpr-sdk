package io.rtpr.sdk.exception;

/**
 * Raised when the rate limit is exceeded (60 requests/minute).
 */
public class RateLimitException extends RtprException {
    public RateLimitException() {
        super("Rate limit exceeded (60 requests/minute)", 429);
    }
}
