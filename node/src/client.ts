import { AuthenticationError, RateLimitError, RtprError } from "./errors";
import { Article, ArticlesResponse, parseArticlesResponse } from "./models";

const DEFAULT_BASE_URL = "https://api.rtpr.io";
const DEFAULT_TIMEOUT_MS = 30_000;

export interface RtprClientOptions {
  baseUrl?: string;
  timeoutMs?: number;
}

export class RtprClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string, options: RtprClientOptions = {}) {
    this.apiKey = apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private async request(path: string, params?: Record<string, string>): Promise<unknown> {
    const url = new URL(path, this.baseUrl);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      });

      if (response.status === 401) throw new AuthenticationError();
      if (response.status === 429) throw new RateLimitError();
      if (!response.ok) {
        const text = await response.text();
        throw new RtprError(`API error: ${text}`, response.status);
      }

      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Get recent press releases across all tickers.
   * @param limit Number of articles to return (default: 20, max: 100).
   */
  async getArticles(limit = 20): Promise<Article[]> {
    const data = await this.request("/articles", { limit: String(limit) });
    return parseArticlesResponse(data as Record<string, unknown>).articles;
  }

  /**
   * Get press releases for a specific ticker.
   * @param ticker Stock ticker symbol (e.g., "AAPL", "TSLA").
   * @param limit Number of articles to return (default: 50, max: 100).
   */
  async getArticlesByTicker(ticker: string, limit = 50): Promise<Article[]> {
    const data = await this.request(`/articles/${encodeURIComponent(ticker)}`, {
      limit: String(limit),
    });
    return parseArticlesResponse(data as Record<string, unknown>).articles;
  }

  /** Check RTPR API health status. */
  async health(): Promise<Record<string, unknown>> {
    const data = await this.request("/health");
    return data as Record<string, unknown>;
  }
}
