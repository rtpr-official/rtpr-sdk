package io.rtpr.sdk.exception;

/**
 * Raised when the API key is invalid or missing.
 */
public class AuthenticationException extends RtprException {
    public AuthenticationException() {
        super("Invalid or missing API key", 401);
    }

    public AuthenticationException(String message) {
        super(message, 401);
    }
}
