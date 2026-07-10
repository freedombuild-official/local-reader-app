import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertOpenedFileBoundary, isExcludedPath, normalizeRelativePath, readGuardedRepoFile, resolveRepoPath } from "../server/pathGuard.js";
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

  it("reads regular files through a held descriptor and rejects all symlink components", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-guarded-read-"));
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "README.md"), "# Safe\n");
    await writeFile(path.join(root, "docs", "guide.md"), "# Guide\n");
    await symlink(path.join(root, "README.md"), path.join(root, "alias.md"));
    await symlink(path.join(root, "docs"), path.join(root, "docs-alias"));

    await expect(readGuardedRepoFile(testRepo(root), "README.md", 64)).resolves.toMatchObject({
      bytes: Buffer.from("# Safe\n"),
    });
    await expect(readGuardedRepoFile(testRepo(root), "README.md", 2)).rejects.toMatchObject({ status: 413 });
    await expect(readGuardedRepoFile(testRepo(root), "alias.md")).rejects.toMatchObject({ status: 403 });
    await expect(readGuardedRepoFile(testRepo(root), "docs-alias/guide.md")).rejects.toMatchObject({ status: 403 });
    await expect(readGuardedRepoFile(testRepo(root), "docs")).rejects.toMatchObject({ status: 400 });
  });

  it("rechecks the canonical root boundary when descriptor links are unavailable", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-fallback-boundary-"));
    const outside = await mkdtemp(path.join(tmpdir(), "reader-wiki-fallback-outside-"));
    await mkdir(path.join(root, "docs"));
    await writeFile(path.join(root, "docs", "guide.md"), "inside");
    await writeFile(path.join(outside, "guide.md"), "outside");
    const repo = testRepo(root);
    const resolved = await resolveRepoPath(repo, "docs/guide.md");
    const handle = await open(resolved.realPath, constants.O_RDONLY);
    try {
      const openedStat = await handle.stat();
      await rename(path.join(root, "docs"), path.join(root, "docs-old"));
      await symlink(outside, path.join(root, "docs"));
      await expect(assertOpenedFileBoundary(repo, resolved, handle.fd, openedStat, [])).rejects.toMatchObject({ status: 403 });
    } finally {
      await handle.close();
    }
  });
});
