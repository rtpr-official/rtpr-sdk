import { ProtocolError } from "./errors";

const MAX_FRAME_BYTES = 64 * 1024;
const MAX_FIELD_LENGTH = 16 * 1024;
const MAX_RULES = 256;

export interface ParsedAlertFrame {
  readonly articleId: string;
  readonly ticker: string;
  readonly ruleNames: readonly string[];
  readonly articlePublishedAt: string;
  /** The exact string supplied in `article_url`; it is never normalized. */
  readonly articleUrl: string;
  readonly dispatchedAtMs: number;
}

export interface ParsedPingFrame {
  readonly kind: "ping";
  readonly correlation: Readonly<Record<string, string | number>>;
}

export interface ParsedAlertMessage {
  readonly kind: "alert";
  readonly alert: ParsedAlertFrame;
}

export interface ParsedConnectedFrame {
  readonly kind: "connected";
}

export type ParsedServerMessage =
  | ParsedPingFrame
  | ParsedAlertMessage
  | ParsedConnectedFrame;

function requiredString(
  object: Record<string, unknown>,
  key: string,
): string {
  const value = object[key];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_FIELD_LENGTH
  ) {
    throw new ProtocolError(`Alert frame field ${key} must be a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function articleIdFromUrl(articleUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(articleUrl);
  } catch {
    throw new ProtocolError("Alert frame article_url must be an absolute URL");
  }

  const prefix = "/a/";
  if (!parsed.pathname.startsWith(prefix)) {
    throw new ProtocolError("Alert frame article_url must use the /a/{article_id} path");
  }
  const encodedId = parsed.pathname.slice(prefix.length);
  if (encodedId.length === 0 || encodedId.includes("/")) {
    throw new ProtocolError("Alert frame article_url must contain one article ID");
  }

  let articleId: string;
  try {
    articleId = decodeURIComponent(encodedId);
  } catch {
    throw new ProtocolError("Alert frame article_url contains an invalid article ID");
  }
  if (articleId.trim().length === 0 || articleId.length > MAX_FIELD_LENGTH) {
    throw new ProtocolError("Alert frame article_url contains an invalid article ID");
  }
  return articleId;
}

export function parseServerMessage(input: string | Buffer): ParsedServerMessage {
  const byteLength =
    typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (byteLength > MAX_FRAME_BYTES) {
    throw new ProtocolError("RTPR alert frame exceeded the 64 KiB protocol limit");
  }

  let value: unknown;
  try {
    value = JSON.parse(typeof input === "string" ? input : input.toString("utf8"));
  } catch {
    throw new ProtocolError("RTPR sent a non-JSON alert frame");
  }

  if (!isRecord(value)) {
    throw new ProtocolError("RTPR alert frame must be a JSON object");
  }

  if (value.type === "ping") {
    const correlation: Record<string, string | number> = {};
    for (const key of ["id", "nonce", "timestamp"] as const) {
      const item = value[key];
      if (typeof item === "string" || (typeof item === "number" && Number.isFinite(item))) {
        correlation[key] = item;
      }
    }
    return { kind: "ping", correlation: Object.freeze(correlation) };
  }
  if (value.type === "connected") {
    return { kind: "connected" };
  }
  if (value.type !== "alert") {
    throw new ProtocolError("RTPR sent an unsupported alert frame type");
  }

  const rules = value.rules;
  if (!Array.isArray(rules) || rules.length === 0 || rules.length > MAX_RULES) {
    throw new ProtocolError("Alert frame rules must be a non-empty bounded array");
  }

  const uniqueRuleNames: string[] = [];
  const seenRuleNames = new Set<string>();
  for (const rule of rules) {
    if (!isRecord(rule)) {
      throw new ProtocolError("Each alert rule must be a JSON object");
    }
    const ruleName = requiredString(rule, "rule_name");
    if (!seenRuleNames.has(ruleName)) {
      seenRuleNames.add(ruleName);
      uniqueRuleNames.push(ruleName);
    }
  }

  const dispatchedAtMs = value.dispatched_at_ms;
  if (
    typeof dispatchedAtMs !== "number" ||
    !Number.isFinite(dispatchedAtMs) ||
    dispatchedAtMs < 0
  ) {
    throw new ProtocolError("Alert frame dispatched_at_ms must be a finite timestamp");
  }

  const articlePublishedAt = requiredString(value, "article_published_at");
  if (!Number.isFinite(Date.parse(articlePublishedAt))) {
    throw new ProtocolError("Alert frame article_published_at must be an ISO timestamp");
  }
  const articleUrl = requiredString(value, "article_url");

  return {
    kind: "alert",
    alert: Object.freeze({
      articleId: articleIdFromUrl(articleUrl),
      ticker: requiredString(value, "ticker"),
      ruleNames: Object.freeze(uniqueRuleNames),
      articlePublishedAt,
      articleUrl,
      dispatchedAtMs,
    }),
  };
}

export function createPong(
  ping: ParsedPingFrame,
): string {
  return JSON.stringify({ type: "pong", ...ping.correlation });
}
