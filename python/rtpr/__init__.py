"""RTPR SDK — Real-time press releases in under 500ms."""

from rtpr.client import AsyncRtprClient, RtprClient
from rtpr.exceptions import AuthenticationError, ConnectionError, RateLimitError, RtprError
from rtpr.models import Article, ArticlesResponse
from rtpr.websocket import RtprWebSocket

__all__ = [
    "RtprClient",
    "AsyncRtprClient",
    "RtprWebSocket",
    "Article",
    "ArticlesResponse",
    "RtprError",
    "AuthenticationError",
    "RateLimitError",
    "ConnectionError",
]

__version__ = "0.1.0"
