from __future__ import annotations

import asyncio
import threading

import httpx
import pytest
from conftest import (
    API_KEY,
    HTTPFactory,
    ScriptedConnector,
    ScriptedWebSocket,
    alert_frame,
    wait_until,
)

from rtpr import AlertStream, BackpressureError, ConsumptionModeError


def test_mixed_latency_burst_delivers_as_completed() -> None:
    delays = {"slow": 0.08, "fast": 0.005, "medium": 0.03}

    async def response(request: httpx.Request) -> httpx.Response:
        article_id = request.url.path.rsplit("/", 1)[-1]
        await asyncio.sleep(delays[article_id])
        return httpx.Response(200, content=article_id.encode(), request=request)

    socket = ScriptedWebSocket([alert_frame("slow"), alert_frame("fast"), alert_frame("medium")])
    http = HTTPFactory(response)
    stream = AlertStream(
        API_KEY,
        max_in_flight=3,
        max_pending_fetches=8,
        _websocket_connector=ScriptedConnector([socket]),
        _http_client_factory=http,
        keepalive_interval_seconds=300,
        shutdown_grace_seconds=0.3,
    )
    try:
        completed = [stream.get(timeout=2).article_id for _ in range(3)]
        assert completed == ["fast", "medium", "slow"]
        stats = stream.stats()
        assert stats["active_fetches"]["high_water"] == 3
        assert stats["counters"]["fetches_completed"] == 3
    finally:
        stream.close()


def test_two_hundred_article_burst_has_no_silent_loss_or_head_of_line_blocking() -> None:
    article_ids = [f"burst-{index}" for index in range(200)]

    async def response(request: httpx.Request) -> httpx.Response:
        article_id = request.url.path.rsplit("/", 1)[-1]
        index = int(article_id.split("-", 1)[1])
        await asyncio.sleep(((index * 7) % 11) * 0.001)
        return httpx.Response(200, content=article_id.encode(), request=request)

    socket = ScriptedWebSocket([alert_frame(article_id) for article_id in article_ids])
    stream = AlertStream(
        API_KEY,
        max_in_flight=16,
        max_pending_fetches=256,
        result_queue_max_items=256,
        result_queue_max_bytes=2 * 1024 * 1024,
        _websocket_connector=ScriptedConnector([socket]),
        _http_client_factory=HTTPFactory(response),
        keepalive_interval_seconds=300,
        shutdown_grace_seconds=0.5,
    )
    try:
        received = [stream.get(timeout=3).article_id for _ in article_ids]
        assert set(received) == set(article_ids)
        assert received[:20] != article_ids[:20]
        assert stream.stats()["counters"]["fetches_completed"] == len(article_ids)
        assert stream.stats()["counters"]["pending_overloads"] == 0
        assert stream.stats()["counters"]["result_overloads"] == 0
    finally:
        stream.close()


def test_duplicate_article_merges_rule_names_and_fetches_once() -> None:
    calls = 0

    async def response(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        await asyncio.sleep(0.05)
        return httpx.Response(200, content=b"one fetch", request=request)

    socket = ScriptedWebSocket(
        [
            alert_frame("dedupe", rules=("Rule A",)),
            alert_frame("dedupe", rules=("Rule B", "Rule A")),
        ]
    )
    http = HTTPFactory(response)
    stream = AlertStream(
        API_KEY,
        max_in_flight=1,
        max_pending_fetches=4,
        _websocket_connector=ScriptedConnector([socket]),
        _http_client_factory=http,
        keepalive_interval_seconds=300,
        shutdown_grace_seconds=0.3,
    )
    try:
        event = stream.get(timeout=2)
        assert event.rule_names == ("Rule A", "Rule B")
        assert calls == 1
        assert stream.stats()["counters"]["duplicates_suppressed"] == 1
    finally:
        stream.close()


def test_slow_callback_does_not_delay_fetch_workers() -> None:
    callback_started = threading.Event()
    release_callback = threading.Event()
    all_callbacks_finished = threading.Event()
    callback_thread_ids: list[int] = []
    received: list[str] = []
    http_completed: list[str] = []

    async def response(request: httpx.Request) -> httpx.Response:
        article_id = request.url.path.rsplit("/", 1)[-1]
        http_completed.append(article_id)
        return httpx.Response(200, content=article_id.encode(), request=request)

    def handler(event: object) -> None:
        callback_thread_ids.append(threading.get_ident())
        article_id = getattr(event, "article_id")
        callback_started.set()
        release_callback.wait(1)
        received.append(article_id)
        if len(received) == 3:
            all_callbacks_finished.set()

    socket = ScriptedWebSocket([alert_frame("cb-1"), alert_frame("cb-2"), alert_frame("cb-3")])
    http = HTTPFactory(response)
    stream = AlertStream(
        API_KEY,
        handler=handler,
        max_in_flight=3,
        max_pending_fetches=8,
        result_queue_max_items=8,
        _websocket_connector=ScriptedConnector([socket]),
        _http_client_factory=http,
        keepalive_interval_seconds=300,
        shutdown_grace_seconds=0.3,
    )
    try:
        stream.start(wait_until_connected=True)
        assert callback_started.wait(1)
        wait_until(lambda: len(http_completed) == 3)
        assert received == []
        assert stream.stats()["counters"]["fetches_completed"] == 3
        with pytest.raises(ConsumptionModeError):
            stream.get(timeout=0)
        release_callback.set()
        assert all_callbacks_finished.wait(2)
        assert all(thread_id != stream.network_thread_ident for thread_id in callback_thread_ids)
    finally:
        release_callback.set()
        stream.close()


def test_result_queue_enforces_aggregate_raw_byte_cap() -> None:
    async def response(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"12345678", request=request)

    socket = ScriptedWebSocket([alert_frame("bytes-1"), alert_frame("bytes-2")])
    http = HTTPFactory(response)
    stream = AlertStream(
        API_KEY,
        max_in_flight=2,
        max_pending_fetches=4,
        result_queue_max_items=4,
        result_queue_max_bytes=10,
        _websocket_connector=ScriptedConnector([socket]),
        _http_client_factory=http,
        keepalive_interval_seconds=300,
        shutdown_grace_seconds=0.3,
    )
    try:
        stream.start(wait_until_connected=True)
        error = stream.get_error(timeout=2)
        assert isinstance(error, BackpressureError)
        assert error.stage == "result_queue"
        assert error.article_id in {"bytes-1", "bytes-2"}
        assert error.article_url is not None
        stats_before_get = stream.stats()
        assert stats_before_get["result_queue"]["depth_items"] == 1
        assert stats_before_get["result_queue"]["depth_raw_bytes"] == 8
        assert stats_before_get["result_queue"]["high_water_raw_bytes"] <= 10
        delivered = stream.get(timeout=1)
        assert len(delivered.raw_bytes) == 8
        assert delivered.article_id != error.article_id
        assert stream.stats()["counters"]["result_overloads"] == 1
    finally:
        stream.close()


def test_single_article_over_byte_cap_emits_refetchable_error() -> None:
    signed_url = "https://signed.rtpr.test/a/too-large?signature=PRIVATE"

    async def response(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"01234567890", request=request)

    socket = ScriptedWebSocket([alert_frame("too-large", article_url=signed_url)])
    http = HTTPFactory(response)
    stream = AlertStream(
        API_KEY,
        result_queue_max_bytes=10,
        _websocket_connector=ScriptedConnector([socket]),
        _http_client_factory=http,
        keepalive_interval_seconds=300,
        shutdown_grace_seconds=0.3,
    )
    try:
        stream.start(wait_until_connected=True)
        error = stream.get_error(timeout=2)
        assert isinstance(error, BackpressureError)
        assert error.stage == "article_size"
        assert error.article_id == "too-large"
        assert error.article_url == signed_url
        assert signed_url not in str(error)
        assert signed_url not in repr(error)
        assert stream.stats()["result_queue"]["depth_raw_bytes"] == 0
        assert stream.stats()["counters"]["results_delivered"] == 0
    finally:
        stream.close()


def test_pending_fetch_queue_overload_is_explicit() -> None:
    release = threading.Event()

    async def response(request: httpx.Request) -> httpx.Response:
        while not release.is_set():
            await asyncio.sleep(0.005)
        return httpx.Response(200, content=b"done", request=request)

    socket = ScriptedWebSocket(
        [alert_frame("pending-1"), alert_frame("pending-2"), alert_frame("pending-3")]
    )
    http = HTTPFactory(response)
    stream = AlertStream(
        API_KEY,
        max_in_flight=1,
        max_pending_fetches=1,
        result_queue_max_items=4,
        _websocket_connector=ScriptedConnector([socket]),
        _http_client_factory=http,
        keepalive_interval_seconds=300,
        shutdown_grace_seconds=0.3,
    )
    try:
        stream.start(wait_until_connected=True)
        error = stream.get_error(timeout=2)
        assert isinstance(error, BackpressureError)
        assert error.stage == "pending_fetches"
        assert error.article_id == "pending-3"
        assert stream.stats()["pending_fetches"]["high_water"] <= 1
        assert stream.stats()["counters"]["pending_overloads"] == 1
    finally:
        release.set()
        stream.close()
