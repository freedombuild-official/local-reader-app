import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const MAX_TEXT_FILE_BYTES = 5_000_000;
const requiredPackageMetadata = {
  private: true,
  license: "MIT",
  packageManager: "pnpm@10.27.0",
};
const generatedPrefixes = ["coverage/", "dist/", "dist-server/", "node_modules/"];
const privateUserMarker = String.fromCharCode(97, 114, 99, 104, 105);
const privateProductMarkers = [
  ["kin", "kaku"].join(""),
  String.fromCodePoint(0x91d1, 0x95a3),
];
const contentRules = [
  { label: "macOS home path", pattern: /(?<![A-Za-z0-9/.:_-])\/Users\/(?!example(?:\/|$)|your[-_ ]?name(?:\/|$))[^/\s"']+/gi },
  { label: "Linux home path", pattern: /(?<![A-Za-z0-9/.:_-])\/home\/(?!example(?:\/|$)|your[-_ ]?name(?:\/|$))[^/\s"']+/gi },
  { label: "Windows home path", pattern: /(?<![A-Za-z0-9/.:_-])[A-Za-z]:\\Users\\(?!example(?:\\|$)|your[-_ ]?name(?:\\|$))[^\\/\s"']+/gi },
  { label: "known private username", pattern: new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(privateUserMarker)}(?![A-Za-z0-9_])`, "gi") },
  { label: "AWS access token", pattern: new RegExp(["A", "KIA", "[0-9A-Z]{16}"].join(""), "g") },
  { label: "GitHub access token", pattern: new RegExp(["g", "h", "[pousr]_[A-Za-z0-9]{20,}"].join(""), "g") },
  { label: "provider access token", pattern: new RegExp(["s", "k", "-[A-Za-z0-9_-]{20,}"].join(""), "g") },
  ...privateProductMarkers.map((value) => ({ label: "private product marker", pattern: new RegExp(escapeRegExp(value), "gi") })),
];

const files = listPublicFiles();
const failures = [];
const warnings = [];

for (const file of files) {
  const normalized = file.replaceAll("\\", "/");
  if (generatedPrefixes.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix))) {
    failures.push(`${file}: generated artifact is present in the public file set`);
    continue;
  }
  if (isSensitiveFileName(normalized)) {
    failures.push(`${file}: sensitive local configuration filename is present`);
  }

  let buffer;
  try {
    const fileStat = await lstat(path.resolve(file));
    if (!fileStat.isFile()) {
      failures.push(`${file}: public scan does not follow symlinks or non-file entries`);
      continue;
    }
    buffer = await readFile(path.resolve(file));
  } catch (error) {
    failures.push(`${file}: could not be read (${error instanceof Error ? error.message : String(error)})`);
    continue;
  }
  if (buffer.includes(0)) continue;
  if (buffer.length > MAX_TEXT_FILE_BYTES) {
    failures.push(`${file}: text content was not scanned because it exceeds ${MAX_TEXT_FILE_BYTES} bytes`);
    continue;
  }

  const content = buffer.toString("utf8");
  for (const rule of contentRules) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(content)) failures.push(`${file}: ${rule.label}`);
  }
}

await validatePackageMetadata(failures, warnings);
validatePublicationMetadata(warnings);

for (const warning of warnings) console.warn(`HUMAN GATE: ${warning}`);
if (failures.length) {
  for (const failure of failures) console.error(`PUBLIC SCAN FAILURE: ${failure}`);
  console.error(`Public source scan failed with ${failures.length} finding(s).`);
  process.exitCode = 1;
} else {
  console.log(`Public source scan passed for ${files.length} file(s).`);
  if (warnings.length) console.log("Publication remains HOLD until the human gates above are resolved.");
}

function listPublicFiles() {
  const result = runGit(["ls-files", "-co", "--exclude-standard", "-z"]);
  return result.stdout.split("\0").filter(Boolean).sort();
}

function runGit(args, allowFailure = false) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr || "").trim()}`);
  }
  return result;
}

async function validatePackageMetadata(foundFailures, foundWarnings) {
  const packageJson = JSON.parse(await readFile(path.resolve("package.json"), "utf8"));
  for (const [key, expected] of Object.entries(requiredPackageMetadata)) {
    if (packageJson[key] !== expected) foundFailures.push(`package.json: ${key} must be ${JSON.stringify(expected)}`);
  }
  if (packageJson.engines?.node !== ">=22.13.0 <27") {
    foundFailures.push('package.json: engines.node must be ">=22.13.0 <27"');
  }
  for (const key of ["repository", "homepage", "bugs"]) {
    if (!packageJson[key]) foundWarnings.push(`package.json.${key} is unset until the public GitHub namespace is chosen`);
  }
}

function validatePublicationMetadata(foundWarnings) {
  const remote = runGit(["remote", "get-url", "origin"], true);
  if (remote.status !== 0 || !remote.stdout.trim()) {
    foundWarnings.push("the Git origin URL is unset; do not invent repository URLs in package metadata");
  }
  foundWarnings.push("history publication mode and author/committer email policy require maintainer approval; run pnpm run scan:history before publishing");
}

function isSensitiveFileName(file) {
  const base = path.posix.basename(file).toLowerCase();
  if (base === ".env.example" || base === ".env.sample") return false;
  return base === ".env" || base.startsWith(".env.") || [".npmrc", "credentials.json"].includes(base);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
