import { describe, expect, it } from "vitest";
import { ProtocolError } from "../src";
import { redactDiagnosticText } from "../src/diagnostics";
import { createPong, parseServerMessage } from "../src/protocol";

describe("saved-rule alert protocol", () => {
  it("preserves the exact signed URL and merges duplicate rule names", () => {
    const articleUrl =
      "https://rtpr.io/a/article-1?exp=1776629999&sig=a%2Bb%2Fc&next=x%26y";
    const parsed = parseServerMessage(
      JSON.stringify({
        type: "alert",
        ticker: "RTPR",
        rules: [
          { rule_name: "Display rule" },
          { rule_name: "Display rule" },
          { rule_name: "Second rule" },
        ],
        article_published_at: "2026-08-19T20:00:00.000Z",
        article_url: articleUrl,
        dispatched_at_ms: 1_787_169_601_250,
      }),
    );

    expect(parsed.kind).toBe("alert");
    if (parsed.kind === "alert") {
      expect(parsed.alert.articleId).toBe("article-1");
      expect(parsed.alert.articleUrl).toBe(articleUrl);
      expect(parsed.alert.ruleNames).toEqual(["Display rule", "Second rule"]);
      expect(parsed.alert.alertKind).toBe("rule_match");
      expect(parsed.alert.impact).toBeNull();
    }
  });

  it("decodes the article ID from the permalink path", () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        type: "alert",
        ticker: "RTPR",
        rules: [{ rule_name: "Display rule" }],
        article_published_at: "2026-08-19T20:00:00.000Z",
        article_url:
          "https://rtpr.io/a/article%20one%2Fpart?exp=1776629999&sig=SIGNED",
        dispatched_at_ms: 1_787_169_601_250,
      }),
    );

    expect(parsed.kind).toBe("alert");
    if (parsed.kind === "alert") {
      expect(parsed.alert.articleId).toBe("article one/part");
    }
  });

  it("parses impact-score frames without rules and rejects unknown kinds", () => {
    const parsed = parseServerMessage(
      JSON.stringify({
        type: "alert",
        alert_kind: "high_impact",
        ticker: "BMRA",
        impact_score: 92,
        impact_tier: "high",
        impact_direction: "bullish",
        event_type: "fda_approval",
        band_hit_rate: 0.41,
        article_published_at: "2026-08-24T12:30:00.000Z",
        article_url: "https://rtpr.io/a/impact-1?exp=1776629999&sig=SIGNED",
        dispatched_at_ms: 1_787_169_601_250,
      }),
    );

    expect(parsed.kind).toBe("alert");
    if (parsed.kind === "alert") {
      expect(parsed.alert.alertKind).toBe("high_impact");
      expect(parsed.alert.articleId).toBe("impact-1");
      expect(parsed.alert.ruleNames).toEqual([]);
      expect(parsed.alert.impact).toEqual({
        impact_score: 92,
        impact_tier: "high",
        impact_direction: "bullish",
        event_type: "fda_approval",
        band_hit_rate: 0.41,
      });
    }

    expect(() =>
      parseServerMessage('{"type":"alert","alert_kind":"mystery"}'),
    ).toThrow(ProtocolError);
  });

  it("accepts connected and creates correlated pong frames", () => {
    expect(parseServerMessage('{"type":"connected"}')).toEqual({
      kind: "connected",
    });
    const ping = parseServerMessage(
      '{"type":"ping","nonce":"nonce-1","timestamp":123}',
    );
    expect(ping.kind).toBe("ping");
    if (ping.kind === "ping") {
      expect(JSON.parse(createPong(ping))).toEqual({
        type: "pong",
        nonce: "nonce-1",
        timestamp: 123,
      });
    }
  });

  it("rejects unknown, malformed, and oversized frames", () => {
    expect(() => parseServerMessage('{"type":"article"}')).toThrow(
      ProtocolError,
    );
    expect(() => parseServerMessage("not json")).toThrow(ProtocolError);
    expect(() => parseServerMessage("x".repeat(65 * 1024))).toThrow(
      ProtocolError,
    );
  });

  it("removes credential values from defensive diagnostic redaction", () => {
    const redacted = redactDiagnosticText(
      "token=TOKEN-SECRET signature=SIGNATURE-SECRET",
    );
    expect(redacted).not.toContain("TOKEN-SECRET");
    expect(redacted).not.toContain("SIGNATURE-SECRET");
  });
});
