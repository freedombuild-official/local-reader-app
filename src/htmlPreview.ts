import type { HtmlPreviewSessionStatus } from "./types";

export const HTML_PREVIEW_HEARTBEAT_INTERVAL_MS = 15_000;
export const HTML_PREVIEW_IFRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-modals allow-popups";

export function validateHtmlPreviewSession(
  value: HtmlPreviewSessionStatus,
  expected: { repoId: string; path: string },
): HtmlPreviewSessionStatus {
  if (!value || typeof value !== "object") throw new Error("HTML Run returned an invalid session.");
  const id = boundedString(value.id, 64);
  const repoId = boundedString(value.repoId, 256);
  const path = boundedString(value.path, 4_096);
  const origin = parseLoopbackHttpOrigin(value.origin);
  const url = parseLoopbackHttpUrl(value.url);
  const startedAt = parseIsoDate(value.startedAt);
  const expiresAt = parseIsoDate(value.expiresAt);
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) throw new Error("HTML Run returned an invalid session id.");
  if (repoId !== expected.repoId || path !== expected.path) {
    throw new Error("HTML Run returned a session for a different repository file.");
  }
  if (url.origin !== origin) throw new Error("HTML Run returned mismatched preview origins.");
  if (url.username || url.password || url.hash) throw new Error("HTML Run returned an unsafe preview URL.");
  if (expiresAt.getTime() <= startedAt.getTime()) throw new Error("HTML Run returned an invalid session lease.");
  return {
    id,
    repoId,
    path,
    origin,
    url: url.href,
    startedAt: startedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

export function isLoopbackPreviewUrl(value: string): boolean {
  try {
    parseLoopbackHttpUrl(value);
    return true;
  } catch {
    return false;
  }
}

function parseLoopbackHttpOrigin(value: string): string {
  const url = parseLoopbackHttpUrl(value);
  if (url.pathname !== "/" || url.search || url.hash) throw new Error("HTML Run returned an invalid preview origin.");
  return url.origin;
}

function parseLoopbackHttpUrl(value: string): URL {
  const url = new URL(boundedString(value, 8_192));
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (url.protocol !== "http:" || !url.port || !["127.0.0.1", "localhost", "::1"].includes(hostname)) {
    throw new Error("HTML Run returned a non-loopback preview URL.");
  }
  return url;
}

function parseIsoDate(value: string): Date {
  const date = new Date(boundedString(value, 64));
  if (Number.isNaN(date.getTime())) throw new Error("HTML Run returned an invalid timestamp.");
  return date;
}

function boundedString(value: unknown, maxLength: number): string {
  return typeof value === "string" && value.length <= maxLength ? value : "";
}
