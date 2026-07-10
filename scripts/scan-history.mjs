import process from "node:process";
import { spawnSync } from "node:child_process";

const MAX_HISTORY_BLOB_BYTES = 5_000_000;
const privateUserMarker = String.fromCharCode(97, 114, 99, 104, 105);
const privateProductMarkers = [
  ["kin", "kaku"].join(""),
  String.fromCodePoint(0x91d1, 0x95a3),
];
const contentRules = [
  { label: "macOS home path", pattern: /\/Users\/(?!example(?:\/|$)|your[-_ ]?name(?:\/|$))[^/\s"']+/gi },
  { label: "Linux home path", pattern: /\/home\/(?!example(?:\/|$)|your[-_ ]?name(?:\/|$))[^/\s"']+/gi },
  { label: "Windows home path", pattern: /[A-Za-z]:\\Users\\(?!example(?:\\|$)|your[-_ ]?name(?:\\|$))[^\\/\s"']+/gi },
  { label: "known private username", pattern: new RegExp(`(^|[^A-Za-z0-9_])${escapeRegExp(privateUserMarker)}(?![A-Za-z0-9_])`, "gi") },
  { label: "AWS access token", pattern: new RegExp(["A", "KIA", "[0-9A-Z]{16}"].join(""), "g") },
  { label: "GitHub access token", pattern: new RegExp(["g", "h", "[pousr]_[A-Za-z0-9]{20,}"].join(""), "g") },
  { label: "provider access token", pattern: new RegExp(["s", "k", "-[A-Za-z0-9_-]{20,}"].join(""), "g") },
  ...privateProductMarkers.map((value) => ({ label: "private product marker", pattern: new RegExp(escapeRegExp(value), "gi") })),
];

const commits = runGit(["rev-list", "--all"]).stdout.trim().split(/\r?\n/).filter(Boolean);
if (!commits.length) {
  console.error("History scan requires at least one Git commit.");
  process.exit(1);
}

const findings = [];
const blobs = new Map();
const emailUsage = new Map();

for (const commit of commits) {
  const tree = runGit(["ls-tree", "-r", "-z", commit]).stdout;
  for (const entry of tree.split("\0").filter(Boolean)) {
    const match = entry.match(/^\d+ blob ([0-9a-f]+)\t([\s\S]+)$/);
    if (!match || blobs.has(match[1])) continue;
    blobs.set(match[1], { commit, path: match[2] });
  }
}

for (const [objectId, source] of blobs) {
  const size = Number(runGit(["cat-file", "-s", objectId]).stdout.trim());
  if (!Number.isFinite(size) || size > MAX_HISTORY_BLOB_BYTES) {
    findings.push(`${source.commit.slice(0, 12)} ${source.path}: historical blob was not scanned because it exceeds ${MAX_HISTORY_BLOB_BYTES} bytes`);
    continue;
  }
  const bufferResult = spawnSync("git", ["cat-file", "blob", objectId], {
    cwd: process.cwd(),
    encoding: "buffer",
    maxBuffer: MAX_HISTORY_BLOB_BYTES + 1024,
    windowsHide: true,
  });
  if (bufferResult.error || bufferResult.status !== 0) {
    findings.push(`${source.commit.slice(0, 12)} ${source.path}: historical blob could not be read`);
    continue;
  }
  const buffer = bufferResult.stdout;
  if (buffer.includes(0)) continue;
  const content = buffer.toString("utf8");
  for (const rule of contentRules) {
    rule.pattern.lastIndex = 0;
    if (rule.pattern.test(content)) findings.push(`${source.commit.slice(0, 12)} ${source.path}: ${rule.label}`);
  }
}

const metadata = runGit(["log", "--all", "--format=%H%x09%ae%x09%ce"]).stdout;
for (const line of metadata.split(/\r?\n/).filter(Boolean)) {
  const [commit, authorEmail, committerEmail] = line.split("\t");
  reviewEmail(commit, "author", authorEmail, emailUsage);
  reviewEmail(commit, "committer", committerEmail, emailUsage);
}
for (const [key, affectedCommits] of emailUsage) {
  const [role, domain] = key.split("|");
  findings.push(`${role} email uses @${domain} in ${affectedCommits.size} commit(s); confirm whether it is intended for public history`);
}

if (findings.length) {
  for (const finding of [...new Set(findings)]) console.error(`HISTORY REVIEW REQUIRED: ${finding}`);
  console.error("History publication remains HOLD. A maintainer must choose clean snapshot, squash, or an approved rewrite and confirm the email policy.");
  console.error("Run a dedicated full-history secret scanner such as gitleaks or trufflehog before publication.");
  process.exitCode = 1;
} else {
  console.log(`History heuristic scan passed across ${commits.length} commit(s) and ${blobs.size} unique blob(s).`);
  console.log("A maintainer must still approve the publication mode and run a dedicated secret scanner before publication.");
}

function reviewEmail(commit, role, email, usage) {
  const domain = String(email || "").split("@").at(-1)?.toLowerCase() || "missing";
  if (["example.test", "users.noreply.github.com"].includes(domain)) return;
  const key = `${role}|${domain}`;
  if (!usage.has(key)) usage.set(key, new Set());
  usage.get(key).add(commit);
}

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${String(result.stderr || "").trim()}`);
  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
