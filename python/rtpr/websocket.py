"""RTPR WebSocket streaming client."""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Awaitable, Callable
from typing import Any

import websockets
import websockets.exceptions

from rtpr.exceptions import AuthenticationError
from rtpr.models import Article

logger = logging.getLogger("rtpr.websocket")

DEFAULT_WS_URL = "wss://ws.rtpr.io"
INITIAL_RECONNECT_DELAY = 1.0
MAX_RECONNECT_DELAY = 60.0

ArticleCallback = Callable[[Article], Awaitable[None] | None]
EventCallback = Callable[[dict[str, Any]], Awaitable[None] | None]


class RtprWebSocket:
    """Async WebSocket client for real-time RTPR press release streaming.

    Handles authentication, subscriptions, ping/pong heartbeat,
    and automatic reconnection with exponential backoff.

    Usage::

        ws = RtprWebSocket("your_api_key")

        @ws.on_article
        async def handle(article):
            print(f"{article.ticker}: {article.title}")

        await ws.connect(tickers=["AAPL", "TSLA"])
    """

    def __init__(
        self,
        api_key: str,
        *,
        ws_url: str = DEFAULT_WS_URL,
        auto_reconnect: bool = True,
    ) -> None:
        self._api_key = api_key
        self._ws_url = ws_url.rstrip("/")
        self._auto_reconnect = auto_reconnect

        self._ws: Any = None
        self._tickers: list[str] = []
        self._running = False

        self._on_article: ArticleCallback | None = None
        self._on_connect: EventCallback | None = None
        self._on_disconnect: EventCallback | None = None
        self._on_error: EventCallback | None = None

    def on_article(self, callback: ArticleCallback) -> ArticleCallback:
        """Register a callback for new articles. Can be used as a decorator."""
        self._on_article = callback
        return callback

    def on_connect(self, callback: EventCallback) -> EventCallback:
        """Register a callback for connection events. Can be used as a decorator."""
        self._on_connect = callback
        return callback

    def on_disconnect(self, callback: EventCallback) -> EventCallback:
        """Register a callback for disconnection events. Can be used as a decorator."""
        self._on_disconnect = callback
        return callback

    def on_error(self, callback: EventCallback) -> EventCallback:
        """Register a callback for error events. Can be used as a decorator."""
        self._on_error = callback
        return callback

    async def connect(self, tickers: list[str] | None = None) -> None:
        """Connect to the RTPR WebSocket and start streaming.

        This method blocks until the connection is closed or stop() is called.

        Args:
            tickers: List of ticker symbols to subscribe to.
                     Use ["*"] for firehose mode (all tickers).
        """
        if tickers:
            self._tickers = tickers
        self._running = True
        delay = INITIAL_RECONNECT_DELAY

        while self._running:
            try:
                await self._run_connection()
                delay = INITIAL_RECONNECT_DELAY
            except websockets.exceptions.ConnectionClosedError as e:
                if e.code == 4003:
                    raise AuthenticationError("Invalid API key") from e
                if e.code == 4004:
                    raise AuthenticationError("Trial expired") from e
                logger.warning("Connection closed (code=%s). Reconnecting...", e.code)
            except (OSError, websockets.exceptions.WebSocketException) as e:
                logger.warning("Connection error: %s. Reconnecting...", e)
            except Exception as e:
                await self._fire_error({"message": str(e)})
                logger.exception("Unexpected error")

            if not self._running or not self._auto_reconnect:
                break

            logger.info("Reconnecting in %.1fs...", delay)
            await asyncio.sleep(delay)
            delay = min(delay * 2, MAX_RECONNECT_DELAY)

    async def _run_connection(self) -> None:
        url = f"{self._ws_url}?apiKey={self._api_key}"
        async with websockets.connect(url) as ws:
            self._ws = ws
            async for raw in ws:
                message = json.loads(raw)
                await self._dispatch(message)

    async def _dispatch(self, message: dict[str, Any]) -> None:
        msg_type = message.get("type", "")

        if msg_type == "connected":
            logger.info("Connected to RTPR")
            await self._fire_connect(message)
            if self._tickers:
                await self.subscribe(self._tickers)

        elif msg_type == "subscribed":
            logger.info("Subscribed to: %s", message.get("tickers"))

        elif msg_type == "article":
            article_data = message.get("data", {})
            article = Article.from_dict(article_data)
            if self._on_article:
                result = self._on_article(article)
                if asyncio.iscoroutine(result):
                    await result

        elif msg_type == "ping":
            if self._ws:
                await self._ws.send(json.dumps({"type": "pong"}))

        elif msg_type == "error":
            logger.error("Server error: %s", message.get("message"))
            await self._fire_error(message)

    async def subscribe(self, tickers: list[str]) -> None:
        """Subscribe to ticker symbols. Merges with existing subscriptions.

        Args:
            tickers: List of ticker symbols, or ["*"] for all tickers.
        """
        if self._ws:
            await self._ws.send(json.dumps({"action": "subscribe", "tickers": tickers}))
            for t in tickers:
                if t not in self._tickers:
                    self._tickers.append(t)

    async def unsubscribe(self, tickers: list[str]) -> None:
        """Unsubscribe from ticker symbols.

        Args:
            tickers: List of ticker symbols to remove, or ["*"] to clear all.
        """
        if self._ws:
            await self._ws.send(json.dumps({"action": "unsubscribe", "tickers": tickers}))
            if "*" in tickers:
                self._tickers.clear()
            else:
                self._tickers = [t for t in self._tickers if t not in tickers]

    async def stop(self) -> None:
        """Stop the WebSocket connection and prevent reconnection."""
        self._running = False
        if self._ws:
            await self._ws.close()

    async def _fire_connect(self, data: dict[str, Any]) -> None:
        if self._on_connect:
            result = self._on_connect(data)
            if asyncio.iscoroutine(result):
                await result

    async def _fire_error(self, data: dict[str, Any]) -> None:
        if self._on_error:
            result = self._on_error(data)
            if asyncio.iscoroutine(result):
                await result

    @property
    def connected(self) -> bool:
        return self._ws is not None and self._ws.open
