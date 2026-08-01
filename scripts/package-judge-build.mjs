import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const judgeArchiveRoot = "local-reader-app-build-week-judge";

export const judgeBuildInputs = Object.freeze([
  "AUTHORS.md",
  "CITATION.cff",
  "LICENSE",
  "NOTICE",
  "README.md",
  "README.ja.md",
  "SECURITY.md",
  "TRADEMARKS.md",
  "dist",
  "dist-server",
  "docs/JUDGING.md",
  "docs/openai-build-week-2026.md",
  "examples/build-week-demo",
  "package.json",
  "pnpm-lock.yaml",
  "sample.repositories.yaml",
  "scripts/start-judge.mjs",
]);

const fixedDosTime = 0;
const fixedDosDate = 0x21;
const utf8Flag = 0x0800;
const crcTable = createCrcTable();

export async function buildJudgePackage({
  projectRoot,
  outputPath,
  sourceCommit,
  sourceState,
}) {
  const resolvedProjectRoot = path.resolve(projectRoot);
  const resolvedOutputPath = path.resolve(outputPath);
  if (isInside(resolvedProjectRoot, resolvedOutputPath)) {
    throw new Error("Judge package output must be outside the project source tree.");
  }
  if (!sourceCommit || !sourceState) {
    throw new Error("sourceCommit and sourceState are required.");
  }

  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "local-reader-app-judge-package-"));
  const stagingRoot = path.join(temporaryRoot, judgeArchiveRoot);
  try {
    await mkdir(stagingRoot, { recursive: true });
    for (const input of judgeBuildInputs) {
      const source = path.join(resolvedProjectRoot, input);
      const destination = path.join(stagingRoot, input);
      await copyAllowlistedPath(source, destination, input);
    }
    await limitPackagedScripts(stagingRoot);

    const packagedFiles = await collectFiles(stagingRoot);
    const fileRecords = [];
    for (const relativePath of packagedFiles) {
      const content = await readFile(path.join(stagingRoot, relativePath));
      fileRecords.push({
        path: toPosixPath(relativePath),
        bytes: content.byteLength,
        sha256: sha256(content),
      });
    }

    const manifest = {
      schema_version: 1,
      project: "Local Reader App",
      purpose: "OpenAI Build Week 2026 Developer Tools judging package",
      source_commit: sourceCommit,
      source_state: sourceState,
      archive_root: judgeArchiveRoot,
      build_inputs: [...judgeBuildInputs],
      transforms: ["package.json scripts are limited to start and start:judge"],
      files: fileRecords,
    };
    await writeFile(
      path.join(stagingRoot, "JUDGE_BUILD_MANIFEST.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );

    const zipEntries = [];
    for (const relativePath of await collectFiles(stagingRoot)) {
      zipEntries.push({
        name: `${judgeArchiveRoot}/${toPosixPath(relativePath)}`,
        data: await readFile(path.join(stagingRoot, relativePath)),
      });
    }
    const archive = createStoredZip(zipEntries);
    await mkdir(path.dirname(resolvedOutputPath), { recursive: true });
    await writeFile(resolvedOutputPath, archive);

    return {
      output: resolvedOutputPath,
      archive_root: judgeArchiveRoot,
      source_commit: sourceCommit,
      source_state: sourceState,
      files: zipEntries.length,
      bytes: archive.byteLength,
      sha256: sha256(archive),
    };
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function limitPackagedScripts(stagingRoot) {
  const packagePath = path.join(stagingRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const start = packageJson.scripts?.start;
  const startJudge = packageJson.scripts?.["start:judge"];
  if (typeof start !== "string" || typeof startJudge !== "string") {
    throw new Error("package.json must define start and start:judge scripts.");
  }
  packageJson.scripts = { start, "start:judge": startJudge };
  await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`, "utf8");
}

async function copyAllowlistedPath(source, destination, label) {
  let sourceStat;
  try {
    sourceStat = await lstat(source);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(`Required judge build input is missing: ${label}`);
    }
    throw error;
  }
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Judge build input must not be a symbolic link: ${label}`);
  }
  if (sourceStat.isDirectory()) {
    await mkdir(destination, { recursive: true });
    const entries = await readdir(source, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      await copyAllowlistedPath(
        path.join(source, entry.name),
        path.join(destination, entry.name),
        `${label}/${entry.name}`,
      );
    }
    return;
  }
  if (!sourceStat.isFile()) {
    throw new Error(`Judge build input must be a regular file or directory: ${label}`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function collectFiles(root, relativeRoot = "") {
  const absoluteRoot = path.join(root, relativeRoot);
  const entries = await readdir(absoluteRoot, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const relativePath = path.join(relativeRoot, entry.name);
    const entryPath = path.join(root, relativePath);
    const entryStat = await lstat(entryPath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Judge staging must not contain symbolic links: ${toPosixPath(relativePath)}`);
    }
    if (entryStat.isDirectory()) {
      files.push(...await collectFiles(root, relativePath));
    } else if (entryStat.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Judge staging contains an unsupported entry: ${toPosixPath(relativePath)}`);
    }
  }
  return files.sort((left, right) => toPosixPath(left).localeCompare(toPosixPath(right), "en"));
}

function createStoredZip(entries) {
  if (entries.length > 0xffff) throw new Error("Judge package contains too many ZIP entries.");
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data);
    if (name.byteLength > 0xffff) throw new Error(`ZIP entry name is too long: ${entry.name}`);
    if (data.byteLength > 0xffffffff) throw new Error(`ZIP entry is too large: ${entry.name}`);
    const checksum = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(utf8Flag, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(fixedDosTime, 10);
    localHeader.writeUInt16LE(fixedDosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(data.byteLength, 18);
    localHeader.writeUInt32LE(data.byteLength, 22);
    localHeader.writeUInt16LE(name.byteLength, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, name, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(utf8Flag, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(fixedDosTime, 12);
    centralHeader.writeUInt16LE(fixedDosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(data.byteLength, 20);
    centralHeader.writeUInt32LE(data.byteLength, 24);
    centralHeader.writeUInt16LE(name.byteLength, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(localOffset, 42);
    centralParts.push(centralHeader, name);

    localOffset += localHeader.byteLength + name.byteLength + data.byteLength;
    if (localOffset > 0xffffffff) throw new Error("Judge package exceeds the classic ZIP size limit.");
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.byteLength, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function createCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function runGit(projectRoot, args) {
  const result = spawnSync("git", args, {
    cwd: projectRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr || "").trim()}`);
  }
  return result.stdout.trim();
}

function parseCliArgs(argv) {
  let outputPath = "";
  let requireClean = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") {
      continue;
    }
    if (argument === "--output") {
      outputPath = argv[index + 1] || "";
      index += 1;
    } else if (argument === "--require-clean") {
      requireClean = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!outputPath) throw new Error("Usage: pnpm package:judge -- --output <path.zip> [--require-clean]");
  return { outputPath, requireClean };
}

async function main() {
  const projectRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
  const { outputPath, requireClean } = parseCliArgs(process.argv.slice(2));
  const sourceCommit = runGit(projectRoot, ["rev-parse", "HEAD"]);
  const worktreeStatus = runGit(projectRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (requireClean && worktreeStatus) {
    throw new Error("--require-clean requires a clean Git worktree.");
  }
  const result = await buildJudgePackage({
    projectRoot,
    outputPath,
    sourceCommit,
    sourceState: worktreeStatus ? "working-tree" : "clean",
  });
  console.log(JSON.stringify(result, null, 2));
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main().catch((error) => {
    console.error(`package-judge-build: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
