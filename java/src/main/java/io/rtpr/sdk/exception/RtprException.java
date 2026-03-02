package io.rtpr.sdk.exception;

/**
 * Base exception for all RTPR SDK errors.
 */
public class RtprException extends Exception {
    private final int statusCode;

    public RtprException(String message) {
        this(message, 0);
    }

    public RtprException(String message, int statusCode) {
        super(message);
        this.statusCode = statusCode;
    }

    public RtprException(String message, Throwable cause) {
        super(message, cause);
        this.statusCode = 0;
    }

    public int getStatusCode() {
        return statusCode;
    }
}
