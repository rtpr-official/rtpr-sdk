"""RTPR SDK exceptions."""

from __future__ import annotations


class RtprError(Exception):
    """Base exception for all RTPR SDK errors."""

    def __init__(self, message: str, status_code: int | None = None) -> None:
        self.message = message
        self.status_code = status_code
        super().__init__(message)


class AuthenticationError(RtprError):
    """Raised when the API key is invalid or missing."""

    def __init__(self, message: str = "Invalid or missing API key") -> None:
        super().__init__(message, status_code=401)


class RateLimitError(RtprError):
    """Raised when the rate limit is exceeded (60 requests/minute)."""

    def __init__(self, message: str = "Rate limit exceeded (60 requests/minute)") -> None:
        super().__init__(message, status_code=429)


class ConnectionError(RtprError):
    """Raised when a WebSocket connection cannot be established."""

    def __init__(self, message: str = "Failed to connect to RTPR WebSocket") -> None:
        super().__init__(message)
