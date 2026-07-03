import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepositoryRegistry, loadConfigRepositories } from "../server/repositoryRegistry.js";

describe("repository registry", () => {
  it("loads repositories from yaml", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-repo-"));
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:\n  - id: docs\n    label: Docs\n    root: ${root}\n    defaultPath: README.md\n    fetchRemote: true\n    excludes:\n      - dist\n`);

    await expect(loadConfigRepositories(configPath)).resolves.toEqual([
      expect.objectContaining({ id: "docs", label: "Docs", root, defaultPath: "README.md", excludes: ["dist"], fetchRemote: true }),
    ]);
    await expect(createRepositoryRegistry({ configPath }).listRepositoryItems()).resolves.toEqual([
      expect.objectContaining({ id: "docs", exists: true }),
    ]);
  });

  it("rejects relative roots in config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-bad-config-"));
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, "repositories:\n  - id: bad\n    label: Bad\n    root: ./relative\n");
    await expect(loadConfigRepositories(configPath)).rejects.toThrow("absolute");
  });
});
