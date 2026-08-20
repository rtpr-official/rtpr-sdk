"""Exceptions raised by the RTPR alert stream.

Exception text is deliberately safe to paste into a support ticket.  An
exception that relates to an article retains the exact signed URL on the
``article_url`` attribute for an explicit caller-initiated refetch, but the
URL is never included in ``str()`` or ``repr()``.
"""

from __future__ import annotations


class RTPRError(Exception):
    """Base class for all public SDK errors."""

    default_message = "RTPR alert stream error"

    def __init__(
        self,
        message: str | None = None,
        *,
        status_code: int | None = None,
        retry_after_seconds: float | None = None,
        article_id: str | None = None,
        article_url: str | None = None,
    ) -> None:
        self.message = message or self.default_message
        self.status_code = status_code
        self.retry_after_seconds = retry_after_seconds
        self.article_id = article_id
        self.article_url = article_url
        super().__init__(self.message)

    def __repr__(self) -> str:
        details = [repr(self.message)]
        if self.status_code is not None:
            details.append(f"status_code={self.status_code}")
        return f"{type(self).__name__}({', '.join(details)})"


class StreamStateError(RTPRError):
    """Raised when an operation is invalid for the stream state."""

    default_message = "The alert stream is not in a valid state for this operation"


class StreamClosedError(StreamStateError):
    """Raised when attempting to consume an explicitly closed stream."""

    default_message = "The alert stream is closed"


class ConsumptionModeError(StreamStateError):
    """Raised when callback and iterator consumption are mixed."""

    default_message = "Callback and iterator consumption cannot be used together"


class ShutdownError(RTPRError):
    """Raised when the dedicated network thread does not stop cleanly."""

    default_message = "The alert stream did not shut down within the requested timeout"


class ConnectionLifecycleError(RTPRError):
    """Base class for WebSocket handshake and connection lifecycle failures."""

    default_message = "RTPR alert connection failed"


class AuthenticationError(ConnectionLifecycleError):
    """The API key was rejected with HTTP 401."""

    default_message = "RTPR authentication failed (HTTP 401)"

    def __init__(
        self,
        *,
        retry_after_seconds: float | None = None,
        article_id: str | None = None,
        article_url: str | None = None,
    ) -> None:
        super().__init__(
            status_code=401,
            retry_after_seconds=retry_after_seconds,
            article_id=article_id,
            article_url=article_url,
        )


class AuthorizationError(ConnectionLifecycleError):
    """The API key is not authorized for the requested resource."""

    default_message = "RTPR authorization failed (HTTP 403)"

    def __init__(
        self,
        *,
        retry_after_seconds: float | None = None,
        article_id: str | None = None,
        article_url: str | None = None,
    ) -> None:
        super().__init__(
            status_code=403,
            retry_after_seconds=retry_after_seconds,
            article_id=article_id,
            article_url=article_url,
        )


class RateLimitError(ConnectionLifecycleError):
    """The service returned HTTP 429."""

    default_message = "RTPR rate limit reached (HTTP 429)"

    def __init__(
        self,
        *,
        retry_after_seconds: float | None = None,
        article_id: str | None = None,
        article_url: str | None = None,
    ) -> None:
        super().__init__(
            status_code=429,
            retry_after_seconds=retry_after_seconds,
            article_id=article_id,
            article_url=article_url,
        )


class AlertConnectionError(ConnectionLifecycleError):
    """A retryable WebSocket connection or lifecycle failure."""


class ProtocolError(RTPRError):
    """A WebSocket frame did not satisfy the saved-rule alert contract."""

    default_message = "Received an invalid RTPR alert frame"


class ArticleFetchError(RTPRError):
    """Base class for failures fetching a signed article URL."""

    default_message = "The raw article could not be fetched"


class FetchNetworkError(ArticleFetchError):
    """All permitted network retries were exhausted."""

    default_message = "The raw article fetch failed due to a network error"


class FetchDeadlineError(ArticleFetchError):
    """The total article fetch deadline was exhausted."""

    default_message = "The raw article fetch exceeded its total deadline"


class FetchHTTPError(ArticleFetchError):
    """The article endpoint returned a non-retryable HTTP status."""

    def __init__(
        self,
        status_code: int,
        *,
        article_id: str,
        article_url: str,
        message: str | None = None,
    ) -> None:
        super().__init__(
            message or f"The raw article fetch failed (HTTP {status_code})",
            status_code=status_code,
            article_id=article_id,
            article_url=article_url,
        )


class RedirectRejectedError(FetchHTTPError):
    """A redirect was rejected to preserve the exact signed URL contract."""

    def __init__(self, status_code: int, *, article_id: str, article_url: str) -> None:
        super().__init__(
            status_code,
            article_id=article_id,
            article_url=article_url,
            message=f"The raw article endpoint returned a rejected redirect (HTTP {status_code})",
        )


class BackpressureError(RTPRError):
    """A bounded pending or result queue could not accept an article."""

    default_message = "An article was not delivered because a bounded SDK queue was full"

    def __init__(
        self,
        *,
        article_id: str,
        article_url: str,
        stage: str,
        item_limit: int,
        byte_limit: int | None = None,
    ) -> None:
        self.stage = stage
        self.item_limit = item_limit
        self.byte_limit = byte_limit
        super().__init__(article_id=article_id, article_url=article_url)


class HandlerError(RTPRError):
    """A customer callback raised an exception."""

    default_message = "A customer alert callback raised an exception"
