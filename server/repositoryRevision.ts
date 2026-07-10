import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { HttpError } from "./errors.js";
import type { RepositoryConfig } from "./types.js";

export async function repositoryRevision(repo: RepositoryConfig): Promise<string> {
  const canonicalRoot = await realpath(repo.root).catch(() => path.resolve(repo.root));
  const identity = JSON.stringify({
    id: repo.id,
    root: canonicalRoot,
    defaultPath: repo.defaultPath || "",
    excludes: [...(repo.excludes || [])].map((item) => item.replace(/\\/g, "/")).sort(),
    fetchRemote: repo.fetchRemote === true,
  });
  return createHash("sha256").update(identity).digest("base64url").slice(0, 24);
}

export async function assertRepositoryRevision(repo: RepositoryConfig, expectedRevision: unknown): Promise<string> {
  const currentRevision = await repositoryRevision(repo);
  if (typeof expectedRevision !== "string" || !expectedRevision || expectedRevision !== currentRevision) {
    throw new HttpError(409, "Repository revision is missing or stale. Reload the repository before continuing.", { currentRevision });
  }
  return currentRevision;
}
