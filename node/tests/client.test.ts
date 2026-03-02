import { describe, it, expect, vi, beforeEach } from "vitest";
import { RtprClient } from "../src/client";
import { AuthenticationError, RateLimitError, RtprError } from "../src/errors";

const MOCK_ARTICLES_RESPONSE = {
  count: 1,
  articles: [
    {
      ticker: "AAPL",
      title: "Apple Announces Q4",
      author: "Business Wire",
      created: "2025-07-28T16:30:00Z",
      article_body: "Apple Inc. announced...",
      exchange: "NASDAQ",
    },
  ],
};

function mockFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  });
}

describe("RtprClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("getArticles returns parsed articles", async () => {
    global.fetch = mockFetch(200, MOCK_ARTICLES_RESPONSE);
    const client = new RtprClient("test_key");
    const articles = await client.getArticles(10);

    expect(articles).toHaveLength(1);
    expect(articles[0].ticker).toBe("AAPL");
    expect(articles[0].title).toBe("Apple Announces Q4");
  });

  it("getArticlesByTicker returns parsed articles", async () => {
    global.fetch = mockFetch(200, MOCK_ARTICLES_RESPONSE);
    const client = new RtprClient("test_key");
    const articles = await client.getArticlesByTicker("AAPL", 5);

    expect(articles).toHaveLength(1);
    expect(articles[0].ticker).toBe("AAPL");
  });

  it("throws AuthenticationError on 401", async () => {
    global.fetch = mockFetch(401, { detail: "Invalid API key" });
    const client = new RtprClient("bad_key");

    await expect(client.getArticles()).rejects.toThrow(AuthenticationError);
  });

  it("throws RateLimitError on 429", async () => {
    global.fetch = mockFetch(429, { detail: "Rate limit exceeded" });
    const client = new RtprClient("test_key");

    await expect(client.getArticles()).rejects.toThrow(RateLimitError);
  });

  it("throws RtprError on 500", async () => {
    global.fetch = mockFetch(500, "Internal Server Error");
    const client = new RtprClient("test_key");

    await expect(client.getArticles()).rejects.toThrow(RtprError);
  });

  it("health returns response data", async () => {
    global.fetch = mockFetch(200, { status: "ok" });
    const client = new RtprClient("test_key");
    const result = await client.health();

    expect(result.status).toBe("ok");
  });

  it("sends Authorization header", async () => {
    const fetchSpy = mockFetch(200, MOCK_ARTICLES_RESPONSE);
    global.fetch = fetchSpy;
    const client = new RtprClient("my_secret_key");
    await client.getArticles();

    const [, options] = fetchSpy.mock.calls[0];
    expect(options.headers.Authorization).toBe("Bearer my_secret_key");
  });
});
