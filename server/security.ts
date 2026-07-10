import { randomBytes, timingSafeEqual } from "node:crypto";
import type { RequestHandler, Response } from "express";

const SESSION_COOKIE = "reader_wiki_session";
const TOKEN_HEADER = "x-reader-wiki-token";
const MUTATION_HEADER = "x-reader-wiki-request";
const DEFAULT_HOST = "127.0.0.1";

export type ReaderWikiSecurity = {
  token: string;
  setPort: (port: number) => void;
  headers: RequestHandler;
  issueSession: RequestHandler;
  protectApi: RequestHandler;
};

export function createReaderWikiSecurity(options: { bindHost?: string; token?: string; dev?: boolean } = {}): ReaderWikiSecurity {
  const bindHost = normalizeHost(options.bindHost || DEFAULT_HOST);
  const token = options.token || randomBytes(32).toString("base64url");
  let port = 0;

  function allowedHosts(): Set<string> {
    if (!port) return new Set();
    const hosts = new Set([hostWithPort(bindHost, port)]);
    if (bindHost === "127.0.0.1" || bindHost === "localhost") {
      hosts.add(hostWithPort("127.0.0.1", port));
      hosts.add(hostWithPort("localhost", port));
    }
    if (bindHost === "::1") hosts.add(hostWithPort("::1", port));
    return hosts;
  }

  const headers: RequestHandler = (request, response, next) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(self), payment=(), usb=()");
    if (!request.path.startsWith("/delivery/")) {
      const connectSources = options.dev
        ? "'self' ws://127.0.0.1:* ws://localhost:* ws://[::1]:*"
        : "'self'";
      const scriptSources = options.dev ? "'self' 'unsafe-inline'" : "'self'";
      response.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          `script-src ${scriptSources}`,
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob: https:",
          `connect-src ${connectSources}`,
          "font-src 'self' data:",
          "frame-src 'self' data: blob:",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
          "frame-ancestors 'none'",
        ].join("; "),
      );
    }
    next();
  };

  const issueSession: RequestHandler = (request, response, next) => {
    if (request.method === "GET" && request.path === "/") {
      response.append("Set-Cookie", `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    }
    next();
  };

  const protectApi: RequestHandler = (request, response, next) => {
    const hosts = allowedHosts();
    const requestHost = String(request.headers.host || "").trim().toLowerCase();
    if (!hosts.has(requestHost)) {
      deny(response, 403, "Reader-Wiki rejected the request Host.");
      return;
    }

    const suppliedToken = headerValue(request.headers[TOKEN_HEADER]) || cookieValue(request.headers.cookie, SESSION_COOKIE);
    if (!tokensEqual(token, suppliedToken)) {
      deny(response, 401, "Reader-Wiki API session is required.");
      return;
    }

    if (isMutation(request.method)) {
      const expectedOrigins = new Set(Array.from(hosts, (host) => `http://${host}`));
      const origin = headerValue(request.headers.origin);
      if (!expectedOrigins.has(origin)) {
        deny(response, 403, "Reader-Wiki rejected the request Origin.");
        return;
      }
      if (headerValue(request.headers[MUTATION_HEADER]) !== "1") {
        deny(response, 403, "Reader-Wiki mutation header is required.");
        return;
      }
      const contentType = headerValue(request.headers["content-type"]).toLowerCase();
      if (!contentType.startsWith("application/json")) {
        deny(response, 415, "Reader-Wiki mutations require application/json.");
        return;
      }
    }

    const fetchSite = headerValue(request.headers["sec-fetch-site"]);
    if (fetchSite === "cross-site") {
      deny(response, 403, "Reader-Wiki rejected a cross-site request.");
      return;
    }
    next();
  };

  return {
    token,
    setPort(nextPort) {
      port = nextPort;
    },
    headers,
    issueSession,
    protectApi,
  };
}

export function isLoopbackHost(input: string): boolean {
  const host = normalizeHost(input);
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

export function formatUrlHost(input: string): string {
  const host = normalizeHost(input);
  return host.includes(":") ? `[${host}]` : host;
}

function normalizeHost(input: string): string {
  const host = input.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) return host.slice(1, -1);
  return host;
}

function hostWithPort(host: string, port: number): string {
  return `${formatUrlHost(host)}:${port}`;
}

function isMutation(method: string): boolean {
  return method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
}

function headerValue(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return String(value[0] || "").trim();
  return String(value || "").trim();
}

function cookieValue(cookieHeader: string | undefined, name: string): string {
  for (const entry of String(cookieHeader || "").split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() === name) return entry.slice(separator + 1).trim();
  }
  return "";
}

function tokensEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function deny(response: Response, status: number, message: string): void {
  response.status(status).setHeader("Cache-Control", "no-store").json({ error: message });
}
