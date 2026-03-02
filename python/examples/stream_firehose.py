"""Stream all press releases in real time via WebSocket."""

import asyncio

from rtpr import RtprWebSocket

API_KEY = "your_api_key"

ws = RtprWebSocket(API_KEY)


@ws.on_article
async def handle_article(article):
    print(f"[{article.ticker}] {article.title}")
    print(f"  Source: {article.author}")
    print(f"  Body:   {article.article_body[:120]}...")
    print()


@ws.on_connect
async def handle_connect(data):
    print("Connected to RTPR real-time feed")


asyncio.run(ws.connect(tickers=["*"]))
