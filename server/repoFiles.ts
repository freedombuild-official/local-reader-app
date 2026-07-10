import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { opendir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  classifyRepoFileName,
  getFileExtension,
  getImageMimeTypeForPath,
  isDocxFileName,
  isPdfFileName,
  isUnsupportedViewerFileName,
} from "../shared/fileClassification.js";
import { extractMarkdownFromDocxBuffer } from "./docxMarkdown.js";
import { HttpError, isHttpError } from "./errors.js";
import { renderMarkdown } from "./markdown.js";
import { isExcludedPath, isExcludedRealPath, isInsideRoot, normalizeRelativePath, readGuardedRepoFile, resolveRepoPath } from "./pathGuard.js";
import { repositoryRevision } from "./repositoryRevision.js";
import { getImageViewerByteLimit, getTextViewerByteLimit, PDF_VIEWER_MAX_BYTES } from "./viewerLimits.js";
import type { DiffStatus, FileInformation, FileKind, FileResponse, GitStatus, GitStatusEntry, RepoSyncStatus, RepositoryConfig, TreeNode, TreeSnapshot } from "./types.js";

const execFileAsync = promisify(execFile);
const GIT_READ_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
const GIT_SYNC_ENV = { ...GIT_READ_ENV, GIT_TERMINAL_PROMPT: "0" };
const PDF_MIME_TYPE = "application/pdf";
const DOCX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const GIT_MAX_BUFFER = 10 * 1024 * 1024;
const GIT_SYNC_TIMEOUT_MS = 15_000;
const GIT_READ_TIMEOUT_MS = 10_000;
const TREE_DIRECTORY_MAX_ENTRIES = 5_000;
const TREE_SNAPSHOT_MAX_NODES = 20_000;
const TREE_SNAPSHOT_MAX_DEPTH = 32;
const TREE_SNAPSHOT_MAX_MS = 5_000;
const TREE_SNAPSHOT_MAX_SERIALIZED_BYTES = 5 * 1024 * 1024;

type ExistingTreeTarget = {
  relativePath: string;
  realPath: string | null;
  rootRealPath: string;
};

type TreeSnapshotBudget = {
  startedAt: number;
  nodes: number;
  serializedBytes: number;
  truncated: boolean;
  warnings: string[];
};

export async function readTree(repo: RepositoryConfig, inputPath: unknown): Promise<TreeNode[]> {
  const gitStatuses = await readGitStatuses(repo);
  const target = await resolveTreeTarget(repo, inputPath, gitStatuses);
  const nodesByPath = new Map<string, TreeNode>();

  if (target.realPath) {
    const boundedDirectory = await readDirectoryEntriesBounded(target.realPath);
    if (boundedDirectory.truncated) throw new HttpError(413, `Directory contains more than ${TREE_DIRECTORY_MAX_ENTRIES} entries.`);
    const entries = boundedDirectory.entries;
    for (const entry of entries) {
      const childRelativePath = joinRelativePath(target.relativePath, entry.name);
      if (isExcludedPath(repo, childRelativePath)) continue;

      const childAbsolutePath = path.join(target.realPath, entry.name);
      const childRealPath = await resolveChildRealPath(childAbsolutePath);
      if (!childRealPath) continue;
      if (!isInsideRoot(target.rootRealPath, childRealPath)) continue;
      if (isExcludedRealPath(repo, target.rootRealPath, childRealPath)) continue;

      const childStat = await stat(childRealPath);
      if (!childStat.isDirectory() && !childStat.isFile()) continue;

      const type = childStat.isDirectory() ? "directory" : "file";
      const gitStatus = getNodeGitStatus(gitStatuses, childRelativePath, type);
      nodesByPath.set(childRelativePath, {
        name: entry.name,
        path: childRelativePath,
        type,
        extension: childStat.isFile() ? getFileExtension(entry.name) : "",
        ...(gitStatus ? { gitStatus } : {}),
      });
    }
  }

  addGitOnlyTreeNodes(nodesByPath, gitStatuses, target.relativePath, repo);

  return sortTreeNodes(Array.from(nodesByPath.values()));
}

export async function readTreeSnapshot(repo: RepositoryConfig): Promise<{ tree: TreeSnapshot; truncated: boolean; warnings: string[] }> {
  const gitStatuses = await readGitStatuses(repo);
  const rootRealPath = await realpath(repo.root);
  const snapshot: TreeSnapshot = {};
  const budget: TreeSnapshotBudget = { startedAt: Date.now(), nodes: 0, serializedBytes: 0, truncated: false, warnings: [] };
  await collectTreeSnapshot(repo, "", rootRealPath, rootRealPath, gitStatuses, snapshot, new Set(), budget, 0);
  return { tree: snapshot, truncated: budget.truncated, warnings: Array.from(new Set(budget.warnings)) };
}

export async function syncRepository(repo: RepositoryConfig): Promise<RepoSyncStatus> {
  return {
    state: "disabled",
    message: repo.fetchRemote
      ? "Git remote fetch is disabled by the public execution policy."
      : "Git remote fetch disabled.",
    fetched: false,
  };
}

export async function readRepoFile(repo: RepositoryConfig, inputPath: unknown): Promise<FileResponse> {
  const revision = await repositoryRevision(repo);
  const relativePath = normalizeVisibleRelativePath(repo, inputPath);
  const gitStatuses = await readGitStatuses(repo);
  const gitStatus = gitStatuses.get(relativePath);

  let resolved: Awaited<ReturnType<typeof resolveRepoPath>>;
  try {
    resolved = await resolveRepoPath(repo, relativePath);
  } catch (error) {
    if (isHttpError(error) && error.status === 404 && gitStatus === "deleted") {
      return readDeletedRepoFile(repo, relativePath, revision);
    }
    throw error;
  }

  const fileStat = await stat(resolved.realPath);
  if (!fileStat.isFile()) throw new HttpError(400, "The file API requires a file path.");

  const extension = getFileExtension(resolved.relativePath);
  const imageMimeType = getImageMimeTypeForPath(resolved.relativePath);
  if (imageMimeType) {
    const imageByteLimit = getImageViewerByteLimit(resolved.relativePath);
    if (imageByteLimit === null || fileStat.size > imageByteLimit) {
      return createMetadataFileResponse(repo.id, resolved.relativePath, extension, "image", fileStat, gitStatus, "oversized", imageMimeType);
    }
    return {
      repoId: repo.id,
      path: resolved.relativePath,
      name: path.basename(resolved.relativePath),
      extension,
      kind: "image",
      assetVersion: fileAssetVersion(fileStat),
      content: "",
      lineCount: 0,
      fileInfo: createFileInformation(resolved.relativePath, "image", fileStat, "", gitStatus, "displayable", imageMimeType),
      gitDiff: gitDiffForBinaryMarker(resolved.relativePath, gitStatus),
      image: { mimeType: imageMimeType, byteLength: fileStat.size },
    };
  }

  if (isPdfFileName(resolved.relativePath)) {
    if (fileStat.size > PDF_VIEWER_MAX_BYTES) {
      return createMetadataFileResponse(repo.id, resolved.relativePath, extension, "pdf", fileStat, gitStatus, "oversized", PDF_MIME_TYPE);
    }
    return {
      repoId: repo.id,
      path: resolved.relativePath,
      name: path.basename(resolved.relativePath),
      extension,
      kind: "pdf",
      assetVersion: fileAssetVersion(fileStat),
      content: "",
      lineCount: 0,
      fileInfo: createFileInformation(resolved.relativePath, "pdf", fileStat, "", gitStatus, "displayable", PDF_MIME_TYPE),
      gitDiff: gitDiffForBinaryMarker(resolved.relativePath, gitStatus),
      pdf: { mimeType: PDF_MIME_TYPE, byteLength: fileStat.size },
    };
  }

  if (isDocxFileName(resolved.relativePath)) {
    try {
      const content = await extractMarkdownFromDocxBuffer((await readGuardedRepoFile(repo, resolved.relativePath, fileStat.size)).bytes);
      const lineCount = countLines(content);
      return {
        repoId: repo.id,
        path: resolved.relativePath,
        name: path.basename(resolved.relativePath),
        extension,
        kind: "markdown",
        content,
        lineCount,
        fileInfo: createFileInformation(resolved.relativePath, "markdown", fileStat, content, gitStatus, "displayable", DOCX_MIME_TYPE),
        gitDiff: await gitDiffForText(repo, resolved.relativePath, gitStatus, lineCount),
        docx: { byteLength: fileStat.size, source: "markdown-in-docx" },
        markdown: renderMarkdown(content, { repoId: repo.id, currentPath: resolved.relativePath, repoRoot: repo.root, revision }),
      };
    } catch (error) {
      const viewerStatus = isHttpError(error) && error.status === 413 ? "oversized" : "unsupported";
      return createMetadataFileResponse(repo.id, resolved.relativePath, extension, "unsupported", fileStat, gitStatus, viewerStatus, DOCX_MIME_TYPE);
    }
  }

  if (isUnsupportedViewerFileName(resolved.relativePath)) {
    return createMetadataFileResponse(repo.id, resolved.relativePath, extension, "unsupported", fileStat, gitStatus, "unsupported");
  }
  const kind = classifyRepoFileName(resolved.relativePath) as FileKind;
  if (fileStat.size > getTextViewerByteLimit(resolved.relativePath)) {
    return createMetadataFileResponse(repo.id, resolved.relativePath, extension, kind, fileStat, gitStatus, "oversized", getTextMimeType(resolved.relativePath, kind));
  }

  const { bytes: buffer } = await readGuardedRepoFile(repo, resolved.relativePath, getTextViewerByteLimit(resolved.relativePath));
  if (looksBinary(buffer)) {
    return createBinaryFileResponse(repo.id, resolved.relativePath, extension, fileStat, gitStatus);
  }

  const content = buffer.toString("utf8");
  const lineCount = countLines(content);
  const response: FileResponse = {
    repoId: repo.id,
    path: resolved.relativePath,
    name: path.basename(resolved.relativePath),
    extension,
    kind,
    content,
    lineCount,
    fileInfo: createFileInformation(resolved.relativePath, kind, fileStat, content, gitStatus, "displayable", getTextMimeType(resolved.relativePath, kind)),
  };
  const gitDiff = await gitDiffForText(repo, resolved.relativePath, gitStatus, lineCount);
  if (gitDiff) response.gitDiff = gitDiff;
  if (kind === "markdown") response.markdown = renderMarkdown(content, { repoId: repo.id, currentPath: resolved.relativePath, repoRoot: repo.root, revision });
  return response;
}

export async function resolveRepoImage(repo: RepositoryConfig, inputPath: unknown): Promise<{ bytes: Buffer; relativePath: string; mimeType: string; byteLength: number }> {
  const resolved = await resolveRepoPath(repo, inputPath);
  const imageMimeType = getImageMimeTypeForPath(resolved.relativePath);
  if (!imageMimeType) throw new HttpError(415, "The requested file is not an image.");
  const imageByteLimit = getImageViewerByteLimit(resolved.relativePath);
  if (imageByteLimit === null) throw new HttpError(413, "The image file is too large to display.");
  const guarded = await readGuardedRepoFile(repo, resolved.relativePath, imageByteLimit);
  return { bytes: guarded.bytes, relativePath: resolved.relativePath, mimeType: imageMimeType, byteLength: guarded.bytes.byteLength };
}

export async function resolveRepoPdf(repo: RepositoryConfig, inputPath: unknown): Promise<{ bytes: Buffer; relativePath: string; mimeType: string; byteLength: number }> {
  const resolved = await resolveRepoPath(repo, inputPath);
  if (!isPdfFileName(resolved.relativePath)) throw new HttpError(415, "The requested file is not a PDF.");
  const guarded = await readGuardedRepoFile(repo, resolved.relativePath, PDF_VIEWER_MAX_BYTES);
  return { bytes: guarded.bytes, relativePath: resolved.relativePath, mimeType: PDF_MIME_TYPE, byteLength: guarded.bytes.byteLength };
}

export async function readGitStatusEntries(repo: RepositoryConfig): Promise<GitStatusEntry[]> {
  const statuses = await readGitStatuses(repo);
  return Array.from(statuses.entries())
    .sort(([leftPath], [rightPath]) => leftPath.localeCompare(rightPath))
    .map(([pathValue, status]) => ({ path: pathValue, status }));
}

async function collectTreeSnapshot(
  repo: RepositoryConfig,
  parentPath: string,
  parentRealPath: string | null,
  rootRealPath: string,
  gitStatuses: Map<string, GitStatus>,
  snapshot: TreeSnapshot,
  visitedRealPaths: Set<string>,
  budget: TreeSnapshotBudget,
  depth: number,
): Promise<void> {
  if (budget.truncated) return;
  if (depth > TREE_SNAPSHOT_MAX_DEPTH) {
    truncateTreeSnapshot(budget, `Tree snapshot stopped at depth ${TREE_SNAPSHOT_MAX_DEPTH}.`);
    return;
  }
  if (Date.now() - budget.startedAt > TREE_SNAPSHOT_MAX_MS) {
    truncateTreeSnapshot(budget, `Tree snapshot exceeded ${TREE_SNAPSHOT_MAX_MS} ms.`);
    return;
  }
  const nodesByPath = new Map<string, TreeNode>();
  if (parentRealPath) {
    if (visitedRealPaths.has(parentRealPath)) {
      snapshot[parentPath] = [];
      return;
    }
    visitedRealPaths.add(parentRealPath);
    const boundedDirectory = await readDirectoryEntriesBounded(parentRealPath);
    if (boundedDirectory.truncated) {
      truncateTreeSnapshot(budget, `Directory ${parentPath || "."} exceeds ${TREE_DIRECTORY_MAX_ENTRIES} entries.`);
      return;
    }
    const entries = boundedDirectory.entries;
    for (const entry of entries) {
      const childRelativePath = joinRelativePath(parentPath, entry.name);
      if (isExcludedPath(repo, childRelativePath)) continue;

      const childAbsolutePath = path.join(parentRealPath, entry.name);
      const childRealPath = await resolveChildRealPath(childAbsolutePath);
      if (!childRealPath) continue;
      if (!isInsideRoot(rootRealPath, childRealPath)) continue;
      if (isExcludedRealPath(repo, rootRealPath, childRealPath)) continue;

      const childStat = await stat(childRealPath);
      if (!childStat.isDirectory() && !childStat.isFile()) continue;

      const type = childStat.isDirectory() ? "directory" : "file";
      const gitStatus = getNodeGitStatus(gitStatuses, childRelativePath, type);
      nodesByPath.set(childRelativePath, {
        name: entry.name,
        path: childRelativePath,
        type,
        extension: childStat.isFile() ? getFileExtension(entry.name) : "",
        ...(gitStatus ? { gitStatus } : {}),
      });
    }
  }

  addGitOnlyTreeNodes(nodesByPath, gitStatuses, parentPath, repo);
  const nodes = sortTreeNodes(Array.from(nodesByPath.values()));
  budget.nodes += nodes.length;
  budget.serializedBytes += nodes.reduce((total, node) => total + Buffer.byteLength(node.path, "utf8") + Buffer.byteLength(node.name, "utf8") + 96, 0);
  if (budget.nodes > TREE_SNAPSHOT_MAX_NODES || budget.serializedBytes > TREE_SNAPSHOT_MAX_SERIALIZED_BYTES || Date.now() - budget.startedAt > TREE_SNAPSHOT_MAX_MS) {
    truncateTreeSnapshot(budget, "Tree snapshot reached its node, byte, or time limit.");
  }
  snapshot[parentPath] = nodes;

  for (const node of nodes) {
    if (node.type !== "directory") continue;
    const childRealPath = await readTreeRealPath(repo, node.path, rootRealPath).catch((error) => {
      if (isHttpError(error) && (error.status === 404 || error.status === 400)) return null;
      throw error;
    });
    if (!childRealPath && !hasGitChildStatus(gitStatuses, node.path)) continue;
    await collectTreeSnapshot(repo, node.path, childRealPath, rootRealPath, gitStatuses, snapshot, visitedRealPaths, budget, depth + 1);
  }
}

export async function readDirectoryEntriesBounded(directoryPath: string, maxEntries = TREE_DIRECTORY_MAX_ENTRIES): Promise<{ entries: Dirent[]; truncated: boolean }> {
  const directory = await opendir(directoryPath);
  const entries: Dirent[] = [];
  let truncated = false;
  try {
    while (true) {
      const entry = await directory.read();
      if (!entry) break;
      if (entries.length >= maxEntries) {
        truncated = true;
        break;
      }
      entries.push(entry);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return { entries, truncated };
}

function truncateTreeSnapshot(budget: TreeSnapshotBudget, warning: string): void {
  budget.truncated = true;
  budget.warnings.push(warning);
}

async function readTreeRealPath(repo: RepositoryConfig, relativePath: string, rootRealPath: string): Promise<string | null> {
  const rootAbsolutePath = path.resolve(repo.root);
  const absolutePath = path.resolve(repo.root, relativePath || ".");
  if (!isInsideRoot(rootAbsolutePath, absolutePath)) throw new HttpError(403, "Paths outside the repository root are not visible.");
  const targetRealPath = await realpath(absolutePath).catch(() => null);
  if (!targetRealPath) return null;
  if (!isInsideRoot(rootRealPath, targetRealPath)) throw new HttpError(403, "Paths outside the repository root are not visible.");
  if (isExcludedRealPath(repo, rootRealPath, targetRealPath)) throw new HttpError(403, "This path is excluded.");
  const currentStat = await stat(targetRealPath);
  if (!currentStat.isDirectory()) throw new HttpError(400, "The tree API requires a directory path.");
  return targetRealPath;
}

function sortTreeNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.sort((left, right) => {
    if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
}

async function resolveTreeTarget(repo: RepositoryConfig, inputPath: unknown, gitStatuses: Map<string, GitStatus>): Promise<ExistingTreeTarget> {
  const relativePath = normalizeVisibleRelativePath(repo, inputPath);
  const rootRealPath = await realpath(repo.root);
  const realPath = await readTreeRealPath(repo, relativePath, rootRealPath);
  if (realPath) return { relativePath, realPath, rootRealPath };
  if (hasGitChildStatus(gitStatuses, relativePath)) return { relativePath, realPath: null, rootRealPath };
  throw new HttpError(404, "The requested path was not found.");
}

function normalizeVisibleRelativePath(repo: RepositoryConfig, inputPath: unknown): string {
  const relativePath = normalizeRelativePath(inputPath);
  if (isExcludedPath(repo, relativePath)) throw new HttpError(403, "This path is excluded.");
  return relativePath;
}

function addGitOnlyTreeNodes(nodesByPath: Map<string, TreeNode>, statuses: Map<string, GitStatus>, parentPath: string, repo: RepositoryConfig): void {
  const prefix = parentPath ? `${parentPath}/` : "";
  for (const [statusPath] of statuses) {
    if (parentPath && !statusPath.startsWith(prefix)) continue;
    const remainder = parentPath ? statusPath.slice(prefix.length) : statusPath;
    if (!remainder || remainder.startsWith("/")) continue;
    const [name, ...rest] = remainder.split("/");
    const childPath = joinRelativePath(parentPath, name);
    if (nodesByPath.has(childPath) || isExcludedPath(repo, childPath)) continue;
    const type = rest.length ? "directory" : "file";
    const gitStatus = getNodeGitStatus(statuses, childPath, type);
    nodesByPath.set(childPath, {
      name,
      path: childPath,
      type,
      extension: type === "file" ? getFileExtension(name) : "",
      ...(gitStatus ? { gitStatus } : {}),
    });
  }
}

function hasGitChildStatus(statuses: Map<string, GitStatus>, parentPath: string): boolean {
  const prefix = parentPath ? `${parentPath}/` : "";
  for (const statusPath of statuses.keys()) {
    if (!parentPath && statusPath) return true;
    if (parentPath && statusPath.startsWith(prefix) && statusPath.length > prefix.length) return true;
  }
  return false;
}

async function readDeletedRepoFile(repo: RepositoryConfig, relativePath: string, revision: string): Promise<FileResponse> {
  const extension = getFileExtension(relativePath);
  const buffer = await readGitBlob(repo, relativePath);
  const isBinary = isBinaryMarkerPath(relativePath) || looksBinary(buffer);
  const content = isBinary ? "" : buffer.toString("utf8");
  const kind = isBinary ? "binary" : (classifyRepoFileName(relativePath) as FileKind);
  const lineCount = isBinary ? 0 : countLines(content);
  const fileInfo: FileInformation = {
    name: path.basename(relativePath),
    path: relativePath,
    type: isBinary ? "Binary" : fileKindLabel(kind),
    byteLength: buffer.byteLength,
    characterCount: isBinary ? 0 : characterCount(content),
    lineCount,
    createdAt: null,
    gitStatus: "deleted",
    viewerStatus: isBinary ? "binary" : "deleted",
  };
  const response: FileResponse = {
    repoId: repo.id,
    path: relativePath,
    name: path.basename(relativePath),
    extension,
    kind,
    content,
    lineCount,
    fileInfo,
    gitDiff: { status: isBinary ? "binary" : "deleted", changedLines: isBinary ? [] : lineNumbers(lineCount) },
  };
  if (kind === "markdown") response.markdown = renderMarkdown(content, { repoId: repo.id, currentPath: relativePath, repoRoot: repo.root, revision });
  return response;
}

function createBinaryFileResponse(
  repoId: string,
  relativePath: string,
  extension: string,
  fileStat: { size: number; birthtime: Date; mtimeMs: number },
  gitStatus?: GitStatus,
): FileResponse {
  return {
    repoId,
    path: relativePath,
    name: path.basename(relativePath),
    extension,
    kind: "binary",
    content: "",
    lineCount: 0,
    fileInfo: createFileInformation(relativePath, "binary", fileStat, "", gitStatus, "binary"),
    gitDiff: gitDiffForBinaryMarker(relativePath, gitStatus),
  };
}

function createMetadataFileResponse(
  repoId: string,
  relativePath: string,
  extension: string,
  kind: FileKind,
  fileStat: { size: number; birthtime: Date; mtimeMs: number },
  gitStatus: GitStatus | undefined,
  viewerStatus: FileInformation["viewerStatus"],
  mimeType?: string,
): FileResponse {
  return {
    repoId,
    path: relativePath,
    name: path.basename(relativePath),
    extension,
    kind,
    content: "",
    lineCount: 0,
    fileInfo: createFileInformation(relativePath, kind, fileStat, "", gitStatus, viewerStatus, mimeType),
    gitDiff: gitDiffForBinaryMarker(relativePath, gitStatus),
  };
}

function createFileInformation(
  relativePath: string,
  kind: FileKind,
  fileStat: { size: number; birthtime: Date },
  content: string,
  gitStatus: GitStatus | undefined,
  viewerStatus: FileInformation["viewerStatus"],
  mimeType?: string,
): FileInformation {
  const isText = kind === "markdown" || kind === "code" || kind === "text" || kind === "html";
  return {
    name: path.basename(relativePath),
    path: relativePath,
    type: fileKindLabel(kind),
    byteLength: fileStat.size,
    characterCount: isText ? characterCount(content) : 0,
    lineCount: isText ? countLines(content) : 0,
    createdAt: Number.isNaN(fileStat.birthtime.getTime()) ? null : fileStat.birthtime.toISOString(),
    ...(gitStatus ? { gitStatus } : {}),
    ...(mimeType ? { mimeType } : {}),
    viewerStatus,
  };
}

function fileKindLabel(kind: FileKind): string {
  switch (kind) {
    case "markdown":
      return "Markdown";
    case "code":
      return "Code";
    case "text":
      return "Text";
    case "html":
      return "HTML";
    case "image":
      return "Image";
    case "pdf":
      return "PDF";
    case "binary":
      return "Binary";
    case "unsupported":
      return "Unsupported";
  }
}

function getTextMimeType(relativePath: string, kind: FileKind): string | undefined {
  if (kind === "markdown") return "text/markdown; charset=utf-8";
  if (kind === "html") return "text/html; charset=utf-8";
  if (kind === "code" || kind === "text") return `text/plain; charset=utf-8`;
  return undefined;
}

async function gitDiffForText(
  repo: RepositoryConfig,
  relativePath: string,
  gitStatus: GitStatus | undefined,
  lineCount: number,
): Promise<FileResponse["gitDiff"] | undefined> {
  if (!gitStatus) return undefined;
  if (gitStatus === "new" || gitStatus === "deleted") return { status: gitStatus, changedLines: lineNumbers(lineCount) };
  return { status: "changed", changedLines: await readGitChangedLines(repo, relativePath) };
}

function gitDiffForBinaryMarker(relativePath: string, gitStatus?: GitStatus): FileResponse["gitDiff"] | undefined {
  if (!gitStatus) return undefined;
  return { status: markerStatusForFile(relativePath, gitStatus), changedLines: [] };
}

async function readGitStatuses(repo: RepositoryConfig): Promise<Map<string, GitStatus>> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", repo.root, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=all"], {
      env: GIT_READ_ENV,
      maxBuffer: GIT_MAX_BUFFER,
      timeout: GIT_READ_TIMEOUT_MS,
    });
    return parseGitStatus(String(stdout), repo);
  } catch {
    return new Map();
  }
}

async function isGitWorkTree(root: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
      env: GIT_READ_ENV,
      maxBuffer: 1024,
      timeout: 5_000,
    });
    return String(stdout).trim() === "true";
  } catch {
    return false;
  }
}

async function readGitRemoteNames(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", root, "remote"], {
      env: GIT_READ_ENV,
      maxBuffer: 1024 * 1024,
      timeout: 5_000,
    });
    return String(stdout)
      .split(/\r\n|\r|\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function gitFetchWarningMessage(error: unknown): string {
  if (isTimeoutError(error)) return "Git fetch timed out. Showing the current local state.";
  return "Git fetch failed. Showing the current local state.";
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { killed?: unknown; signal?: unknown; code?: unknown };
  return record.killed === true || record.signal === "SIGTERM" || record.code === "ETIMEDOUT";
}

function parseGitStatus(output: string, repo: RepositoryConfig): Map<string, GitStatus> {
  const statuses = new Map<string, GitStatus>();
  const parts = output.split("\0").filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.length < 4) continue;
    const rawStatus = part.slice(0, 2);
    const relativePath = normalizeGitRelativePath(part.slice(3));
    const gitStatus = classifyGitStatus(rawStatus);
    if (!gitStatus || !relativePath || isExcludedPath(repo, relativePath)) {
      if (rawStatus.includes("R") || rawStatus.includes("C")) index += 1;
      continue;
    }
    statuses.set(relativePath, gitStatus);
    if (rawStatus.includes("R") || rawStatus.includes("C")) index += 1;
  }
  return statuses;
}

function classifyGitStatus(rawStatus: string): GitStatus | null {
  if (rawStatus.includes("D")) return "deleted";
  if (rawStatus === "??" || rawStatus[0] === "A" || rawStatus[1] === "A") return "new";
  if (/[MRCUT]/.test(rawStatus)) return "changed";
  return null;
}

function normalizeGitRelativePath(relativePath: string): string {
  return relativePath.replaceAll("\\", "/").replace(/^\.\//, "");
}

async function resolveChildRealPath(childAbsolutePath: string): Promise<string | null> {
  try {
    return await realpath(childAbsolutePath);
  } catch {
    return null;
  }
}

function getNodeGitStatus(statuses: Map<string, GitStatus>, relativePath: string, type: "directory" | "file"): DiffStatus | undefined {
  if (type === "file") {
    const status = statuses.get(relativePath);
    return status ? markerStatusForFile(relativePath, status) : undefined;
  }
  let nextStatus: DiffStatus | undefined;
  const prefix = `${relativePath}/`;
  for (const [statusPath, status] of statuses.entries()) {
    if (statusPath !== relativePath && !statusPath.startsWith(prefix)) continue;
    nextStatus = pickHigherPriorityStatus(nextStatus, markerStatusForFile(statusPath, status));
  }
  return nextStatus;
}

function markerStatusForFile(relativePath: string, gitStatus: GitStatus): DiffStatus {
  if (gitStatus !== "deleted" && isBinaryMarkerPath(relativePath)) return "binary";
  return gitStatus;
}

function pickHigherPriorityStatus(current: DiffStatus | undefined, next: DiffStatus): DiffStatus {
  if (!current) return next;
  const priority: Record<DiffStatus, number> = { new: 1, binary: 2, deleted: 3, changed: 4 };
  return priority[next] > priority[current] ? next : current;
}

function isBinaryMarkerPath(relativePath: string): boolean {
  return Boolean(getImageMimeTypeForPath(relativePath) || isPdfFileName(relativePath) || isUnsupportedViewerFileName(relativePath));
}

async function readGitChangedLines(repo: RepositoryConfig, relativePath: string): Promise<number[]> {
  const changedLines = new Set<number>();
  for (const args of [
    ["-c", "core.fsmonitor=false", "-C", repo.root, "diff", "--no-ext-diff", "--no-textconv", "--unified=0", "--", relativePath],
    ["-c", "core.fsmonitor=false", "-C", repo.root, "diff", "--cached", "--no-ext-diff", "--no-textconv", "--unified=0", "--", relativePath],
  ]) {
    try {
      const { stdout } = await execFileAsync("git", args, { env: GIT_READ_ENV, maxBuffer: GIT_MAX_BUFFER, timeout: GIT_READ_TIMEOUT_MS });
      parseChangedLines(String(stdout)).forEach((line) => changedLines.add(line));
    } catch {
      // Keep the rest of the file readable even if git cannot produce a diff.
    }
  }
  return Array.from(changedLines).sort((left, right) => left - right);
}

function parseChangedLines(diff: string): number[] {
  const changedLines = new Set<number>();
  for (const line of diff.split(/\r\n|\r|\n/)) {
    const match = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] ? Number(match[2]) : 1;
    if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0) continue;
    for (let lineNumber = start; lineNumber < start + count; lineNumber += 1) {
      changedLines.add(lineNumber);
    }
  }
  return Array.from(changedLines);
}

async function readGitBlob(repo: RepositoryConfig, relativePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", repo.root, "show", `HEAD:${relativePath}`],
      { env: GIT_READ_ENV, maxBuffer: GIT_MAX_BUFFER, encoding: "buffer", timeout: GIT_READ_TIMEOUT_MS },
      (error, stdout) => {
        if (error) {
          reject(new HttpError(404, "The deleted file is not available in HEAD."));
          return;
        }
        resolve(Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout));
      },
    );
  });
}

function joinRelativePath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

function fileAssetVersion(fileStat: { mtimeMs: number; size: number }): string {
  return `${Math.trunc(fileStat.mtimeMs)}-${fileStat.size}`;
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

function countLines(content: string): number {
  if (!content) return 1;
  return content.split(/\r\n|\r|\n/).length;
}

function lineNumbers(lineCount: number): number[] {
  return Array.from({ length: lineCount }, (_value, index) => index + 1);
}

function characterCount(content: string): number {
  return Array.from(content).length;
}
