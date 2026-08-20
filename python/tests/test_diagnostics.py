from __future__ import annotations

import json

import httpx
from conftest import API_KEY, HTTPFactory, ScriptedConnector, ScriptedWebSocket, alert_frame

from rtpr import AlertStream
from rtpr.diagnostics import SCHEMA, DiagnosticCollector


def diagnostic_json(report: str) -> dict[str, object]:
    summary, marker, payload = report.split("\n", 2)
    assert summary
    assert marker == SCHEMA
    parsed = json.loads(payload)
    assert parsed["schema"] == SCHEMA
    return parsed


def test_event_and_window_reports_are_copy_ready_and_redacted() -> None:
    signed_url = (
        "https://signed.rtpr.test/a/diagnostic-id?signature=SIGNED-URL-SECRET&apiKey=QUERY-SECRET"
    )
    raw_secret = b"<html>RAW-CONTENT-SECRET</html>"
    rule_secret = "CUSTOMER-RULE-SECRET"

    async def response(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={
                "CF-Ray": "safe-ray",
                "CF-Cache-Status": "HIT",
                "Age": "2",
                "Content-Type": "text/html",
                "X-RTPR-Auth-Mode": "header",
                "X-RTPR-Origin-Ms": "7",
                "X-RTPR-Storage-Tier": "hot",
                "Server-Timing": (
                    "origin;dur=7;desc=token=HEADER-TOKEN, "
                    "edge;desc=customer.example.com, ip;desc=192.0.2.1"
                ),
                "Location": "https://must-not-appear.test/?secret=1",
                "Set-Cookie": "machine-id=private",
            },
            content=raw_secret,
            request=request,
        )

    socket = ScriptedWebSocket(
        [
            alert_frame(
                "diagnostic-id",
                rules=(rule_secret,),
                article_url=signed_url,
            )
        ]
    )
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
        event_payload = diagnostic_json(event.support_report())
        window_payload = diagnostic_json(stream.support_report(window_seconds=600))
    finally:
        stream.close()

    combined = json.dumps([event_payload, window_payload], sort_keys=True)
    for secret in (
        API_KEY,
        "QUERY-SECRET",
        "SIGNED-URL-SECRET",
        signed_url,
        raw_secret.decode(),
        rule_secret,
        "must-not-appear.test",
        "machine-id",
        "HEADER-TOKEN",
        "customer.example.com",
        "192.0.2.1",
    ):
        assert secret not in combined
    assert "article_url" not in combined

    def contains_key(value: object, forbidden: str) -> bool:
        if isinstance(value, dict):
            return forbidden in value or any(
                contains_key(item, forbidden) for item in value.values()
            )
        if isinstance(value, list):
            return any(contains_key(item, forbidden) for item in value)
        return False

    assert not contains_key(event_payload, "raw_bytes")
    assert not contains_key(window_payload, "raw_bytes")
    assert '"rules"' not in combined

    environment = event_payload["environment"]
    assert isinstance(environment, dict)
    assert set(environment) == {
        "sdk_version",
        "runtime_version",
        "os_family",
        "architecture",
        "configured_limits",
    }
    event_record = event_payload["event"]
    assert isinstance(event_record, dict)
    assert set(event_record["response_headers"]) == {
        "cf-ray",
        "cf-cache-status",
        "age",
        "content-type",
        "x-rtpr-auth-mode",
        "x-rtpr-origin-ms",
        "x-rtpr-storage-tier",
        "server-timing",
    }
    timings = event_record["timings"]
    assert {
        "fetch_start_delay_ms",
        "time_to_headers_ms",
        "body_read_ms",
        "fetch_round_trip_ms",
        "result_queue_lag_ms",
    }.issubset(timings)
    assert event_record["raw_byte_count"] == len(raw_secret)
    assert event_record["correlation"]["article_id"] == "diagnostic-id"
    assert event_record["correlation"]["sdk_session_id"]
    assert event_record["correlation"]["cf_ray"] == "safe-ray"
    assert event_record["http"]["redirect_followed"] is False
    assert "result_offered" in event_record["burst_state"]


def test_window_percentiles_are_computed_on_report_request() -> None:
    limits: dict[str, int | float] = {
        "max_in_flight": 8,
        "max_pending_fetches": 64,
        "result_queue_max_items": 64,
        "result_queue_max_bytes": 1024,
    }
    collector = DiagnosticCollector(capacity=10, limits=limits)
    for index, duration in enumerate((1.0, 2.0, 3.0, 4.0, 100.0), start=1):
        collector.record_success(
            article_id=f"id-{index}",
            raw_byte_count=index,
            status_code=200,
            attempts=1,
            timings={
                "fetch_start_delay_ms": 0,
                "time_to_headers_ms": duration / 2,
                "body_read_ms": duration / 2,
                "fetch_round_trip_ms": duration,
            },
            milestones={},
            apparent_wall_clock={},
            headers={},
        )

    payload = diagnostic_json(collector.window_report(window_seconds=600, stats={"state": "test"}))
    distribution = payload["duration_ms"]["fetch_round_trip_ms"]
    assert distribution == {
        "count": 5,
        "p50": 3.0,
        "p95": 80.8,
        "p99": 96.16,
        "max": 100.0,
    }
    assert len(payload["slow_article_ids"]) == 5
    assert payload["slow_article_ids"][0] == {
        "article_id": "id-5",
        "fetch_round_trip_ms": 100.0,
    }


def test_diagnostic_ring_is_fixed_size_and_slow_ids_are_bounded() -> None:
    collector = DiagnosticCollector(capacity=3, limits={})
    for index in range(10):
        collector.record_success(
            article_id=f"bounded-{index}",
            raw_byte_count=10_000_000,
            status_code=200,
            attempts=1,
            timings={"fetch_round_trip_ms": float(index)},
            milestones={},
            apparent_wall_clock={},
            headers={},
        )

    payload = diagnostic_json(collector.window_report(window_seconds=600, stats={}))
    assert payload["sample"]["metadata_records"] == 3
    assert payload["sample"]["ring_capacity"] == 3
    assert len(payload["slow_article_ids"]) == 3
    assert {item["article_id"] for item in payload["slow_article_ids"]} == {
        "bounded-7",
        "bounded-8",
        "bounded-9",
    }
