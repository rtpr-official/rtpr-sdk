import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AuthenticationError,
  AuthorizationError,
  RateLimitError,
  RedirectRejectedError,
  type AlertStream,
  type AlertStreamOptions,
} from "../src";
import {
  API_KEY,
  MockRTPRServer,
  nextEvent,
  waitFor,
  waitForError,
} from "./helpers";

describe("AlertStream transport", () => {
  let server: MockRTPRServer;
  const streams: AlertStream[] = [];

  beforeEach(async () => {
    server = new MockRTPRServer();
    await server.start();
  });

  afterEach(async () => {
    await Promise.allSettled(streams.map((stream) => stream.close()));
    await server.close();
  });

  function makeStream(options: AlertStreamOptions = {}) {
    const stream = server.stream(options);
    streams.push(stream);
    return stream;
  }

  it("fetches exact raw bytes as-completed, sends API-key fallback, and pongs", async () => {
    const bodies = new Map([
      ["slow", Buffer.from([0, 255, 1, 2, 3])],
      ["fast", Buffer.from("<html>fast\r\nbytes</html>")],
      ["medium", Buffer.from("medium")],
    ]);
    const delays = new Map([
      ["slow", 70],
      ["fast", 2],
      ["medium", 25],
    ]);
    server.articleHandler = async (_request, response, id) => {
      await new Promise<void>((resolve) => setTimeout(resolve, delays.get(id) ?? 0));
      response.writeHead(200, {
        "content-type": "text/html",
        "cf-ray": `ray-${id}`,
      });
      response.end(bodies.get(id));
    };

    const stream = makeStream({
      fetchConcurrency: 3,
      maxPendingFetches: 8,
      maxResultItems: 8,
      maxResultBytes: 1024,
      maxArticleBytes: 1024,
    });
    await stream.start();
    const iterator = stream[Symbol.asyncIterator]();

    server.send({ type: "connected", channel: "alerts" });
    server.send({ type: "ping", nonce: "ping-1" });
    server.sendAlert("slow");
    server.sendAlert("fast");
    server.sendAlert("medium");

    const events = [
      await nextEvent(iterator),
      await nextEvent(iterator),
      await nextEvent(iterator),
    ];
    expect(events.map((event) => event.articleId)).toEqual([
      "fast",
      "medium",
      "slow",
    ]);
    for (const event of events) {
      expect(event.raw.equals(bodies.get(event.articleId) as Buffer)).toBe(true);
      expect(event.statusCode).toBe(200);
      expect(event.contentType).toBe("text/html");
      expect(event.diagnosticHeaders["cf-ray"]).toBe(`ray-${event.articleId}`);
    }
    expect(server.articleRequests).toHaveLength(3);
    expect(server.articleRequests.every((request) => request.apiKey === API_KEY)).toBe(
      true,
    );
    expect(
      server.articleRequests.every(
        (request) => request.acceptEncoding === "identity",
      ),
    ).toBe(true);
    expect(server.articleRequests[0]?.url).toContain(
      "exp=1776629999&sig=SIGNED%2BVALUE",
    );
    await waitFor(() => server.pongs.length === 1);
    expect(JSON.parse(server.pongs[0] as string)).toMatchObject({
      type: "pong",
      nonce: "ping-1",
    });
    await iterator.return?.();
  });

  it("deduplicates article fetches and merges rule names while in flight", async () => {
    server.articleHandler = async (_request, response) => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      response.writeHead(200);
      response.end("one fetch");
    };
    const stream = makeStream();
    await stream.start();
    const iterator = stream[Symbol.asyncIterator]();
    server.sendAlert("dedupe", { rules: ["Rule A"] });
    server.sendAlert("dedupe", { rules: ["Rule B", "Rule A"] });

    const event = await nextEvent(iterator);
    expect(event.ruleNames).toEqual(["Rule A", "Rule B"]);
    expect(server.articleRequests).toHaveLength(1);
    expect(stream.stats().counters.duplicateFrames).toBe(1);
    await iterator.return?.();
  });

  it.each([
    [401, AuthenticationError],
    [403, AuthorizationError],
  ])("surfaces terminal HTTP %i handshake errors", async (status, ErrorType) => {
    server.handshakeResponses.push({ status });
    const stream = makeStream({ connectTimeoutMs: 1_000 });
    await expect(stream.start()).rejects.toBeInstanceOf(ErrorType);
    expect(server.connectionAttempts).toBe(1);
  });

  it("honors Retry-After on HTTP 429 before reconnecting", async () => {
    server.handshakeResponses.push({ status: 429, retryAfter: "0.04" });
    const stream = makeStream({
      connectTimeoutMs: 1_000,
      reconnectBaseMs: 1,
      reconnectMaxMs: 100,
    });
    const startedAt = Date.now();
    await stream.start();

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
    expect(server.connectionAttempts).toBe(2);
    expect(await waitForError(stream)).toBeInstanceOf(RateLimitError);
  });

  it("retries transient 5xx and Cloudflare 526, rejecting redirects", async () => {
    const attempts = new Map<string, number>();
    server.articleHandler = (_request, response, id) => {
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      if (id === "retry" && attempt === 1) {
        response.writeHead(503);
        response.end();
        return;
      }
      if (id === "retry" && attempt === 2) {
        response.writeHead(526);
        response.end();
        return;
      }
      if (id === "redirect") {
        response.writeHead(302, {
          location: `${server.httpOrigin}/a/login?apiKey=SHOULD-NOT-FOLLOW`,
        });
        response.end();
        return;
      }
      response.writeHead(200);
      response.end("retried");
    };

    const stream = makeStream({
      fetchRetryBaseMs: 1,
      fetchRetryMaxMs: 5,
    });
    await stream.start();
    const iterator = stream[Symbol.asyncIterator]();
    server.sendAlert("retry");
    expect((await nextEvent(iterator)).raw.toString()).toBe("retried");
    expect(attempts.get("retry")).toBe(3);

    server.sendAlert("redirect");
    const error = await waitForError(
      stream,
      (candidate) => candidate instanceof RedirectRejectedError,
    );
    expect(error).toBeInstanceOf(RedirectRejectedError);
    expect(attempts.get("redirect")).toBe(1);
    expect(server.articleRequests.some((request) => request.id === "login")).toBe(
      false,
    );
    await iterator.return?.();
  });

  it("shuts down cleanly and makes close idempotent", async () => {
    const stream = makeStream();
    await stream.start();
    await waitFor(() => server.keepaliveRequests > 0);
    expect(stream.stats().keepalive.healthy).toBe(true);
    await stream.close();
    await stream.close();
    expect(stream.state).toBe("closed");
  });
});
