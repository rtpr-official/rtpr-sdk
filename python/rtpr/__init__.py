"""Official RTPR Python SDK for saved-rule alerts and exact raw bytes."""

from rtpr._version import __version__
from rtpr.events import AlertEvent, AlertRule, RawArticleEvent
from rtpr.exceptions import (
    AlertConnectionError,
    ArticleFetchError,
    AuthenticationError,
    AuthorizationError,
    BackpressureError,
    ConnectionLifecycleError,
    ConsumptionModeError,
    FetchDeadlineError,
    FetchHTTPError,
    FetchNetworkError,
    HandlerError,
    ProtocolError,
    RateLimitError,
    RedirectRejectedError,
    RTPRError,
    ShutdownError,
    StreamClosedError,
    StreamStateError,
)
from rtpr.stream import AlertStream, parse_alert_frame

__all__ = [
    "AlertConnectionError",
    "AlertEvent",
    "AlertRule",
    "AlertStream",
    "ArticleFetchError",
    "AuthenticationError",
    "AuthorizationError",
    "BackpressureError",
    "ConnectionLifecycleError",
    "ConsumptionModeError",
    "FetchDeadlineError",
    "FetchHTTPError",
    "FetchNetworkError",
    "HandlerError",
    "ProtocolError",
    "RTPRError",
    "RateLimitError",
    "RawArticleEvent",
    "RedirectRejectedError",
    "ShutdownError",
    "StreamClosedError",
    "StreamStateError",
    "__version__",
    "parse_alert_frame",
]
