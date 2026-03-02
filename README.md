<p align="center">
  <h1 align="center">RTPR SDK</h1>
  <p align="center">
    Official SDK for <a href="https://rtpr.io">RTPR</a> — real-time press releases in under 500ms
  </p>
</p>

<p align="center">
  <a href="https://github.com/rtpr-io/rtpr-sdk/actions/workflows/python-ci.yml"><img src="https://github.com/rtpr-io/rtpr-sdk/actions/workflows/python-ci.yml/badge.svg" alt="Python CI"></a>
  <a href="https://github.com/rtpr-io/rtpr-sdk/actions/workflows/java-ci.yml"><img src="https://github.com/rtpr-io/rtpr-sdk/actions/workflows/java-ci.yml/badge.svg" alt="Java CI"></a>
  <a href="https://github.com/rtpr-io/rtpr-sdk/actions/workflows/cpp-ci.yml"><img src="https://github.com/rtpr-io/rtpr-sdk/actions/workflows/cpp-ci.yml/badge.svg" alt="C++ CI"></a>
  <a href="https://pypi.org/project/rtpr/"><img src="https://img.shields.io/pypi/v/rtpr" alt="PyPI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
</p>

---

**RTPR** delivers press releases from Business Wire, PR Newswire, and GlobeNewswire the moment they hit the wire — the same sub-500ms speed used by hedge funds, now available at $99/month.

This repo contains official client SDKs in **Python**, **Java**, and **C++** for both the REST API and WebSocket streaming API.

## Why RTPR?

| Feature | RTPR | Free News APIs / RSS Feeds |
|---------|------|----------------------------|
| Latency | **< 500ms** | 3–15 minutes |
| Delivery | WebSocket push | Polling / pull |
| Sources | Business Wire, PR Newswire, GlobeNewswire | Aggregated/delayed |
| Structured data | Typed models (ticker, body, source) | Raw HTML / unstructured |
| Price | $99/month | Free (but slow) |

**Use cases:** FDA/PDUFA catalysts, earnings surprises, M&A announcements, contract wins — any event where milliseconds matter.

## Prerequisites

1. **Get an API key** — Sign up at [rtpr.io](https://rtpr.io) and start a free 7-day trial. Your API key will be available in the [dashboard](https://rtpr.io/dashboard) after signup.
2. **Install the SDK** for your language (see below).

That's it — two steps and you're streaming real-time press releases.

## Quick Start

### Python

```bash
pip install rtpr
```

```python
from rtpr import RtprClient

client = RtprClient("your_api_key")
articles = client.get_articles(limit=10)
for a in articles:
    print(f"{a.ticker}: {a.title}")
```

**WebSocket streaming:**

```python
import asyncio
from rtpr import RtprWebSocket

ws = RtprWebSocket("your_api_key")

@ws.on_article
async def handle(article):
    print(f"{article.ticker}: {article.title}")

asyncio.run(ws.connect(tickers=["AAPL", "TSLA"]))
```

> See [python/](python/) for full docs, async client, and more examples.

### Java

```xml
<dependency>
    <groupId>io.rtpr</groupId>
    <artifactId>rtpr-sdk</artifactId>
    <version>0.1.0</version>
</dependency>
```

```java
RtprClient client = new RtprClient.Builder()
    .apiKey("your_api_key")
    .build();

List<Article> articles = client.getArticles(10);
for (Article a : articles) {
    System.out.println(a.getTicker() + ": " + a.getTitle());
}
```

**WebSocket streaming:**

```java
RtprWebSocket ws = new RtprWebSocket.Builder()
    .apiKey("your_api_key")
    .listener(new RtprWebSocket.Listener() {
        @Override
        public void onArticle(Article article) {
            System.out.println(article.getTicker() + ": " + article.getTitle());
        }
    })
    .build();

ws.connect(Arrays.asList("AAPL", "TSLA"));
```

> See [java/](java/) for full docs, Maven/Gradle setup, and examples.

### C++

```cpp
#include "rtpr/client.hpp"

rtpr::Client client("your_api_key");
auto articles = client.get_articles(10);
for (const auto& a : articles) {
    std::cout << a.ticker << ": " << a.title << std::endl;
}
```

**WebSocket streaming:**

```cpp
#include "rtpr/websocket.hpp"

rtpr::WebSocketClient ws("your_api_key");
ws.on_article([](const rtpr::Article& a) {
    std::cout << a.ticker << ": " << a.title << std::endl;
});
ws.connect({"AAPL", "TSLA"});
```

> See [cpp/](cpp/) for CMake build instructions and examples.

## Feature Matrix

| Feature | Python | Java | C++ |
|---------|--------|------|-----|
| REST API | Yes | Yes | Yes |
| WebSocket streaming | Yes | Yes | Yes |
| Typed models | Yes (dataclasses) | Yes (POJOs) | Yes (structs) |
| Auto-reconnect | Yes | Yes | Yes |
| Ping/pong heartbeat | Yes | Yes | Yes |
| Async support | Yes (asyncio) | CompletableFuture | Blocking |
| Package manager | pip (PyPI) | Maven Central | CMake (FetchContent) |

## API Overview

**Base URL:** `https://api.rtpr.io`
**WebSocket URL:** `wss://ws.rtpr.io`

### REST Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/articles?limit=20` | Recent articles across all tickers |
| `GET` | `/articles/{ticker}?limit=50` | Articles for a specific ticker |
| `GET` | `/health` | Health check (no auth) |

**Auth:** `Authorization: Bearer YOUR_API_KEY`
**Rate limit:** 60 requests/minute

### WebSocket Protocol

1. Connect: `wss://ws.rtpr.io?apiKey=YOUR_API_KEY`
2. Subscribe: `{"action": "subscribe", "tickers": ["AAPL", "TSLA"]}`
3. Receive articles: `{"type": "article", "data": {...}}`
4. Firehose mode: `{"action": "subscribe", "tickers": ["*"]}`

Full API documentation: [rtpr.io/docs](https://rtpr.io/docs)

## Examples

Each SDK includes ready-to-run examples:

| Example | Python | Java | C++ |
|---------|--------|------|-----|
| Quick start (REST) | [quickstart.py](python/examples/quickstart.py) | [QuickStart.java](java/examples/QuickStart.java) | [quickstart.cpp](cpp/examples/quickstart.cpp) |
| WebSocket streaming | [stream_firehose.py](python/examples/stream_firehose.py) | [StreamArticles.java](java/examples/StreamArticles.java) | [stream_articles.cpp](cpp/examples/stream_articles.cpp) |
| Trading bot | [trading_bot_example.py](python/examples/trading_bot_example.py) | — | — |

## Project Structure

```
rtpr-sdk/
├── python/          Python SDK (pip install rtpr)
│   ├── rtpr/        Package source
│   ├── examples/    Usage examples
│   └── tests/       Unit tests
├── java/            Java SDK (Maven)
│   ├── src/         Source + tests
│   └── examples/    Usage examples
├── cpp/             C++ SDK (CMake)
│   ├── include/     Headers
│   ├── src/         Implementations
│   └── examples/    Usage examples
└── .github/         CI workflows
```

## Contributing

We welcome contributions! See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

## Links

- **Website:** [rtpr.io](https://rtpr.io)
- **API Docs:** [rtpr.io/docs](https://rtpr.io/docs)
- **Pricing:** [rtpr.io/pricing](https://rtpr.io/pricing)
- **Support:** support@rtpr.io

## License

MIT — see [LICENSE](LICENSE) for details.
