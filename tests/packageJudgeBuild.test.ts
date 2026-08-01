import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as yauzl from "yauzl";
import { describe, expect, it } from "vitest";

type JudgeBuildModule = {
  buildJudgePackage: (input: {
    projectRoot: string;
    outputPath: string;
    sourceCommit: string;
    sourceState: string;
  }) => Promise<{
    output: string;
    source_commit: string;
    source_state: string;
    files: number;
    sha256: string;
  }>;
  judgeArchiveRoot: string;
  judgeBuildInputs: readonly string[];
};

const judgeModuleUrl = pathToFileURL(path.resolve(process.cwd(), "scripts/package-judge-build.mjs")).href;

async function loadJudgeModule(): Promise<JudgeBuildModule> {
  return await import(/* @vite-ignore */ judgeModuleUrl) as JudgeBuildModule;
}

describe("judge package builder", () => {
  it("creates a deterministic allowlisted ZIP with a SHA-256 manifest", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "judge-package-test-"));
    const projectRoot = path.join(temporaryRoot, "project");
    try {
      await writeJudgeFixture(projectRoot);
      const { buildJudgePackage, judgeArchiveRoot } = await loadJudgeModule();
      const firstPath = path.join(temporaryRoot, "first.zip");
      const secondPath = path.join(temporaryRoot, "second.zip");
      const input = {
        projectRoot,
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        sourceState: "clean",
      };

      const first = await buildJudgePackage({ ...input, outputPath: firstPath });
      const second = await buildJudgePackage({ ...input, outputPath: secondPath });
      const firstBuffer = await readFile(firstPath);
      const secondBuffer = await readFile(secondPath);
      expect(firstBuffer).toEqual(secondBuffer);
      expect(first.sha256).toBe(createHash("sha256").update(firstBuffer).digest("hex"));
      expect(second.sha256).toBe(first.sha256);

      const entries = await readZipEntries(firstPath);
      const manifestPath = `${judgeArchiveRoot}/JUDGE_BUILD_MANIFEST.json`;
      expect(entries.has(`${judgeArchiveRoot}/dist/index.html`)).toBe(true);
      expect(entries.has(`${judgeArchiveRoot}/dist-server/server/index.js`)).toBe(true);
      expect(entries.has(`${judgeArchiveRoot}/examples/build-week-demo/README.md`)).toBe(true);
      expect(
        entries
          .get(`${judgeArchiveRoot}/examples/build-week-demo/src/reader.ts`)
          ?.toString("utf8"),
      ).toContain("options: ReaderWorkspaceOptions");
      expect(entries.has(manifestPath)).toBe(true);
      const packagedPackage = JSON.parse(entries.get(`${judgeArchiveRoot}/package.json`)?.toString("utf8") || "{}") as {
        scripts?: Record<string, string>;
      };
      expect(packagedPackage.scripts).toEqual({
        start: "node dist-server/server/index.js",
        "start:judge": "node scripts/start-judge.mjs",
      });

      const manifest = JSON.parse(entries.get(manifestPath)?.toString("utf8") || "{}") as {
        source_commit?: string;
        source_state?: string;
        files?: Array<{ path: string; bytes: number; sha256: string }>;
      };
      expect(manifest.source_commit).toBe(input.sourceCommit);
      expect(manifest.source_state).toBe("clean");
      expect(manifest.files?.some((file) => file.path === "dist/index.html")).toBe(true);
      expect(manifest.files?.some((file) => file.path === "JUDGE_BUILD_MANIFEST.json")).toBe(false);
      for (const file of manifest.files || []) {
        expect(file.path).not.toContain("\\");
        const content = entries.get(`${judgeArchiveRoot}/${file.path}`);
        expect(content, file.path).toBeDefined();
        expect(content?.byteLength).toBe(file.bytes);
        expect(createHash("sha256").update(content || Buffer.alloc(0)).digest("hex")).toBe(file.sha256);
      }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  it("fails when an allowlisted input is missing", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "judge-package-missing-"));
    const projectRoot = path.join(temporaryRoot, "project");
    try {
      await writeJudgeFixture(projectRoot);
      await rm(path.join(projectRoot, "LICENSE"));
      const { buildJudgePackage } = await loadJudgeModule();
      await expect(buildJudgePackage({
        projectRoot,
        outputPath: path.join(temporaryRoot, "missing.zip"),
        sourceCommit: "0123456789abcdef0123456789abcdef01234567",
        sourceState: "clean",
      })).rejects.toThrow("Required judge build input is missing: LICENSE");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});

async function writeJudgeFixture(projectRoot: string): Promise<void> {
  const { judgeBuildInputs } = await loadJudgeModule();
  const directorySamples: Record<string, Array<[string, string]>> = {
    dist: [["index.html", "<!doctype html><title>Judge</title>\n"]],
    "dist-server": [["server/index.js", "console.log('server');\n"]],
    "examples/build-week-demo": [
      ["README.md", "# Demo\n"],
      [
        "src/reader.ts",
        "export type ReaderWorkspaceOptions = { mode: \"local\"; writes: \"disabled\" };\nexport function createReaderWorkspace(options: ReaderWorkspaceOptions) { return options; }\n",
      ],
    ],
  };
  for (const input of judgeBuildInputs) {
    if (directorySamples[input]) {
      for (const [relativePath, content] of directorySamples[input]) {
        await writeText(path.join(projectRoot, input, relativePath), content);
      }
    } else {
      const content = input === "package.json"
        ? "{\n  \"name\": \"local-reader-app\",\n  \"scripts\": {\n    \"build\": \"exit 1\",\n    \"start\": \"node dist-server/server/index.js\",\n    \"start:judge\": \"node scripts/start-judge.mjs\"\n  }\n}\n"
        : `${input}\n`;
      await writeText(path.join(projectRoot, input), content);
    }
  }
}

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

async function readZipEntries(zipPath: string): Promise<Map<string, Buffer>> {
  const zipFile = await yauzl.openPromise(zipPath, {
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  });
  return await new Promise((resolve, reject) => {
    const entries = new Map<string, Buffer>();
    zipFile.once("error", reject);
    zipFile.once("end", () => resolve(entries));
    zipFile.on("entry", (entry) => {
      zipFile.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          reject(error || new Error(`Could not read ${entry.fileName}`));
          return;
        }
        const chunks: Buffer[] = [];
        stream.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        stream.once("error", reject);
        stream.once("end", () => {
          entries.set(entry.fileName, Buffer.concat(chunks));
          zipFile.readEntry();
        });
      });
    });
    zipFile.readEntry();
  });
}
