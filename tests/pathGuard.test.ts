import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isExcludedPath, normalizeRelativePath, resolveRepoPath } from "../server/pathGuard.js";
import type { RepositoryConfig } from "../server/types.js";

function testRepo(root: string): RepositoryConfig {
  return { id: "repo", label: "Repo", root, defaultPath: "README.md", excludes: ["node_modules", "dist"] };
}

describe("path guard", () => {
  it("rejects absolute paths and parent traversal", () => {
    expect(() => normalizeRelativePath("/tmp/file")).toThrow("relative");
    expect(() => normalizeRelativePath("../private-file")).toThrow("outside");
  });

  it("keeps resolved paths inside the registered root", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-root-"));
    const outside = await mkdtemp(path.join(tmpdir(), "reader-wiki-outside-"));
    await writeFile(path.join(root, "README.md"), "# OK\n");
    await writeFile(path.join(outside, "private.md"), "# Private\n");
    await symlink(outside, path.join(root, "escape"));

    await expect(resolveRepoPath(testRepo(root), "README.md")).resolves.toMatchObject({ relativePath: "README.md" });
    await expect(resolveRepoPath(testRepo(root), "escape/private.md")).rejects.toThrow("outside");
  });

  it("applies default and configured excludes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-excludes-"));
    await mkdir(path.join(root, ".git"));
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, ".git/config"), "hidden\n");
    await writeFile(path.join(root, "node_modules/pkg.txt"), "hidden\n");

    const repo = testRepo(root);
    expect(isExcludedPath(repo, ".git/config")).toBe(true);
    expect(isExcludedPath(repo, "node_modules/pkg.txt")).toBe(true);
    await expect(resolveRepoPath(repo, ".git/config")).rejects.toThrow("excluded");
  });
});
