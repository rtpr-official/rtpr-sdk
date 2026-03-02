"""Tests for RTPR data models."""

from rtpr.models import Article, ArticlesResponse


class TestArticle:
    def test_from_dict_full(self):
        data = {
            "ticker": "AAPL",
            "title": "Apple Announces Q4 Results",
            "author": "Business Wire",
            "created": "2025-07-28T16:30:00Z",
            "article_body": "Apple Inc. announced...",
            "exchange": "NASDAQ",
            "article_body_html": "<p>Apple Inc. announced...</p>",
            "id": "abc123",
            "tickers": ["AAPL", "MSFT"],
        }
        article = Article.from_dict(data)

        assert article.ticker == "AAPL"
        assert article.title == "Apple Announces Q4 Results"
        assert article.author == "Business Wire"
        assert article.exchange == "NASDAQ"
        assert article.id == "abc123"
        assert article.tickers == ["AAPL", "MSFT"]

    def test_from_dict_minimal(self):
        data = {
            "ticker": "TSLA",
            "title": "Tesla Update",
            "author": "PR Newswire",
            "created": "2025-07-28T10:00:00Z",
            "article_body": "Tesla...",
        }
        article = Article.from_dict(data)

        assert article.ticker == "TSLA"
        assert article.exchange == ""
        assert article.id == ""
        assert article.tickers == []

    def test_frozen(self):
        article = Article.from_dict(
            {
                "ticker": "AAPL",
                "title": "Test",
                "author": "Test",
                "created": "2025-01-01",
                "article_body": "Test",
            }
        )
        try:
            article.ticker = "MSFT"  # type: ignore[misc]
            assert False, "Should have raised FrozenInstanceError"
        except AttributeError:
            pass


class TestArticlesResponse:
    def test_from_dict(self):
        data = {
            "count": 2,
            "articles": [
                {
                    "ticker": "AAPL",
                    "title": "Article 1",
                    "author": "BW",
                    "created": "2025-01-01",
                    "article_body": "Body 1",
                },
                {
                    "ticker": "TSLA",
                    "title": "Article 2",
                    "author": "PRN",
                    "created": "2025-01-02",
                    "article_body": "Body 2",
                },
            ],
        }
        resp = ArticlesResponse.from_dict(data)

        assert resp.count == 2
        assert len(resp.articles) == 2
        assert resp.articles[0].ticker == "AAPL"
        assert resp.articles[1].ticker == "TSLA"

    def test_empty(self):
        data = {"count": 0, "articles": []}
        resp = ArticlesResponse.from_dict(data)

        assert resp.count == 0
        assert resp.articles == []
