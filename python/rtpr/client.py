"""RTPR REST API client."""

from __future__ import annotations

from typing import Any

import httpx

from rtpr.exceptions import AuthenticationError, RateLimitError, RtprError
from rtpr.models import Article, ArticlesResponse

DEFAULT_BASE_URL = "https://api.rtpr.io"
DEFAULT_TIMEOUT = 30.0


class RtprClient:
    """Synchronous client for the RTPR REST API.

    Usage::

        client = RtprClient("your_api_key")
        articles = client.get_articles(limit=10)
        for article in articles:
            print(f"{article.ticker}: {article.title}")
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._client = httpx.Client(
            base_url=self._base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout,
        )

    def _handle_response(self, response: httpx.Response) -> dict[str, Any]:
        if response.status_code == 401:
            raise AuthenticationError()
        if response.status_code == 429:
            raise RateLimitError()
        if response.status_code >= 400:
            raise RtprError(
                f"API error: {response.text}",
                status_code=response.status_code,
            )
        return response.json()  # type: ignore[no-any-return]

    def get_articles(self, limit: int = 20) -> list[Article]:
        """Get recent press releases across all tickers.

        Args:
            limit: Number of articles to return (default: 20, max: 100).

        Returns:
            List of Article objects.
        """
        response = self._client.get("/articles", params={"limit": limit})
        data = self._handle_response(response)
        return ArticlesResponse.from_dict(data).articles

    def get_articles_by_ticker(self, ticker: str, limit: int = 50) -> list[Article]:
        """Get press releases for a specific ticker.

        Args:
            ticker: Stock ticker symbol (e.g., "AAPL", "TSLA").
            limit: Number of articles to return (default: 50, max: 100).

        Returns:
            List of Article objects.
        """
        response = self._client.get(f"/articles/{ticker}", params={"limit": limit})
        data = self._handle_response(response)
        return ArticlesResponse.from_dict(data).articles

    def health(self) -> dict[str, Any]:
        """Check RTPR API health status."""
        response = self._client.get("/health")
        return response.json()  # type: ignore[no-any-return]

    def close(self) -> None:
        """Close the underlying HTTP client."""
        self._client.close()

    def __enter__(self) -> RtprClient:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()


class AsyncRtprClient:
    """Async client for the RTPR REST API.

    Usage::

        async with AsyncRtprClient("your_api_key") as client:
            articles = await client.get_articles(limit=10)
            for article in articles:
                print(f"{article.ticker}: {article.title}")
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = DEFAULT_BASE_URL,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout,
        )

    def _handle_response(self, response: httpx.Response) -> dict[str, Any]:
        if response.status_code == 401:
            raise AuthenticationError()
        if response.status_code == 429:
            raise RateLimitError()
        if response.status_code >= 400:
            raise RtprError(
                f"API error: {response.text}",
                status_code=response.status_code,
            )
        return response.json()  # type: ignore[no-any-return]

    async def get_articles(self, limit: int = 20) -> list[Article]:
        """Get recent press releases across all tickers.

        Args:
            limit: Number of articles to return (default: 20, max: 100).

        Returns:
            List of Article objects.
        """
        response = await self._client.get("/articles", params={"limit": limit})
        data = self._handle_response(response)
        return ArticlesResponse.from_dict(data).articles

    async def get_articles_by_ticker(self, ticker: str, limit: int = 50) -> list[Article]:
        """Get press releases for a specific ticker.

        Args:
            ticker: Stock ticker symbol (e.g., "AAPL", "TSLA").
            limit: Number of articles to return (default: 50, max: 100).

        Returns:
            List of Article objects.
        """
        response = await self._client.get(f"/articles/{ticker}", params={"limit": limit})
        data = self._handle_response(response)
        return ArticlesResponse.from_dict(data).articles

    async def health(self) -> dict[str, Any]:
        """Check RTPR API health status."""
        response = await self._client.get("/health")
        return response.json()  # type: ignore[no-any-return]

    async def close(self) -> None:
        """Close the underlying HTTP client."""
        await self._client.aclose()

    async def __aenter__(self) -> AsyncRtprClient:
        return self

    async def __aexit__(self, *args: object) -> None:
        await self.close()
