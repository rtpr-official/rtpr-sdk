"""RTPR data models."""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Article:
    """A press release article from a PR wire service."""

    ticker: str
    title: str
    author: str
    created: str
    article_body: str
    exchange: str = ""
    article_body_html: str = ""
    id: str = ""
    tickers: list[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> Article:
        return cls(
            ticker=str(data.get("ticker", "")),
            title=str(data.get("title", "")),
            author=str(data.get("author", "")),
            created=str(data.get("created", "")),
            article_body=str(data.get("article_body", "")),
            exchange=str(data.get("exchange", "")),
            article_body_html=str(data.get("article_body_html", "")),
            id=str(data.get("id", "")),
            tickers=list(data.get("tickers", [])),  # type: ignore[arg-type]
        )


@dataclass(frozen=True)
class ArticlesResponse:
    """Response from the /articles endpoint."""

    count: int
    articles: list[Article]

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> ArticlesResponse:
        raw_articles = data.get("articles", [])
        articles = [
            Article.from_dict(a)
            for a in raw_articles  # type: ignore[union-attr]
        ]
        return cls(count=int(data.get("count", 0)), articles=articles)
