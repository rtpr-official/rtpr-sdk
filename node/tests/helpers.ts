import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { WebSocketServer, type WebSocket } from "ws";
import { AlertStream, type AlertStreamOptions } from "../src";
import type { AlertStreamError, RawArticleEvent } from "../src";

export const API_KEY = "TEST-API-KEY-DO-NOT-LOG";

export interface ArticleRequest {
  readonly id: string;
  readonly url: string;
  readonly apiKey: string | undefined;
  readonly acceptEncoding: string | undefined;
}

export type ArticleHandler = (
  request: IncomingMessage,
  response: ServerResponse,
  id: string,
) => void | Promise<void>;

export class MockRTPRServer {
  readonly #server = createServer((request, response) => {
    void this.#handleRequest(request, response);
  });
  readonly #webSockets = new WebSocketServer({ noServer: true });
  readonly sockets = new Set<WebSocket>();
  readonly articleRequests: ArticleRequest[] = [];
  readonly pongs: string[] = [];
  readonly handshakeResponses: Array<{
    readonly status: number;
    readonly retryAfter?: string;
  }> = [];

  articleHandler: ArticleHandler = (_request, response, id) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(Buffer.from(id));
  };
  keepaliveRequests = 0;
  connectionAttempts = 0;
  #port = 0;

  constructor() {
    this.#server.on("upgrade", (request, socket, head) => {
      this.connectionAttempts += 1;
      const rejection = this.handshakeResponses.shift();
      if (rejection !== undefined) {
        const reason =
          rejection.status === 401
            ? "Unauthorized"
            : rejection.status === 403
              ? "Forbidden"
              : "Too Many Requests";
        const retryAfter =
          rejection.retryAfter === undefined
            ? ""
            : `Retry-After: ${rejection.retryAfter}\r\n`;
        socket.end(
          `HTTP/1.1 ${rejection.status} ${reason}\r\n` +
            `${retryAfter}Connection: close\r\nContent-Length: 0\r\n\r\n`,
        );
        return;
      }
      const url = new URL(request.url ?? "/", this.httpOrigin);
      if (url.pathname !== "/ws-alerts" || url.searchParams.get("apiKey") !== API_KEY) {
        socket.end(
          "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
        return;
      }
      this.#webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        this.#webSockets.emit("connection", webSocket, request);
      });
    });
    this.#webSockets.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("message", (data) => {
        const text = data.toString();
        if (text.includes('"type":"pong"')) {
          this.pongs.push(text);
        }
      });
    });
  }

  get httpOrigin(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  get websocketUrl(): string {
    return `ws://127.0.0.1:${this.#port}/ws-alerts`;
  }

  async start(): Promise<void> {
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    this.#port = (this.#server.address() as AddressInfo).port;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.terminate();
    }
    this.#webSockets.close();
    this.#server.close();
    await once(this.#server, "close");
  }

  stream(options: AlertStreamOptions = {}): AlertStream {
    const withTestOverrides = {
      ...options,
      __test: {
        websocketUrl: this.websocketUrl,
        keepaliveUrl: `${this.httpOrigin}/a/_sdk_keepalive`,
        allowInsecureArticleUrls: true,
        fixedJitter: 1,
      },
    };
    return new AlertStream(API_KEY, withTestOverrides);
  }

  articleUrl(id: string, query = "exp=1776629999&sig=SIGNED%2BVALUE"): string {
    return `${this.httpOrigin}/a/${encodeURIComponent(id)}?${query}`;
  }

  send(value: object): void {
    const payload = JSON.stringify(value);
    for (const socket of this.sockets) {
      socket.send(payload);
    }
  }

  sendAlert(
    id: string,
    options: {
      readonly rules?: readonly string[];
      readonly ticker?: string;
      readonly url?: string;
      readonly dispatchedAtMs?: number;
    } = {},
  ): void {
    this.send({
      type: "alert",
      article_id: id,
      ticker: options.ticker ?? "RTPR",
      rules: (options.rules ?? ["Display rule"]).map((ruleName) => ({
        rule_name: ruleName,
      })),
      article_published_at: "2026-08-19T20:00:00.000Z",
      article_url: options.url ?? this.articleUrl(id),
      dispatched_at_ms: options.dispatchedAtMs ?? 1_787_169_601_250,
    });
  }

  async #handleRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", this.httpOrigin);
    if (request.method === "HEAD" && url.pathname === "/a/_sdk_keepalive") {
      this.keepaliveRequests += 1;
      response.writeHead(204, {
        "cache-control": "no-store",
        "x-rtpr-sdk-keepalive": "1",
      });
      response.end();
      return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/a/")) {
      const id = decodeURIComponent(url.pathname.slice("/a/".length));
      this.articleRequests.push({
        id,
        url: request.url ?? "",
        apiKey:
          typeof request.headers["x-api-key"] === "string"
            ? request.headers["x-api-key"]
            : undefined,
        acceptEncoding:
          typeof request.headers["accept-encoding"] === "string"
            ? request.headers["accept-encoding"]
            : undefined,
      });
      await this.articleHandler(request, response, id);
      return;
    }
    response.writeHead(404);
    response.end();
  }
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Condition was not met before timeout");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

export async function waitForError(
  stream: AlertStream,
  predicate: (error: AlertStreamError) => boolean = () => true,
  timeoutMs = 2_000,
): Promise<AlertStreamError> {
  let found: AlertStreamError | undefined;
  await waitFor(() => {
    const error = stream.pollError();
    if (error !== undefined && predicate(error)) {
      found = error;
      return true;
    }
    return false;
  }, timeoutMs);
  return found as AlertStreamError;
}

export async function nextEvent(
  iterator: AsyncIterator<RawArticleEvent>,
): Promise<RawArticleEvent> {
  const result = await iterator.next();
  if (result.done) {
    throw new Error("AlertStream ended before an event arrived");
  }
  return result.value;
}
