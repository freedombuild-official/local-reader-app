import { access, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { isAbsolute } from "node:path";
import { parse } from "yaml";
import { HttpError } from "./errors.js";
import type { RepoListItem, RepositoryConfig } from "./types.js";

type RawRegistry = {
  repositories?: unknown;
};

export type RepositoryRegistryOptions = {
  configPath: string;
};

export type RepositoryRegistry = {
  listRepositoryItems: () => Promise<RepoListItem[]>;
  findRepository: (id: string) => Promise<RepositoryConfig>;
};

export function createRepositoryRegistry(options: RepositoryRegistryOptions): RepositoryRegistry {
  return new FileBackedRepositoryRegistry(options.configPath);
}

export async function loadConfigRepositories(configPath: string): Promise<RepositoryConfig[]> {
  const raw = await readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      throw new HttpError(500, `Repository config was not found: ${configPath}`);
    }
    throw error;
  });
  const parsed = parse(raw) as RawRegistry;
  if (!Array.isArray(parsed.repositories)) {
    throw new HttpError(500, "repositories.yaml must contain a repositories array.");
  }

  return parsed.repositories.map((entry, index) => normalizeRepository(entry, index));
}

class FileBackedRepositoryRegistry implements RepositoryRegistry {
  constructor(private readonly configPath: string) {}

  async listRepositoryItems(): Promise<RepoListItem[]> {
    const repos = await loadConfigRepositories(this.configPath);
    return Promise.all(repos.map((repo) => this.toListItem(repo)));
  }

  async findRepository(id: string): Promise<RepositoryConfig> {
    const repos = await loadConfigRepositories(this.configPath);
    const repo = repos.find((candidate) => candidate.id === id);
    if (!repo) throw new HttpError(404, "Repository is not registered.");
    return repo;
  }

  private async toListItem(repo: RepositoryConfig): Promise<RepoListItem> {
    return {
      id: repo.id,
      label: repo.label,
      root: repo.root,
      defaultPath: repo.defaultPath || "",
      exists: await pathExists(repo.root),
    };
  }
}

function normalizeRepository(entry: unknown, index: number): RepositoryConfig {
  if (!entry || typeof entry !== "object") {
    throw new HttpError(500, `repositories[${index}] must be an object.`);
  }
  const source = entry as Record<string, unknown>;
  const id = requiredString(source.id, `repositories[${index}].id`);
  const label = requiredString(source.label, `repositories[${index}].label`);
  const root = requiredString(source.root, `repositories[${index}].root`);
  if (!isAbsolute(root)) {
    throw new HttpError(500, `${id}.root must be an absolute path.`);
  }
  const defaultPath = typeof source.defaultPath === "string" ? source.defaultPath.trim() : "";
  const excludes = Array.isArray(source.excludes) ? source.excludes.filter((value): value is string => typeof value === "string") : [];
  const fetchRemote = source.fetchRemote === true;
  return { id, label, root, defaultPath, excludes, fetchRemote };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(500, `${label} is required.`);
  return value.trim();
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(await realpath(target));
    return true;
  } catch {
    return false;
  }
}
