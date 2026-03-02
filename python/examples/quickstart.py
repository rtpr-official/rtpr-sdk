"""Quickstart: fetch recent press releases with the RTPR Python SDK."""

from rtpr import RtprClient

API_KEY = "your_api_key"

client = RtprClient(API_KEY)
articles = client.get_articles(limit=10)

for article in articles:
    print(f"[{article.ticker}] {article.title}")
    print(f"  Source: {article.author}  |  {article.created}")
    print()
