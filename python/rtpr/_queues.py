"""Thread-safe bounded delivery queue with an exact raw-byte budget."""

from __future__ import annotations

import queue
import threading
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime
from typing import Callable

from rtpr.events import RawArticleEvent


class ResultQueueClosedError(Exception):
    """Internal signal used when a closed result queue has been drained."""


@dataclass(frozen=True)
class QueuedResult:
    event: RawArticleEvent
    enqueued_monotonic: float
    enqueued_at: datetime


class BoundedResultQueue:
    """A FIFO bounded by both item count and aggregate raw bytes."""

    def __init__(
        self,
        *,
        max_items: int,
        max_raw_bytes: int,
        on_change: Callable[[int, int], None],
    ) -> None:
        self.max_items = max_items
        self.max_raw_bytes = max_raw_bytes
        self._on_change = on_change
        self._condition = threading.Condition()
        self._items: deque[QueuedResult] = deque()
        self._raw_bytes = 0
        self._closed = False

    def put_nowait(self, item: QueuedResult) -> bool:
        raw_size = len(item.event.raw_bytes)
        with self._condition:
            if (
                self._closed
                or len(self._items) >= self.max_items
                or self._raw_bytes + raw_size > self.max_raw_bytes
            ):
                return False
            self._items.append(item)
            self._raw_bytes += raw_size
            depth = len(self._items)
            raw_bytes = self._raw_bytes
            self._condition.notify()
        self._on_change(depth, raw_bytes)
        return True

    def get(self, timeout: float | None = None) -> QueuedResult:
        deadline = None if timeout is None else time.monotonic() + timeout
        with self._condition:
            while not self._items:
                if self._closed:
                    raise ResultQueueClosedError
                if deadline is None:
                    self._condition.wait()
                    continue
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise queue.Empty
                self._condition.wait(remaining)
            item = self._items.popleft()
            self._raw_bytes -= len(item.event.raw_bytes)
            depth = len(self._items)
            raw_bytes = self._raw_bytes
        self._on_change(depth, raw_bytes)
        return item

    def get_nowait(self) -> QueuedResult:
        return self.get(timeout=0)

    def close(self) -> None:
        with self._condition:
            self._closed = True
            self._condition.notify_all()

    def snapshot(self) -> tuple[int, int, bool]:
        with self._condition:
            return len(self._items), self._raw_bytes, self._closed
