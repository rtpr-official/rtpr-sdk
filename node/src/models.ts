export interface Article {
  readonly ticker: string;
  readonly title: string;
  readonly author: string;
  readonly created: string;
  readonly articleBody: string;
  readonly exchange: string;
  readonly articleBodyHtml: string;
  readonly id: string;
  readonly tickers: string[];
}

export interface ArticlesResponse {
  readonly count: number;
  readonly articles: Article[];
}

export function parseArticle(data: Record<string, unknown>): Article {
  const rawTickers = data.tickers;
  return Object.freeze({
    ticker: String(data.ticker ?? ""),
    title: String(data.title ?? ""),
    author: String(data.author ?? ""),
    created: String(data.created ?? ""),
    articleBody: String(data.article_body ?? ""),
    exchange: String(data.exchange ?? ""),
    articleBodyHtml: String(data.article_body_html ?? ""),
    id: String(data.id ?? ""),
    tickers: Array.isArray(rawTickers) ? rawTickers.map(String) : [],
  });
}

export function parseArticlesResponse(data: Record<string, unknown>): ArticlesResponse {
  const rawArticles = data.articles;
  const articles = Array.isArray(rawArticles)
    ? rawArticles.map((a) => parseArticle(a as Record<string, unknown>))
    : [];
  return Object.freeze({ count: Number(data.count ?? 0), articles });
}
