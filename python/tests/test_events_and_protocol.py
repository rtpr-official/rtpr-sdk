from __future__ import annotations

import json
import queue
import threading
from dataclasses import FrozenInstanceError
from datetime import datetime, timezone

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

from rtpr import AlertStream, ProtocolError, parse_alert_frame


def test_parse_saved_rule_alert_and_merge_names_in_frame() -> None:
    received = datetime(2026, 8, 19, 20, 0, 2, tzinfo=timezone.utc)
    frame = json.loads(alert_frame("article-1", rules=("Rule A", "Rule A", "Rule B")))

    event = parse_alert_frame(
        frame,
        received_at=received,
        received_monotonic=123.0,
    )

    assert event.article_id == "article-1"
    assert event.ticker == "RTPR"
    assert event.rule_names == ("Rule A", "Rule B")
    assert event.article_published_at.tzinfo is timezone.utc
    assert event.received_at == received
    assert event._received_monotonic == 123.0
    with pytest.raises(FrozenInstanceError):
        event.ticker = "OTHER"  # type: ignore[misc]


def test_parse_high_impact_frame_without_rules() -> None:
    frame = json.loads(alert_frame("impact-1"))
    del frame["rules"]
    frame["alert_kind"] = "high_impact"
    frame["impact_score"] = 92
    frame["impact_tier"] = "high"
    frame["impact_direction"] = "bullish"
    frame["event_type"] = "fda_approval"
    frame["band_hit_rate"] = 0.41

    event = parse_alert_frame(frame)

    assert event.alert_kind == "high_impact"
    assert event.rule_names == ()
    assert event.impact is not None
    assert event.impact["impact_score"] == 92
    assert event.impact["impact_tier"] == "high"
    assert event.impact["impact_direction"] == "bullish"
    assert event.impact["event_type"] == "fda_approval"
    assert event.impact["band_hit_rate"] == 0.41


def test_rule_match_frames_expose_default_kind_and_no_impact() -> None:
    event = parse_alert_frame(json.loads(alert_frame("plain-rule")))

    assert event.alert_kind == "rule_match"
    assert event.impact is None


def test_high_impact_frames_fetch_and_deliver_raw_bytes() -> None:
    frame = json.loads(alert_frame("impact-stream"))
    del frame["rules"]
    frame["alert_kind"] = "high_impact"
    frame["impact_score"] = 88

    async def response(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, content=b"impact-body", request=request)

    socket = ScriptedWebSocket([json.dumps(frame)])
    http = HTTPFactory(response)
    stream = AlertStream(
        API_KEY,
        _websocket_connector=ScriptedConnector([socket]),
        _http_client_factory=http,
        keepalive_interval_seconds=300,
        shutdown_grace_seconds=0.2,
    )
    try:
        event = stream.get(timeout=2)
        assert event.raw_bytes == b"impact-body"
        assert event.alert_kind == "high_impact"
        assert event.impact is not None
        assert event.impact["impact_score"] == 88
        assert event.rule_names == ()
        with pytest.raises(queue.Empty):
            stream.get_error(timeout=0.01)
    finally:
        stream.close()


def test_parse_derives_percent_encoded_article_id_from_permalink() -> None:
    article_url = "https://signed.rtpr.test/a/article%20one%2Fpart?exp=1776629999&sig=SIGNED"
    frame = json.loads(alert_frame("unused", article_url=article_url))

    event = parse_alert_frame(frame)

    assert event.article_id == "article one/part"
    assert event.article_url == article_url


@pytest.mark.parametrize(
    "change",
    [
        {"ticker": None},
        {"rules": []},
        {"rules": [{"wrong": "name"}]},
        {"alert_kind": "mystery"},
        {"article_published_at": "not-a-date"},
        {"article_url": "http://unsigned.test/a"},
        {"article_url": "https://signed.rtpr.test/not-a-permalink/article-invalid"},
        {"dispatched_at_ms": True},
    ],
)
def test_parse_rejects_invalid_contract_fields(change: dict[str, object]) -> None:
    frame = json.loads(alert_frame("article-invalid"))
    frame.update(change)
    with pytest.raises(ProtocolError):
        parse_alert_frame(frame)


def test_ping_pong_raw_bytes_and_thread_isolation() -> None:
    raw = b"\x00\xff<html>\r\n  exact bytes \x80</html>"
    socket = ScriptedWebSocket(
        ['{"type":"connected","channel":"alerts"}', '{"type":"ping"}', alert_frame("article-raw")]
    )
    connector = ScriptedConnector([socket])

    async def response(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={
                "Content-Type": "text/html; charset=utf-8",
                "CF-Ray": "ray-123",
                "Set-Cookie": "must-not-leak",
            },
            content=raw,
            request=request,
        )

    http = HTTPFactory(response)
    stream = AlertStream(
        API_KEY,
        _websocket_connector=connector,
        _http_client_factory=http,
        keepalive_interval_seconds=300,
        shutdown_grace_seconds=0.2,
    )
    try:
        stream.start(wait_until_connected=True)
        event = stream.get(timeout=2)

        assert event.raw_bytes == raw
        assert event.content_type == "text/html; charset=utf-8"
        assert event.headers == {
            "content-type": "text/html; charset=utf-8",
            "cf-ray": "ray-123",
        }
        assert event.timings["fetch_round_trip_ms"] >= 0
        assert "alert_received_at_utc" in event.utc_milestones
        assert "apparent_publish_to_dispatch_ms_wall_clock" in event.apparent_wall_clock
        with pytest.raises(TypeError):
            event.headers["other"] = "value"  # type: ignore[index]

        wait_until(lambda: socket.sent == ['{"type":"pong"}'])
        assert connector.urls == ["wss://ws.rtpr.io/ws-alerts?apiKey=TOP-SECRET-API-KEY"]
        assert connector.thread_ids == [stream.network_thread_ident]
        assert socket.send_thread_ids == [stream.network_thread_ident]
        assert http.factory_thread_ids == [stream.network_thread_ident]
        assert all(
            thread_id == stream.network_thread_ident for thread_id in http.request_thread_ids
        )
        article_request = next(request for request in http.requests if request.method == "GET")
        assert article_request.headers["x-api-key"] == API_KEY
        assert article_request.headers["accept-encoding"] == "identity"
        assert threading.get_ident() != stream.network_thread_ident
        assert stream.stats()["last_ping_at_utc"] is not None
    finally:
        stream.close()

    assert socket.closed.is_set()
    assert all(client.is_closed for client in http.clients)


def test_malformed_frame_is_reported_without_network_failure() -> None:
    socket = ScriptedWebSocket(["not-json"])
    connector = ScriptedConnector([socket])
    http = HTTPFactory(lambda request: httpx.Response(500, request=request))
    stream = AlertStream(
        API_KEY,
        _websocket_connector=connector,
        _http_client_factory=http,
        keepalive_interval_seconds=300,
        shutdown_grace_seconds=0.2,
    )
    try:
        stream.start(wait_until_connected=True)
        error = stream.get_error(timeout=1)
        assert isinstance(error, ProtocolError)
        assert stream.stats()["counters"]["protocol_errors"] == 1
        with pytest.raises(queue.Empty):
            stream.get_error(timeout=0.01)
    finally:
        stream.close()
