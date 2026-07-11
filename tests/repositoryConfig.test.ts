import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadRepositoryConfigState,
  saveRepositoryConfigDraft,
  validateRepositoryConfigDraft,
} from "../server/repositoryConfig.js";
import { loadConfigRepositories } from "../server/repositoryRegistry.js";

describe("repository config safety", () => {
  it("rejects regular-file, duplicate, and nested repository roots", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-config-roots-"));
    const nested = path.join(root, "nested");
    const regularFile = path.join(root, "not-a-directory");
    await mkdir(nested);
    await writeFile(regularFile, "not a directory\n");
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, "repositories: []\n");

    const validation = await validateRepositoryConfigDraft({
      entries: [
        { id: "file", label: "File", root: regularFile, defaultPath: "", excludes: [], fetchRemote: false },
        { id: "root-a", label: "Root A", root, defaultPath: "", excludes: [], fetchRemote: false },
        { id: "root-b", label: "Root B", root, defaultPath: "", excludes: [], fetchRemote: false },
        { id: "nested", label: "Nested", root: nested, defaultPath: "", excludes: [], fetchRemote: false },
      ],
    }, configPath);

    expect(validation.valid).toBe(false);
    expect(validation.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "entry:0:rootExists", status: "error" }),
      expect.objectContaining({ id: "roots:1:2:duplicate", status: "error" }),
      expect.objectContaining({ id: "roots:1:3:nested", status: "error" }),
    ]));
  });

  it("enforces root validation for hand-edited runtime config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-runtime-config-"));
    const regularFile = path.join(root, "not-a-directory");
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(regularFile, "not a directory\n");
    await writeFile(configPath, `repositories:
  - id: unsafe
    label: Unsafe
    root: ${regularFile}
`);

    await expect(loadConfigRepositories(configPath)).rejects.toMatchObject({
      status: 500,
      message: expect.stringContaining("unsafe"),
    });
  });

  it("canonicalizes valid exclude patterns and rejects a non-empty root exclude", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-config-excludes-"));
    const configPath = path.join(root, "repositories.yaml");
    await writeFile(configPath, `repositories:
  - id: docs
    label: Docs
    root: ${root}
    excludes:
      - ./private
      - docs/../secret
      - 'nested\\cache'
`);
    await expect(loadConfigRepositories(configPath)).resolves.toEqual([
      expect.objectContaining({ excludes: ["private", "secret", "nested/cache"] }),
    ]);

    const validation = await validateRepositoryConfigDraft({
      entries: [{ id: "docs", label: "Docs", root, defaultPath: "", excludes: ["."], fetchRemote: false }],
    }, configPath);
    expect(validation).toMatchObject({ valid: false });
    expect(validation.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "entry:0:excludesRelative", status: "error" }),
    ]));
  });

  it("rejects stale and concurrent saves without overwriting the winning config", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-config-cas-"));
    const configPath = path.join(root, "repositories.yaml");
    const original = `repositories:
  - id: docs
    label: Docs
    root: ${root}
`;
    await writeFile(configPath, original);
    const state = await loadRepositoryConfigState(configPath);
    const expectedConfigRevision = state.configRevision;
    const draft = (id: string) => ({
      expectedConfigRevision,
      entries: [{ id, label: id, root, defaultPath: "", excludes: [], fetchRemote: false }],
    });

    const results = await Promise.allSettled([
      saveRepositoryConfigDraft(draft("alpha"), configPath),
      saveRepositoryConfigDraft(draft("beta"), configPath),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    expect(rejected?.reason).toMatchObject({ status: 409 });
    const winningConfig = await readFile(configPath, "utf8");
    expect(winningConfig.includes("id: alpha") || winningConfig.includes("id: beta")).toBe(true);
    expect((await readdir(root)).filter((name) => name.startsWith(".repositories.") && name.endsWith(".tmp"))).toEqual([]);

    const winningState = await loadRepositoryConfigState(configPath);
    await writeFile(configPath, original.replace("label: Docs", "label: External"));
    await expect(saveRepositoryConfigDraft({
      expectedConfigRevision: winningState.configRevision,
      entries: [{ id: "gamma", label: "gamma", root, defaultPath: "", excludes: [], fetchRemote: false }],
    }, configPath)).rejects.toMatchObject({ status: 409 });
    await expect(readFile(configPath, "utf8")).resolves.toContain("label: External");
  });
});
