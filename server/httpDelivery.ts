import { createHash, randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { type NextFunction, type Request, type Response, Router } from "express";
import { getImageMimeTypeForPath, isPdfFileName } from "../shared/fileClassification.js";
import { HttpError, isHttpError } from "./errors.js";
import { renderMarkdown } from "./markdown.js";
import { isExcludedRealPath, isInsideRoot, relativePathFromRoot, resolveRepoPath, type ResolvedRepoPath } from "./pathGuard.js";
import type { RepositoryRegistry } from "./repositoryRegistry.js";
import type { HttpDeliverySessionStatus, RepositoryConfig } from "./types.js";

export const HTTP_DELIVERY_MAX_SESSIONS = 5;

const MARKDOWN_DELIVERY_SCRIPT = `(() => {
  const copyLabels = {
    idle: "Copy code block",
    copied: "Code block copied",
    error: "Code block copy failed"
  };
  const copyTimers = new WeakMap();

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const copyButton = target.closest(".markdown-code-copy-button");
    if (copyButton) {
      event.preventDefault();
      void copyCodeBlock(copyButton);
      return;
    }
    const wrapButton = target.closest(".markdown-code-wrap-button");
    if (wrapButton) {
      event.preventDefault();
      toggleCodeBlockWrap(wrapButton);
    }
  });

  async function copyCodeBlock(button) {
    const code = button.closest(".markdown-code-block")?.querySelector("pre code");
    if (!code) {
      setCopyState(button, "error");
      scheduleCopyReset(button);
      return;
    }
    try {
      await writeClipboardText(code.textContent || "");
      setCopyState(button, "copied");
    } catch {
      setCopyState(button, "error");
    }
    scheduleCopyReset(button);
  }

  function setCopyState(button, state) {
    const label = copyLabels[state] || copyLabels.idle;
    button.dataset.copyState = state;
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  function scheduleCopyReset(button) {
    const previousTimer = copyTimers.get(button);
    if (previousTimer !== undefined) window.clearTimeout(previousTimer);
    const nextTimer = window.setTimeout(() => {
      if (button.isConnected) setCopyState(button, "idle");
      copyTimers.delete(button);
    }, 1800);
    copyTimers.set(button, nextTimer);
  }

  function toggleCodeBlockWrap(button) {
    const block = button.closest(".markdown-code-block");
    if (!block) return;
    const shouldWrap = !block.classList.contains("wrapped");
    block.classList.toggle("wrapped", shouldWrap);
    button.dataset.wrapState = shouldWrap ? "on" : "off";
    button.setAttribute("aria-pressed", String(shouldWrap));
    const label = shouldWrap ? "Disable code wrap" : "Wrap code block";
    button.setAttribute("aria-label", label);
    button.title = label;
  }

  async function writeClipboardText(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      try {
        await withTimeout(navigator.clipboard.writeText(text), 900);
        return;
      } catch {
        // Fall through to the selection-based copy path.
      }
    }
    if (copyTextWithSelection(text)) return;
    throw new Error("Clipboard write failed");
  }

  async function withTimeout(promise, timeoutMs) {
    let timeoutId;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timeoutId = window.setTimeout(() => reject(new Error("Timed out")), timeoutMs);
        })
      ]);
    } finally {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    }
  }

  function copyTextWithSelection(text) {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.top = "-1000px";
    textarea.style.left = "-1000px";
    textarea.style.width = "1px";
    textarea.style.height = "1px";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    let copied = false;
    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      textarea.remove();
    }
    return copied;
  }
})();`;

const MARKDOWN_DELIVERY_SCRIPT_HASH = createHash("sha256").update(MARKDOWN_DELIVERY_SCRIPT, "utf8").digest("base64");
const MARKDOWN_DELIVERY_CSP = [
  "default-src 'none'",
  "img-src 'self' https:",
  "style-src 'unsafe-inline'",
  `script-src 'sha256-${MARKDOWN_DELIVERY_SCRIPT_HASH}'`,
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

type InternalSession = HttpDeliverySessionStatus;

export type HttpDeliveryService = {
  router: Router;
  status: () => { state: "idle" | "running"; sessions: HttpDeliverySessionStatus[] };
  start: (payload: { repoId: string; path: string; baseUrl: string }) => Promise<{ state: "idle" | "running"; sessions: HttpDeliverySessionStatus[] }>;
  stop: (sessionId: string) => { state: "idle" | "running"; sessions: HttpDeliverySessionStatus[] };
};

export function createHttpDeliveryService(registry: RepositoryRegistry): HttpDeliveryService {
  const sessions = new Map<string, InternalSession>();
  const router = Router();

  function publicStatus() {
    return {
      state: sessions.size > 0 ? ("running" as const) : ("idle" as const),
      sessions: Array.from(sessions.values()).sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    };
  }

  async function start(payload: { repoId: string; path: string; baseUrl: string }) {
    const repo = await registry.findRepository(payload.repoId);
    const resolved = await resolveRepoPath(repo, payload.path);
    const fileStat = await stat(resolved.realPath);
    if (!fileStat.isFile()) throw new HttpError(400, "HTTP Delivery requires a file path.");

    const existing = Array.from(sessions.values()).find((session) => session.repoId === repo.id && session.path === resolved.relativePath);
    if (existing) return publicStatus();
    if (sessions.size >= HTTP_DELIVERY_MAX_SESSIONS) throw new HttpError(409, `HTTP Delivery supports up to ${HTTP_DELIVERY_MAX_SESSIONS} active files.`);

    const id = randomUUID();
    const url = `${payload.baseUrl.replace(/\/$/, "")}/delivery/${encodeURIComponent(id)}/${encodeURIComponent(path.basename(resolved.relativePath))}`;
    sessions.set(id, {
      id,
      repoId: repo.id,
      path: resolved.relativePath,
      url,
      startedAt: new Date().toISOString(),
    });
    return publicStatus();
  }

  function stop(sessionId: string) {
    sessions.delete(sessionId);
    return publicStatus();
  }

  async function handleDeliveryRequest(request: Request, response: Response, next: NextFunction) {
    try {
      const session = sessions.get(String(request.params.sessionId || ""));
      if (!session) throw new HttpError(404, "HTTP Delivery session was not found.");
      const repo = await registry.findRepository(session.repoId);
      const resolved = await resolveRepoPath(repo, session.path);
      const deliveryPath = String(request.params[0] || "");
      const deliveryFile = await resolveDeliveryFile(repo, resolved, deliveryPath);
      const fileStat = await stat(deliveryFile.realPath);
      if (!fileStat.isFile()) throw new HttpError(403, "Directory listing is disabled.");

      response.setHeader("Cache-Control", "no-store, max-age=0");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(path.basename(deliveryFile.relativePath))}`);

      if (isMarkdownFileName(deliveryFile.relativePath)) {
        await sendMarkdownHtml(response, repo, deliveryFile.relativePath, deliveryFile.realPath);
        return;
      }

      response.setHeader("Content-Type", mimeTypeForDeliveryPath(deliveryFile.relativePath));
      response.setHeader("Content-Length", String(fileStat.size));
      response.sendFile(deliveryFile.realPath, (error) => {
        if (error) next(error);
      });
    } catch (error) {
      next(error);
    }
  }

  router.get("/:sessionId", handleDeliveryRequest);
  router.get("/:sessionId/*", handleDeliveryRequest);
  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const httpError = isHttpError(error) ? error : new HttpError(500, "HTTP Delivery failed.");
    response
      .status(httpError.status)
      .set({
        "Cache-Control": "no-store, max-age=0",
        "Content-Type": "text/plain; charset=utf-8",
        "X-Content-Type-Options": "nosniff",
      })
      .send(httpError.message);
  });

  return { router, status: publicStatus, start, stop };
}

type DeliveryFile = {
  relativePath: string;
  realPath: string;
};

async function resolveDeliveryFile(repo: RepositoryConfig, target: ResolvedRepoPath, deliveryPath: string): Promise<DeliveryFile> {
  const assetPath = normalizeDeliveryAssetPath(deliveryPath);
  if (!assetPath) return { relativePath: target.relativePath, realPath: target.realPath };

  const parentRealPath = await realpath(path.dirname(target.realPath));
  const candidateRealPath = await realpath(path.resolve(parentRealPath, assetPath)).catch(() => {
    throw new HttpError(404, "HTTP Delivery asset was not found.");
  });

  if (!isInsideRoot(parentRealPath, candidateRealPath)) {
    throw new HttpError(403, "HTTP Delivery assets must stay under the delivered file directory.");
  }
  if (!isInsideRoot(target.rootRealPath, candidateRealPath)) {
    throw new HttpError(403, "Paths outside the repository root are not visible.");
  }
  if (isExcludedRealPath(repo, target.rootRealPath, candidateRealPath)) {
    throw new HttpError(403, "This path is excluded.");
  }

  return {
    relativePath: relativePathFromRoot(target.rootRealPath, candidateRealPath),
    realPath: candidateRealPath,
  };
}

function normalizeDeliveryAssetPath(input: string): string {
  const value = input.trim().replaceAll("\\", "/");
  if (!value || value === ".") return "";
  if (value.includes("\0") || path.posix.isAbsolute(value)) {
    throw new HttpError(400, "Only relative HTTP Delivery asset paths are allowed.");
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === "") return "";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new HttpError(403, "HTTP Delivery assets must stay under the delivered file directory.");
  }
  return normalized.replace(/^\.\//, "");
}

async function sendMarkdownHtml(response: Response, repo: RepositoryConfig, relativePath: string, realPath: string): Promise<void> {
  const source = await readFile(realPath, "utf8");
  const rendered = renderMarkdown(source, { repoId: repo.id, currentPath: relativePath, repoRoot: repo.root });
  const html = buildMarkdownHtmlDocument(path.posix.basename(relativePath) || relativePath || "Markdown", rendered.html);
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Content-Length", String(Buffer.byteLength(html, "utf8")));
  response.send(html);
}

function buildMarkdownHtmlDocument(title: string, bodyHtml: string): string {
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<meta http-equiv="Content-Security-Policy" content="${MARKDOWN_DELIVERY_CSP}">`,
    `<title>${escapeHtml(title)}</title>`,
    "<style>",
    ":root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #111827; background: #ffffff; }",
    "body { margin: 0; padding: 32px 20px 56px; line-height: 1.68; }",
    "main { max-width: 920px; margin: 0 auto; }",
    "h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.5em 0 0.65em; }",
    "h1 { font-size: 2rem; border-bottom: 1px solid #d7dce0; padding-bottom: 0.35em; }",
    "a { color: #075985; }",
    "img { max-width: 100%; height: auto; }",
    "pre { overflow-x: auto; overflow-y: hidden; padding: 12px 14px; background: #f6f7f8; border: 1px solid #d7dce0; border-radius: 6px; }",
    "code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace; }",
    "pre code { display: block; min-width: max-content; background: transparent; border: 0; color: inherit; padding: 0; overflow-wrap: normal; word-break: normal; }",
    ".markdown-table-scroll { overflow-x: auto; margin: 1em 0; }",
    "table { border-collapse: collapse; width: max-content; min-width: 100%; }",
    "th, td { border-bottom: 1px solid #d7dce0; padding: 6px 10px; text-align: left; vertical-align: top; }",
    "th { font-weight: 700; background: #f6f7f8; }",
    ".markdown-code-block { margin: 1em 0; max-width: 100%; overflow: hidden; border: 1px solid #d7dce0; border-radius: 6px; background: #f6f7f8; }",
    ".markdown-code-block-toolbar { display: flex; justify-content: flex-end; gap: 6px; min-height: 37px; padding: 6px 7px 0; }",
    ".markdown-code-block pre { margin: 0; border: 0; border-radius: 0; background: transparent; padding: 4px 14px 14px; }",
    ".markdown-code-block.wrapped pre, .markdown-code-block.wrapped pre code { white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal; }",
    ".markdown-code-action-button { display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border: 1px solid #cbd3da; border-radius: 7px; background: #ffffff; color: #4e5965; cursor: pointer; padding: 0; line-height: 1; }",
    ".markdown-code-action-button:hover, .markdown-code-action-button:focus-visible { border-color: #9facba; color: #172026; outline: 0; }",
    ".markdown-code-action-button:focus-visible { outline: 2px solid #287888; outline-offset: 2px; }",
    ".markdown-code-icon { display: inline-flex; align-items: center; justify-content: center; }",
    ".markdown-code-icon svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.9; }",
    ".markdown-code-icon-check { display: none; }",
    ".markdown-code-copy-button[data-copy-state=\"copied\"] { border-color: #8fc7a6; background: #edf8f1; color: #23693d; }",
    ".markdown-code-copy-button[data-copy-state=\"copied\"] .markdown-code-icon-copy { display: none; }",
    ".markdown-code-copy-button[data-copy-state=\"copied\"] .markdown-code-icon-check { display: inline-flex; }",
    ".markdown-code-copy-button[data-copy-state=\"error\"] { border-color: #e2aaa4; background: #fff5f4; color: #9d2f2f; }",
    ".markdown-code-wrap-button[data-wrap-state=\"on\"] { border-color: #9ab9c0; background: #e7f1f4; color: #0f4a53; }",
    "blockquote { margin: 1em 0; padding: 12px 14px; border-left: 4px solid #d7dce0; background: #f8faf9; color: #5d6670; }",
    ".task-list-checkbox { margin-right: 0.5em; }",
    "</style>",
    "</head>",
    "<body>",
    `<main>${bodyHtml}</main>`,
    `<script>${MARKDOWN_DELIVERY_SCRIPT}</script>`,
    "</body>",
    "</html>",
  ].join("");
}

function isMarkdownFileName(relativePath: string): boolean {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return extension === ".md" || extension === ".markdown";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function mimeTypeForDeliveryPath(relativePath: string): string {
  const imageMimeType = getImageMimeTypeForPath(relativePath);
  if (imageMimeType) return imageMimeType;
  if (isPdfFileName(relativePath)) return "application/pdf";
  const extension = path.posix.extname(relativePath).toLowerCase();
  if (extension === ".html" || extension === ".htm") return "text/html; charset=utf-8";
  if (isMarkdownFileName(relativePath)) return "text/html; charset=utf-8";
  if ([".css", ".csv", ".json", ".js", ".mjs", ".ts", ".tsx", ".txt", ".yaml", ".yml", ".xml"].includes(extension)) {
    return "text/plain; charset=utf-8";
  }
  return "application/octet-stream";
}
