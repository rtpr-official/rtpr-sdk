from __future__ import annotations

import random

import httpx
import pytest
from conftest import (
    API_KEY,
    HandshakeFailureError,
    HTTPFactory,
    ScriptedConnector,
    ScriptedWebSocket,
    alert_frame,
    wait_until,
)

from rtpr import (
    AlertStream,
    AuthenticationError,
    AuthorizationError,
    RateLimitError,
)


class MaximumRandom(random.Random):
    def uniform(self, a: float, b: float) -> float:
        del a
        return b


@pytest.mark.parametrize(
    ("status", "error_type"),
    [(401, AuthenticationError), (403, AuthorizationError)],
)
def test_terminal_handshake_errors_are_raised_and_not_reconnected(
    status: int,
    error_type: type[Exception],
) -> None:
    connector = ScriptedConnector([HandshakeFailureError(status)])
    http = HTTPFactory(lambda request: httpx.Response(500, request=request))
    stream = AlertStream(
        API_KEY,
        _websocket_connector=connector,
        _http_client_factory=http,
        keepalive_interval_seconds=300,
        shutdown_grace_seconds=0.2,
    )
    try:
        with pytest.raises(error_type):
            stream.start(wait_until_connected=True, timeout=1)
        error = stream.get_error(timeout=1)
        assert isinstance(error, error_type)
        assert error.status_code == status
        assert len(connector.urls) == 1
    finally:
        stream.close()


def test_429_handshake_honors_retry_after_then_connects() -> None:
    socket = ScriptedWebSocket([])
    connector = ScriptedConnector([HandshakeFailureError(429, retry_after="0.05"), socket])
    http = HTTPFactory(lambda request: httpx.Response(500, request=request))
    stream = AlertStream(
        API_KEY,
        _websocket_connector=connector,
        _http_client_factory=http,
        reconnect_base_seconds=0,
        reconnect_max_seconds=1,
        keepalive_interval_seconds=300,
        shutdown_grace_seconds=0.2,
    )
    try:
        stream.start(wait_until_connected=True, timeout=2)
        assert len(connector.call_times) == 2
        assert connector.call_times[1] - connector.call_times[0] >= 0.045
        error = stream.get_error(timeout=1)
        assert isinstance(error, RateLimitError)
        assert error.retry_after_seconds == 0.05
        assert stream.stats()["counters"]["reconnects"] == 1
    finally:
        stream.close()


def test_failed_fetch_is_not_deduped_as_delivered() -> None:
    calls = 0

    async def response(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(500, request=request)
        return httpx.Response(200, content=b"second attempt delivered", request=request)

    first = ScriptedWebSocket([alert_frame("retry-after-failure")], hold_open=False)
    second = ScriptedWebSocket([alert_frame("retry-after-failure")])
    connector = ScriptedConnector([first, second])
    http = HTTPFactory(response)
    stream = AlertStream(
        API_KEY,
        fetch_max_attempts=1,
        reconnect_base_seconds=0.05,
        reconnect_max_seconds=0.05,
        _random_source=MaximumRandom(),
        _websocket_connector=connector,
        _http_client_factory=http,
        keepalive_interval_seconds=300,
        shutdown_grace_seconds=0.3,
    )
    try:
        event = stream.get(timeout=2)
        assert event.raw_bytes == b"second attempt delivered"
        assert calls == 2
        stats = stream.stats()
        assert stats["counters"]["fetch_failures"] == 1
        assert stats["counters"]["fetches_completed"] == 1
        assert stats["counters"]["results_delivered"] == 1
    finally:
        stream.close()


def test_clean_shutdown_closes_websocket_http_client_and_network_thread() -> None:
    socket = ScriptedWebSocket([])
    connector = ScriptedConnector([socket])
    http = HTTPFactory(lambda request: httpx.Response(200, content=b"x", request=request))
    stream = AlertStream(
        API_KEY,
        _websocket_connector=connector,
        _http_client_factory=http,
        keepalive_interval_seconds=300,
        shutdown_grace_seconds=0.2,
    )

    stream.start(wait_until_connected=True)
    wait_until(lambda: stream.stats()["keepalive"]["healthy"] is True)
    network_thread = stream._network_thread
    assert network_thread is not None and network_thread.is_alive()
    stream.close(timeout=1)
    stream.close(timeout=1)

    assert socket.closed.is_set()
    assert not network_thread.is_alive()
    assert all(client.is_closed for client in http.clients)
    assert stream.stats()["state"] == "closed"
    assert stream.stats()["keepalive"]["healthy"] is True


@pytest.mark.asyncio
async def test_async_iterator_consumes_without_owning_network_loop() -> None:
    socket = ScriptedWebSocket([alert_frame("async-event")])

    async def response(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"async raw", request=request)

    http = HTTPFactory(response)
    stream = AlertStream(
        API_KEY,
        _websocket_connector=ScriptedConnector([socket]),
        _http_client_factory=http,
        keepalive_interval_seconds=300,
        shutdown_grace_seconds=0.2,
    )
    async with stream:
        event = await stream.__anext__()
        assert event.article_id == "async-event"
        assert event.raw_bytes == b"async raw"
        assert stream.network_thread_ident is not None

    assert socket.closed.is_set()
