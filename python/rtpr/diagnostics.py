"""Bounded, redacted diagnostics for the RTPR alert stream."""

from __future__ import annotations

import json
import math
import platform
import re
import sys
import threading
import time
import uuid
from collections import deque
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

from rtpr._version import __version__
from rtpr.events import RawArticleEvent

SCHEMA = "RTPR_SUPPORT_DIAGNOSTIC_V1"
_TIMING_NAMES = (
    "fetch_start_delay_ms",
    "time_to_headers_ms",
    "body_read_ms",
    "fetch_round_trip_ms",
    "result_queue_lag_ms",
    "handler_start_lag_ms",
    "handler_duration_ms",
)
_SAFE_ID = re.compile(r"^[A-Za-z0-9_.:@-]{1,96}$")
_URL = re.compile(r"https?://[^\s\"'<>]+", re.IGNORECASE)
_CREDENTIAL = re.compile(
    r"\b(?:api[-_]?key|token|authorization|signature|sig)=[^&\s;,]+",
    re.IGNORECASE,
)
_IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_IPV6 = re.compile(r"\b(?:[a-f0-9]{1,4}:){2,7}[a-f0-9]{1,4}\b", re.IGNORECASE)
_HOSTNAME = re.compile(
    r"\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|dev|cloud|local)\b",
    re.IGNORECASE,
)


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_iso(value: datetime | None = None) -> str:
    current = value or utc_now()
    if current.tzinfo is None:
        current = current.replace(tzinfo=timezone.utc)
    return (
        current.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    )


def _safe_id(value: str) -> str:
    if _SAFE_ID.fullmatch(value):
        return value
    # Do not echo malformed IDs that could themselves contain a URL or query.
    import hashlib

    return f"redacted-id-{hashlib.sha256(value.encode('utf-8')).hexdigest()[:12]}"


def safe_diagnostic_id(value: str) -> str:
    """Return a bounded support-safe correlation identifier."""

    return _safe_id(value)


def _safe_article_path(value: str | None) -> str | None:
    if value is None:
        return None
    path = value.split("?", 1)[0].split("#", 1)[0]
    if not path.startswith("/") or any(character in path for character in "\r\n"):
        return "<redacted>"
    path = _CREDENTIAL.sub("<redacted-credential>", path)
    path = _IPV4.sub("<redacted-ip>", path)
    path = _IPV6.sub("<redacted-ip>", path)
    return _HOSTNAME.sub("<redacted-host>", path)[:512]


def _safe_header_value(value: str) -> str:
    redacted = _URL.sub("<redacted-url>", value)
    redacted = _CREDENTIAL.sub("<redacted-credential>", redacted)
    redacted = _IPV4.sub("<redacted-ip>", redacted)
    redacted = _IPV6.sub("<redacted-ip>", redacted)
    redacted = _HOSTNAME.sub("<redacted-host>", redacted)
    return redacted[:512]


def _environment(limits: Mapping[str, int | float]) -> dict[str, Any]:
    return {
        "sdk_version": __version__,
        "runtime_version": ".".join(str(part) for part in sys.version_info[:3]),
        "os_family": platform.system() or "unknown",
        "architecture": platform.machine() or "unknown",
        "configured_limits": dict(sorted(limits.items())),
    }


def _copy_ready(summary: str, payload: Mapping[str, Any]) -> str:
    return f"{summary}\n{SCHEMA}\n{json.dumps(payload, indent=2, sort_keys=True)}"


def _percentile(values: Iterable[float], percentile: float) -> float | None:
    ordered = sorted(float(value) for value in values if math.isfinite(float(value)))
    if not ordered:
        return None
    if len(ordered) == 1:
        return round(ordered[0], 3)
    position = (len(ordered) - 1) * percentile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return round(ordered[lower], 3)
    fraction = position - lower
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * fraction, 3)


def _distribution(values: Iterable[float]) -> dict[str, float | int | None]:
    materialized = tuple(values)
    return {
        "count": len(materialized),
        "p50": _percentile(materialized, 0.50),
        "p95": _percentile(materialized, 0.95),
        "p99": _percentile(materialized, 0.99),
        "max": round(max(materialized), 3) if materialized else None,
    }


class StreamStatistics:
    """Thread-safe counters and gauges used by public snapshots."""

    _COUNTERS = (
        "alerts_received",
        "alerts_accepted",
        "duplicates_suppressed",
        "fetches_started",
        "fetches_completed",
        "fetch_retries",
        "fetch_failures",
        "pending_overloads",
        "result_overloads",
        "results_delivered",
        "connections",
        "reconnects",
        "protocol_errors",
        "errors_emitted",
        "error_queue_overloads",
        "callback_failures",
        "keepalive_failures",
    )

    def __init__(self, limits: Mapping[str, int | float]) -> None:
        self._lock = threading.Lock()
        self._limits = dict(limits)
        self._counters = {name: 0 for name in self._COUNTERS}
        self._state = "new"
        self._connected = False
        self._active_fetches = 0
        self._active_fetches_high_water = 0
        self._pending_fetches = 0
        self._pending_fetches_high_water = 0
        self._result_items = 0
        self._result_bytes = 0
        self._result_items_high_water = 0
        self._result_bytes_high_water = 0
        self._worker_loop_lag_ms = 0.0
        self._worker_loop_lag_max_ms = 0.0
        self._last_ping_monotonic: float | None = None
        self._last_ping_at_utc: str | None = None
        self._keepalive: dict[str, Any] = {
            "healthy": None,
            "last_checked_at_utc": None,
            "last_success_at_utc": None,
            "status_code": None,
            "latency_ms": None,
        }
        self._started_monotonic = time.monotonic()
        self._started_at_utc = utc_iso()

    def increment(self, name: str, amount: int = 1) -> None:
        with self._lock:
            self._counters[name] = self._counters.get(name, 0) + amount

    def set_state(self, state: str) -> None:
        with self._lock:
            self._state = state

    def set_connected(self, connected: bool) -> None:
        with self._lock:
            self._connected = connected

    def active_fetch_delta(self, delta: int) -> None:
        with self._lock:
            self._active_fetches = max(0, self._active_fetches + delta)
            self._active_fetches_high_water = max(
                self._active_fetches_high_water, self._active_fetches
            )

    def note_pending(self, depth: int) -> None:
        with self._lock:
            self._pending_fetches = max(0, depth)
            self._pending_fetches_high_water = max(self._pending_fetches_high_water, depth)

    def note_result_queue(self, items: int, raw_bytes: int) -> None:
        with self._lock:
            self._result_items = max(0, items)
            self._result_bytes = max(0, raw_bytes)
            self._result_items_high_water = max(self._result_items_high_water, items)
            self._result_bytes_high_water = max(self._result_bytes_high_water, raw_bytes)

    def note_loop_lag(self, lag_ms: float) -> None:
        with self._lock:
            self._worker_loop_lag_ms = max(0.0, lag_ms)
            self._worker_loop_lag_max_ms = max(self._worker_loop_lag_max_ms, lag_ms)

    def note_ping(self, at_monotonic: float, at_utc: datetime) -> None:
        with self._lock:
            self._last_ping_monotonic = at_monotonic
            self._last_ping_at_utc = utc_iso(at_utc)

    def note_keepalive(
        self,
        *,
        healthy: bool,
        status_code: int | None,
        latency_ms: float | None,
        checked_at: datetime,
    ) -> None:
        with self._lock:
            self._keepalive["healthy"] = healthy
            self._keepalive["last_checked_at_utc"] = utc_iso(checked_at)
            self._keepalive["status_code"] = status_code
            self._keepalive["latency_ms"] = None if latency_ms is None else round(latency_ms, 3)
            if healthy:
                self._keepalive["last_success_at_utc"] = utc_iso(checked_at)
            else:
                self._counters["keepalive_failures"] += 1

    def snapshot(self) -> dict[str, Any]:
        now = time.monotonic()
        with self._lock:
            ping_age = (
                None
                if self._last_ping_monotonic is None
                else max(0.0, (now - self._last_ping_monotonic) * 1000)
            )
            return {
                "state": self._state,
                "connected": self._connected,
                "started_at_utc": self._started_at_utc,
                "uptime_ms": round((now - self._started_monotonic) * 1000, 3),
                "counters": dict(self._counters),
                "active_fetches": {
                    "current": self._active_fetches,
                    "high_water": self._active_fetches_high_water,
                    "limit": int(self._limits["max_in_flight"]),
                },
                "pending_fetches": {
                    "depth": self._pending_fetches,
                    "high_water": self._pending_fetches_high_water,
                    "limit": int(self._limits["max_pending_fetches"]),
                },
                "result_queue": {
                    "depth_items": self._result_items,
                    "depth_raw_bytes": self._result_bytes,
                    "high_water_items": self._result_items_high_water,
                    "high_water_raw_bytes": self._result_bytes_high_water,
                    "item_limit": int(self._limits["result_queue_max_items"]),
                    "raw_byte_limit": int(self._limits["result_queue_max_bytes"]),
                },
                "worker_loop_lag_ms": {
                    "last": round(self._worker_loop_lag_ms, 3),
                    "max": round(self._worker_loop_lag_max_ms, 3),
                },
                "last_ping_at_utc": self._last_ping_at_utc,
                "last_ping_age_ms": None if ping_age is None else round(ping_age, 3),
                "keepalive": dict(self._keepalive),
            }


@dataclass
class _DiagnosticRecord:
    token: int
    article_id: str
    recorded_monotonic: float
    recorded_at_utc: str
    outcome: str
    raw_byte_count: int | None = None
    status_code: int | None = None
    attempts: int | None = None
    timings: dict[str, float] = field(default_factory=dict)
    milestones: dict[str, str] = field(default_factory=dict)
    apparent_wall_clock: dict[str, float | None] = field(default_factory=dict)
    headers: dict[str, str] = field(default_factory=dict)
    error_type: str | None = None
    ticker: str | None = None
    dispatched_at_ms: int | None = None
    article_path: str | None = None
    attempt_reasons: tuple[str, ...] = ()
    burst_state: dict[str, Any] = field(default_factory=dict)
    keepalive: dict[str, Any] = field(default_factory=dict)


class DiagnosticCollector:
    """A fixed-size metadata-only ring.

    Raw article bytes, signed URLs, rule names, API keys, and exception text
    are never accepted by this collector.
    """

    def __init__(self, *, capacity: int, limits: Mapping[str, int | float]) -> None:
        self._capacity = capacity
        self._limits = dict(limits)
        self._session_id = str(uuid.uuid4())
        self._lock = threading.Lock()
        self._order: deque[int] = deque()
        self._records: dict[int, _DiagnosticRecord] = {}
        self._next_token = 1

    def _append(self, record: _DiagnosticRecord) -> int:
        with self._lock:
            while len(self._order) >= self._capacity:
                expired = self._order.popleft()
                self._records.pop(expired, None)
            self._order.append(record.token)
            self._records[record.token] = record
        return record.token

    def record_success(
        self,
        *,
        article_id: str,
        raw_byte_count: int,
        status_code: int,
        attempts: int,
        timings: Mapping[str, float],
        milestones: Mapping[str, str],
        apparent_wall_clock: Mapping[str, float | None],
        headers: Mapping[str, str],
        ticker: str | None = None,
        dispatched_at_ms: int | None = None,
        article_path: str | None = None,
        attempt_reasons: Iterable[str] = (),
        burst_state: Mapping[str, Any] | None = None,
        keepalive: Mapping[str, Any] | None = None,
    ) -> int:
        with self._lock:
            token = self._next_token
            self._next_token += 1
        return self._append(
            _DiagnosticRecord(
                token=token,
                article_id=_safe_id(article_id),
                recorded_monotonic=time.monotonic(),
                recorded_at_utc=utc_iso(),
                outcome="fetched",
                raw_byte_count=raw_byte_count,
                status_code=status_code,
                attempts=attempts,
                timings={name: float(value) for name, value in timings.items()},
                milestones=dict(milestones),
                apparent_wall_clock=dict(apparent_wall_clock),
                headers={name: _safe_header_value(value) for name, value in headers.items()},
                ticker=None if ticker is None else _safe_id(ticker),
                dispatched_at_ms=dispatched_at_ms,
                article_path=_safe_article_path(article_path),
                attempt_reasons=tuple(str(reason)[:64] for reason in attempt_reasons),
                burst_state=dict(burst_state or {}),
                keepalive=dict(keepalive or {}),
            )
        )

    def record_failure(
        self,
        *,
        article_id: str,
        error_type: str,
        status_code: int | None = None,
        timings: Mapping[str, float] | None = None,
        ticker: str | None = None,
        dispatched_at_ms: int | None = None,
        article_path: str | None = None,
        burst_state: Mapping[str, Any] | None = None,
    ) -> int:
        with self._lock:
            token = self._next_token
            self._next_token += 1
        return self._append(
            _DiagnosticRecord(
                token=token,
                article_id=_safe_id(article_id),
                recorded_monotonic=time.monotonic(),
                recorded_at_utc=utc_iso(),
                outcome="failed",
                status_code=status_code,
                timings=dict(timings or {}),
                error_type=error_type,
                ticker=None if ticker is None else _safe_id(ticker),
                dispatched_at_ms=dispatched_at_ms,
                article_path=_safe_article_path(article_path),
                burst_state=dict(burst_state or {}),
            )
        )

    def mark_delivery(
        self,
        token: int,
        *,
        result_queue_lag_ms: float,
        delivered_at_utc: str,
        burst_state: Mapping[str, Any] | None = None,
    ) -> None:
        with self._lock:
            record = self._records.get(token)
            if record is None:
                return
            record.outcome = "delivered"
            record.timings["result_queue_lag_ms"] = result_queue_lag_ms
            record.milestones["delivered_at_utc"] = delivered_at_utc
            if burst_state is not None:
                record.burst_state["delivered"] = dict(burst_state)

    def mark_handler_start(
        self,
        token: int,
        handler_start_lag_ms: float,
        handler_started_at_utc: str,
        burst_state: Mapping[str, Any] | None = None,
    ) -> None:
        with self._lock:
            record = self._records.get(token)
            if record is not None:
                record.timings["handler_start_lag_ms"] = handler_start_lag_ms
                record.milestones["handler_started_at_utc"] = handler_started_at_utc
                if burst_state is not None:
                    record.burst_state["handler_started"] = dict(burst_state)

    def mark_handler_duration(
        self,
        token: int,
        duration_ms: float,
        handler_completed_at_utc: str,
    ) -> None:
        with self._lock:
            record = self._records.get(token)
            if record is not None:
                record.timings["handler_duration_ms"] = duration_ms
                record.milestones["handler_completed_at_utc"] = handler_completed_at_utc

    def mark_handler_failure(self, token: int) -> None:
        with self._lock:
            record = self._records.get(token)
            if record is not None:
                record.outcome = "handler_failed"

    def mark_outcome(self, token: int, outcome: str) -> None:
        with self._lock:
            record = self._records.get(token)
            if record is not None:
                record.outcome = outcome

    def event_report(self, token: int, event: RawArticleEvent) -> str:
        with self._lock:
            record = self._records.get(token)
            if record is None:
                return standalone_event_report(event, limits=self._limits)
            payload_record = self._record_payload(record)

        payload = {
            "schema": SCHEMA,
            "scope": "event",
            "generated_at_utc": utc_iso(),
            "sdk_session_id": self._session_id,
            "environment": _environment(self._limits),
            "event": payload_record,
        }
        fetch_ms = payload_record["timings"].get("fetch_round_trip_ms")
        summary = (
            f"RTPR event diagnostic: article {payload_record['article_id']}; "
            f"{payload_record.get('raw_byte_count', 0)} raw bytes; "
            f"fetch {fetch_ms if fetch_ms is not None else 'n/a'} ms."
        )
        return _copy_ready(summary, payload)

    def window_report(
        self,
        *,
        window_seconds: float,
        stats: Mapping[str, Any],
    ) -> str:
        cutoff = time.monotonic() - window_seconds
        with self._lock:
            records = [
                self._copy_record(self._records[token])
                for token in self._order
                if self._records[token].recorded_monotonic >= cutoff
            ]

        distributions = {
            name: _distribution(
                record.timings[name] for record in records if name in record.timings
            )
            for name in _TIMING_NAMES
        }
        internal_values = [
            value
            for record in records
            if (
                value := record.apparent_wall_clock.get(
                    "apparent_publish_to_dispatch_ms_wall_clock"
                )
            )
            is not None
        ]
        transit_values = [
            value
            for record in records
            if (
                value := record.apparent_wall_clock.get(
                    "apparent_dispatch_to_receive_ms_wall_clock"
                )
            )
            is not None
        ]
        arrival_values = [
            internal + transit
            for record in records
            if (
                internal := record.apparent_wall_clock.get(
                    "apparent_publish_to_dispatch_ms_wall_clock"
                )
            )
            is not None
            and (
                transit := record.apparent_wall_clock.get(
                    "apparent_dispatch_to_receive_ms_wall_clock"
                )
            )
            is not None
        ]
        slowest = sorted(
            (
                (record.timings["fetch_round_trip_ms"], record.article_id)
                for record in records
                if "fetch_round_trip_ms" in record.timings
            ),
            reverse=True,
        )[:10]
        outcomes: dict[str, int] = {}
        for record in records:
            outcomes[record.outcome] = outcomes.get(record.outcome, 0) + 1
        counters = stats.get("counters", {})
        if not isinstance(counters, Mapping):
            counters = {}
        result_queue = stats.get("result_queue", {})
        pending_fetches = stats.get("pending_fetches", {})
        active_fetches = stats.get("active_fetches", {})

        payload = {
            "schema": SCHEMA,
            "scope": "window",
            "generated_at_utc": utc_iso(),
            "window_seconds": window_seconds,
            "sdk_session_id": self._session_id,
            "environment": _environment(self._limits),
            "sample": {
                "metadata_records": len(records),
                "ring_capacity": self._capacity,
                "outcomes": outcomes,
                "failures": sum(
                    count
                    for outcome, count in outcomes.items()
                    if outcome not in {"fetched", "delivered"}
                ),
                "retries": int(counters.get("fetch_retries", 0)),
                "overloads": int(counters.get("pending_overloads", 0))
                + int(counters.get("result_overloads", 0)),
            },
            "duration_ms": distributions,
            "canary_breakdown_ms": {
                "warning": (
                    "arrival/internal/transit use wall clocks that may differ; "
                    "fetch and SDK queue durations are monotonic"
                ),
                "arrival": _distribution(arrival_values),
                "internal": _distribution(internal_values),
                "transit": _distribution(transit_values),
                "fetch": distributions["fetch_round_trip_ms"],
                "fetch_start_delay": distributions["fetch_start_delay_ms"],
                "result_queue_lag": distributions["result_queue_lag_ms"],
                "handler_start_lag": distributions["handler_start_lag_ms"],
            },
            "slow_article_ids": [
                {"article_id": article_id, "fetch_round_trip_ms": round(duration, 3)}
                for duration, article_id in slowest
            ],
            "queue_high_water": {
                "active_fetches": active_fetches.get("high_water"),
                "pending_fetches": pending_fetches.get("high_water"),
                "result_items": result_queue.get("high_water_items"),
                "result_bytes": result_queue.get("high_water_raw_bytes"),
            },
            "stream_stats": dict(stats),
        }
        summary = (
            f"RTPR window diagnostic: {len(records)} metadata records over "
            f"{window_seconds:g}s; {outcomes.get('delivered', 0)} delivered."
        )
        return _copy_ready(summary, payload)

    @staticmethod
    def _copy_record(record: _DiagnosticRecord) -> _DiagnosticRecord:
        return _DiagnosticRecord(
            token=record.token,
            article_id=record.article_id,
            recorded_monotonic=record.recorded_monotonic,
            recorded_at_utc=record.recorded_at_utc,
            outcome=record.outcome,
            raw_byte_count=record.raw_byte_count,
            status_code=record.status_code,
            attempts=record.attempts,
            timings=dict(record.timings),
            milestones=dict(record.milestones),
            apparent_wall_clock=dict(record.apparent_wall_clock),
            headers=dict(record.headers),
            error_type=record.error_type,
            ticker=record.ticker,
            dispatched_at_ms=record.dispatched_at_ms,
            article_path=record.article_path,
            attempt_reasons=tuple(record.attempt_reasons),
            burst_state=dict(record.burst_state),
            keepalive=dict(record.keepalive),
        )

    def _record_payload(self, record: _DiagnosticRecord) -> dict[str, Any]:
        response_headers = dict(record.headers)
        return {
            "article_id": record.article_id,
            "recorded_at_utc": record.recorded_at_utc,
            "outcome": record.outcome,
            "raw_byte_count": record.raw_byte_count,
            "status_code": record.status_code,
            "attempts": record.attempts,
            "timings": {name: round(value, 3) for name, value in record.timings.items()},
            "utc_milestones": dict(record.milestones),
            "apparent_wall_clock": {
                name: None if value is None else round(value, 3)
                for name, value in record.apparent_wall_clock.items()
            },
            "response_headers": response_headers,
            "error_type": record.error_type,
            "correlation": {
                "sdk_session_id": self._session_id,
                "article_id": record.article_id,
                "ticker": record.ticker,
                "dispatched_at_ms": record.dispatched_at_ms,
                "article_path": record.article_path,
                "cf_ray": response_headers.get("cf-ray"),
            },
            "http": {
                "attempt_count": record.attempts,
                "attempt_reasons": list(record.attempt_reasons),
                "final_status": record.status_code,
                "response_byte_count": record.raw_byte_count,
                "content_type": response_headers.get("content-type"),
                "cf_cache_status": response_headers.get("cf-cache-status"),
                "age": response_headers.get("age"),
                "auth_mode": response_headers.get("x-rtpr-auth-mode"),
                "origin_ms": response_headers.get("x-rtpr-origin-ms"),
                "storage_tier": response_headers.get("x-rtpr-storage-tier"),
                "server_timing": response_headers.get("server-timing"),
                "redirect_followed": False,
            },
            "burst_state": dict(record.burst_state),
            "keepalive": dict(record.keepalive),
        }


def standalone_event_report(
    event: RawArticleEvent,
    *,
    limits: Mapping[str, int | float] | None = None,
) -> str:
    """Create a safe report for a manually reconstructed event."""

    configured_limits = dict(limits or {})
    session_id = str(uuid.uuid4())
    response_headers = {name: _safe_header_value(value) for name, value in event.headers.items()}
    payload = {
        "schema": SCHEMA,
        "scope": "event",
        "generated_at_utc": utc_iso(),
        "sdk_session_id": session_id,
        "environment": _environment(configured_limits),
        "event": {
            "article_id": _safe_id(event.article_id),
            "outcome": "detached",
            "raw_byte_count": len(event.raw_bytes),
            "status_code": event.status_code,
            "attempts": event.attempts,
            "timings": {name: round(float(value), 3) for name, value in event.timings.items()},
            "utc_milestones": dict(event.utc_milestones),
            "apparent_wall_clock": dict(event.apparent_wall_clock),
            "response_headers": response_headers,
            "correlation": {
                "sdk_session_id": session_id,
                "article_id": _safe_id(event.article_id),
                "ticker": _safe_id(event.ticker),
                "dispatched_at_ms": event.dispatched_at_ms,
                "article_path": _safe_article_path(urlsplit(event.article_url).path),
                "cf_ray": response_headers.get("cf-ray"),
            },
        },
    }
    summary = (
        f"RTPR event diagnostic: article {_safe_id(event.article_id)}; "
        f"{len(event.raw_bytes)} raw bytes."
    )
    return _copy_ready(summary, payload)
