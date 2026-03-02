import { RtprWebSocket } from "@rtpr-io/rtpr";

const ws = new RtprWebSocket("your_api_key");

ws.onArticle((article) => {
  const time = new Date().toLocaleTimeString();
  console.log(`[${time}] ${article.ticker}: ${article.title}`);
  console.log(`  Source: ${article.author}`);
  console.log();
});

ws.onConnect(() => {
  console.log("Connected to RTPR WebSocket");
});

ws.onDisconnect((data) => {
  console.log("Disconnected:", data);
});

ws.onError((data) => {
  console.error("Error:", data);
});

// Subscribe to all tickers (firehose mode)
// Use ["AAPL", "TSLA"] to subscribe to specific tickers
ws.connect(["*"]).catch(console.error);
