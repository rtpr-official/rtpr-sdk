from __future__ import annotations

import asyncio
import inspect
import json
import threading
import time
from collections.abc import Awaitable, Callable, Iterable
from typing import Any

import httpx

API_KEY = "TOP-SECRET-API-KEY"


def alert_frame(
    article_id: str,
    *,
    rules: Iterable[str] = ("Display rule",),
    article_url: str | None = None,
    ticker: str = "RTPR",
) -> str:
    return json.dumps(
        {
            "type": "alert",
            "article_id": article_id,
            "ticker": ticker,
            "rules": [{"rule_name": name} for name in rules],
            "article_published_at": "2026-08-19T20:00:00.000Z",
            "article_url": article_url
            or f"https://signed.rtpr.test/a/{article_id}?signature=SIGNED-{article_id}",
            "dispatched_at_ms": 1_787_169_601_250,
        }
    )


class ScriptedWebSocket:
    def __init__(self, messages: Iterable[object], *, hold_open: bool = True) -> None:
        self.messages = list(messages)
        self.hold_open = hold_open
        self.sent: list[str] = []
        self.send_thread_ids: list[int] = []
        self.entered = threading.Event()
        self.closed = threading.Event()
        self._index = 0
        self._closed_async: asyncio.Event | None = None

    async def __aenter__(self) -> ScriptedWebSocket:
        self._closed_async = asyncio.Event()
        self.entered.set()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: Any,
    ) -> None:
        await self.close()

    def __aiter__(self) -> ScriptedWebSocket:
        return self

    async def __anext__(self) -> object:
        if self._index < len(self.messages):
            message = self.messages[self._index]
            self._index += 1
            await asyncio.sleep(0)
            return message
        if self.hold_open:
            assert self._closed_async is not None
            await self._closed_async.wait()
        raise StopAsyncIteration

    async def send(self, message: str) -> None:
        self.sent.append(message)
        self.send_thread_ids.append(threading.get_ident())

    async def close(self, **kwargs: Any) -> None:
        del kwargs
        self.closed.set()
        if self._closed_async is not None:
            self._closed_async.set()


class HandshakeFailureError(Exception):
    def __init__(
        self,
        status_code: int,
        *,
        retry_after: str | None = None,
    ) -> None:
        self.status_code = status_code
        self.headers = {} if retry_after is None else {"retry-after": retry_after}
        super().__init__(f"handshake status {status_code}")


class _RaisingConnection:
    def __init__(self, error: BaseException) -> None:
        self.error = error

    async def __aenter__(self) -> Any:
        raise self.error

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: Any,
    ) -> None:
        return None


class ScriptedConnector:
    def __init__(self, actions: Iterable[ScriptedWebSocket | BaseException]) -> None:
        self.actions = list(actions)
        self.urls: list[str] = []
        self.kwargs: list[dict[str, Any]] = []
        self.thread_ids: list[int] = []
        self.call_times: list[float] = []
        self._index = 0

    def __call__(self, url: str, **kwargs: Any) -> Any:
        self.urls.append(url)
        self.kwargs.append(kwargs)
        self.thread_ids.append(threading.get_ident())
        self.call_times.append(time.monotonic())
        index = min(self._index, len(self.actions) - 1)
        self._index += 1
        action = self.actions[index]
        if isinstance(action, BaseException):
            return _RaisingConnection(action)
        return action


ResponseHandler = Callable[
    [httpx.Request],
    httpx.Response | Awaitable[httpx.Response],
]


class HTTPFactory:
    def __init__(self, handler: ResponseHandler) -> None:
        self.handler = handler
        self.requests: list[httpx.Request] = []
        self.request_thread_ids: list[int] = []
        self.factory_thread_ids: list[int] = []
        self.clients: list[httpx.AsyncClient] = []

    def __call__(self) -> httpx.AsyncClient:
        self.factory_thread_ids.append(threading.get_ident())

        async def dispatch(request: httpx.Request) -> httpx.Response:
            self.requests.append(request)
            self.request_thread_ids.append(threading.get_ident())
            if request.method == "HEAD" and str(request.url) == "https://rtpr.io/a/_sdk_keepalive":
                return httpx.Response(
                    204,
                    headers={"X-RTPR-SDK-Keepalive": "ok"},
                    request=request,
                )
            response = self.handler(request)
            if inspect.isawaitable(response):
                return await response
            return response

        client = httpx.AsyncClient(
            transport=httpx.MockTransport(dispatch),
            follow_redirects=True,
        )
        self.clients.append(client)
        return client


def wait_until(
    predicate: Callable[[], bool],
    *,
    timeout: float = 2.0,
    interval: float = 0.005,
) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        if time.monotonic() >= deadline:
            raise AssertionError("condition did not become true before timeout")
        time.sleep(interval)
