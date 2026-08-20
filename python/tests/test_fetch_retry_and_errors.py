from __future__ import annotations

import queue

import httpx
import pytest
from conftest import API_KEY, HTTPFactory, ScriptedConnector, ScriptedWebSocket, alert_frame

from rtpr import (
    AlertStream,
    AuthenticationError,
    AuthorizationError,
    FetchHTTPError,
    RateLimitError,
    RedirectRejectedError,
)


def make_stream(
    socket: ScriptedWebSocket,
    http: HTTPFactory,
    **kwargs: object,
) -> AlertStream:
    return AlertStream(
        API_KEY,
        _websocket_connector=ScriptedConnector([socket]),
        _http_client_factory=http,
        fetch_retry_base_seconds=0,
        fetch_retry_max_seconds=0.01,
        reconnect_base_seconds=0.01,
        keepalive_interval_seconds=300,
        shutdown_grace_seconds=0.2,
        **kwargs,
    )


def test_brief_404_retryable_5xx_and_cloudflare_526_then_exact_success() -> None:
    calls = 0
    raw = b"first\r\nsecond\x00third"

    async def response(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            return httpx.Response(404, request=request)
        if calls == 2:
            return httpx.Response(
                503,
                headers={"Retry-After": "0"},
                request=request,
            )
        if calls == 3:
            return httpx.Response(526, request=request)
        return httpx.Response(200, content=raw, request=request)

    socket = ScriptedWebSocket([alert_frame("retry-article")])
    http = HTTPFactory(response)
    stream = make_stream(socket, http)
    try:
        event = stream.get(timeout=2)
        assert event.raw_bytes == raw
        assert event.attempts == 4
        assert calls == 4
        assert stream.stats()["counters"]["fetch_retries"] == 3
        get_requests = [request for request in http.requests if request.method == "GET"]
        assert [str(request.url) for request in get_requests] == [
            "https://signed.rtpr.test/a/retry-article?signature=SIGNED-retry-article"
        ] * 4
        assert all(request.headers["x-api-key"] == API_KEY for request in get_requests)
    finally:
        stream.close()


def test_network_error_is_the_only_exception_class_retried() -> None:
    calls = 0

    async def response(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ConnectError("synthetic connect failure", request=request)
        return httpx.Response(200, content=b"after-network-retry", request=request)

    socket = ScriptedWebSocket([alert_frame("network-retry")])
    http = HTTPFactory(response)
    stream = make_stream(socket, http)
    try:
        event = stream.get(timeout=2)
        assert event.raw_bytes == b"after-network-retry"
        assert event.attempts == 2
        assert calls == 2
    finally:
        stream.close()


def test_redirect_is_rejected_and_never_followed() -> None:
    signed_url = "https://signed.rtpr.test/a/redirect?signature=DO-NOT-LOG"

    async def response(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            302,
            headers={"Location": "https://other.test/leak?apiKey=SHOULD-NOT-FOLLOW"},
            request=request,
        )

    socket = ScriptedWebSocket([alert_frame("redirect", article_url=signed_url)])
    http = HTTPFactory(response)
    stream = make_stream(socket, http)
    try:
        stream.start(wait_until_connected=True)
        error = stream.get_error(timeout=2)
        assert isinstance(error, RedirectRejectedError)
        assert error.article_id == "redirect"
        assert error.article_url == signed_url
        assert signed_url not in str(error)
        assert signed_url not in repr(error)
        assert len([request for request in http.requests if request.method == "GET"]) == 1
        assert stream.stats()["counters"]["results_delivered"] == 0
        with pytest.raises(queue.Empty):
            stream.get_error(timeout=0.01)
    finally:
        stream.close()


@pytest.mark.parametrize(
    ("status", "error_type"),
    [
        (401, AuthenticationError),
        (403, AuthorizationError),
        (429, RateLimitError),
        (418, FetchHTTPError),
    ],
)
def test_fetch_lifecycle_statuses_are_explicit_and_not_retried(
    status: int,
    error_type: type[Exception],
) -> None:
    async def response(request: httpx.Request) -> httpx.Response:
        headers = {"Retry-After": "2"} if status == 429 else {}
        return httpx.Response(status, headers=headers, request=request)

    signed_url = f"https://signed.rtpr.test/a/status-{status}?signature=SECRET"
    socket = ScriptedWebSocket([alert_frame(f"status-{status}", article_url=signed_url)])
    http = HTTPFactory(response)
    stream = make_stream(socket, http)
    try:
        stream.start(wait_until_connected=True)
        error = stream.get_error(timeout=2)
        assert isinstance(error, error_type)
        assert error.status_code == status
        assert error.article_url == signed_url
        assert len([request for request in http.requests if request.method == "GET"]) == 1
        assert stream.stats()["counters"]["fetch_retries"] == 0
        assert stream.stats()["counters"]["results_delivered"] == 0
        if status == 429:
            assert error.retry_after_seconds == 2
    finally:
        stream.close()
