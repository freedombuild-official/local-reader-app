import { access, readFile, realpath } from "node:fs/promises";
import { HttpError } from "./errors.js";
import { parseRepositoryConfig } from "./repositoryConfig.js";
import type { RepoListItem, RepositoryConfig } from "./types.js";

export type RepositoryRegistryOptions = {
  configPath: string;
};

export type RepositoryRegistry = {
  configPath?: string;
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
  return parseRepositoryConfig(raw);
}

class FileBackedRepositoryRegistry implements RepositoryRegistry {
  constructor(public readonly configPath: string) {}

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

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(await realpath(target));
    return true;
  } catch {
    return false;
  }
}
