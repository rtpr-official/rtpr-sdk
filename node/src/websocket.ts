import WebSocket from "ws";
import { AuthenticationError } from "./errors";
import { Article, parseArticle } from "./models";

const DEFAULT_WS_URL = "wss://ws.rtpr.io";
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

export interface RtprWebSocketOptions {
  wsUrl?: string;
  autoReconnect?: boolean;
}

type ArticleCallback = (article: Article) => void | Promise<void>;
type EventCallback = (data: Record<string, unknown>) => void | Promise<void>;

export class RtprWebSocket {
  private readonly apiKey: string;
  private readonly wsUrl: string;
  private readonly autoReconnect: boolean;

  private ws: WebSocket | null = null;
  private tickers: string[] = [];
  private running = false;

  private articleCallback: ArticleCallback | null = null;
  private connectCallback: EventCallback | null = null;
  private disconnectCallback: EventCallback | null = null;
  private errorCallback: EventCallback | null = null;

  constructor(apiKey: string, options: RtprWebSocketOptions = {}) {
    this.apiKey = apiKey;
    this.wsUrl = (options.wsUrl ?? DEFAULT_WS_URL).replace(/\/+$/, "");
    this.autoReconnect = options.autoReconnect ?? true;
  }

  /** Register a callback for new articles. */
  onArticle(callback: ArticleCallback): this {
    this.articleCallback = callback;
    return this;
  }

  /** Register a callback for connection events. */
  onConnect(callback: EventCallback): this {
    this.connectCallback = callback;
    return this;
  }

  /** Register a callback for disconnection events. */
  onDisconnect(callback: EventCallback): this {
    this.disconnectCallback = callback;
    return this;
  }

  /** Register a callback for error events. */
  onError(callback: EventCallback): this {
    this.errorCallback = callback;
    return this;
  }

  /**
   * Connect to the RTPR WebSocket and start streaming.
   * Resolves when stop() is called or a fatal auth error occurs.
   * @param tickers Ticker symbols to subscribe to. Use ["*"] for firehose.
   */
  async connect(tickers?: string[]): Promise<void> {
    if (tickers) this.tickers = [...tickers];
    this.running = true;
    let delay = INITIAL_RECONNECT_DELAY_MS;

    while (this.running) {
      try {
        await this.runConnection();
        delay = INITIAL_RECONNECT_DELAY_MS;
      } catch (err: unknown) {
        if (err instanceof AuthenticationError) throw err;

        const msg = err instanceof Error ? err.message : String(err);
        this.fireError({ message: msg });
      }

      if (!this.running || !this.autoReconnect) break;

      await sleep(delay);
      delay = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
    }
  }

  /** Subscribe to additional tickers while connected. */
  subscribe(tickers: string[]): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: "subscribe", tickers }));
    }
    for (const t of tickers) {
      if (!this.tickers.includes(t)) this.tickers.push(t);
    }
  }

  /** Unsubscribe from tickers. Pass ["*"] to clear all. */
  unsubscribe(tickers: string[]): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ action: "unsubscribe", tickers }));
    }
    if (tickers.includes("*")) {
      this.tickers = [];
    } else {
      this.tickers = this.tickers.filter((t) => !tickers.includes(t));
    }
  }

  /** Disconnect and prevent reconnection. */
  stop(): void {
    this.running = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /** Whether the WebSocket is currently open. */
  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  private runConnection(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const url = `${this.wsUrl}?apiKey=${this.apiKey}`;
      const ws = new WebSocket(url);
      this.ws = ws;

      ws.on("message", (raw: WebSocket.Data) => {
        try {
          const message = JSON.parse(raw.toString()) as Record<string, unknown>;
          this.dispatch(message);
        } catch {
          // ignore malformed messages
        }
      });

      ws.on("close", (code: number) => {
        this.ws = null;
        this.fireDisconnect({ code });

        if (code === 4003) {
          reject(new AuthenticationError("Invalid API key"));
        } else if (code === 4004) {
          reject(new AuthenticationError("Trial expired"));
        } else {
          resolve();
        }
      });

      ws.on("error", (err: Error) => {
        this.fireError({ message: err.message });
      });
    });
  }

  private dispatch(message: Record<string, unknown>): void {
    const type = message.type as string | undefined;

    switch (type) {
      case "connected":
        this.fireConnect(message);
        if (this.tickers.length > 0) {
          this.subscribe(this.tickers);
        }
        break;

      case "article": {
        const data = (message.data ?? {}) as Record<string, unknown>;
        const article = parseArticle(data);
        if (this.articleCallback) this.articleCallback(article);
        break;
      }

      case "ping":
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "pong" }));
        }
        break;

      case "error":
        this.fireError(message);
        break;
    }
  }

  private fireConnect(data: Record<string, unknown>): void {
    if (this.connectCallback) this.connectCallback(data);
  }

  private fireDisconnect(data: Record<string, unknown>): void {
    if (this.disconnectCallback) this.disconnectCallback(data);
  }

  private fireError(data: Record<string, unknown>): void {
    if (this.errorCallback) this.errorCallback(data);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
