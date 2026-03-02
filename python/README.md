# RTPR Python SDK

Official Python SDK for [RTPR](https://rtpr.io) — real-time press releases in under 500ms.

## Installation

```bash
pip install rtpr
```

## Quick Start

### REST API

```python
from rtpr import RtprClient

client = RtprClient("your_api_key")

# Get recent articles across all tickers
articles = client.get_articles(limit=10)
for article in articles:
    print(f"[{article.ticker}] {article.title}")

# Get articles for a specific ticker
aapl = client.get_articles_by_ticker("AAPL")
```

### WebSocket Streaming

```python
import asyncio
from rtpr import RtprWebSocket

ws = RtprWebSocket("your_api_key")

@ws.on_article
async def handle(article):
    print(f"[{article.ticker}] {article.title}")

asyncio.run(ws.connect(tickers=["AAPL", "TSLA"]))
```

### Async REST

```python
from rtpr import AsyncRtprClient

async with AsyncRtprClient("your_api_key") as client:
    articles = await client.get_articles(limit=10)
```

## API Reference

### `RtprClient(api_key, *, base_url, timeout)`

Synchronous REST client.

- `get_articles(limit=20)` — Recent articles across all tickers
- `get_articles_by_ticker(ticker, limit=50)` — Articles for a specific ticker
- `health()` — API health check

### `AsyncRtprClient(api_key, *, base_url, timeout)`

Async REST client with the same methods (all awaitable).

### `RtprWebSocket(api_key, *, ws_url, auto_reconnect)`

Real-time WebSocket streaming client.

- `connect(tickers)` — Connect and start streaming (blocking)
- `subscribe(tickers)` — Add tickers to subscription
- `unsubscribe(tickers)` — Remove tickers
- `stop()` — Disconnect
- `@on_article` — Decorator for article callbacks
- `@on_connect` — Decorator for connection callbacks
- `@on_error` — Decorator for error callbacks

### `Article`

Dataclass with fields: `ticker`, `title`, `author`, `created`, `article_body`, `exchange`, `article_body_html`, `id`, `tickers`.

## Requirements

- Python 3.9+
- `httpx` for REST
- `websockets` for WebSocket
