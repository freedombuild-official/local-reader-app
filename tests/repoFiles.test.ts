// @vitest-environment node

import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readDirectoryEntriesBounded, readTreeSnapshot } from "../server/repoFiles.js";
import type { RepositoryConfig } from "../server/types.js";

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
