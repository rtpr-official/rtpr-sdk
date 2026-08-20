"""Immutable events exposed by :class:`rtpr.AlertStream`."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import datetime, timezone
from types import MappingProxyType
from typing import Any, Protocol

ALLOWED_RESPONSE_HEADERS = frozenset(
    {
        "cf-ray",
        "cf-cache-status",
        "age",
        "content-type",
        "x-rtpr-auth-mode",
        "x-rtpr-origin-ms",
        "x-rtpr-storage-tier",
        "server-timing",
    }
)


class _EventReporter(Protocol):
    def event_report(self, token: int, event: RawArticleEvent) -> str: ...


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)


@dataclass(frozen=True)
class AlertRule:
    """A saved rule that matched an alert."""

    rule_name: str


@dataclass(frozen=True)
class AlertEvent:
    """A validated saved-rule alert received from the RTPR WebSocket."""

    article_id: str
    ticker: str
    rules: tuple[AlertRule, ...]
    article_published_at: datetime
    article_url: str = field(repr=False)
    dispatched_at_ms: int
    received_at: datetime
    _received_monotonic: float = field(repr=False, compare=False)

    def __post_init__(self) -> None:
        object.__setattr__(self, "rules", tuple(self.rules))
        object.__setattr__(self, "article_published_at", _as_utc(self.article_published_at))
        object.__setattr__(self, "received_at", _as_utc(self.received_at))

    @property
    def rule_names(self) -> tuple[str, ...]:
        """Rule names in first-seen order, with duplicates removed."""

        return tuple(rule.rule_name for rule in self.rules)

    @property
    def dispatched_at(self) -> datetime:
        """Server dispatch timestamp as a UTC datetime."""

        return datetime.fromtimestamp(self.dispatched_at_ms / 1000, tz=timezone.utc)


@dataclass(frozen=True)
class RawArticleEvent:
    """An alert paired with the exact bytes returned by its signed URL."""

    alert: AlertEvent
    raw_bytes: bytes = field(repr=False)
    status_code: int
    headers: Mapping[str, str]
    timings: Mapping[str, float]
    utc_milestones: Mapping[str, str]
    apparent_wall_clock: Mapping[str, float | None]
    attempts: int
    _diagnostic_token: int = field(repr=False, compare=False)
    _reporter: _EventReporter | None = field(default=None, repr=False, compare=False)

    def __post_init__(self) -> None:
        safe_headers = {
            str(name).lower(): str(value)
            for name, value in self.headers.items()
            if str(name).lower() in ALLOWED_RESPONSE_HEADERS
        }
        object.__setattr__(self, "raw_bytes", bytes(self.raw_bytes))
        object.__setattr__(self, "headers", MappingProxyType(safe_headers))
        object.__setattr__(
            self,
            "timings",
            MappingProxyType({str(name): float(value) for name, value in self.timings.items()}),
        )
        object.__setattr__(
            self,
            "utc_milestones",
            MappingProxyType(
                {str(name): str(value) for name, value in self.utc_milestones.items()}
            ),
        )
        object.__setattr__(
            self,
            "apparent_wall_clock",
            MappingProxyType(
                {
                    str(name): None if value is None else float(value)
                    for name, value in self.apparent_wall_clock.items()
                }
            ),
        )

    @property
    def article_id(self) -> str:
        return self.alert.article_id

    @property
    def ticker(self) -> str:
        return self.alert.ticker

    @property
    def rules(self) -> tuple[AlertRule, ...]:
        return self.alert.rules

    @property
    def rule_names(self) -> tuple[str, ...]:
        return self.alert.rule_names

    @property
    def article_published_at(self) -> datetime:
        return self.alert.article_published_at

    @property
    def article_url(self) -> str:
        return self.alert.article_url

    @property
    def dispatched_at_ms(self) -> int:
        return self.alert.dispatched_at_ms

    @property
    def received_at(self) -> datetime:
        return self.alert.received_at

    @property
    def content_type(self) -> str | None:
        """Allowlisted HTTP content type, when the response supplied one."""

        return self.headers.get("content-type")

    def support_report(self) -> str:
        """Return a redacted, copy-ready diagnostic for this event."""

        if self._reporter is not None:
            return self._reporter.event_report(self._diagnostic_token, self)

        # Stream-produced events always have a reporter.  This fallback keeps
        # manually reconstructed events safe and useful.
        from rtpr.diagnostics import standalone_event_report

        return standalone_event_report(self)


def immutable_view(values: Mapping[str, Any]) -> Mapping[str, Any]:
    """Return a shallow, immutable copy used by public snapshot APIs."""

    return MappingProxyType(dict(values))
