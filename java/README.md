# RTPR Java SDK

Official Java SDK for [RTPR](https://rtpr.io) — real-time press releases in under 500ms.

## Installation

### Maven

```xml
<dependency>
    <groupId>io.rtpr</groupId>
    <artifactId>rtpr-sdk</artifactId>
    <version>0.1.0</version>
</dependency>
```

### Gradle

```groovy
implementation 'io.rtpr:rtpr-sdk:0.1.0'
```

## Quick Start

### REST API

```java
RtprClient client = new RtprClient.Builder()
    .apiKey("your_api_key")
    .build();

List<Article> articles = client.getArticles(10);
for (Article a : articles) {
    System.out.println(a.getTicker() + ": " + a.getTitle());
}

List<Article> aapl = client.getArticlesByTicker("AAPL");
```

### WebSocket Streaming

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

## API Reference

### `RtprClient`

Built via `RtprClient.Builder`. Methods:

- `getArticles(int limit)` — Recent articles across all tickers
- `getArticlesByTicker(String ticker, int limit)` — Articles for a specific ticker
- `close()` — Shut down connection pool

### `RtprWebSocket`

Built via `RtprWebSocket.Builder`. Methods:

- `connect(List<String> tickers)` — Connect and subscribe
- `subscribe(List<String> tickers)` — Add tickers
- `unsubscribe(List<String> tickers)` — Remove tickers
- `disconnect()` — Close connection

### `RtprWebSocket.Listener`

Interface with default methods:

- `onConnect()` — Connection established
- `onArticle(Article article)` — New article received
- `onDisconnect(int code, String reason)` — Connection closed
- `onError(Throwable error)` — Error occurred

## Requirements

- Java 11+
- OkHttp 4.x
- Gson 2.x
