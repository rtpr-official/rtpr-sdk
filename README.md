# RTPR Alert Fetch SDK

Official burst-safe clients for RTPR's alert-then-fetch delivery flow.

The SDK connects only to `wss://ws.rtpr.io/ws-alerts`, receives saved-rule
alerts, and immediately fetches each exact signed `article_url`. Network work
runs outside customer handlers with warm HTTP connections, bounded
concurrency, explicit backpressure, retries, and copy-ready diagnostics.

Version 0.2.0 is a clean replacement for the archived 0.1.0 clients. The
current tree contains only the Python and Node.js alert-fetch implementations.
The pre-0.2 source remains available at the `v0.1.0` Git tag.

## Supported SDKs

- [Python](python/) — Python 3.9 through 3.13
- [Node.js/TypeScript](node/) — Node.js 18 or newer

## Python quickstart

```bash
pip install rtpr
```

```python
import os

from rtpr import AlertStream

with AlertStream(os.environ["RTPR_API_KEY"]) as stream:
    event = stream.get(timeout=30)
    display_bytes = event.raw_bytes

    print(event.article_id, len(display_bytes))
    print(event.support_report())
```

## Node.js quickstart

```bash
npm install @rtpr-io/rtpr
```

```typescript
import { AlertStream } from "@rtpr-io/rtpr";

const stream = new AlertStream(process.env.RTPR_API_KEY);

stream.onEvent((event) => {
  const displayBytes = event.raw;
  console.log(event.articleId, displayBytes.byteLength);
  console.log(event.supportReport());
});

await stream.start();
```

## Runtime contract

- Alerts are push-only; the SDK never subscribes to an article stream.
- Saved-rule and Impact Score (Beta) `high_impact` frames are both fetched;
  score frames carry no rule names and expose score metadata instead.
- `article_url` is fetched immediately and exactly as supplied.
- `X-API-Key` is sent as a fallback if a signed URL expires during transit.
- Redirects are never followed.
- Article bodies are returned as unparsed bytes and are not persisted.
- Successful article IDs are deduplicated for a bounded TTL.
- Pending work and undelivered bodies are bounded by item and byte limits.
- An article rejected by a bound raises a refetchable `BackpressureError`.
- Reports omit API keys, signed URLs, rule names, customer identity, bodies,
  hostnames, and IP addresses.

## Support diagnostics

Use `event.support_report()` / `event.supportReport()` for one article or
`stream.support_report(...)` / `stream.supportReport(...)` for a time window.
The versioned `RTPR_SUPPORT_DIAGNOSTIC_V1` payload includes article IDs,
CF-Ray, safe response headers, UTC milestones, monotonic durations, retry and
queue evidence, burst state, and percentile summaries.

## Data and use guardrails

RTPR article output is for authorized display and human-decision workflows.
Do not redistribute article bytes or signed URLs. Do not persist content
unless your RTPR agreement expressly permits it. The SDK does not parse,
extract, classify, summarize, or provide trading signals from article
content.

See [CONTRIBUTING.md](CONTRIBUTING.md) for local development commands.

## License

MIT — see [LICENSE](LICENSE).
