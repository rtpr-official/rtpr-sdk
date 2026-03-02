"""Tests for RTPR REST client."""

import httpx
import pytest
import respx

from rtpr import RtprClient
from rtpr.exceptions import AuthenticationError, RateLimitError, RtprError

BASE_URL = "https://api.rtpr.io"
MOCK_ARTICLES_RESPONSE = {
    "count": 1,
    "articles": [
        {
            "ticker": "AAPL",
            "title": "Apple Announces Q4",
            "author": "Business Wire",
            "created": "2025-07-28T16:30:00Z",
            "article_body": "Apple Inc. announced...",
            "exchange": "NASDAQ",
        }
    ],
}


class TestRtprClient:
    @respx.mock
    def test_get_articles(self):
        respx.get(f"{BASE_URL}/articles").mock(
            return_value=httpx.Response(200, json=MOCK_ARTICLES_RESPONSE)
        )
        client = RtprClient("test_key")
        articles = client.get_articles(limit=10)

        assert len(articles) == 1
        assert articles[0].ticker == "AAPL"
        assert articles[0].title == "Apple Announces Q4"
        client.close()

    @respx.mock
    def test_get_articles_by_ticker(self):
        respx.get(f"{BASE_URL}/articles/AAPL").mock(
            return_value=httpx.Response(200, json=MOCK_ARTICLES_RESPONSE)
        )
        client = RtprClient("test_key")
        articles = client.get_articles_by_ticker("AAPL", limit=5)

        assert len(articles) == 1
        assert articles[0].ticker == "AAPL"
        client.close()

    @respx.mock
    def test_auth_error(self):
        respx.get(f"{BASE_URL}/articles").mock(
            return_value=httpx.Response(401, json={"detail": "Invalid API key"})
        )
        client = RtprClient("bad_key")

        with pytest.raises(AuthenticationError):
            client.get_articles()
        client.close()

    @respx.mock
    def test_rate_limit_error(self):
        respx.get(f"{BASE_URL}/articles").mock(
            return_value=httpx.Response(429, json={"detail": "Rate limit exceeded"})
        )
        client = RtprClient("test_key")

        with pytest.raises(RateLimitError):
            client.get_articles()
        client.close()

    @respx.mock
    def test_server_error(self):
        respx.get(f"{BASE_URL}/articles").mock(
            return_value=httpx.Response(500, text="Internal Server Error")
        )
        client = RtprClient("test_key")

        with pytest.raises(RtprError) as exc_info:
            client.get_articles()
        assert exc_info.value.status_code == 500
        client.close()

    @respx.mock
    def test_context_manager(self):
        respx.get(f"{BASE_URL}/articles").mock(
            return_value=httpx.Response(200, json=MOCK_ARTICLES_RESPONSE)
        )
        with RtprClient("test_key") as client:
            articles = client.get_articles()
            assert len(articles) == 1

    @respx.mock
    def test_health(self):
        respx.get(f"{BASE_URL}/health").mock(
            return_value=httpx.Response(200, json={"status": "ok"})
        )
        client = RtprClient("test_key")
        result = client.health()

        assert result["status"] == "ok"
        client.close()
