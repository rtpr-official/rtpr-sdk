"""Example: simple news-driven trading signal bot using RTPR WebSocket.

This demonstrates how to filter articles for keywords that typically
move stock prices (FDA, earnings, acquisition, etc.) and generate
trade signals in real time.
"""

import asyncio
from datetime import datetime, timezone

from rtpr import Article, RtprWebSocket

API_KEY = "your_api_key"
WATCHLIST = ["AAPL", "TSLA", "NVDA", "MSFT", "AMZN"]

BULLISH_KEYWORDS = [
    "fda approval",
    "beat expectations",
    "revenue growth",
    "strategic partnership",
    "contract win",
    "acquires",
    "acquisition",
    "exceeded guidance",
    "raised outlook",
    "upgrade",
]

BEARISH_KEYWORDS = [
    "fda rejection",
    "missed expectations",
    "revenue decline",
    "layoffs",
    "data breach",
    "downgrade",
    "investigation",
    "recall",
    "lawsuit",
    "lowered guidance",
]


def analyze_sentiment(article: Article) -> str:
    body_lower = article.article_body.lower()
    title_lower = article.title.lower()
    text = f"{title_lower} {body_lower}"

    bullish = sum(1 for kw in BULLISH_KEYWORDS if kw in text)
    bearish = sum(1 for kw in BEARISH_KEYWORDS if kw in text)

    if bullish > bearish:
        return "BULLISH"
    elif bearish > bullish:
        return "BEARISH"
    return "NEUTRAL"


ws = RtprWebSocket(API_KEY)


@ws.on_article
async def on_article(article: Article) -> None:
    now = datetime.now(timezone.utc).strftime("%H:%M:%S")
    sentiment = analyze_sentiment(article)

    if sentiment == "NEUTRAL":
        return

    signal = "BUY" if sentiment == "BULLISH" else "SELL"
    print(f"[{now}] {signal} SIGNAL: {article.ticker}")
    print(f"  Headline: {article.title}")
    print(f"  Source:   {article.author}")
    print(f"  Sentiment: {sentiment}")
    print()


async def main() -> None:
    print(f"Monitoring {len(WATCHLIST)} tickers for trade signals...")
    print(f"Tickers: {', '.join(WATCHLIST)}")
    print()
    await ws.connect(tickers=WATCHLIST)


asyncio.run(main())
