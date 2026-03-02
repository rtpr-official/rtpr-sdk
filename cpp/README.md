# RTPR C++ SDK

Official C++ SDK for [RTPR](https://rtpr.io) — real-time press releases in under 500ms.

## Dependencies

- C++17 compiler
- [libcurl](https://curl.se/libcurl/)
- [Boost.Beast](https://www.boost.org/doc/libs/release/libs/beast/) (WebSocket)
- [nlohmann/json](https://github.com/nlohmann/json) (auto-fetched by CMake if not installed)
- OpenSSL

## Build

```bash
cd cpp
mkdir build && cd build
cmake ..
make
```

## Quick Start

### REST API

```cpp
#include "rtpr/client.hpp"

rtpr::Client client("your_api_key");
auto articles = client.get_articles(10);
for (const auto& a : articles) {
    std::cout << a.ticker << ": " << a.title << std::endl;
}

auto aapl = client.get_articles_by_ticker("AAPL");
```

### WebSocket Streaming

```cpp
#include "rtpr/websocket.hpp"

rtpr::WebSocketClient ws("your_api_key");

ws.on_article([](const rtpr::Article& a) {
    std::cout << a.ticker << ": " << a.title << std::endl;
});

ws.connect({"AAPL", "TSLA"});  // blocks until stop()
```

## API Reference

### `rtpr::Client`

- `Client(api_key, base_url, timeout_seconds)` — Constructor
- `get_articles(limit)` — Recent articles across all tickers
- `get_articles_by_ticker(ticker, limit)` — Articles for a specific ticker

### `rtpr::WebSocketClient`

- `WebSocketClient(api_key, ws_url, auto_reconnect)` — Constructor
- `connect(tickers)` — Connect and stream (blocking)
- `subscribe(tickers)` — Add tickers
- `unsubscribe(tickers)` — Remove tickers
- `stop()` — Disconnect
- `on_article(callback)` — Article handler
- `on_connect(callback)` — Connection handler
- `on_error(callback)` — Error handler
- `on_disconnect(callback)` — Disconnection handler

### `rtpr::Article`

Struct with fields: `ticker`, `title`, `author`, `created`, `article_body`, `exchange`, `article_body_html`, `id`, `tickers`.

### Exception Hierarchy

- `rtpr::RtprError` — Base exception
- `rtpr::AuthenticationError` — Invalid API key (401)
- `rtpr::RateLimitError` — Rate limit exceeded (429)
- `rtpr::ConnectionError` — Connection failure
