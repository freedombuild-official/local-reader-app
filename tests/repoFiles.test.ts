// @vitest-environment node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { readDirectoryEntriesBounded, readTree, readTreeSnapshot } from "../server/repoFiles.js";
import type { RepositoryConfig } from "../server/types.js";

const execFileAsync = promisify(execFile);

async function initGitRepository(root: string): Promise<void> {
  await execFileAsync("git", ["init", "-q"], { cwd: root });
}

function repository(root: string, excludes: string[] = []): RepositoryConfig {
  return { id: "test", label: "Test", root, defaultPath: "", excludes };
}

describe("repository tree budgets", () => {
  it("stops directory enumeration after the configured entry budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-bounded-directory-"));
    await Promise.all(["a", "b", "c", "d"].map((name) => writeFile(path.join(root, `${name}.txt`), name)));

    const result = await readDirectoryEntriesBounded(root, 3);
    expect(result.entries).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("returns a partial tree warning instead of traversing beyond the depth budget", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-deep-tree-"));
    let current = root;
    for (let depth = 0; depth < 35; depth += 1) {
      current = path.join(current, `d${depth}`);
      await mkdir(current);
    }
    await writeFile(path.join(current, "end.txt"), "end");
    const repo: RepositoryConfig = { id: "deep", label: "Deep", root, defaultPath: "", excludes: [] };

    const result = await readTreeSnapshot(repo);
    expect(result.truncated).toBe(true);
    expect(result.warnings.join(" ")).toContain("depth 32");
  });
});

describe("Git ignored tree nodes", () => {
  it("marks a visible file ignored by Git", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-git-ignore-"));
    await initGitRepository(root);
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(root, "ignored.txt"), "ignored");

    const tree = await readTree(repository(root), "");

    expect(tree.find((node) => node.path === "ignored.txt")).toMatchObject({ gitIgnored: true });
  });

  it("marks a visible directory ignored by Git", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-git-ignore-directory-"));
    await initGitRepository(root);
    await mkdir(path.join(root, "ignored-dir"));
    await writeFile(path.join(root, "ignored-dir", "inside.txt"), "ignored");
    await writeFile(path.join(root, ".gitignore"), "ignored-dir/\n");

    const tree = await readTree(repository(root), "");

    expect(tree.find((node) => node.path === "ignored-dir")).toMatchObject({ type: "directory", gitIgnored: true });
  });

  it("applies nested ignore rules to visible child paths", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-git-ignore-nested-"));
    await initGitRepository(root);
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "ignored.log"), "ignored");
    await writeFile(path.join(root, "nested", ".gitignore"), "*.log\n");

    const tree = await readTree(repository(root), "nested");

    expect(tree.find((node) => node.path === "nested/ignored.log")).toMatchObject({ gitIgnored: true });
  });

  it("keeps a negated ignore match unmarked", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-git-ignore-negation-"));
    await initGitRepository(root);
    await writeFile(path.join(root, ".gitignore"), "*.log\n!keep.log\n");
    await writeFile(path.join(root, "ignored.log"), "ignored");
    await writeFile(path.join(root, "keep.log"), "keep");

    const tree = await readTree(repository(root), "");

    expect(tree.find((node) => node.path === "ignored.log")?.gitIgnored).toBe(true);
    expect(tree.find((node) => node.path === "keep.log")?.gitIgnored).toBeUndefined();
  });

  it("honors .git/info/exclude", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-git-info-exclude-"));
    await initGitRepository(root);
    await writeFile(path.join(root, ".git", "info", "exclude"), "local-only.txt\n");
    await writeFile(path.join(root, "local-only.txt"), "ignored");

    const tree = await readTree(repository(root), "");

    expect(tree.find((node) => node.path === "local-only.txt")?.gitIgnored).toBe(true);
  });

  it("does not mark a tracked matching file and preserves its changed marker", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-git-ignore-tracked-"));
    await initGitRepository(root);
    await writeFile(path.join(root, ".gitignore"), "tracked.txt\n");
    await writeFile(path.join(root, "tracked.txt"), "initial\n");
    await execFileAsync("git", ["add", ".gitignore"], { cwd: root });
    await execFileAsync("git", ["add", "-f", "tracked.txt"], { cwd: root });
    await execFileAsync("git", ["-c", "user.name=Reader Wiki Tests", "-c", "user.email=reader-wiki@example.invalid", "commit", "-q", "-m", "initial"], { cwd: root });
    await writeFile(path.join(root, "tracked.txt"), "changed\n");

    const tree = await readTree(repository(root), "");
    const tracked = tree.find((node) => node.path === "tracked.txt");

    expect(tracked).toMatchObject({ gitStatus: "changed" });
    expect(tracked?.gitIgnored).toBeUndefined();
  });

  it("does not mark a staged deleted tracked file that matches an ignore rule", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-git-ignore-deleted-tracked-"));
    await initGitRepository(root);
    await writeFile(path.join(root, ".gitignore"), "*.log\n");
    await writeFile(path.join(root, "tracked.log"), "initial\n");
    await execFileAsync("git", ["add", ".gitignore"], { cwd: root });
    await execFileAsync("git", ["add", "-f", "tracked.log"], { cwd: root });
    await execFileAsync("git", ["-c", "user.name=Reader Wiki Tests", "-c", "user.email=reader-wiki@example.invalid", "commit", "-q", "-m", "initial"], { cwd: root });
    await unlink(path.join(root, "tracked.log"));
    await execFileAsync("git", ["add", "-u"], { cwd: root });

    const tree = await readTree(repository(root), "");
    const deletedTracked = tree.find((node) => node.path === "tracked.log");

    expect(deletedTracked).toMatchObject({ gitStatus: "deleted" });
    expect(deletedTracked?.gitIgnored).toBeUndefined();
  });

  it("keeps configured excludes hidden even when Git ignores them", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-git-ignore-excluded-"));
    await initGitRepository(root);
    await writeFile(path.join(root, ".gitignore"), "hidden.txt\n");
    await writeFile(path.join(root, "hidden.txt"), "hidden");

    const tree = await readTree(repository(root, ["hidden.txt"]), "");

    expect(tree.some((node) => node.path === "hidden.txt")).toBe(false);
  });

  it("keeps a non-Git directory readable without ignored markers", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-non-git-ignore-"));
    await writeFile(path.join(root, ".gitignore"), "*.tmp\n");
    await writeFile(path.join(root, "plain.tmp"), "plain outside Git");

    const tree = await readTree(repository(root), "");

    expect(tree).toEqual(expect.arrayContaining([expect.objectContaining({ path: "plain.tmp" })]));
    expect(tree.every((node) => node.gitIgnored === undefined)).toBe(true);
  });

  it("marks ignored nodes in a full snapshot without changing snapshot metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-git-ignore-snapshot-"));
    await initGitRepository(root);
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, ".gitignore"), "nested/ignored.txt\n");
    await writeFile(path.join(root, "nested", "ignored.txt"), "ignored");

    const result = await readTreeSnapshot(repository(root));

    expect(result.tree.nested.find((node) => node.path === "nested/ignored.txt")?.gitIgnored).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.warnings).toEqual([]);
  });

  it("keeps valid ignore markers when a snapshot traverses a symbolic-link directory", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "reader-wiki-git-ignore-symlink-snapshot-"));
    await initGitRepository(root);
    await mkdir(path.join(root, "target-dir"));
    await writeFile(path.join(root, "target-dir", "inside.txt"), "inside");
    await symlink("target-dir", path.join(root, "linked-dir"), "dir");
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(root, "ignored.txt"), "ignored");

    const result = await readTreeSnapshot(repository(root));

    expect(result.tree["linked-dir"]?.some((node) => node.path === "linked-dir/inside.txt")).toBe(true);
    expect(result.tree[""]?.find((node) => node.path === "ignored.txt")?.gitIgnored).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.warnings).toEqual([]);
  });
});
