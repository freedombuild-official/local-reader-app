import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { type NextFunction, type Request, type Response, Router } from "express";
import MarkdownIt from "markdown-it";
import { getImageMimeTypeForPath, isPdfFileName } from "../shared/fileClassification.js";
import { HttpError, isHttpError } from "./errors.js";
import { renderMarkdown } from "./markdown.js";
import { isExcludedRealPath, isInsideRoot, readGuardedRepoFile, relativePathFromRoot, resolveRepoPath, type ResolvedRepoPath } from "./pathGuard.js";
import type { RepositoryRegistry } from "./repositoryRegistry.js";
import { assertRepositoryRevision } from "./repositoryRevision.js";
import type { HttpDeliveryItemStatus, RepositoryConfig } from "./types.js";

export const HTTP_DELIVERY_MAX_SESSIONS = 5;
const HTTP_DELIVERY_MARKDOWN_MAX_BYTES = 2 * 1024 * 1024;
const HTTP_DELIVERY_ASSET_MAX_BYTES = 25 * 1024 * 1024;

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
  "connect-src 'none'",
  "style-src 'unsafe-inline'",
  `script-src 'sha256-${MARKDOWN_DELIVERY_SCRIPT_HASH}'`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

type InternalSession = HttpDeliveryItemStatus & {
  allowedAssets: Set<string>;
  repo: RepositoryConfig;
  revision: string;
};

const deliveryMarkdown = new MarkdownIt({ html: false, linkify: false });
const PASSIVE_ASSET_EXTENSIONS = new Set([".gif", ".jpeg", ".jpg", ".pdf", ".png", ".webp"]);

export type HttpDeliveryService = {
  router: Router;
  status: () => { state: "idle" | "running"; items: HttpDeliveryItemStatus[] };
  start: (payload: { repo: RepositoryConfig; revision: string; path: string; baseUrl: string }) => Promise<{ state: "idle" | "running"; items: HttpDeliveryItemStatus[] }>;
  stop: (deliveryId: string) => { state: "idle" | "running"; items: HttpDeliveryItemStatus[] };
  stopAll: () => void;
};

export function createHttpDeliveryService(registry: RepositoryRegistry): HttpDeliveryService {
  const items = new Map<string, InternalSession>();
  const router = Router();

  function publicStatus() {
    return {
      state: items.size > 0 ? ("running" as const) : ("idle" as const),
      items: Array.from(items.values())
        .map(({ allowedAssets: _allowedAssets, repo: _repo, revision: _revision, ...item }) => item)
        .sort((left, right) => left.startedAt.localeCompare(right.startedAt)),
    };
  }

  async function start(payload: { repo: RepositoryConfig; revision: string; path: string; baseUrl: string }) {
    const repo = { ...payload.repo, excludes: [...(payload.repo.excludes || [])] };
    await assertRepositoryRevision(repo, payload.revision);
    const resolved = await resolveRepoPath(repo, payload.path);
    const fileStat = await stat(resolved.realPath);
    if (!fileStat.isFile()) throw new HttpError(400, "HTTP Delivery requires a file path.");
    if (isActiveDeliveryPath(resolved.relativePath)) {
      throw new HttpError(415, "HTTP Delivery does not execute HTML or SVG files.");
    }

    const existing = Array.from(items.values()).find((item) => item.repoId === repo.id && item.revision === payload.revision && item.path === resolved.relativePath);
    if (existing) return publicStatus();
    if (items.size >= HTTP_DELIVERY_MAX_SESSIONS) throw new HttpError(409, `HTTP Delivery supports up to ${HTTP_DELIVERY_MAX_SESSIONS} active files.`);

    const id = randomUUID();
    const url = `${payload.baseUrl.replace(/\/$/, "")}/delivery/${encodeURIComponent(id)}/${encodeURIComponent(path.basename(resolved.relativePath))}`;
    const allowedAssets = isMarkdownFileName(resolved.relativePath)
      ? await collectPassiveMarkdownAssets(repo, resolved)
      : new Set<string>();
    items.set(id, {
      id,
      repoId: repo.id,
      path: resolved.relativePath,
      url,
      startedAt: new Date().toISOString(),
      allowedAssets,
      repo,
      revision: payload.revision,
    });
    return publicStatus();
  }

  function stop(deliveryId: string) {
    items.delete(deliveryId);
    return publicStatus();
  }

  function stopAll() {
    items.clear();
  }

  async function handleDeliveryRequest(request: Request, response: Response, next: NextFunction) {
    try {
      const item = items.get(String(request.params.deliveryId || ""));
      if (!item) throw new HttpError(404, "HTTP Delivery item was not found.");
      try {
        const currentRepo = await registry.findRepository(item.repoId);
        await assertRepositoryRevision(currentRepo, item.revision);
      } catch {
        items.delete(item.id);
        throw new HttpError(409, "HTTP Delivery expired because the repository configuration changed.");
      }
      const repo = item.repo;
      const resolved = await resolveRepoPath(repo, item.path);
      const deliveryPath = String(request.params[0] || "");
      const assetQuery = typeof request.query.asset === "string" ? request.query.asset : "";
      const deliveryFile = assetQuery
        ? await resolveAllowedDeliveryAsset(repo, assetQuery, item.allowedAssets)
        : await resolveDeliveryFile(repo, resolved, deliveryPath, item.allowedAssets);
      const isMarkdown = isMarkdownFileName(deliveryFile.relativePath);
      const guarded = await readGuardedRepoFile(repo, deliveryFile.relativePath, isMarkdown ? HTTP_DELIVERY_MARKDOWN_MAX_BYTES : HTTP_DELIVERY_ASSET_MAX_BYTES);

      response.setHeader("Cache-Control", "no-store, max-age=0");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(path.basename(deliveryFile.relativePath))}`);

      if (isMarkdown) {
        sendMarkdownHtml(response, repo, deliveryFile.relativePath, guarded.bytes.toString("utf8"), `/delivery/${encodeURIComponent(item.id)}`);
        return;
      }

      response.setHeader("Content-Type", mimeTypeForDeliveryPath(deliveryFile.relativePath));
      response.setHeader("Content-Length", String(guarded.bytes.byteLength));
      response.send(guarded.bytes);
    } catch (error) {
      next(error);
    }
  }

  router.get("/:deliveryId", handleDeliveryRequest);
  router.get("/:deliveryId/*", handleDeliveryRequest);
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

  return { router, status: publicStatus, start, stop, stopAll };
}

type DeliveryFile = {
  relativePath: string;
  realPath: string;
};

async function resolveDeliveryFile(repo: RepositoryConfig, target: ResolvedRepoPath, deliveryPath: string, allowedAssets: Set<string>): Promise<DeliveryFile> {
  const assetPath = normalizeDeliveryAssetPath(deliveryPath);
  if (!assetPath || assetPath === path.posix.basename(target.relativePath)) {
    return { relativePath: target.relativePath, realPath: target.realPath };
  }

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

  const relativePath = relativePathFromRoot(target.rootRealPath, candidateRealPath);
  if (!allowedAssets.has(relativePath)) {
    throw new HttpError(403, "HTTP Delivery asset is not referenced by the delivered Markdown file.");
  }
  return {
    relativePath,
    realPath: candidateRealPath,
  };
}

async function resolveAllowedDeliveryAsset(repo: RepositoryConfig, inputPath: string, allowedAssets: Set<string>): Promise<DeliveryFile> {
  const relativePath = normalizeDeliveryAssetPath(inputPath);
  if (!relativePath || !allowedAssets.has(relativePath)) {
    throw new HttpError(403, "HTTP Delivery asset is not referenced by the delivered Markdown file.");
  }
  const resolved = await resolveRepoPath(repo, relativePath);
  return { relativePath: resolved.relativePath, realPath: resolved.realPath };
}

async function collectPassiveMarkdownAssets(repo: RepositoryConfig, target: ResolvedRepoPath): Promise<Set<string>> {
  const source = (await readGuardedRepoFile(repo, target.relativePath, HTTP_DELIVERY_MARKDOWN_MAX_BYTES)).bytes.toString("utf8");
  const references = markdownAssetReferences(source);
  const allowed = new Set<string>();
  for (const reference of references) {
    const assetPath = normalizeDeliveryAssetPath(reference);
    if (!assetPath || isSensitiveAssetPath(assetPath) || !PASSIVE_ASSET_EXTENSIONS.has(path.posix.extname(assetPath).toLowerCase())) continue;
    const candidateRelativePath = path.posix.normalize(path.posix.join(path.posix.dirname(target.relativePath), assetPath));
    if (candidateRelativePath === ".." || candidateRelativePath.startsWith("../")) continue;
    try {
      const resolved = await resolveRepoPath(repo, candidateRelativePath);
      const fileStat = await stat(resolved.realPath);
      if (fileStat.isFile()) allowed.add(resolved.relativePath);
    } catch {
      // Broken or excluded references stay unavailable instead of widening delivery.
    }
  }
  return allowed;
}

function markdownAssetReferences(source: string): Set<string> {
  const references = new Set<string>();
  const visit = (tokens: ReturnType<typeof deliveryMarkdown.parse>) => {
    for (const token of tokens) {
      const value = token.type === "image"
        ? token.attrGet("src")
        : token.type === "link_open"
          ? token.attrGet("href")
          : null;
      const normalized = normalizeMarkdownReference(value || "");
      if (normalized) references.add(normalized);
      if (token.children?.length) visit(token.children);
    }
  };
  visit(deliveryMarkdown.parse(source, {}));
  return references;
}

function normalizeMarkdownReference(input: string): string {
  const value = input.trim();
  if (!value || value.startsWith("#") || value.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(value)) return "";
  const withoutQuery = value.split(/[?#]/, 1)[0] || "";
  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    return "";
  }
}

function isSensitiveAssetPath(input: string): boolean {
  const segments = input.toLowerCase().split("/");
  if (segments.some((segment) => segment.startsWith("."))) return true;
  return segments.some((segment) => /(^|[._-])(credential|password|passwd|secret|token|private[-_]?key)s?([._-]|$)/.test(segment));
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

function sendMarkdownHtml(response: Response, repo: RepositoryConfig, relativePath: string, source: string, localAssetBaseUrl: string): void {
  const rendered = renderMarkdown(source, { repoId: repo.id, currentPath: relativePath, repoRoot: repo.root, localAssetBaseUrl });
  const html = buildMarkdownHtmlDocument(path.posix.basename(relativePath) || relativePath || "Markdown", rendered.html);
  response.setHeader("Content-Security-Policy", MARKDOWN_DELIVERY_CSP);
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
    ".markdown-code-block.wrapped pre, .markdown-code-block.wrapped pre code { min-width: 0; max-width: 100%; width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; word-break: normal; }",
    ".markdown-code-block.wrapped pre { overflow-x: hidden; }",
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

function isActiveDeliveryPath(relativePath: string): boolean {
  const extension = path.posix.extname(relativePath).toLowerCase();
  return extension === ".html" || extension === ".htm" || extension === ".svg";
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
