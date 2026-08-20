# RTPR Python SDK 0.2.0

`AlertStream` receives push-only saved-rule alerts and fetches each alert's
exact signed article response as immutable `bytes`. Its WebSocket, HTTP client,
warm fetch workers, retries, and keepalive run on a dedicated network thread.

Python 3.9–3.13 is supported.

## Install

```bash
pip install rtpr
```

## Quickstart

```python
import os

from rtpr import AlertStream

with AlertStream(os.environ["RTPR_API_KEY"]) as stream:
    event = stream.get(timeout=30)
    print(
        event.article_id,
        len(event.raw_bytes),
        f"{event.timings['fetch_round_trip_ms']:.1f} ms",
    )

    # Copy this redacted text when contacting RTPR support.
    print(event.support_report())
    print(stream.support_report(window_seconds=600))
```

`raw_bytes` is the unparsed response body. The SDK neither decodes nor
normalizes it, follows redirects, nor writes article content to storage.

### Callback consumption

```python
from rtpr import AlertStream

stream = AlertStream("api-key")


@stream.on_event
def display(event):
    print(event.ticker, len(event.raw_bytes))


@stream.on_error
def report(error):
    print(type(error).__name__, error)


with stream:
    input("Press Enter to stop cleanly\n")
```

Callbacks run outside the network thread, so a slow display handler does not
block WebSocket intake or article fetch workers. Callback and iterator/pull
consumption cannot be mixed on one stream.

### Async iteration

```python
import asyncio
from rtpr import AlertStream


async def main():
    async with AlertStream("api-key") as stream:
        async for event in stream:
            print(len(event.raw_bytes), event.timings["fetch_round_trip_ms"])
            break


asyncio.run(main())
```

Lifecycle, fetch, protocol, and overload errors are available through
`get_error()`, `poll_error()`, and `on_error()`. A `BackpressureError` retains
`article_id` and the original `article_url` as attributes for an explicit
refetch, while its text and diagnostics omit the signed URL.

Origin timing on a Cloudflare `HIT` describes the earlier cache fill. Treat it
as current-origin evidence only when `CF-Cache-Status` is `MISS` or `DYNAMIC`.

## Usage guardrails

This SDK output is for display and human decision support only. Do not persist
or redistribute article bytes. Keep the API key and signed URLs private. Apply
your own review and authorization controls before showing content to a user.
