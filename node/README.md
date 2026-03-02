# RTPR Node.js SDK

Official Node.js/TypeScript SDK for [RTPR](https://rtpr.io) — real-time press releases in under 500ms.

## Installation

```bash
npm install @rtpr-io/rtpr
```

## Quick Start

### REST API

```typescript
import { RtprClient } from "@rtpr-io/rtpr";

const client = new RtprClient("your_api_key");

// Get recent articles across all tickers
const articles = await client.getArticles(10);
for (const article of articles) {
  console.log(`[${article.ticker}] ${article.title}`);
}

// Get articles for a specific ticker
const aapl = await client.getArticlesByTicker("AAPL");
```

### WebSocket Streaming

```typescript
import { RtprWebSocket } from "@rtpr-io/rtpr";

const ws = new RtprWebSocket("your_api_key");

ws.onArticle((article) => {
  console.log(`[${article.ticker}] ${article.title}`);
});

await ws.connect(["AAPL", "TSLA"]);
```

### Firehose (All Tickers)

```typescript
await ws.connect(["*"]);
```

## API Reference

### `new RtprClient(apiKey, options?)`

REST client for querying articles.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | `https://api.rtpr.io` | API base URL |
| `timeoutMs` | `number` | `30000` | Request timeout in milliseconds |

**Methods:**

- `getArticles(limit?)` — Recent articles across all tickers (default limit: 20, max: 100)
- `getArticlesByTicker(ticker, limit?)` — Articles for a specific ticker (default limit: 50, max: 100)
- `health()` — API health check

All methods return Promises.

### `new RtprWebSocket(apiKey, options?)`

Real-time WebSocket streaming client with auto-reconnect and exponential backoff.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `wsUrl` | `string` | `wss://ws.rtpr.io` | WebSocket URL |
| `autoReconnect` | `boolean` | `true` | Reconnect on disconnect |

**Methods:**

- `connect(tickers?)` — Connect and start streaming (returns a Promise)
- `subscribe(tickers)` — Add tickers to subscription
- `unsubscribe(tickers)` — Remove tickers (pass `["*"]` to clear all)
- `stop()` — Disconnect and prevent reconnection
- `connected` — `boolean` property for connection state

**Event handlers (chainable):**

- `onArticle(callback)` — New article received
- `onConnect(callback)` — Connection established
- `onDisconnect(callback)` — Connection lost
- `onError(callback)` — Error occurred

### `Article`

| Field | Type | Description |
|-------|------|-------------|
| `ticker` | `string` | Primary stock ticker |
| `title` | `string` | Article headline |
| `author` | `string` | PR wire source (Business Wire, PR Newswire, etc.) |
| `created` | `string` | ISO timestamp |
| `articleBody` | `string` | Plain text body |
| `articleBodyHtml` | `string` | Original HTML body |
| `exchange` | `string` | Exchange name |
| `id` | `string` | Unique article ID |
| `tickers` | `string[]` | All associated tickers |

### Errors

| Class | Status | Description |
|-------|--------|-------------|
| `RtprError` | varies | Base error class |
| `AuthenticationError` | 401 | Invalid or missing API key |
| `RateLimitError` | 429 | Exceeded 60 requests/minute |
| `ConnectionError` | — | WebSocket connection failure |

## Requirements

- Node.js 18+
- TypeScript 5+ (if using TypeScript)
