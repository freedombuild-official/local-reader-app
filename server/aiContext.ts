import { stat } from "node:fs/promises";
import path from "node:path";
import { HttpError, isHttpError } from "./errors.js";
import { loadAIChatSystemPrompt } from "./aiPromptPolicy.js";
import { normalizeRelativePath, resolveRepoPath } from "./pathGuard.js";
import type { RepositoryRegistry } from "./repositoryRegistry.js";
import { assertRepositoryRevision } from "./repositoryRevision.js";
import { readRepoFile, readTree } from "./repoFiles.js";
import type { AIChatContext, AIChatContextItem, AIChatContextPathRequest, AIChatContextRequest, AIChatContextRole, AIChatContextSource, RepositoryConfig, TreeNode } from "./types.js";

const TEXT_CONTEXT_KINDS = new Set(["markdown", "code", "text", "html"]);
const MAX_CONTEXT_CHARS = 16000;
const MAX_PRIMARY_CONTEXT_ITEMS = 12;
const MAX_RULE_CONTEXT_ITEMS = 2;
const MAX_CONTEXT_TOTAL_BYTES = 64 * 1024;
const ROOT_RULE_PATHS = new Set(["AGENTS.md", "CLAUDE.md"]);

export async function buildAIChatContext(registry: RepositoryRegistry, request: AIChatContextRequest): Promise<AIChatContext> {
  const repo = await registry.findRepository(String(request.repoId || ""));
  return buildAIChatContextForRepository(repo, request);
}

export async function buildAIChatContextForRepository(repo: RepositoryConfig, request: AIChatContextRequest): Promise<AIChatContext> {
  const revision = await assertRepositoryRevision(repo, request.expectedRevision);
  const normalized = normalizeContextRequest(request);
  if (normalized.primaryPaths.length > MAX_PRIMARY_CONTEXT_ITEMS || normalized.rulePaths.length > MAX_RULE_CONTEXT_ITEMS) {
    throw new HttpError(413, `AI Chat context supports up to ${MAX_PRIMARY_CONTEXT_ITEMS} primary items and ${MAX_RULE_CONTEXT_ITEMS} rule items.`);
  }
  const primaryItems = await materializeContextItems(repo, normalized.primaryPaths, "primary");
  const ruleItems = await materializeContextItems(repo, normalized.rulePaths, "rule");
  const totalBytes = [...primaryItems, ...ruleItems].reduce((sum, item) => sum + Buffer.byteLength(item.content || "", "utf8"), 0);
  if (totalBytes > MAX_CONTEXT_TOTAL_BYTES) {
    throw new HttpError(413, `AI Chat context exceeds the ${MAX_CONTEXT_TOTAL_BYTES}-byte aggregate limit.`);
  }
  return {
    repoId: repo.id,
    revision,
    systemPromptVersion: loadAIChatSystemPrompt().version,
    primaryItems,
    ruleItems,
  };
}

function normalizeContextRequest(request: AIChatContextRequest): { primaryPaths: AIChatContextPathRequest[]; rulePaths: AIChatContextPathRequest[] } {
  const primaryPaths = Array.isArray(request.primaryPaths) ? request.primaryPaths : [];
  const rulePaths = Array.isArray(request.rulePaths) ? request.rulePaths : [];
  if (typeof request.path === "string" && request.path.trim()) {
    return {
      primaryPaths: [{ path: request.path, includeContent: request.includeContent, source: "legacy" }],
      rulePaths,
    };
  }
  return { primaryPaths, rulePaths };
}

async function materializeContextItems(repo: RepositoryConfig, requests: AIChatContextPathRequest[], role: AIChatContextRole): Promise<AIChatContextItem[]> {
  const items: AIChatContextItem[] = [];
  const seen = new Set<string>();
  for (const request of requests) {
    const source = normalizeSource(request.source, role);
    const relativePath = normalizeRelativePath(request.path);
    if (!relativePath) continue;
    if (seen.has(relativePath)) continue;
    seen.add(relativePath);
    const item = role === "rule"
      ? await materializeRuleItem(repo, relativePath, source, request)
      : await materializePrimaryItem(repo, relativePath, source, request);
    if (item) items.push(item);
  }
  return items;
}

async function materializeRuleItem(repo: RepositoryConfig, relativePath: string, source: AIChatContextSource, request: AIChatContextPathRequest): Promise<AIChatContextItem | null> {
  if (!ROOT_RULE_PATHS.has(relativePath) || relativePath.includes("/")) {
    throw new HttpError(400, "Rule context only supports repository root AGENTS.md or CLAUDE.md.");
  }
  try {
    return await materializeFileItem(repo, relativePath, "rule", source, request.includeContent !== false);
  } catch (error) {
    if (isHttpError(error) && error.status === 404) return null;
    throw error;
  }
}

async function materializePrimaryItem(repo: RepositoryConfig, relativePath: string, source: AIChatContextSource, request: AIChatContextPathRequest): Promise<AIChatContextItem> {
  const resolved = await resolveRepoPath(repo, relativePath);
  const targetStat = await stat(resolved.realPath);
  if (targetStat.isDirectory()) return materializeDirectoryItem(repo, resolved.relativePath, source);
  if (targetStat.isFile()) return materializeFileItem(repo, resolved.relativePath, "primary", source, request.includeContent !== false);
  throw new HttpError(400, "AI Chat context supports only files and directories.");
}

async function materializeFileItem(repo: RepositoryConfig, relativePath: string, role: AIChatContextRole, source: AIChatContextSource, includeContent: boolean): Promise<AIChatContextItem> {
  const file = await readRepoFile(repo, relativePath);
  const canIncludeContent =
    includeContent &&
    TEXT_CONTEXT_KINDS.has(file.kind) &&
    file.fileInfo.viewerStatus === "displayable" &&
    file.content.length > 0;
  const content = canIncludeContent ? truncateContext(file.content) : "";
  return {
    repoId: file.repoId,
    role,
    source,
    path: file.path,
    name: file.name,
    kind: "file",
    fileKind: file.kind,
    viewerStatus: file.fileInfo.viewerStatus,
    lineCount: file.lineCount,
    byteLength: file.fileInfo.byteLength,
    contentIncluded: Boolean(content),
    content,
  };
}

async function materializeDirectoryItem(repo: RepositoryConfig, relativePath: string, source: AIChatContextSource): Promise<AIChatContextItem> {
  const nodes = await readTree(repo, relativePath);
  const content = formatDirectChildren(nodes);
  return {
    repoId: repo.id,
    role: "primary",
    source,
    path: relativePath,
    name: path.posix.basename(relativePath) || repo.id,
    kind: "directory",
    viewerStatus: "directory",
    lineCount: content ? content.split(/\r?\n/).length : 0,
    byteLength: Buffer.byteLength(content, "utf8"),
    contentIncluded: true,
    content,
  };
}

function formatDirectChildren(nodes: TreeNode[]): string {
  if (!nodes.length) return "[Directory has no visible direct children.]";
  return nodes.map((node) => `- [${node.type}] ${node.path}`).join("\n");
}

function normalizeSource(source: AIChatContextPathRequest["source"], role: AIChatContextRole): AIChatContextSource {
  if (source === "tree-menu" || source === "manual" || source === "auto-root-rule" || source === "legacy") return source;
  return role === "rule" ? "auto-root-rule" : "manual";
}

function truncateContext(content: string): string {
  if (content.length <= MAX_CONTEXT_CHARS) return content;
  return `${content.slice(0, MAX_CONTEXT_CHARS)}\n\n[Reader-Wiki omitted the rest of this large file.]`;
}
