"""Thread-isolated saved-rule alert streaming and raw article delivery."""

from __future__ import annotations

import asyncio
import inspect
import json
import logging
import queue
import random
import threading
import time
from collections import OrderedDict
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Mapping
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import unquote, urlencode, urlsplit

import httpx
import websockets

from rtpr._queues import BoundedResultQueue, QueuedResult, ResultQueueClosedError
from rtpr.diagnostics import (
    DiagnosticCollector,
    StreamStatistics,
    safe_diagnostic_id,
    utc_iso,
    utc_now,
)
from rtpr.events import ALLOWED_RESPONSE_HEADERS, AlertEvent, AlertRule, RawArticleEvent
from rtpr.exceptions import (
    AlertConnectionError,
    ArticleFetchError,
    AuthenticationError,
    AuthorizationError,
    BackpressureError,
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

WSS_ENDPOINT = "wss://ws.rtpr.io/ws-alerts"
KEEPALIVE_URL = "https://rtpr.io/a/_sdk_keepalive"
# 526 is Cloudflare failing TLS validation against the RTPR origin on an
# edge subrequest; observed transient in production, and the GET is idempotent.
_RETRYABLE_FETCH_STATUSES = frozenset({500, 502, 503, 504, 526})
_REDIRECT_STATUSES = frozenset({300, 301, 302, 303, 307, 308})
_ERROR_CALLBACK_STOP = object()
_logger = logging.getLogger("rtpr.alert_stream")

EventHandler = Callable[[RawArticleEvent], Any]
ErrorHandler = Callable[[RTPRError], Any]
WebSocketConnector = Callable[..., Any]
HTTPClientFactory = Callable[[], httpx.AsyncClient]


async def _await_callback_result(result: Awaitable[Any]) -> Any:
    return await result


@dataclass
class _PendingArticle:
    alert: AlertEvent
    received_burst_state: Mapping[str, Any]


@dataclass(frozen=True)
class _FetchedArticle:
    raw_bytes: bytes
    status_code: int
    headers: Mapping[str, str]
    timings: Mapping[str, float]
    milestones: Mapping[str, str]
    apparent_wall_clock: Mapping[str, float | None]
    attempts: int
    attempt_reasons: tuple[str, ...]
    burst_state: Mapping[str, Mapping[str, Any]]


def _parse_utc_datetime(value: object) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ProtocolError()
    candidate = value.strip()
    if candidate.endswith(("Z", "z")):
        candidate = f"{candidate[:-1]}+00:00"
    try:
        parsed = datetime.fromisoformat(candidate)
    except ValueError as exc:
        raise ProtocolError() from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _require_text(frame: Mapping[str, object], name: str) -> str:
    value = frame.get(name)
    if not isinstance(value, str) or not value.strip() or len(value) > 16 * 1024:
        raise ProtocolError()
    return value


def _article_id_from_url(article_url: str) -> str:
    parsed_url = urlsplit(article_url)
    if parsed_url.scheme != "https" or not parsed_url.netloc:
        raise ProtocolError()

    prefix = "/a/"
    if not parsed_url.path.startswith(prefix):
        raise ProtocolError()
    encoded_id = parsed_url.path[len(prefix) :]
    if not encoded_id or "/" in encoded_id:
        raise ProtocolError()
    try:
        article_id = unquote(encoded_id, encoding="utf-8", errors="strict")
    except UnicodeDecodeError:
        raise ProtocolError() from None
    if not article_id.strip() or len(article_id) > 16 * 1024:
        raise ProtocolError()
    return article_id


def parse_alert_frame(
    frame: Mapping[str, object],
    *,
    received_at: datetime | None = None,
    received_monotonic: float | None = None,
) -> AlertEvent:
    """Validate one saved-rule alert frame.

    The helper is public primarily so applications can deterministically test
    captured alert metadata without constructing an ``AlertStream``.  It does
    not fetch, persist, or transform article content.
    """

    if frame.get("type") != "alert":
        raise ProtocolError()
    ticker = _require_text(frame, "ticker")
    article_url = _require_text(frame, "article_url")
    article_id = _article_id_from_url(article_url)

    raw_rules = frame.get("rules")
    if not isinstance(raw_rules, list) or not raw_rules or len(raw_rules) > 256:
        raise ProtocolError()
    names: list[str] = []
    seen_names: set[str] = set()
    for raw_rule in raw_rules:
        if not isinstance(raw_rule, Mapping):
            raise ProtocolError()
        name = raw_rule.get("rule_name")
        if not isinstance(name, str) or not name.strip():
            raise ProtocolError()
        if name not in seen_names:
            seen_names.add(name)
            names.append(name)

    dispatched = frame.get("dispatched_at_ms")
    if isinstance(dispatched, bool) or not isinstance(dispatched, (int, float)):
        raise ProtocolError()
    dispatched_at_ms = int(dispatched)
    if dispatched_at_ms < 0 or float(dispatched) != dispatched_at_ms:
        raise ProtocolError()

    received = received_at or utc_now()
    if received.tzinfo is None:
        received = received.replace(tzinfo=timezone.utc)
    return AlertEvent(
        article_id=article_id,
        ticker=ticker,
        rules=tuple(AlertRule(rule_name=name) for name in names),
        article_published_at=_parse_utc_datetime(frame.get("article_published_at")),
        article_url=article_url,
        dispatched_at_ms=dispatched_at_ms,
        received_at=received.astimezone(timezone.utc),
        _received_monotonic=(
            time.monotonic() if received_monotonic is None else received_monotonic
        ),
    )


def _merge_alert_rules(existing: AlertEvent, incoming: AlertEvent) -> AlertEvent:
    names = set(existing.rule_names)
    additions = tuple(rule for rule in incoming.rules if rule.rule_name not in names)
    if not additions:
        return existing
    return replace(existing, rules=existing.rules + additions)


def _parse_retry_after(value: str | None) -> float | None:
    if value is None:
        return None
    candidate = value.strip()
    if not candidate:
        return None
    try:
        seconds = float(candidate)
    except ValueError:
        try:
            parsed = parsedate_to_datetime(candidate)
        except (TypeError, ValueError, OverflowError):
            return None
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        seconds = (parsed.astimezone(timezone.utc) - utc_now()).total_seconds()
    if seconds < 0:
        return 0.0
    return seconds


def _status_and_retry_after(error: BaseException) -> tuple[int | None, float | None]:
    status = getattr(error, "status_code", None)
    headers: Any = getattr(error, "headers", None)
    response = getattr(error, "response", None)
    if response is not None:
        status = getattr(response, "status_code", status)
        headers = getattr(response, "headers", headers)
    retry_after: str | None = None
    if headers is not None:
        try:
            retry_after = headers.get("retry-after")
        except (AttributeError, TypeError):
            retry_after = None
    return (status if isinstance(status, int) else None, _parse_retry_after(retry_after))


class AlertStream(Iterator[RawArticleEvent], AsyncIterator[RawArticleEvent]):
    """Push-only saved-rule alert stream with bounded raw-byte delivery.

    A dedicated thread owns the WebSocket, ``httpx.AsyncClient``, and its
    asyncio event loop.  Pull consumers run on their calling thread.  Callback
    consumers run on a separate callback thread, never on the network thread.
    Callback and pull/iterator consumption are intentionally mutually
    exclusive.
    """

    def __init__(
        self,
        api_key: str,
        *,
        max_in_flight: int = 32,
        max_pending_fetches: int = 256,
        result_queue_max_items: int = 64,
        result_queue_max_bytes: int = 64 * 1024 * 1024,
        fetch_deadline_seconds: float = 15.0,
        request_timeout_seconds: float = 10.0,
        fetch_max_attempts: int = 4,
        fetch_retry_base_seconds: float = 0.1,
        fetch_retry_max_seconds: float = 2.0,
        availability_404_retry_seconds: float = 2.0,
        dedupe_ttl_seconds: float = 600.0,
        dedupe_max_entries: int = 10_000,
        reconnect_base_seconds: float = 0.5,
        reconnect_max_seconds: float = 30.0,
        keepalive_interval_seconds: float = 60.0,
        websocket_ping_interval_seconds: float = 20.0,
        websocket_ping_timeout_seconds: float = 20.0,
        diagnostics_capacity: int = 2_048,
        max_error_queue_items: int = 1_024,
        shutdown_grace_seconds: float = 5.0,
        handler: EventHandler | None = None,
        error_handler: ErrorHandler | None = None,
        _websocket_connector: WebSocketConnector | None = None,
        _http_client_factory: HTTPClientFactory | None = None,
        _random_source: random.Random | None = None,
    ) -> None:
        if not isinstance(api_key, str) or not api_key:
            raise ValueError("api_key must be a non-empty string")
        positive_integers = {
            "max_in_flight": max_in_flight,
            "max_pending_fetches": max_pending_fetches,
            "result_queue_max_items": result_queue_max_items,
            "result_queue_max_bytes": result_queue_max_bytes,
            "fetch_max_attempts": fetch_max_attempts,
            "dedupe_max_entries": dedupe_max_entries,
            "diagnostics_capacity": diagnostics_capacity,
            "max_error_queue_items": max_error_queue_items,
        }
        for name, integer_value in positive_integers.items():
            if (
                isinstance(integer_value, bool)
                or not isinstance(integer_value, int)
                or integer_value <= 0
            ):
                raise ValueError(f"{name} must be a positive integer")
        positive_floats = {
            "fetch_deadline_seconds": fetch_deadline_seconds,
            "request_timeout_seconds": request_timeout_seconds,
            "fetch_retry_max_seconds": fetch_retry_max_seconds,
            "dedupe_ttl_seconds": dedupe_ttl_seconds,
            "reconnect_max_seconds": reconnect_max_seconds,
            "keepalive_interval_seconds": keepalive_interval_seconds,
            "websocket_ping_interval_seconds": websocket_ping_interval_seconds,
            "websocket_ping_timeout_seconds": websocket_ping_timeout_seconds,
            "shutdown_grace_seconds": shutdown_grace_seconds,
        }
        for name, float_value in positive_floats.items():
            if (
                isinstance(float_value, bool)
                or not isinstance(float_value, (int, float))
                or float_value <= 0
            ):
                raise ValueError(f"{name} must be greater than zero")
        nonnegative_floats = {
            "fetch_retry_base_seconds": fetch_retry_base_seconds,
            "availability_404_retry_seconds": availability_404_retry_seconds,
            "reconnect_base_seconds": reconnect_base_seconds,
        }
        for name, float_value in nonnegative_floats.items():
            if (
                isinstance(float_value, bool)
                or not isinstance(float_value, (int, float))
                or float_value < 0
            ):
                raise ValueError(f"{name} must be non-negative")
        self._api_key = api_key
        self._max_in_flight = max_in_flight
        self._max_pending_fetches = max_pending_fetches
        self._result_queue_max_items = result_queue_max_items
        self._result_queue_max_bytes = result_queue_max_bytes
        self._fetch_deadline_seconds = float(fetch_deadline_seconds)
        self._request_timeout_seconds = float(request_timeout_seconds)
        self._fetch_max_attempts = fetch_max_attempts
        self._fetch_retry_base_seconds = float(fetch_retry_base_seconds)
        self._fetch_retry_max_seconds = float(fetch_retry_max_seconds)
        self._availability_404_retry_seconds = float(availability_404_retry_seconds)
        self._dedupe_ttl_seconds = float(dedupe_ttl_seconds)
        self._dedupe_max_entries = dedupe_max_entries
        self._reconnect_base_seconds = float(reconnect_base_seconds)
        self._reconnect_max_seconds = float(reconnect_max_seconds)
        self._keepalive_interval_seconds = float(keepalive_interval_seconds)
        self._websocket_ping_interval_seconds = float(websocket_ping_interval_seconds)
        self._websocket_ping_timeout_seconds = float(websocket_ping_timeout_seconds)
        self._max_error_queue_items = max_error_queue_items
        self._shutdown_grace_seconds = float(shutdown_grace_seconds)
        self._websocket_connector = _websocket_connector or websockets.connect
        self._http_client_factory = _http_client_factory
        self._random = _random_source or random.Random()

        self._limits: dict[str, int | float] = {
            "max_in_flight": max_in_flight,
            "max_pending_fetches": max_pending_fetches,
            "result_queue_max_items": result_queue_max_items,
            "result_queue_max_bytes": result_queue_max_bytes,
            "fetch_deadline_seconds": float(fetch_deadline_seconds),
            "fetch_max_attempts": fetch_max_attempts,
            "dedupe_ttl_seconds": float(dedupe_ttl_seconds),
            "dedupe_max_entries": dedupe_max_entries,
            "diagnostics_capacity": diagnostics_capacity,
            "max_error_queue_items": max_error_queue_items,
        }
        self._stats = StreamStatistics(self._limits)
        self._diagnostics = DiagnosticCollector(
            capacity=diagnostics_capacity,
            limits=self._limits,
        )
        self._result_queue = BoundedResultQueue(
            max_items=result_queue_max_items,
            max_raw_bytes=result_queue_max_bytes,
            on_change=self._stats.note_result_queue,
        )
        self._error_queue: queue.Queue[RTPRError] = queue.Queue(maxsize=max_error_queue_items)
        self._error_callback_queue: queue.Queue[RTPRError | object] = queue.Queue(
            maxsize=max_error_queue_items
        )

        self._state_lock = threading.RLock()
        self._state = "new"
        self._consumption_mode: str | None = "callback" if handler is not None else None
        self._event_handler = handler
        self._error_handler = error_handler
        self._network_thread: threading.Thread | None = None
        self._callback_thread: threading.Thread | None = None
        self._error_callback_thread: threading.Thread | None = None
        self._network_thread_ident: int | None = None
        self._ready = threading.Event()
        self._stopped = threading.Event()
        self._connection_ready = threading.Event()
        self._stop_requested = threading.Event()
        self._thread_failure: RTPRError | None = None
        self._fatal_connection_error: RTPRError | None = None

        # These objects are created and used only by the network thread.
        self._loop: asyncio.AbstractEventLoop | None = None
        self._async_stop: asyncio.Event | None = None
        self._fetch_queue: asyncio.Queue[_PendingArticle] | None = None
        self._http_client: httpx.AsyncClient | None = None
        self._current_websocket: Any = None
        self._connection_opened = False
        self._latency_warning_emitted = False
        self._pending: dict[str, _PendingArticle] = {}
        self._delivered: OrderedDict[str, float] = OrderedDict()

    @property
    def network_thread_ident(self) -> int | None:
        """Identifier of the dedicated network thread, when running."""

        return self._network_thread_ident

    def start(
        self,
        *,
        wait_until_connected: bool = False,
        timeout: float | None = 10.0,
    ) -> AlertStream:
        """Start the dedicated network thread.

        By default this waits only for the private loop, workers, and HTTP
        client to be ready.  Set ``wait_until_connected=True`` to also wait for
        the first successful handshake and synchronously surface terminal
        HTTP 401/403 handshake errors.
        """

        with self._state_lock:
            if self._state == "closed":
                raise StreamClosedError()
            if self._state in {"starting", "running"}:
                if wait_until_connected:
                    self.wait_until_connected(timeout=timeout)
                return self
            if self._state == "closing":
                raise StreamStateError()
            self._state = "starting"
            self._stats.set_state("starting")
            self._start_callback_threads_locked()
            self._network_thread = threading.Thread(
                target=self._network_thread_main,
                name="rtpr-alert-network",
                daemon=False,
            )
            self._network_thread.start()

        if not self._ready.wait(timeout):
            self.close(timeout=self._shutdown_grace_seconds + 1)
            raise AlertConnectionError("The RTPR network thread did not become ready")
        if self._thread_failure is not None:
            raise self._thread_failure
        with self._state_lock:
            if self._state == "starting":
                self._state = "running"
                self._stats.set_state("running")
        if wait_until_connected:
            self.wait_until_connected(timeout=timeout)
        return self

    def wait_until_connected(self, timeout: float | None = 10.0) -> None:
        """Wait for the first successful WebSocket handshake."""

        if not self._connection_ready.wait(timeout):
            raise AlertConnectionError("Timed out waiting for the RTPR alert handshake")
        if self._fatal_connection_error is not None:
            raise self._fatal_connection_error

    def close(self, *, timeout: float | None = None) -> None:
        """Stop intake, finish bounded in-flight work, and close all transports."""

        requested_timeout = self._shutdown_grace_seconds + 2.0 if timeout is None else timeout
        with self._state_lock:
            if self._state == "closed":
                return
            if self._state == "new":
                self._state = "closed"
                self._stats.set_state("closed")
                self._result_queue.close()
                self._stop_callback_threads_locked(requested_timeout)
                self._stopped.set()
                return
            self._state = "closing"
            self._stats.set_state("closing")
            self._stop_requested.set()
            loop = self._loop
            async_stop = self._async_stop
            if loop is not None and async_stop is not None:
                loop.call_soon_threadsafe(async_stop.set)
            network_thread = self._network_thread

        if network_thread is not None and network_thread is not threading.current_thread():
            network_thread.join(requested_timeout)
            if network_thread.is_alive():
                raise ShutdownError()

        with self._state_lock:
            self._result_queue.close()
            self._stop_callback_threads_locked(requested_timeout)
            self._state = "closed"
            self._stats.set_state("closed")
            self._stopped.set()

    async def aclose(self, *, timeout: float | None = None) -> None:
        """Asynchronously wait for the synchronous clean shutdown."""

        await asyncio.to_thread(self.close, timeout=timeout)

    def __enter__(self) -> AlertStream:
        return self.start()

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: Any,
    ) -> None:
        self.close()

    async def __aenter__(self) -> AlertStream:
        return self.start()

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: Any,
    ) -> None:
        await self.aclose()

    def on_event(self, handler: EventHandler) -> EventHandler:
        """Register the sole event callback (also usable as a decorator)."""

        if not callable(handler):
            raise TypeError("handler must be callable")
        with self._state_lock:
            self._claim_consumption_mode_locked("callback")
            if self._event_handler is not None and self._event_handler is not handler:
                raise StreamStateError("Only one event callback can be registered")
            self._event_handler = handler
            if self._state in {"starting", "running"}:
                self._start_callback_threads_locked()
        return handler

    def on_error(self, handler: ErrorHandler) -> ErrorHandler:
        """Register the error callback (also usable as a decorator)."""

        if not callable(handler):
            raise TypeError("handler must be callable")
        with self._state_lock:
            if self._error_handler is not None and self._error_handler is not handler:
                raise StreamStateError("Only one error callback can be registered")
            self._error_handler = handler
            if self._state in {"starting", "running"}:
                self._start_callback_threads_locked()
        return handler

    def get(self, timeout: float | None = None) -> RawArticleEvent:
        """Return the next completed article, in completion order."""

        with self._state_lock:
            self._claim_consumption_mode_locked("pull")
        self.start()
        try:
            queued = self._result_queue.get(timeout)
        except ResultQueueClosedError as exc:
            raise StreamClosedError() from exc
        return self._materialize_delivery(queued)

    def get_error(self, timeout: float | None = None) -> RTPRError:
        """Return the next lifecycle, fetch, protocol, or overload error."""

        return self._error_queue.get(timeout=timeout)

    def poll_error(self) -> RTPRError | None:
        """Return one pending error, or ``None`` without blocking."""

        try:
            return self._error_queue.get_nowait()
        except queue.Empty:
            return None

    def __iter__(self) -> AlertStream:
        with self._state_lock:
            self._claim_consumption_mode_locked("pull")
        self.start()
        return self

    def __next__(self) -> RawArticleEvent:
        try:
            return self.get()
        except StreamClosedError as exc:
            raise StopIteration from exc

    def __aiter__(self) -> AlertStream:
        with self._state_lock:
            self._claim_consumption_mode_locked("pull")
        self.start()
        return self

    async def __anext__(self) -> RawArticleEvent:
        while True:
            try:
                queued = self._result_queue.get_nowait()
            except queue.Empty:
                await asyncio.sleep(0.01)
                continue
            except ResultQueueClosedError as exc:
                raise StopAsyncIteration from exc
            return self._materialize_delivery(queued)

    def stats(self) -> dict[str, Any]:
        """Return a thread-safe point-in-time snapshot."""

        return self._stats.snapshot()

    def _diagnostic_burst_state(self) -> dict[str, Any]:
        snapshot = self._stats.snapshot()
        counters = snapshot["counters"]
        return {
            "fetch_queue_depth": snapshot["pending_fetches"]["depth"],
            "result_queue_depth": snapshot["result_queue"]["depth_items"],
            "result_queue_bytes": snapshot["result_queue"]["depth_raw_bytes"],
            "active_fetches": snapshot["active_fetches"]["current"],
            "configured_concurrency": self._max_in_flight,
            "worker_loop_lag_ms": snapshot["worker_loop_lag_ms"]["last"],
            "reconnect_count": counters["reconnects"],
            "last_ping_age_ms": snapshot["last_ping_age_ms"],
            "retry_count": counters["fetch_retries"],
            "overload_count": (counters["pending_overloads"] + counters["result_overloads"]),
        }

    def support_report(self, window_seconds: float = 600.0) -> str:
        """Return a redacted, copy-ready window diagnostic."""

        if isinstance(window_seconds, bool) or window_seconds <= 0:
            raise ValueError("window_seconds must be greater than zero")
        return self._diagnostics.window_report(
            window_seconds=float(window_seconds),
            stats=self.stats(),
        )

    def _claim_consumption_mode_locked(self, requested: str) -> None:
        if self._consumption_mode is None:
            self._consumption_mode = requested
            return
        if self._consumption_mode != requested:
            raise ConsumptionModeError()

    def _start_callback_threads_locked(self) -> None:
        if self._event_handler is not None and (
            self._callback_thread is None or not self._callback_thread.is_alive()
        ):
            self._callback_thread = threading.Thread(
                target=self._event_callback_loop,
                name="rtpr-alert-callback",
                daemon=True,
            )
            self._callback_thread.start()
        if self._error_handler is not None and (
            self._error_callback_thread is None or not self._error_callback_thread.is_alive()
        ):
            self._error_callback_thread = threading.Thread(
                target=self._error_callback_loop,
                name="rtpr-error-callback",
                daemon=True,
            )
            self._error_callback_thread.start()

    def _stop_callback_threads_locked(self, timeout: float) -> None:
        callback_thread = self._callback_thread
        if callback_thread is not None and callback_thread is not threading.current_thread():
            callback_thread.join(max(0.0, timeout))

        error_thread = self._error_callback_thread
        if error_thread is not None and error_thread.is_alive():
            try:
                self._error_callback_queue.put_nowait(_ERROR_CALLBACK_STOP)
            except queue.Full:
                try:
                    self._error_callback_queue.get_nowait()
                except queue.Empty:
                    pass
                try:
                    self._error_callback_queue.put_nowait(_ERROR_CALLBACK_STOP)
                except queue.Full:
                    pass
        if error_thread is not None and error_thread is not threading.current_thread():
            error_thread.join(max(0.0, timeout))

    def _event_callback_loop(self) -> None:
        while True:
            try:
                queued = self._result_queue.get()
            except ResultQueueClosedError:
                return
            event = self._materialize_delivery(queued)
            handler_started = time.monotonic()
            handler_lag_ms = max(0.0, (handler_started - queued.enqueued_monotonic) * 1000)
            handler_milestone = utc_iso()
            timings = dict(event.timings)
            timings["handler_start_lag_ms"] = handler_lag_ms
            milestones = dict(event.utc_milestones)
            milestones["handler_started_at_utc"] = handler_milestone
            event = replace(event, timings=timings, utc_milestones=milestones)
            self._diagnostics.mark_handler_start(
                event._diagnostic_token,
                handler_lag_ms,
                handler_milestone,
                self._diagnostic_burst_state(),
            )
            try:
                handler = self._event_handler
                if handler is not None:
                    result = handler(event)
                    if inspect.isawaitable(result):
                        asyncio.run(_await_callback_result(result))
            except BaseException:
                self._stats.increment("callback_failures")
                self._diagnostics.mark_handler_failure(event._diagnostic_token)
                self._emit_error(HandlerError(article_id=event.article_id))
            finally:
                duration_ms = max(0.0, (time.monotonic() - handler_started) * 1000)
                self._diagnostics.mark_handler_duration(
                    event._diagnostic_token,
                    duration_ms,
                    utc_iso(),
                )

    def _error_callback_loop(self) -> None:
        while True:
            error = self._error_callback_queue.get()
            if error is _ERROR_CALLBACK_STOP:
                return
            handler = self._error_handler
            if handler is None or not isinstance(error, RTPRError):
                continue
            try:
                result = handler(error)
                if inspect.isawaitable(result):
                    asyncio.run(_await_callback_result(result))
            except BaseException:
                self._stats.increment("callback_failures")

    def _materialize_delivery(self, queued: QueuedResult) -> RawArticleEvent:
        delivered_monotonic = time.monotonic()
        delivered_at = utc_iso()
        queue_lag_ms = max(0.0, (delivered_monotonic - queued.enqueued_monotonic) * 1000)
        timings = dict(queued.event.timings)
        timings["result_queue_lag_ms"] = queue_lag_ms
        milestones = dict(queued.event.utc_milestones)
        milestones["delivered_at_utc"] = delivered_at
        event = replace(
            queued.event,
            timings=timings,
            utc_milestones=milestones,
        )
        self._diagnostics.mark_delivery(
            event._diagnostic_token,
            result_queue_lag_ms=queue_lag_ms,
            delivered_at_utc=delivered_at,
            burst_state=self._diagnostic_burst_state(),
        )
        self._stats.increment("results_delivered")
        return event

    def _emit_error(self, error: RTPRError) -> None:
        self._stats.increment("errors_emitted")
        try:
            self._error_queue.put_nowait(error)
        except queue.Full:
            self._stats.increment("error_queue_overloads")
            try:
                self._error_queue.get_nowait()
            except queue.Empty:
                pass
            try:
                self._error_queue.put_nowait(error)
            except queue.Full:
                self._stats.increment("error_queue_overloads")

        if self._error_handler is not None:
            try:
                self._error_callback_queue.put_nowait(error)
            except queue.Full:
                self._stats.increment("error_queue_overloads")

    def _network_thread_main(self) -> None:
        self._network_thread_ident = threading.get_ident()
        loop = asyncio.new_event_loop()
        self._loop = loop
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(self._network_main())
        except BaseException:
            failure = AlertConnectionError("The RTPR network thread stopped unexpectedly")
            self._thread_failure = failure
            self._emit_error(failure)
        finally:
            self._stats.set_connected(False)
            try:
                loop.run_until_complete(loop.shutdown_asyncgens())
            except BaseException:
                pass
            asyncio.set_event_loop(None)
            loop.close()
            self._loop = None
            self._result_queue.close()
            self._ready.set()
            self._connection_ready.set()
            self._stopped.set()

    async def _network_main(self) -> None:
        self._async_stop = asyncio.Event()
        self._fetch_queue = asyncio.Queue(maxsize=self._max_pending_fetches)
        try:
            self._http_client = self._make_http_client()
        except BaseException:
            self._thread_failure = AlertConnectionError(
                "The RTPR HTTP client could not be initialized"
            )
            self._ready.set()
            return

        workers = [
            asyncio.create_task(self._fetch_worker(index), name=f"rtpr-fetch-{index}")
            for index in range(self._max_in_flight)
        ]
        websocket_task = asyncio.create_task(self._websocket_supervisor(), name="rtpr-websocket")
        keepalive_task = asyncio.create_task(self._keepalive_loop(), name="rtpr-keepalive")
        loop_lag_task = asyncio.create_task(self._loop_lag_monitor(), name="rtpr-loop-lag")
        self._ready.set()
        if self._stop_requested.is_set():
            self._async_stop.set()

        await self._async_stop.wait()
        self._stats.set_connected(False)

        websocket_task.cancel()
        keepalive_task.cancel()
        loop_lag_task.cancel()
        current_websocket = self._current_websocket
        if current_websocket is not None:
            try:
                await current_websocket.close(code=1000, reason="client shutdown")
            except BaseException:
                pass

        await asyncio.gather(
            websocket_task,
            keepalive_task,
            loop_lag_task,
            return_exceptions=True,
        )

        fetch_queue = self._fetch_queue
        try:
            await asyncio.wait_for(fetch_queue.join(), timeout=self._shutdown_grace_seconds)
        except asyncio.TimeoutError:
            pass
        for worker in workers:
            worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)

        while not fetch_queue.empty():
            try:
                pending = fetch_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
            self._pending.pop(pending.alert.article_id, None)
            fetch_queue.task_done()
        self._stats.note_pending(0)

        client = self._http_client
        self._http_client = None
        if client is not None:
            try:
                await client.aclose()
            except BaseException:
                pass

    def _make_http_client(self) -> httpx.AsyncClient:
        if self._http_client_factory is not None:
            return self._http_client_factory()
        # keepalive_expiry must outlive the keepalive heartbeat interval;
        # httpx's 5-second default would close idle pool connections between
        # heartbeats and turn every post-lull fetch into a cold TLS handshake.
        keepalive_expiry = max(120.0, self._keepalive_interval_seconds * 2)
        return httpx.AsyncClient(
            follow_redirects=False,
            timeout=httpx.Timeout(self._request_timeout_seconds),
            headers={"User-Agent": "rtpr-python/0.2.0"},
            limits=httpx.Limits(
                max_connections=self._max_in_flight,
                max_keepalive_connections=self._max_in_flight,
                keepalive_expiry=keepalive_expiry,
            ),
        )

    async def _websocket_supervisor(self) -> None:
        reconnect_attempt = 0
        while self._async_stop is not None and not self._async_stop.is_set():
            self._connection_opened = False
            try:
                await self._run_websocket_connection()
                if self._async_stop.is_set():
                    return
                error: RTPRError = AlertConnectionError(
                    "The RTPR alert connection closed; reconnecting"
                )
            except asyncio.CancelledError:
                raise
            except BaseException as raw_error:
                error = self._map_connection_error(raw_error)

            self._stats.set_connected(False)
            self._emit_error(error)
            if isinstance(error, (AuthenticationError, AuthorizationError)):
                self._fatal_connection_error = error
                with self._state_lock:
                    self._state = "failed"
                    self._stats.set_state("failed")
                self._connection_ready.set()
                self._async_stop.set()
                return

            if self._connection_opened:
                reconnect_attempt = 0
            reconnect_attempt += 1
            self._stats.increment("reconnects")
            delay = self._reconnect_delay(
                reconnect_attempt,
                retry_after_seconds=error.retry_after_seconds,
            )
            if await self._wait_for_stop(delay):
                return

    async def _run_websocket_connection(self) -> None:
        url = f"{WSS_ENDPOINT}?{urlencode({'apiKey': self._api_key})}"
        connector = self._websocket_connector
        async with connector(
            url,
            ping_interval=self._websocket_ping_interval_seconds,
            ping_timeout=self._websocket_ping_timeout_seconds,
            close_timeout=min(self._shutdown_grace_seconds, 5.0),
            max_queue=16,
            max_size=1024 * 1024,
        ) as websocket:
            self._current_websocket = websocket
            self._connection_opened = True
            self._stats.increment("connections")
            self._stats.set_connected(True)
            self._connection_ready.set()
            try:
                async for message in websocket:
                    if self._async_stop is not None and self._async_stop.is_set():
                        return
                    await self._handle_websocket_message(websocket, message)
            finally:
                self._current_websocket = None
                self._stats.set_connected(False)

    def _map_connection_error(self, error: BaseException) -> RTPRError:
        if isinstance(error, RTPRError):
            return error
        status_code, retry_after = _status_and_retry_after(error)
        if status_code == 401:
            return AuthenticationError(retry_after_seconds=retry_after)
        if status_code == 403:
            return AuthorizationError(retry_after_seconds=retry_after)
        if status_code == 429:
            return RateLimitError(retry_after_seconds=retry_after)
        if status_code is not None:
            return AlertConnectionError(
                f"RTPR alert handshake failed (HTTP {status_code})",
                status_code=status_code,
                retry_after_seconds=retry_after,
            )
        return AlertConnectionError()

    async def _handle_websocket_message(self, websocket: Any, message: object) -> None:
        received_monotonic = time.monotonic()
        received_at = utc_now()
        if isinstance(message, bytes):
            try:
                text = message.decode("utf-8")
            except UnicodeDecodeError:
                self._stats.increment("protocol_errors")
                self._emit_error(ProtocolError())
                return
        elif isinstance(message, str):
            text = message
        else:
            self._stats.increment("protocol_errors")
            self._emit_error(ProtocolError())
            return

        try:
            decoded = json.loads(text)
        except (TypeError, ValueError):
            self._stats.increment("protocol_errors")
            self._emit_error(ProtocolError())
            return
        if not isinstance(decoded, dict):
            self._stats.increment("protocol_errors")
            self._emit_error(ProtocolError())
            return

        if decoded.get("type") == "ping":
            await websocket.send('{"type":"pong"}')
            self._stats.note_ping(received_monotonic, received_at)
            return
        if decoded.get("type") == "connected":
            return

        self._stats.increment("alerts_received")
        try:
            alert = parse_alert_frame(
                decoded,
                received_at=received_at,
                received_monotonic=received_monotonic,
            )
        except ProtocolError as error:
            self._stats.increment("protocol_errors")
            self._emit_error(error)
            return
        self._accept_alert(alert)

    def _accept_alert(self, alert: AlertEvent) -> None:
        now = time.monotonic()
        self._expire_dedupe(now)
        existing = self._pending.get(alert.article_id)
        if existing is not None:
            existing.alert = _merge_alert_rules(existing.alert, alert)
            self._stats.increment("duplicates_suppressed")
            return
        if alert.article_id in self._delivered:
            self._delivered[alert.article_id] = now + self._dedupe_ttl_seconds
            self._delivered.move_to_end(alert.article_id)
            self._stats.increment("duplicates_suppressed")
            return

        fetch_queue = self._fetch_queue
        if fetch_queue is None or fetch_queue.full():
            self._reject_pending_alert(alert)
            return
        pending = _PendingArticle(
            alert=alert,
            received_burst_state=self._diagnostic_burst_state(),
        )
        self._pending[alert.article_id] = pending
        try:
            fetch_queue.put_nowait(pending)
        except asyncio.QueueFull:
            self._pending.pop(alert.article_id, None)
            self._reject_pending_alert(alert)
            return
        self._stats.increment("alerts_accepted")
        self._stats.note_pending(fetch_queue.qsize())

    def _reject_pending_alert(self, alert: AlertEvent) -> None:
        self._stats.increment("pending_overloads")
        self._diagnostics.record_failure(
            article_id=alert.article_id,
            error_type="BackpressureError",
            ticker=alert.ticker,
            dispatched_at_ms=alert.dispatched_at_ms,
            article_path=urlsplit(alert.article_url).path,
            burst_state={"alert_rejected": self._diagnostic_burst_state()},
        )
        self._emit_error(
            BackpressureError(
                article_id=alert.article_id,
                article_url=alert.article_url,
                stage="pending_fetches",
                item_limit=self._max_pending_fetches,
            )
        )

    def _expire_dedupe(self, now: float) -> None:
        while self._delivered:
            article_id, expires_at = next(iter(self._delivered.items()))
            if expires_at > now:
                break
            self._delivered.pop(article_id, None)

    def _mark_dedupe_delivered(self, article_id: str) -> None:
        self._delivered[article_id] = time.monotonic() + self._dedupe_ttl_seconds
        self._delivered.move_to_end(article_id)
        while len(self._delivered) > self._dedupe_max_entries:
            self._delivered.popitem(last=False)

    async def _fetch_worker(self, worker_index: int) -> None:
        del worker_index
        fetch_queue = self._fetch_queue
        if fetch_queue is None:
            return
        while True:
            pending = await fetch_queue.get()
            self._stats.active_fetch_delta(1)
            self._stats.increment("fetches_started")
            self._stats.note_pending(fetch_queue.qsize())
            succeeded = False
            try:
                fetched = await self._fetch_article(
                    pending.alert,
                    received_burst_state=pending.received_burst_state,
                )
                self._stats.increment("fetches_completed")
                latest_alert = pending.alert
                token = self._diagnostics.record_success(
                    article_id=latest_alert.article_id,
                    raw_byte_count=len(fetched.raw_bytes),
                    status_code=fetched.status_code,
                    attempts=fetched.attempts,
                    timings=fetched.timings,
                    milestones=fetched.milestones,
                    apparent_wall_clock=fetched.apparent_wall_clock,
                    headers=fetched.headers,
                    ticker=latest_alert.ticker,
                    dispatched_at_ms=latest_alert.dispatched_at_ms,
                    article_path=urlsplit(latest_alert.article_url).path,
                    attempt_reasons=fetched.attempt_reasons,
                    burst_state={
                        **fetched.burst_state,
                        "result_offered": self._diagnostic_burst_state(),
                    },
                    keepalive=self.stats()["keepalive"],
                )
                event = RawArticleEvent(
                    alert=latest_alert,
                    raw_bytes=fetched.raw_bytes,
                    status_code=fetched.status_code,
                    headers=fetched.headers,
                    timings=fetched.timings,
                    utc_milestones=fetched.milestones,
                    apparent_wall_clock=fetched.apparent_wall_clock,
                    attempts=fetched.attempts,
                    _diagnostic_token=token,
                    _reporter=self._diagnostics,
                )
                queued = QueuedResult(
                    event=event,
                    enqueued_monotonic=time.monotonic(),
                    enqueued_at=utc_now(),
                )
                if self._result_queue.put_nowait(queued):
                    self._mark_dedupe_delivered(latest_alert.article_id)
                    succeeded = True
                    if not self._latency_warning_emitted and (
                        fetched.timings["fetch_start_delay_ms"] >= 5.0
                        or fetched.timings["fetch_round_trip_ms"] >= 500.0
                    ):
                        self._latency_warning_emitted = True
                        _logger.warning(
                            "RTPR latency threshold crossed for article_id=%r; "
                            "copy diagnostics with event.support_report()",
                            safe_diagnostic_id(latest_alert.article_id),
                        )
                else:
                    self._stats.increment("result_overloads")
                    self._diagnostics.mark_outcome(token, "result_queue_overloaded")
                    self._emit_error(
                        BackpressureError(
                            article_id=latest_alert.article_id,
                            article_url=latest_alert.article_url,
                            stage="result_queue",
                            item_limit=self._result_queue_max_items,
                            byte_limit=self._result_queue_max_bytes,
                        )
                    )
            except asyncio.CancelledError:
                raise
            except RTPRError as error:
                self._stats.increment("fetch_failures")
                if isinstance(error, BackpressureError):
                    self._stats.increment("result_overloads")
                self._diagnostics.record_failure(
                    article_id=pending.alert.article_id,
                    error_type=type(error).__name__,
                    status_code=error.status_code,
                    ticker=pending.alert.ticker,
                    dispatched_at_ms=pending.alert.dispatched_at_ms,
                    article_path=urlsplit(pending.alert.article_url).path,
                    burst_state={"fetch_failed": self._diagnostic_burst_state()},
                )
                self._emit_error(error)
            except BaseException:
                self._stats.increment("fetch_failures")
                fetch_error = ArticleFetchError(
                    article_id=pending.alert.article_id,
                    article_url=pending.alert.article_url,
                )
                self._diagnostics.record_failure(
                    article_id=pending.alert.article_id,
                    error_type=type(fetch_error).__name__,
                    ticker=pending.alert.ticker,
                    dispatched_at_ms=pending.alert.dispatched_at_ms,
                    article_path=urlsplit(pending.alert.article_url).path,
                    burst_state={"fetch_failed": self._diagnostic_burst_state()},
                )
                self._emit_error(fetch_error)
            finally:
                if not succeeded:
                    self._delivered.pop(pending.alert.article_id, None)
                self._pending.pop(pending.alert.article_id, None)
                self._stats.note_pending(fetch_queue.qsize())
                self._stats.active_fetch_delta(-1)
                fetch_queue.task_done()

    async def _fetch_article(
        self,
        alert: AlertEvent,
        *,
        received_burst_state: Mapping[str, Any],
    ) -> _FetchedArticle:
        client = self._http_client
        if client is None:
            raise ArticleFetchError(
                article_id=alert.article_id,
                article_url=alert.article_url,
            )
        absolute_deadline = alert._received_monotonic + self._fetch_deadline_seconds
        first_start_monotonic: float | None = None
        first_started_at: datetime | None = None
        attempt = 0
        last_was_network_error = False
        attempt_reasons = ["initial"]
        burst_state: dict[str, Mapping[str, Any]] = {
            "alert_received": dict(received_burst_state),
        }

        while attempt < self._fetch_max_attempts:
            now = time.monotonic()
            remaining = absolute_deadline - now
            if remaining <= 0:
                raise FetchDeadlineError(
                    article_id=alert.article_id,
                    article_url=alert.article_url,
                )
            attempt += 1
            request_started = now
            request_started_at = utc_now()
            if first_start_monotonic is None:
                first_start_monotonic = request_started
                first_started_at = request_started_at
                burst_state["fetch_submitted"] = self._diagnostic_burst_state()
            timeout = httpx.Timeout(min(self._request_timeout_seconds, remaining))
            retry_status: int | None = None
            retry_after: float | None = None
            retry_reason: str | None = None

            try:
                async with client.stream(
                    "GET",
                    alert.article_url,
                    headers={
                        "X-API-Key": self._api_key,
                        "Accept-Encoding": "identity",
                    },
                    timeout=timeout,
                    follow_redirects=False,
                ) as response:
                    headers_received = time.monotonic()
                    headers_received_at = utc_now()
                    burst_state["headers_received"] = self._diagnostic_burst_state()
                    status = response.status_code

                    if status == 401:
                        raise AuthenticationError(
                            article_id=alert.article_id,
                            article_url=alert.article_url,
                        )
                    if status == 403:
                        raise AuthorizationError(
                            article_id=alert.article_id,
                            article_url=alert.article_url,
                        )
                    if status == 429:
                        raise RateLimitError(
                            retry_after_seconds=_parse_retry_after(
                                response.headers.get("retry-after")
                            ),
                            article_id=alert.article_id,
                            article_url=alert.article_url,
                        )
                    if status in _REDIRECT_STATUSES:
                        raise RedirectRejectedError(
                            status,
                            article_id=alert.article_id,
                            article_url=alert.article_url,
                        )
                    is_brief_404 = (
                        status == 404
                        and request_started - alert._received_monotonic
                        <= self._availability_404_retry_seconds
                    )
                    if status in _RETRYABLE_FETCH_STATUSES or is_brief_404:
                        retry_status = status
                        retry_reason = (
                            "availability_404" if is_brief_404 else f"retryable_http_{status}"
                        )
                        retry_after = _parse_retry_after(response.headers.get("retry-after"))
                    elif not 200 <= status < 300:
                        raise FetchHTTPError(
                            status,
                            article_id=alert.article_id,
                            article_url=alert.article_url,
                        )
                    else:
                        content_length = response.headers.get("content-length")
                        if content_length is not None:
                            try:
                                announced_size = int(content_length)
                            except ValueError:
                                announced_size = -1
                            if announced_size > self._result_queue_max_bytes:
                                raise BackpressureError(
                                    article_id=alert.article_id,
                                    article_url=alert.article_url,
                                    stage="article_size",
                                    item_limit=self._result_queue_max_items,
                                    byte_limit=self._result_queue_max_bytes,
                                )

                        chunks: list[bytes] = []
                        body_size = 0
                        if response.is_stream_consumed:
                            body_size = len(response.content)
                            if body_size > self._result_queue_max_bytes:
                                raise BackpressureError(
                                    article_id=alert.article_id,
                                    article_url=alert.article_url,
                                    stage="article_size",
                                    item_limit=self._result_queue_max_items,
                                    byte_limit=self._result_queue_max_bytes,
                                )
                            chunks.append(response.content)
                        else:
                            async for chunk in response.aiter_raw():
                                body_size += len(chunk)
                                if body_size > self._result_queue_max_bytes:
                                    raise BackpressureError(
                                        article_id=alert.article_id,
                                        article_url=alert.article_url,
                                        stage="article_size",
                                        item_limit=self._result_queue_max_items,
                                        byte_limit=self._result_queue_max_bytes,
                                    )
                                chunks.append(chunk)
                        body_finished = time.monotonic()
                        body_finished_at = utc_now()
                        burst_state["body_completed"] = self._diagnostic_burst_state()
                        assert first_start_monotonic is not None
                        assert first_started_at is not None
                        timings = {
                            "fetch_start_delay_ms": max(
                                0.0,
                                (first_start_monotonic - alert._received_monotonic) * 1000,
                            ),
                            "time_to_headers_ms": max(
                                0.0, (headers_received - request_started) * 1000
                            ),
                            "body_read_ms": max(0.0, (body_finished - headers_received) * 1000),
                            "fetch_round_trip_ms": max(
                                0.0,
                                (body_finished - first_start_monotonic) * 1000,
                            ),
                        }
                        milestones = {
                            "alert_received_at_utc": utc_iso(alert.received_at),
                            "fetch_started_at_utc": utc_iso(first_started_at),
                            "headers_received_at_utc": utc_iso(headers_received_at),
                            "body_received_at_utc": utc_iso(body_finished_at),
                        }
                        apparent = {
                            "apparent_publish_to_dispatch_ms_wall_clock": (
                                alert.dispatched_at_ms
                                - alert.article_published_at.timestamp() * 1000
                            ),
                            "apparent_dispatch_to_receive_ms_wall_clock": (
                                alert.received_at.timestamp() * 1000 - alert.dispatched_at_ms
                            ),
                        }
                        safe_headers = {
                            name.lower(): value
                            for name, value in response.headers.items()
                            if name.lower() in ALLOWED_RESPONSE_HEADERS
                        }
                        return _FetchedArticle(
                            raw_bytes=b"".join(chunks),
                            status_code=status,
                            headers=safe_headers,
                            timings=timings,
                            milestones=milestones,
                            apparent_wall_clock=apparent,
                            attempts=attempt,
                            attempt_reasons=tuple(attempt_reasons),
                            burst_state=burst_state,
                        )
            except asyncio.CancelledError:
                raise
            except (BackpressureError, AuthenticationError, AuthorizationError):
                raise
            except (RateLimitError, RedirectRejectedError, FetchHTTPError):
                raise
            except httpx.TransportError:
                last_was_network_error = True
                retry_status = None
                retry_reason = "network_error"

            if attempt >= self._fetch_max_attempts:
                if last_was_network_error:
                    raise FetchNetworkError(
                        article_id=alert.article_id,
                        article_url=alert.article_url,
                    )
                assert retry_status is not None
                raise FetchHTTPError(
                    retry_status,
                    article_id=alert.article_id,
                    article_url=alert.article_url,
                )

            self._stats.increment("fetch_retries")
            attempt_reasons.append(retry_reason or "retry")
            await self._sleep_fetch_retry(
                attempt,
                absolute_deadline=absolute_deadline,
                retry_after_seconds=retry_after,
                article_id=alert.article_id,
                article_url=alert.article_url,
            )
            last_was_network_error = False

        raise FetchDeadlineError(
            article_id=alert.article_id,
            article_url=alert.article_url,
        )

    async def _sleep_fetch_retry(
        self,
        attempt: int,
        *,
        absolute_deadline: float,
        retry_after_seconds: float | None,
        article_id: str,
        article_url: str,
    ) -> None:
        if retry_after_seconds is not None:
            delay = min(retry_after_seconds, self._fetch_retry_max_seconds)
        else:
            ceiling = min(
                self._fetch_retry_max_seconds,
                self._fetch_retry_base_seconds * (2 ** max(0, attempt - 1)),
            )
            delay = self._random.uniform(0.0, ceiling)
        remaining = absolute_deadline - time.monotonic()
        if remaining <= 0 or delay >= remaining:
            raise FetchDeadlineError(
                article_id=article_id,
                article_url=article_url,
            )
        if delay > 0:
            await asyncio.sleep(delay)

    def _reconnect_delay(
        self,
        attempt: int,
        *,
        retry_after_seconds: float | None,
    ) -> float:
        if retry_after_seconds is not None:
            return min(retry_after_seconds, self._reconnect_max_seconds)
        ceiling = min(
            self._reconnect_max_seconds,
            self._reconnect_base_seconds * (2 ** max(0, attempt - 1)),
        )
        return self._random.uniform(0.0, ceiling)

    async def _wait_for_stop(self, delay: float) -> bool:
        async_stop = self._async_stop
        if async_stop is None:
            return True
        if delay <= 0:
            await asyncio.sleep(0)
            return async_stop.is_set()
        try:
            await asyncio.wait_for(async_stop.wait(), timeout=delay)
        except asyncio.TimeoutError:
            return False
        return True

    async def _keepalive_loop(self) -> None:
        while self._async_stop is not None and not self._async_stop.is_set():
            await self._run_keepalive()
            if await self._wait_for_stop(self._keepalive_interval_seconds):
                return

    async def _run_keepalive(self) -> None:
        client = self._http_client
        if client is None:
            return
        started = time.monotonic()
        checked_at = utc_now()
        try:
            response = await client.head(
                KEEPALIVE_URL,
                headers={"Accept-Encoding": "identity"},
                timeout=httpx.Timeout(
                    min(self._request_timeout_seconds, self._keepalive_interval_seconds)
                ),
                follow_redirects=False,
            )
            latency_ms = max(0.0, (time.monotonic() - started) * 1000)
            healthy = response.status_code == 204 and bool(
                response.headers.get("x-rtpr-sdk-keepalive")
            )
            self._stats.note_keepalive(
                healthy=healthy,
                status_code=response.status_code,
                latency_ms=latency_ms,
                checked_at=checked_at,
            )
        except (httpx.TransportError, httpx.HTTPError):
            self._stats.note_keepalive(
                healthy=False,
                status_code=None,
                latency_ms=max(0.0, (time.monotonic() - started) * 1000),
                checked_at=checked_at,
            )
        except BaseException:
            self._stats.note_keepalive(
                healthy=False,
                status_code=None,
                latency_ms=None,
                checked_at=checked_at,
            )

    async def _loop_lag_monitor(self) -> None:
        interval = 1.0
        loop = asyncio.get_running_loop()
        expected = loop.time() + interval
        while self._async_stop is not None and not self._async_stop.is_set():
            await asyncio.sleep(interval)
            observed = loop.time()
            self._stats.note_loop_lag(max(0.0, (observed - expected) * 1000))
            expected = observed + interval
