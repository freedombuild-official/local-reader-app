import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import path from "node:path";
import { HttpError, isHttpError } from "./errors.js";
import {
  htmlPreviewContentType,
  isHtmlPreviewAssetPath,
  isHtmlPreviewDocumentPath,
  isHtmlPreviewWritableTextPath,
} from "./htmlPreviewAssetTypes.js";
import { normalizeRelativePath, readGuardedRepoFile } from "./pathGuard.js";
import type { RepositoryRegistry } from "./repositoryRegistry.js";
import { assertRepositoryRevision } from "./repositoryRevision.js";
import { formatUrlHost, isLoopbackHost } from "./security.js";
import type { HtmlPreviewSessionStatus, RepositoryConfig } from "./types.js";

export const HTML_PREVIEW_MAX_SESSIONS = 5;
export const HTML_PREVIEW_MAX_WRITE_BYTES = 5 * 1024 * 1024;
export const HTML_PREVIEW_MAX_ASSET_BYTES = 25 * 1024 * 1024;
export const HTML_PREVIEW_WRITE_HEADER = "x-local-reader-preview-write";
export const HTML_PREVIEW_WRITE_VALUE = "replace";
export const HTML_PREVIEW_DEFAULT_TTL_MS = 60_000;
export const HTML_PREVIEW_BOOTSTRAP_PATH = "/__reader_wiki_preview_bootstrap";

const HTML_PREVIEW_COOKIE_MAX_AGE_SECONDS = 86_400;
const HTML_PREVIEW_COOKIE_SLOTS = Array.from(
  { length: HTML_PREVIEW_MAX_SESSIONS },
  (_value, index) => `reader_wiki_preview_${index + 1}`,
);
const HTML_PREVIEW_NAVIGATION_GATE = `(() => {
  const allowedUrl = (rawUrl) => {
    try {
      const value = rawUrl === undefined || rawUrl === null || rawUrl === "" ? "about:blank" : String(rawUrl);
      const target = new URL(value, document.baseURI);
      if (target.href === "about:blank") return true;
      if (target.protocol === "blob:") return target.origin === window.location.origin;
      return target.protocol === "http:" && target.origin === window.location.origin;
    } catch {
      return false;
    }
  };
  const allowedPopupUrl = (rawUrl) => {
    try {
      const target = new URL(String(rawUrl), document.baseURI);
      return target.protocol === "http:" &&
        target.origin === window.location.origin &&
        /[.]html?$/i.test(target.pathname);
    } catch {
      return false;
    }
  };
  const opensNewContext = (rawTarget) => {
    const target = String(rawTarget || "").trim().toLowerCase();
    return Boolean(target && !["_self", "_parent", "_top"].includes(target));
  };

  const nativeOpen = window.open.bind(window);
  const patchMethod = (prototype, name, handler) => {
    if (!prototype) return;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor || typeof descriptor.value !== "function") return;
    try {
      Object.defineProperty(prototype, name, {
        configurable: false,
        enumerable: descriptor.enumerable,
        writable: false,
        value: handler(descriptor.value),
      });
    } catch {
      // Some runtimes freeze DOM prototypes. CSP remains the primary boundary.
    }
  };

  patchMethod(Location.prototype, "assign", (nativeMethod) => function(url) {
    if (!allowedUrl(url)) return;
    return nativeMethod.call(this, url);
  });
  patchMethod(Location.prototype, "replace", (nativeMethod) => function(url) {
    if (!allowedUrl(url)) return;
    return nativeMethod.call(this, url);
  });
  patchMethod(HTMLFormElement.prototype, "submit", (nativeMethod) => function() {
    if (!allowedUrl(this.action) ||
      (opensNewContext(this.target) && !allowedPopupUrl(this.action))) return;
    return nativeMethod.call(this);
  });

  Object.defineProperty(window, "open", {
    configurable: false,
    writable: false,
    value(url, target, features) {
      if (!allowedPopupUrl(url)) return null;
      return nativeOpen(url, target, features);
    }
  });

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const anchor = target.closest("a[href]");
    if (anchor && (!allowedUrl(anchor.href) ||
      (opensNewContext(anchor.target) && !allowedPopupUrl(anchor.href)))) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  document.addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    const submitter = event.submitter;
    const hasFormOverrides = submitter instanceof HTMLButtonElement ||
      submitter instanceof HTMLInputElement;
    const action = hasFormOverrides ? submitter.formAction : form.action;
    const target = hasFormOverrides ? submitter.formTarget : form.target;
    if (!allowedUrl(action) ||
      (opensNewContext(target) && !allowedPopupUrl(action))) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  const removeExternalRefresh = (root) => {
    const candidates = [];
    if (root instanceof HTMLMetaElement) candidates.push(root);
    if (root instanceof Element || root instanceof Document) {
      candidates.push(...root.querySelectorAll('meta[http-equiv="refresh" i]'));
    }
    for (const meta of candidates) {
      const content = meta.getAttribute("content") || "";
      const match = content.match(/(?:^|;)\\s*url\\s*=\\s*(.+)$/i);
      if (match && !allowedUrl(match[1].trim().replace(/^['"]|['"]$/g, ""))) meta.remove();
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    removeExternalRefresh(document);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) removeExternalRefresh(node);
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }, { once: true });
})();`;

type HtmlPreviewServiceOptions = {
  repositoryRegistry: Pick<RepositoryRegistry, "findRepository">;
  bindHost?: string;
  now?: () => number;
  ttlMs?: number;
  cleanupIntervalMs?: number;
};

type StartHtmlPreviewInput = {
  repoId: string;
  path: string;
  expectedRevision: string;
  appOrigin: string;
};

export type HtmlPreviewService = {
  start: (input: StartHtmlPreviewInput) => Promise<HtmlPreviewSessionStatus>;
  heartbeat: (sessionId: string) => Promise<HtmlPreviewSessionStatus>;
  stop: (sessionId: string) => Promise<void>;
  stopAll: () => Promise<void>;
  dispose: () => Promise<void>;
  activeCount: () => number;
};

type InternalHtmlPreviewSession = {
  id: string;
  server: Server;
  sockets: Set<Socket>;
  requests: Set<Promise<void>>;
  status: HtmlPreviewSessionStatus;
  repo: RepositoryConfig;
  revision: string;
  origin: string;
  cleanUrl: string;
  appOrigin: string;
  bootstrapToken: string;
  bootstrapConsumed: boolean;
  cookieName: string;
  cookieValue: string;
  expiresAtMs: number;
  closing: boolean;
  closePromise: Promise<void> | null;
};

type WritableTarget = {
  relativePath: string;
  realPath: string;
  rootRealPath: string;
  fileStat: Stats;
};

type PreviewWriteResult = {
  path: string;
  byteLength: number;
  etag: string;
  updatedAt: string;
};

type ForceClosableServer = Server & {
  closeIdleConnections?: () => void;
  closeAllConnections?: () => void;
};

export function createHtmlPreviewService(options: HtmlPreviewServiceOptions): HtmlPreviewService {
  return new HtmlPreviewServerService(options);
}

export class HtmlPreviewServerService implements HtmlPreviewService {
  private readonly repositoryRegistry: HtmlPreviewServiceOptions["repositoryRegistry"];
  private readonly configuredBindHost: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly sessions = new Map<string, InternalHtmlPreviewSession>();
  private readonly writeQueues = new Map<string, Promise<void>>();
  private readonly cleanupTimer: NodeJS.Timeout;
  private startQueue: Promise<void> = Promise.resolve();
  private pendingStarts = 0;
  private disposed = false;

  constructor(options: HtmlPreviewServiceOptions) {
    this.repositoryRegistry = options.repositoryRegistry;
    this.configuredBindHost = normalizeHostname(options.bindHost || "127.0.0.1");
    if (!isLoopbackHost(this.configuredBindHost)) {
      throw new Error("HTML Run preview requires a loopback bind host.");
    }
    this.now = options.now || Date.now;
    this.ttlMs = positiveInteger(options.ttlMs, HTML_PREVIEW_DEFAULT_TTL_MS);
    const cleanupIntervalMs = positiveInteger(
      options.cleanupIntervalMs,
      Math.max(1_000, Math.min(15_000, Math.floor(this.ttlMs / 2))),
    );
    this.cleanupTimer = setInterval(() => {
      void this.closeExpiredSessions();
    }, cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  start(input: StartHtmlPreviewInput): Promise<HtmlPreviewSessionStatus> {
    if (this.disposed) return Promise.reject(new HttpError(503, "HTML Run preview service is shutting down."));
    this.pendingStarts += 1;
    const result = this.startQueue.then(
      () => this.startSession(input),
      () => this.startSession(input),
    );
    const tracked = result.finally(() => {
      this.pendingStarts -= 1;
    });
    this.startQueue = tracked.then(
      () => undefined,
      () => undefined,
    );
    return tracked;
  }

  private async startSession(input: StartHtmlPreviewInput): Promise<HtmlPreviewSessionStatus> {
    if (this.disposed) throw new HttpError(503, "HTML Run preview service is shutting down.");
    await this.closeExpiredSessions();
    if (this.sessions.size >= HTML_PREVIEW_MAX_SESSIONS) {
      throw new HttpError(409, `HTML Run supports up to ${HTML_PREVIEW_MAX_SESSIONS} active sessions.`);
    }

    const appOrigin = normalizeAppOrigin(input.appOrigin, this.configuredBindHost);
    const appUrl = new URL(appOrigin);
    const previewHost = normalizeHostname(appUrl.hostname);
    const repo = await this.repositoryRegistry.findRepository(String(input.repoId || "").trim());
    const revision = await assertRepositoryRevision(repo, input.expectedRevision);
    const entry = await readGuardedRepoFile(repo, input.path, HTML_PREVIEW_MAX_ASSET_BYTES);
    if (!isHtmlPreviewDocumentPath(entry.resolved.relativePath)) {
      throw new HttpError(415, "HTML Run only executes HTML files.");
    }

    const cookieName = this.availableCookieName();
    const id = randomBytes(16).toString("base64url");
    const bootstrapToken = randomBytes(32).toString("base64url");
    const cookieValue = randomBytes(32).toString("base64url");
    const startedAtMs = this.now();
    const expiresAtMs = startedAtMs + this.ttlMs;
    const sockets = new Set<Socket>();
    let session: InternalHtmlPreviewSession | null = null;
    const server = createServer((request, response) => {
      if (!session) {
        sendText(response, 503, "HTML Run preview is not ready.");
        return;
      }
      const operation = this.handleRequest(session, request, response);
      session.requests.add(operation);
      void operation.finally(() => session?.requests.delete(operation));
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 2_000;
    server.maxHeadersCount = 64;
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });

    try {
      await listen(server, previewHost, 0);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      if (!port) throw new Error("HTML Run preview could not allocate a loopback port.");
      const origin = `http://${formatUrlHost(previewHost)}:${port}`;
      const cleanUrl = `${origin}/${encodeRepoPath(entry.resolved.relativePath)}`;
      const bootstrapUrl = `${origin}${HTML_PREVIEW_BOOTSTRAP_PATH}?token=${encodeURIComponent(bootstrapToken)}`;
      const status: HtmlPreviewSessionStatus = {
        id,
        repoId: repo.id,
        path: entry.resolved.relativePath,
        origin,
        url: bootstrapUrl,
        startedAt: new Date(startedAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
      session = {
        id,
        server,
        sockets,
        requests: new Set(),
        status,
        repo: { ...repo, excludes: [...(repo.excludes || [])] },
        revision,
        origin,
        cleanUrl,
        appOrigin,
        bootstrapToken,
        bootstrapConsumed: false,
        cookieName,
        cookieValue,
        expiresAtMs,
        closing: false,
        closePromise: null,
      };
      this.sessions.set(id, session);
      return { ...status };
    } catch (error) {
      await closeServerAndSockets(server, sockets).catch(() => undefined);
      throw error;
    }
  }

  async heartbeat(sessionId: string): Promise<HtmlPreviewSessionStatus> {
    const id = normalizeSessionId(sessionId);
    const knownSession = this.sessions.get(id);
    await this.closeExpiredSessions();
    const session = this.sessions.get(id);
    if (knownSession && !session) throw new HttpError(410, "HTML Run session expired.");
    if (!session || session.closing) throw new HttpError(404, "HTML Run session was not found.");
    session.expiresAtMs = this.now() + this.ttlMs;
    session.status.expiresAt = new Date(session.expiresAtMs).toISOString();
    return { ...session.status };
  }

  async stop(sessionId: string): Promise<void> {
    const id = normalizeSessionId(sessionId);
    if (!id) return;
    const session = this.sessions.get(id);
    if (session) await this.closeSession(session);
  }

  async stopAll(): Promise<void> {
    await this.startQueue;
    await Promise.all([...this.sessions.values()].map((session) => this.closeSession(session)));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.cleanupTimer);
    await this.startQueue;
    await this.stopAll();
  }

  activeCount(): number {
    return this.sessions.size + this.pendingStarts;
  }

  private async handleRequest(
    session: InternalHtmlPreviewSession,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (!this.isActive(session)) throw new HttpError(503, "HTML Run session is not active.");
      assertExactHost(request.headers, session.origin);
      if (session.expiresAtMs <= this.now()) {
        throw new HttpError(410, "HTML Run session expired.");
      }

      const requestUrl = parseRequestUrl(request.url || "/", session.origin);
      const method = String(request.method || "GET").toUpperCase();
      if (requestUrl.pathname === HTML_PREVIEW_BOOTSTRAP_PATH) {
        this.handleBootstrap(session, method, requestUrl, response);
        return;
      }
      if (!hasCookie(request.headers.cookie, session.cookieName, session.cookieValue)) {
        throw new HttpError(401, "HTML Run session cookie is required.");
      }
      await this.assertCurrentRepository(session);

      if (method !== "GET" && method !== "HEAD" && method !== "PUT") {
        response.setHeader("Allow", "GET, HEAD, PUT");
        throw new HttpError(405, "Method Not Allowed");
      }
      const relativePath = requestRelativePath(requestUrl.pathname);
      if (method === "PUT") {
        await this.handleWriteRequest(session, request, response, relativePath);
        return;
      }
      await this.handleAssetRequest(session, request, method, response, relativePath);
    } catch (error) {
      if (!request.complete) request.resume();
      const status = isHttpError(error) ? error.status : 500;
      const message = isHttpError(error) ? error.message : "HTML Run preview failed.";
      if (status === 409 || status === 410) {
        response.once("finish", () => void this.closeSession(session));
      }
      sendText(response, status, message);
    }
  }

  private handleBootstrap(
    session: InternalHtmlPreviewSession,
    method: string,
    requestUrl: URL,
    response: ServerResponse,
  ): void {
    if (method !== "GET") throw new HttpError(405, "HTML Run bootstrap requires GET.");
    const suppliedToken = requestUrl.searchParams.get("token") || "";
    if (session.bootstrapConsumed || !secretsEqual(session.bootstrapToken, suppliedToken)) {
      throw new HttpError(401, "HTML Run bootstrap token is invalid or already used.");
    }
    session.bootstrapConsumed = true;
    response.statusCode = 303;
    response.setHeader("Cache-Control", "no-store, max-age=0");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Set-Cookie",
      `${session.cookieName}=${session.cookieValue}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${HTML_PREVIEW_COOKIE_MAX_AGE_SECONDS}`,
    );
    response.setHeader("Location", session.cleanUrl);
    response.end();
  }

  private async handleAssetRequest(
    session: InternalHtmlPreviewSession,
    request: IncomingMessage,
    method: "GET" | "HEAD",
    response: ServerResponse,
    relativePath: string,
  ): Promise<void> {
    if (!isHtmlPreviewAssetPath(relativePath)) {
      throw new HttpError(415, "This asset type is not available to HTML Run.");
    }
    const fetchDestination = requireOptionalSingleHeader(request.headers["sec-fetch-dest"]).toLowerCase();
    const isDocumentNavigation = fetchDestination === ""
      ? isHtmlPreviewDocumentPath(relativePath)
      : ["document", "iframe"].includes(fetchDestination);
    if (isDocumentNavigation && !isHtmlPreviewDocumentPath(relativePath)) {
      throw new HttpError(415, "HTML Run navigation is limited to HTML documents.");
    }
    const guarded = await readGuardedRepoFile(session.repo, relativePath, HTML_PREVIEW_MAX_ASSET_BYTES);
    const sourceEtag = etagForStat(guarded.stat);
    let bytes = guarded.bytes;
    if (isHtmlPreviewDocumentPath(relativePath)) {
      assertValidUtf8Text(bytes, "HTML Run document is not valid UTF-8 text.");
      if (isDocumentNavigation) {
        bytes = Buffer.from(injectNavigationGate(bytes.toString("utf8")), "utf8");
      }
    }

    setPreviewHeaders(response, session);
    response.statusCode = 200;
    response.setHeader("Content-Type", htmlPreviewContentType(relativePath));
    response.setHeader("Content-Length", String(bytes.byteLength));
    response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(path.basename(relativePath))}`);
    response.setHeader("ETag", sourceEtag);
    if (method === "HEAD") {
      response.end();
      return;
    }
    response.end(bytes);
  }

  private async handleWriteRequest(
    session: InternalHtmlPreviewSession,
    request: IncomingMessage,
    response: ServerResponse,
    relativePath: string,
  ): Promise<void> {
    assertWriteRequestHeaders(request, session);
    const initialTarget = await resolveWritableTarget(session.repo, relativePath);
    const body = await readBoundedUtf8Body(request);
    const ifMatch = requireSingleHeader(
      request.headers["if-match"],
      428,
      "If-Match with the current file ETag is required.",
    );
    const writeKey = `${initialTarget.rootRealPath}\0${initialTarget.relativePath}`;
    const result = await this.enqueueWrite(writeKey, async () => {
      if (!this.isActive(session)) throw new HttpError(503, "HTML Run session is not active.");
      const currentTarget = await resolveWritableTarget(session.repo, relativePath);
      const currentEtag = etagForStat(currentTarget.fileStat);
      if (ifMatch !== currentEtag) {
        throw new HttpError(412, "The save target changed. Read it again before saving.");
      }
      return this.atomicReplace(session, currentTarget, body, currentEtag);
    });
    sendJson(response, 200, result, result.etag);
  }

  private async atomicReplace(
    session: InternalHtmlPreviewSession,
    target: WritableTarget,
    body: Buffer,
    expectedEtag: string,
  ): Promise<PreviewWriteResult> {
    const temporaryPath = path.join(
      path.dirname(target.realPath),
      `.reader-wiki-preview-${process.pid}-${randomBytes(12).toString("hex")}.tmp`,
    );
    let temporaryHandle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      temporaryHandle = await open(temporaryPath, "wx", 0o600);
      await temporaryHandle.writeFile(body);
      await temporaryHandle.sync();
      await temporaryHandle.chmod(target.fileStat.mode & 0o777);
      await temporaryHandle.close();
      temporaryHandle = null;

      const commitTarget = await resolveWritableTarget(session.repo, target.relativePath);
      if (commitTarget.realPath !== target.realPath || etagForStat(commitTarget.fileStat) !== expectedEtag) {
        throw new HttpError(412, "The save target changed. Read it again before saving.");
      }
      if (!this.isActive(session)) throw new HttpError(503, "HTML Run session is not active.");

      await rename(temporaryPath, commitTarget.realPath);
      await syncDirectory(path.dirname(commitTarget.realPath));
      const finalTarget = await resolveWritableTarget(session.repo, target.relativePath);
      return {
        path: finalTarget.relativePath,
        byteLength: body.byteLength,
        etag: etagForStat(finalTarget.fileStat),
        updatedAt: new Date(finalTarget.fileStat.mtimeMs).toISOString(),
      };
    } finally {
      await temporaryHandle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async assertCurrentRepository(session: InternalHtmlPreviewSession): Promise<void> {
    try {
      const currentRepo = await this.repositoryRegistry.findRepository(session.repo.id);
      await assertRepositoryRevision(currentRepo, session.revision);
    } catch {
      throw new HttpError(409, "HTML Run expired because the repository configuration changed.");
    }
  }

  private async closeExpiredSessions(): Promise<void> {
    const now = this.now();
    await Promise.all(
      [...this.sessions.values()]
        .filter((session) => session.expiresAtMs <= now)
        .map((session) => this.closeSession(session)),
    );
  }

  private async closeSession(session: InternalHtmlPreviewSession): Promise<void> {
    if (session.closePromise) return session.closePromise;
    session.closing = true;
    this.sessions.delete(session.id);
    session.closePromise = (async () => {
      await closeServerAndSockets(session.server, session.sockets);
      await Promise.allSettled([...session.requests]);
    })();
    return session.closePromise;
  }

  private isActive(session: InternalHtmlPreviewSession): boolean {
    return !session.closing && this.sessions.get(session.id) === session;
  }

  private availableCookieName(): string {
    const inUse = new Set([...this.sessions.values()].map((session) => session.cookieName));
    const cookieName = HTML_PREVIEW_COOKIE_SLOTS.find((candidate) => !inUse.has(candidate));
    if (!cookieName) throw new HttpError(409, "HTML Run cookie capacity is exhausted.");
    return cookieName;
  }

  private enqueueWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(key) || Promise.resolve();
    const result = previous.then(operation, operation);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.writeQueues.set(key, settled);
    void settled.then(() => {
      if (this.writeQueues.get(key) === settled) this.writeQueues.delete(key);
    });
    return result;
  }
}

async function resolveWritableTarget(repo: RepositoryConfig, relativePath: string): Promise<WritableTarget> {
  const guarded = await readGuardedRepoFile(repo, relativePath, HTML_PREVIEW_MAX_WRITE_BYTES);
  if (!isHtmlPreviewWritableTextPath(relativePath)) {
    throw new HttpError(415, "HTML Run can only save a known UTF-8 text file.");
  }
  assertValidUtf8Text(guarded.bytes, "The save target is not valid UTF-8 text.");
  return {
    relativePath: guarded.resolved.relativePath,
    realPath: guarded.resolved.realPath,
    rootRealPath: guarded.resolved.rootRealPath,
    fileStat: guarded.stat,
  };
}

function assertWriteRequestHeaders(request: IncomingMessage, session: InternalHtmlPreviewSession): void {
  const origin = requireSingleHeader(request.headers.origin, 403, "HTML Run saves require an Origin.");
  if (origin !== session.origin) throw new HttpError(403, "Only the same HTML Run origin can save.");
  const fetchSite = requireOptionalSingleHeader(request.headers["sec-fetch-site"]);
  if (fetchSite && fetchSite !== "same-origin") {
    throw new HttpError(403, "HTML Run rejected a non-same-origin save.");
  }
  const writeIntent = requireSingleHeader(
    request.headers[HTML_PREVIEW_WRITE_HEADER],
    403,
    "HTML Run save intent is required.",
  );
  if (writeIntent !== HTML_PREVIEW_WRITE_VALUE) {
    throw new HttpError(403, "HTML Run save intent is invalid.");
  }
  requireSingleHeader(request.headers["if-match"], 428, "If-Match with the current file ETag is required.");

  const contentEncoding = requireOptionalSingleHeader(request.headers["content-encoding"]);
  if (contentEncoding && contentEncoding !== "identity") {
    throw new HttpError(415, "Compressed save bodies are not supported.");
  }
  const contentType = requireSingleHeader(
    request.headers["content-type"],
    415,
    "HTML Run saves require a Content-Type.",
  );
  if (!isUtf8TextContentType(contentType)) {
    throw new HttpError(415, "HTML Run only saves UTF-8 text.");
  }
  const rawContentLength = request.headers["content-length"];
  if (rawContentLength !== undefined) {
    const contentLength = Number(requireSingleHeader(rawContentLength, 400, "Content-Length is invalid."));
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new HttpError(400, "Content-Length is invalid.");
    }
    if (contentLength > HTML_PREVIEW_MAX_WRITE_BYTES) {
      throw new HttpError(413, "The save body exceeds 5 MiB.");
    }
  }
}

async function readBoundedUtf8Body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  let oversized = false;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    byteLength += chunk.byteLength;
    if (byteLength > HTML_PREVIEW_MAX_WRITE_BYTES) {
      oversized = true;
      continue;
    }
    chunks.push(chunk);
  }
  if (oversized) throw new HttpError(413, "The save body exceeds 5 MiB.");
  const body = Buffer.concat(chunks, byteLength);
  assertValidUtf8Text(body, "The save body is not valid UTF-8 text.");
  return body;
}

function isUtf8TextContentType(rawContentType: string): boolean {
  const [rawMediaType, ...parameters] = rawContentType.split(";");
  const mediaType = rawMediaType?.trim().toLowerCase() || "";
  const charset = parameters
    .map((parameter) => parameter.trim().toLowerCase())
    .find((parameter) => parameter.startsWith("charset="))
    ?.slice("charset=".length)
    .replace(/^"|"$/g, "");
  if (charset && charset !== "utf-8" && charset !== "utf8") return false;
  return Boolean(
    mediaType.startsWith("text/") ||
    [
      "application/json",
      "application/manifest+json",
      "application/javascript",
      "application/xml",
      "application/yaml",
      "application/x-yaml",
      "application/toml",
    ].includes(mediaType),
  );
}

function assertValidUtf8Text(contents: Buffer, invalidUtf8Message: string): void {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    if (decoded.includes("\0")) throw new HttpError(415, "HTML Run text cannot contain NUL.");
  } catch (error) {
    if (isHttpError(error)) throw error;
    throw new HttpError(415, invalidUtf8Message);
  }
}

function setPreviewHeaders(response: ServerResponse, session: InternalHtmlPreviewSession): void {
  const csp = [
    "default-src 'self' data: blob:",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "child-src 'self'",
    "frame-src 'self'",
    "navigate-to 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    `frame-ancestors 'self' ${session.appOrigin}`,
  ].join("; ");
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Content-Security-Policy", csp);
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=(), serial=(), hid=()",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Origin-Agent-Cluster", "?1");
}

function injectNavigationGate(source: string): string {
  const injection = `<script data-reader-wiki-preview-guard>${HTML_PREVIEW_NAVIGATION_GATE}</script>`;
  const doctype = source.match(/^(\s*<!doctype[^>]*>)/i);
  if (!doctype) return `${injection}${source}`;
  return `${doctype[1]}${injection}${source.slice(doctype[1].length)}`;
}

function normalizeAppOrigin(rawOrigin: string, configuredBindHost: string): string {
  let url: URL;
  try {
    url = new URL(rawOrigin);
  } catch {
    throw new HttpError(400, "HTML Run app origin is invalid.");
  }
  const hostname = normalizeHostname(url.hostname);
  if (
    url.protocol !== "http:" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !isLoopbackHost(hostname) ||
    !equivalentConfiguredHost(configuredBindHost, hostname)
  ) {
    throw new HttpError(400, "HTML Run app origin must be the current loopback app origin.");
  }
  return `http://${formatUrlHost(hostname)}:${url.port}`;
}

function equivalentConfiguredHost(configuredHost: string, requestedHost: string): boolean {
  if (configuredHost === "::1" || requestedHost === "::1") return configuredHost === requestedHost;
  return ["127.0.0.1", "localhost"].includes(configuredHost) && ["127.0.0.1", "localhost"].includes(requestedHost);
}

function normalizeHostname(hostname: string): string {
  const value = hostname.trim().toLowerCase();
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function parseRequestUrl(rawUrl: string, origin: string): URL {
  try {
    const url = new URL(rawUrl, origin);
    if (url.origin !== origin || url.username || url.password || url.hash) {
      throw new Error("invalid");
    }
    return url;
  } catch {
    throw new HttpError(400, "HTML Run request URL is invalid.");
  }
}

function requestRelativePath(pathname: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    throw new HttpError(400, "HTML Run path is invalid.");
  }
  if (!decoded.startsWith("/") || decoded.includes("\0") || decoded.includes("\\")) {
    throw new HttpError(400, "HTML Run path is invalid.");
  }
  const relativePath = normalizeRelativePath(decoded.replace(/^\/+/, ""));
  if (!relativePath) throw new HttpError(403, "Directory listing is disabled.");
  return relativePath;
}

function assertExactHost(headers: IncomingHttpHeaders, origin: string): void {
  const host = requireSingleHeader(headers.host, 403, "HTML Run request Host is required.");
  if (host.toLowerCase() !== new URL(origin).host.toLowerCase()) {
    throw new HttpError(403, "HTML Run rejected the request Host.");
  }
}

function hasCookie(cookieHeader: string | undefined, name: string, expectedValue: string): boolean {
  for (const entry of String(cookieHeader || "").split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== name) continue;
    return secretsEqual(expectedValue, entry.slice(separator + 1).trim());
  }
  return false;
}

function secretsEqual(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function encodeRepoPath(relativePath: string): string {
  return relativePath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function normalizeSessionId(sessionId: string): string {
  const value = String(sessionId || "").trim();
  return /^[A-Za-z0-9_-]{16,64}$/.test(value) ? value : "";
}

function requireSingleHeader(
  header: string | string[] | undefined,
  status: number,
  message: string,
): string {
  if (typeof header !== "string" || !header) throw new HttpError(status, message);
  return header;
}

function requireOptionalSingleHeader(header: string | string[] | undefined): string {
  if (header === undefined) return "";
  if (typeof header !== "string") throw new HttpError(400, "Duplicate request headers are not allowed.");
  return header;
}

function etagForStat(fileStat: Stats): string {
  const fingerprint = [
    fileStat.dev,
    fileStat.ino,
    fileStat.size,
    fileStat.mtimeMs,
    fileStat.ctimeMs,
  ].join(":");
  return `"${createHash("sha256").update(fingerprint).digest("base64url")}"`;
}

function sendText(response: ServerResponse, statusCode: number, message: string): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const body = Buffer.from(`${message}\n`, "utf8");
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.setHeader("Content-Length", String(body.byteLength));
  response.end(body);
}

function sendJson(response: ServerResponse, statusCode: number, value: unknown, etag?: string): void {
  if (response.headersSent) {
    response.end();
    return;
  }
  const body = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  response.statusCode = statusCode;
  response.setHeader("Cache-Control", "no-store, max-age=0");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(body.byteLength));
  if (etag) response.setHeader("ETag", etag);
  response.end(body);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

async function syncDirectory(directoryPath: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directoryPath, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error && !isServerNotRunningError(error)) reject(error);
      else resolve();
    });
  });
}

async function closeServerAndSockets(server: Server, sockets: Set<Socket>): Promise<void> {
  const forceClosable = server as ForceClosableServer;
  const closePromise = closeServer(server);
  forceClosable.closeIdleConnections?.();
  forceClosable.closeAllConnections?.();
  for (const socket of sockets) socket.destroy();
  await closePromise;
}

function isServerNotRunningError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: string }).code === "ERR_SERVER_NOT_RUNNING";
}
