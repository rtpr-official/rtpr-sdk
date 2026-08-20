import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspect } from "node:util";
import {
  BackpressureError,
  type AlertStream,
  type AlertStreamOptions,
  type RawArticleEvent,
} from "../src";
import {
  API_KEY,
  MockRTPRServer,
  nextEvent,
  waitFor,
  waitForError,
} from "./helpers";

const SUPPORT_MARKER = "RTPR_SUPPORT_DIAGNOSTIC_V1 ";

function diagnosticJson(report: string): Record<string, unknown> {
  const offset = report.indexOf(SUPPORT_MARKER);
  if (offset < 0) {
    throw new Error("Support report marker is missing");
  }
  return JSON.parse(report.slice(offset + SUPPORT_MARKER.length)) as Record<
    string,
    unknown
  >;
}

describe("AlertStream burst isolation and diagnostics", () => {
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

  function makeStream(options: AlertStreamOptions = {}): AlertStream {
    const stream = server.stream(options);
    streams.push(stream);
    return stream;
  }

  it(
    "delivers hundreds of mixed-latency responses as completed without silent loss",
    async () => {
      server.articleHandler = async (_request, response, id) => {
        const index = Number(id.slice("burst-".length));
        await new Promise<void>((resolve) =>
          setTimeout(resolve, ((index * 7) % 11) * 2),
        );
        response.writeHead(200);
        response.end(id);
      };
      const stream = makeStream({
        fetchConcurrency: 16,
        maxPendingFetches: 256,
        maxResultItems: 256,
        maxResultBytes: 2 * 1024 * 1024,
        maxArticleBytes: 1024,
      });
      await stream.start();
      const iterator = stream[Symbol.asyncIterator]();
      const sent = Array.from({ length: 200 }, (_, index) => `burst-${index}`);
      for (const id of sent) {
        server.sendAlert(id);
      }

      const received: string[] = [];
      for (let index = 0; index < sent.length; index += 1) {
        received.push((await nextEvent(iterator)).articleId);
      }
      expect(new Set(received)).toEqual(new Set(sent));
      expect(received.slice(0, 20)).not.toEqual(sent.slice(0, 20));
      await waitFor(() => stream.stats().counters.fetchesSucceeded === 200);
      expect(stream.stats().counters.overloads).toBe(0);
      expect(stream.stats().counters.fetchesSucceeded).toBe(200);
      await iterator.return?.();
    },
    15_000,
  );

  it("keeps worker fetches healthy while an async customer handler is blocked", async () => {
    server.articleHandler = (_request, response, id) => {
      response.writeHead(200);
      response.end(id);
    };
    let releaseHandler: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseHandler = resolve;
    });
    let handlerStarted = false;
    let handled = 0;
    const stream = makeStream({
      fetchConcurrency: 8,
      maxPendingFetches: 32,
      maxResultItems: 32,
      maxResultBytes: 1024 * 1024,
      maxArticleBytes: 1024,
    });
    stream.onEvent(async () => {
      handlerStarted = true;
      await gate;
      handled += 1;
    });
    await stream.start();
    for (let index = 0; index < 20; index += 1) {
      server.sendAlert(`slow-handler-${index}`);
    }

    await waitFor(() => handlerStarted);
    await waitFor(() => server.articleRequests.length === 20);
    await waitFor(() => stream.stats().counters.fetchesSucceeded === 20);
    expect(handled).toBe(0);
    expect(stream.stats().queues.activeFetches).toBe(0);

    releaseHandler?.();
    await waitFor(() => handled === 20);
    expect(stream.stats().counters.handlerFailures).toBe(0);
  });

  it("enforces result item and aggregate byte caps with refetchable errors", async () => {
    server.articleHandler = (_request, response) => {
      response.writeHead(200);
      response.end("12345678");
    };
    const stream = makeStream({
      fetchConcurrency: 2,
      maxPendingFetches: 4,
      maxResultItems: 1,
      maxResultBytes: 10,
      maxArticleBytes: 10,
    });
    await stream.start();
    server.sendAlert("bounded-1");
    server.sendAlert("bounded-2");

    const error = await waitForError(
      stream,
      (candidate) => candidate instanceof BackpressureError,
    );
    expect(error).toBeInstanceOf(BackpressureError);
    expect(error.articleId).toMatch(/^bounded-/);
    expect(error.articleUrl).toContain("/a/bounded-");
    expect(String(error)).not.toContain("SIGNED%2BVALUE");
    expect(inspect(error)).not.toContain("SIGNED%2BVALUE");
    expect(stream.stats().queues.bufferedResultItemsHighWater).toBeLessThanOrEqual(
      1,
    );
    expect(stream.stats().queues.bufferedResultBytesHighWater).toBeLessThanOrEqual(
      10,
    );

    const iterator = stream[Symbol.asyncIterator]();
    const delivered = await nextEvent(iterator);
    expect(delivered.byteLength).toBe(8);
    expect(delivered.articleId).not.toBe(error.articleId);
    await iterator.return?.();
  });

  it("produces versioned, bounded, redacted event and window reports", async () => {
    const bodySecret = "RAW-ARTICLE-CONTENT-SECRET";
    const ruleSecret = "CUSTOMER-RULE-SECRET";
    const signedQuery = "exp=1776629999&sig=SIGNED-QUERY-SECRET";
    server.articleHandler = (_request, response) => {
      response.writeHead(200, {
        "content-type": "text/html",
        "cf-ray": "safe-ray-ORD",
        "cf-cache-status": "HIT",
        age: "3",
        "x-rtpr-auth-mode": "signed_token",
        "x-rtpr-origin-ms": "7.2",
        "x-rtpr-storage-tier": "l1",
        "server-timing":
          "origin;dur=7.2;desc=token=HEADER-TOKEN, " +
          "edge;desc=customer.example.com, ip;desc=192.0.2.1",
        location: "https://private.example.com/?apiKey=HEADER-SECRET",
        "set-cookie": "machine-id=SECRET",
      });
      response.end(bodySecret);
    };
    const stream = makeStream({ diagnosticRingSize: 16 });
    await stream.start();
    const iterator = stream[Symbol.asyncIterator]();
    server.sendAlert("diagnostic-id", {
      rules: [ruleSecret],
      url: server.articleUrl("diagnostic-id", signedQuery),
    });
    const event: RawArticleEvent = await nextEvent(iterator);
    expect(inspect(event)).not.toContain("SIGNED-QUERY-SECRET");
    expect(inspect(event)).not.toContain(bodySecret);

    const eventReport = event.supportReport();
    const windowReport = stream.supportReport(600);
    const eventPayload = diagnosticJson(eventReport);
    const windowPayload = diagnosticJson(windowReport);
    expect(eventPayload.schema).toBe("RTPR_SUPPORT_DIAGNOSTIC_V1");
    expect(windowPayload.schema).toBe("RTPR_SUPPORT_DIAGNOSTIC_V1");
    const eventRecord = eventPayload.event as {
      correlation: Record<string, unknown>;
      burstState: Record<string, unknown>;
      http: Record<string, unknown>;
    };
    expect(eventRecord.correlation.articleId).toBe("diagnostic-id");
    expect(eventRecord.correlation.sdkSessionId).toBeTruthy();
    expect(eventRecord.correlation.cfRay).toBe("safe-ray-ORD");
    expect(eventRecord.http.redirectFollowed).toBe(false);
    expect(eventRecord.burstState.resultOffered).toBeTruthy();
    expect(eventReport).toContain("safe-ray-ORD");
    expect(windowReport).toContain("fetchRoundTripMs");
    for (const secret of [
      API_KEY,
      bodySecret,
      ruleSecret,
      "SIGNED-QUERY-SECRET",
      "HEADER-SECRET",
      "private.example.com",
      "machine-id",
      "HEADER-TOKEN",
      "customer.example.com",
      "192.0.2.1",
      "127.0.0.1",
    ]) {
      expect(eventReport).not.toContain(secret);
      expect(windowReport).not.toContain(secret);
    }
    expect(eventReport).not.toContain("articleUrl");
    expect(eventReport).not.toContain('"raw"');
    await iterator.return?.();
  });
});
