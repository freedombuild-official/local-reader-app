import { realpath } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.js";
import type { RepositoryConfig } from "./types.js";

export type ResolvedRepoPath = {
  relativePath: string;
  absolutePath: string;
  realPath: string;
  rootRealPath: string;
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
