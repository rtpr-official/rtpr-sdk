import { describe, it, expect } from "vitest";
import { parseArticle, parseArticlesResponse } from "../src/models";

describe("parseArticle", () => {
  it("parses a full article", () => {
    const data = {
      ticker: "AAPL",
      title: "Apple Announces Q4 Results",
      author: "Business Wire",
      created: "2025-07-28T16:30:00Z",
      article_body: "Apple Inc. announced...",
      exchange: "NASDAQ",
      article_body_html: "<p>Apple Inc. announced...</p>",
      id: "abc123",
      tickers: ["AAPL", "MSFT"],
    };
    const article = parseArticle(data);

    expect(article.ticker).toBe("AAPL");
    expect(article.title).toBe("Apple Announces Q4 Results");
    expect(article.author).toBe("Business Wire");
    expect(article.exchange).toBe("NASDAQ");
    expect(article.articleBodyHtml).toBe("<p>Apple Inc. announced...</p>");
    expect(article.id).toBe("abc123");
    expect(article.tickers).toEqual(["AAPL", "MSFT"]);
  });

  it("handles minimal data with defaults", () => {
    const data = {
      ticker: "TSLA",
      title: "Tesla Update",
      author: "PR Newswire",
      created: "2025-07-28T10:00:00Z",
      article_body: "Tesla...",
    };
    const article = parseArticle(data);

    expect(article.ticker).toBe("TSLA");
    expect(article.exchange).toBe("");
    expect(article.id).toBe("");
    expect(article.tickers).toEqual([]);
  });

  it("returns a frozen object", () => {
    const article = parseArticle({
      ticker: "AAPL",
      title: "Test",
      author: "Test",
      created: "2025-01-01",
      article_body: "Test",
    });

    expect(Object.isFrozen(article)).toBe(true);
  });
});

describe("parseArticlesResponse", () => {
  it("parses a response with articles", () => {
    const data = {
      count: 2,
      articles: [
        { ticker: "AAPL", title: "Article 1", author: "BW", created: "2025-01-01", article_body: "Body 1" },
        { ticker: "TSLA", title: "Article 2", author: "PRN", created: "2025-01-02", article_body: "Body 2" },
      ],
    };
    const resp = parseArticlesResponse(data);

    expect(resp.count).toBe(2);
    expect(resp.articles).toHaveLength(2);
    expect(resp.articles[0].ticker).toBe("AAPL");
    expect(resp.articles[1].ticker).toBe("TSLA");
  });

  it("handles empty response", () => {
    const data = { count: 0, articles: [] };
    const resp = parseArticlesResponse(data);

    expect(resp.count).toBe(0);
    expect(resp.articles).toEqual([]);
  });
});
