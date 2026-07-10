import { constants, type Stats } from "node:fs";
import { lstat, open, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.js";
import type { RepositoryConfig } from "./types.js";

export type ResolvedRepoPath = {
  relativePath: string;
  absolutePath: string;
  realPath: string;
  rootRealPath: string;
};

export type GuardedRepoFile = {
  resolved: ResolvedRepoPath;
  stat: Stats;
  bytes: Buffer;
};

const DEFAULT_EXCLUDES = [".git"];

export function normalizeRelativePath(input: unknown): string {
  const value = typeof input === "string" ? input.trim().replaceAll("\\", "/") : "";
  if (!value || value === ".") return "";
  if (value.includes("\0") || path.posix.isAbsolute(value)) {
    throw new HttpError(400, "Only repository-relative paths are allowed.");
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === "") return "";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new HttpError(400, "Paths outside the repository root are not allowed.");
  }
  return normalized.replace(/^\.\//, "");
}

export async function resolveRepoPath(repo: RepositoryConfig, inputPath: unknown): Promise<ResolvedRepoPath> {
  const relativePath = normalizeRelativePath(inputPath);
  if (isExcludedPath(repo, relativePath)) {
    throw new HttpError(403, "This path is excluded.");
  }

  const rootRealPath = await realpath(repo.root);
  const absolutePath = path.resolve(repo.root, relativePath || ".");
  const realPath = await realpath(absolutePath).catch(() => {
    throw new HttpError(404, "The requested path was not found.");
  });

  if (!isInsideRoot(rootRealPath, realPath)) {
    throw new HttpError(403, "Paths outside the repository root are not visible.");
  }
  if (isExcludedRealPath(repo, rootRealPath, realPath)) {
    throw new HttpError(403, "This path is excluded.");
  }

  return { relativePath, absolutePath, realPath, rootRealPath };
}

export async function readGuardedRepoFile(repo: RepositoryConfig, inputPath: unknown, maxBytes = Number.MAX_SAFE_INTEGER): Promise<GuardedRepoFile> {
  const resolved = await resolveRepoPath(repo, inputPath);
  await assertNoSymlinkComponents(resolved.rootRealPath, resolved.relativePath);
  const flags = constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
  const handle = await open(resolved.realPath, flags);
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) throw new HttpError(400, "The requested path must be a regular file.");
    if (openedStat.size > maxBytes) throw new HttpError(413, "The requested file exceeds the Reader-Wiki byte limit.");
    await assertOpenedFileBoundary(repo, resolved, handle.fd, openedStat);
    const bytes = await handle.readFile();
    const finalStat = await handle.stat();
    if (finalStat.size > maxBytes || bytes.byteLength > maxBytes) {
      throw new HttpError(413, "The requested file exceeds the Reader-Wiki byte limit.");
    }
    if (finalStat.dev !== openedStat.dev || finalStat.ino !== openedStat.ino || finalStat.size !== bytes.byteLength) {
      throw new HttpError(409, "The file changed while Reader-Wiki was reading it. Retry the request.");
    }
    await assertOpenedFileBoundary(repo, resolved, handle.fd, finalStat);
    return { resolved, stat: finalStat, bytes };
  } finally {
    await handle.close();
  }
}

async function assertNoSymlinkComponents(rootRealPath: string, relativePath: string): Promise<void> {
  let current = rootRealPath;
  for (const segment of relativePath.split("/").filter(Boolean)) {
    current = path.join(current, segment);
    const component = await lstat(current).catch(() => {
      throw new HttpError(404, "The requested path was not found.");
    });
    if (component.isSymbolicLink()) throw new HttpError(403, "Symbolic links are disabled by the Reader-Wiki safe file policy.");
  }
}

export async function assertOpenedFileBoundary(
  repo: RepositoryConfig,
  resolved: ResolvedRepoPath,
  fd: number,
  openedStat: Stats,
  descriptors = process.platform === "linux" ? [`/proc/self/fd/${fd}`, `/dev/fd/${fd}`] : [`/dev/fd/${fd}`],
): Promise<void> {
  for (const descriptor of descriptors) {
    try {
      const linked = await readlink(descriptor);
      const openedPath = await realpath(path.isAbsolute(linked) ? linked : path.resolve(path.dirname(descriptor), linked));
      if (!isInsideRoot(resolved.rootRealPath, openedPath) || isExcludedRealPath(repo, resolved.rootRealPath, openedPath)) {
        throw new HttpError(403, "The opened file escaped the repository boundary.");
      }
      return;
    } catch (error) {
      if (error instanceof HttpError) throw error;
    }
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const currentRealPath = await realpath(resolved.realPath).catch(() => {
      throw new HttpError(409, "The file path changed while Reader-Wiki was opening it. Retry the request.");
    });
    if (!isInsideRoot(resolved.rootRealPath, currentRealPath) || isExcludedRealPath(repo, resolved.rootRealPath, currentRealPath)) {
      throw new HttpError(403, "The opened file escaped the repository boundary.");
    }
    const pathStat = await stat(currentRealPath);
    if (pathStat.dev !== openedStat.dev || pathStat.ino !== openedStat.ino) {
      throw new HttpError(409, "The file path changed while Reader-Wiki was opening it. Retry the request.");
    }
  }
}

export function isInsideRoot(rootRealPath: string, candidateRealPath: string): boolean {
  const relative = path.relative(rootRealPath, candidateRealPath);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

export function isExcludedPath(repo: Pick<RepositoryConfig, "excludes">, relativePath: string): boolean {
  if (!relativePath) return false;
  const patterns = [...DEFAULT_EXCLUDES, ...(repo.excludes || [])];
  return patterns.some((pattern) => matchesPattern(pattern, relativePath));
}

export function isExcludedRealPath(repo: Pick<RepositoryConfig, "excludes">, rootRealPath: string, candidateRealPath: string): boolean {
  return isExcludedPath(repo, relativePathFromRoot(rootRealPath, candidateRealPath));
}

export function relativePathFromRoot(rootRealPath: string, candidateRealPath: string): string {
  const relative = path.relative(rootRealPath, candidateRealPath);
  if (!relative) return "";
  return relative.split(path.sep).join("/");
}

function matchesPattern(pattern: string, relativePath: string): boolean {
  const cleanPattern = pattern.trim().replace(/\/+$/, "");
  if (!cleanPattern) return false;
  const normalized = relativePath.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized);
  const segments = normalized.split("/");

  if (cleanPattern.startsWith("*.") && basename.endsWith(cleanPattern.slice(1))) return true;
  if (cleanPattern.endsWith("*") && !cleanPattern.startsWith("*")) {
    const prefix = cleanPattern.slice(0, -1);
    return segments.some((segment) => segment.startsWith(prefix)) || normalized.startsWith(prefix);
  }
  if (cleanPattern.includes("/")) {
    return normalized === cleanPattern || normalized.startsWith(`${cleanPattern}/`);
  }
  return segments.includes(cleanPattern) || basename === cleanPattern;
}
