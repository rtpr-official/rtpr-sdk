# RTPR Node.js SDK 0.2.0

Push-only saved-rule alerts with the exact raw bytes fetched from each signed
article URL. WebSocket, HTTP, retry, keepalive, and body reads run in a bounded
worker thread; customer handlers run on the application thread.

```bash
npm install @rtpr-io/rtpr
```

## Quickstart

```typescript
import { AlertStream } from "@rtpr-io/rtpr";

const stream = new AlertStream(process.env.RTPR_API_KEY);

stream.onEvent(async (event) => {
  console.log(
    event.articleId,
    `${event.raw.byteLength} exact bytes`,
    `${event.timing.fetchRoundTripMs.toFixed(1)} ms fetch`,
  );

  // Copy this redacted text into a support request when needed.
  console.log(event.supportReport());
});

stream.onError((error) => {
  // BackpressureError exposes articleId and the original articleUrl for an
  // explicit refetch. Do not put signed articleUrl values in ordinary logs.
  console.error(error.name, error.code);
});

await stream.start();
process.once("SIGINT", () => void stream.close());
```

AsyncIterable consumption is also supported:

```typescript
const stream = new AlertStream(); // falls back to RTPR_API_KEY
await stream.start();

for await (const event of stream) {
  console.log(event.raw.byteLength, event.timing.fetchRoundTripMs);
}
```

Choose callbacks or one AsyncIterator; the SDK rejects mixing both consumption
modes. Errors are available through `onError()`, `pollError()`, and
`drainErrors()`. `stream.stats()` returns bounded queue, retry, overload,
reconnect, loop-lag, ping, and keepalive health counters.

For a redacted window report:

```typescript
const copyReady = stream.supportReport(600);
```

Both report forms contain a concise summary and an
`RTPR_SUPPORT_DIAGNOSTIC_V1` JSON record. Reports contain no API key, signed
URL/query, content, rule names, customer identity, hostname, or IP address.
Treat origin timing on a Cloudflare `HIT` as metadata from the earlier cache
fill; use it as current-origin evidence only on `MISS` or `DYNAMIC` responses.

## Data and use guardrails

- Authenticate every deployment with its own authorized RTPR API key.
- Content is for human-decision and display-only workflows.
- The SDK does not parse, normalize, or persist article content.
- Do not persist content unless your RTPR agreement explicitly permits it.
- Do not redistribute raw bytes, signed URLs, or derived content.
- Treat `event.raw` as untrusted bytes and apply display-layer safety controls.

## Runtime behavior

- Connects only to `wss://ws.rtpr.io/ws-alerts?apiKey=...`.
- Handles saved-rule and Impact Score (Beta) frames; score alerts arrive with
  `event.alertKind === "high_impact"`, empty `ruleNames`, and `event.impact`.
- Fetches each exact signed `articleUrl` immediately with `X-API-Key`.
- Rejects redirects and transfers the raw `ArrayBuffer` from the worker without
  a worker/main-thread body copy.
- Retries only network failures, selected 5xx responses, and a brief 404
  availability race, all within one configured deadline.
- Uses TTL/LRU successful-delivery dedupe and merges duplicate rule names while
  an article is pending.
- Bounds pending fetches and unacknowledged results by item count and bytes.
  Overload is explicit through `BackpressureError`.
- Sends periodic worker-side `HEAD https://rtpr.io/a/_sdk_keepalive` checks.

Node.js 18 or newer is required.
