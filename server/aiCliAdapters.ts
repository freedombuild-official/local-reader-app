import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpError } from "./errors.js";
import { buildAIChatRuntimePrompt, buildConversationTranscript } from "./aiPromptPolicy.js";
import { resolveRepoPath } from "./pathGuard.js";
import type {
  AIChangedPath,
  AIChatAttachment,
  AIChatContext,
  AIChatExecutionTarget,
  AIChatMessage,
  AIChatRunSummary,
  AIConnectionStatus,
  AIEntryKind,
  AIModelBehavior,
  AIProviderSettings,
  GitStatus,
  RepositoryConfig,
} from "./types.js";

type RepoWriteChatRequest = {
  target: AIChatExecutionTarget;
  messages: AIChatMessage[];
  context: AIChatContext;
  repo: RepositoryConfig;
  attachments?: AIChatAttachment[];
  modelBehavior?: AIModelBehavior;
  runner?: AICommandRunner;
};

type GitChangeSnapshot = {
  available: boolean;
  paths: AIChangedPath[];
};

type SelectedFileSnapshot = {
  path: string;
  content: string;
};

type SelectedFileSnapshotResult = {
  snapshots: SelectedFileSnapshot[];
  warnings: string[];
};

type SelectedFileReview = {
  changedPaths: AIChangedPath[];
  warnings: string[];
  repairs: string[];
};

type FinalAnswerReview = {
  content: string;
  warnings: string[];
};

type DuplicateBlockOccurrence = {
  block: string;
  startLine: number;
  endLine: number;
};

type DuplicateBlockGroup = {
  block: string;
  beforeCount: number;
  afterOccurrences: DuplicateBlockOccurrence[];
};

type DuplicateRepairRange = {
  startLine: number;
  endLine: number;
  block: string;
};

type DuplicatePostflightReview = {
  repairedContent: string | null;
  warnings: string[];
  repairs: string[];
};

export type AICommandRunner = (binary: string, args: string[], options: AICommandOptions) => Promise<AICommandResult>;

export type AICommandOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  input?: string;
  timeoutMs: number;
  maxBuffer: number;
};

export type AICommandResult = {
  stdout: string;
  stderr: string;
};

export type AIWorkspace = {
  repoId: string;
  root: string;
};

const CLI_TIMEOUT_MS = 120_000;
const CLI_MAX_BUFFER = 1024 * 1024;
const MAX_SELECTED_FILE_SNAPSHOTS = 5;
const DUPLICATE_BLOCK_PREVIEW_CHARS = 72;
const WORK_ORDER_PREVIEW_ITEMS = 8;

export async function requestRepoWriteAIChatCompletion(request: RepoWriteChatRequest): Promise<{ content: string; status: AIConnectionStatus; run: AIChatRunSummary }> {
  const runner = request.runner || runAICommand;
  const workspace = await resolveAIWorkspace(request.repo);
  const before = await collectGitChangedPaths(workspace.root);
  const selectedSnapshots = collectSelectedFileSnapshots(request.context);
  const prompt = buildRepoWritePrompt(request.context, request.messages, request.attachments || [], request.modelBehavior, selectedSnapshots.snapshots);
  const entry = targetEntry(request.target);
  const substrate = targetSubstrate(request.target);
  try {
    const result = substrate === "codexCli"
      ? await runCodexChat(runner, request.target, workspace.root, prompt)
      : await runClaudeChat(runner, workspace.root, prompt);
    const finalAnswer = sanitizeFinalAnswerText(sanitizeCliText(result).trim());
    if (!finalAnswer.content) throw new HttpError(502, "CLI adapter returned an empty response.");
    const after = await collectGitChangedPaths(workspace.root);
    const selectedReview = await reviewSelectedFileSnapshots(request.repo, selectedSnapshots.snapshots);
    const changedPaths = mergeChangedPaths(diffChangedPaths(before.paths, after.paths), selectedReview.changedPaths);
    const warnings = runWarnings(changedPaths, before, after, selectedSnapshots.warnings, selectedReview.warnings, finalAnswer.warnings);
    return {
      content: finalAnswer.content,
      status: status("ready", "CLI response received."),
      run: {
        accessMode: "repoWrite",
        entry,
        substrate,
        changedPaths,
        repairs: selectedReview.repairs,
        warnings,
      },
    };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new HttpError(502, sanitizeCliText(message) || "CLI adapter failed.");
  }
}

export function runAICommand(binary: string, args: string[], options: AICommandOptions): Promise<AICommandResult> {
  return new Promise((resolve, reject) => {
    const child = execFile(binary, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
    }, (error, stdout, stderr) => {
      const result = { stdout: String(stdout || ""), stderr: String(stderr || "") };
      if (error) {
        const output = sanitizeCliText([result.stdout, result.stderr, error.message].filter(Boolean).join("\n"));
        reject(new HttpError(502, output || "CLI adapter failed."));
        return;
      }
      resolve(result);
    });
    if (options.input) {
      child.stdin?.end(options.input);
    }
  });
}

export async function ensureSafeCwd(): Promise<string> {
  const cwd = path.join(tmpdir(), "reader-wiki-ai-cli-cwd");
  await mkdir(cwd, { recursive: true });
  return cwd;
}

export async function resolveAIWorkspace(repo: RepositoryConfig): Promise<AIWorkspace> {
  const root = await realpath(repo.root);
  return { repoId: repo.id, root };
}

export function safeCliEnv(entry: AIEntryKind, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of [
    "HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "TERM",
  ]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if ((entry === "codexCli" || entry === "claudeCli") && process.env.CODEX_HOME) {
    env.CODEX_HOME = process.env.CODEX_HOME;
  }
  env.READER_WIKI_AI_CLI = "1";
  return { ...env, ...extra };
}

export async function collectGitChangedPaths(cwd: string): Promise<GitChangeSnapshot> {
  const result = await runLocalCommand("git", ["-C", cwd, "status", "--porcelain=v1", "-z"], cwd).catch(() => null);
  if (!result) return { available: false, paths: [] };
  const tokens = result.stdout.split("\0").filter(Boolean);
  const paths: AIChangedPath[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] || "";
    const statusText = token.slice(0, 2);
    const rawPath = token.slice(3);
    if (!rawPath) continue;
    if (statusText.includes("R") || statusText.includes("C")) index += 1;
    paths.push({ path: normalizeGitPath(rawPath), status: gitStatus(statusText) });
  }
  return { available: true, paths };
}

function buildRepoWritePrompt(context: AIChatContext, messages: AIChatMessage[], attachments: AIChatAttachment[], modelBehavior: AIModelBehavior | undefined, snapshots: SelectedFileSnapshot[]): string {
  const runtime = buildAIChatRuntimePrompt(context, attachments, modelBehavior);
  const transcript = buildConversationTranscript(messages);
  return [
    runtime.systemPrompt,
    runtime.contextPrompt,
    buildRuntimeWorkOrder(snapshots),
    transcript ? `Conversation:\n${transcript}` : "Conversation: [no prior messages]",
    [
      "Reader-Wiki execution policy:",
      "- You may edit files only inside the active repository root.",
      "- Do not write outside the repository root, follow symlinks outside it, edit .git internals, or perform Git commit/push/pull/fetch/checkout/merge/reset/rebase/tag/branch operations.",
      "- Before writing, check whether the requested section, marker, paragraph, list block, or equivalent content already exists.",
      "- Use the selected primary file preflight below as the source of truth for idempotency; append only if the requested block is missing.",
      "- After writing, re-read each changed file and verify that the exact same content block was not inserted more than once.",
      "- If duplicate content was inserted, remove the duplicate before your final answer, or report that duplicate content was detected if you cannot safely remove it.",
      "- Do not include tool-call markup, JSON tool calls, hidden channel tokens, or raw CLI protocol text in your final answer.",
      "- Report changed repository-relative paths in your final answer.",
      "- Never reveal local absolute filesystem paths.",
    ].join("\n"),
  ].filter(Boolean).join("\n\n");
}

async function runCodexChat(runner: AICommandRunner, target: AIChatExecutionTarget, cwd: string, prompt: string): Promise<string> {
  const substrate = target.kind === "codexBackedProvider" ? await codexProviderSubstrate(target.provider) : target.kind === "codexBackedLocal" ? await codexLocalSubstrate(target.provider) : { args: [], env: safeCliEnv("codexCli") };
  const result = await runner("codex", [
    "exec",
    ...substrate.args,
    "--sandbox",
    "workspace-write",
    "-c",
    "approval_policy=\"never\"",
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "-C",
    cwd,
    "-",
  ], {
    cwd,
    env: substrate.env,
    input: prompt,
    timeoutMs: CLI_TIMEOUT_MS,
    maxBuffer: CLI_MAX_BUFFER,
  });
  return parseCxJsonl(result.stdout);
}

async function runClaudeChat(runner: AICommandRunner, cwd: string, prompt: string): Promise<string> {
  const result = await runner("claude", [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--safe-mode",
    "--no-chrome",
    "--disable-slash-commands",
    "--strict-mcp-config",
    "--mcp-config",
    "{\"mcpServers\":{}}",
    "--tools",
    "Read,Edit,Write",
    "--disallowedTools",
    "Bash",
    "--permission-mode",
    "acceptEdits",
    "--max-budget-usd",
    "0.25",
  ], {
    cwd,
    env: safeCliEnv("claudeCli"),
    input: prompt,
    timeoutMs: CLI_TIMEOUT_MS,
    maxBuffer: CLI_MAX_BUFFER,
  });
  return parseClaudeJson(result.stdout);
}

export async function codexProviderSubstrate(provider: AIProviderSettings): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  const home = await ensureIsolatedCodexHome(provider.entry);
  const envKey = "READER_WIKI_AI_API_KEY";
  const profile = "reader-wiki-ai-api";
  await writeFile(path.join(home, `${profile}.config.toml`), buildCodexProviderProfile(provider, envKey), "utf8");
  return {
    args: ["--profile", profile],
    env: safeCliEnv(provider.entry, { CODEX_HOME: home, [envKey]: provider.credential || "" }),
  };
}

export async function codexLocalSubstrate(provider: AIProviderSettings): Promise<{ args: string[]; env: NodeJS.ProcessEnv }> {
  const localProvider = provider.runtime === "lmStudio" ? "lmstudio" : provider.runtime === "ollama" ? "ollama" : "";
  if (!localProvider) throw new HttpError(400, "Local AI write mode supports Ollama and LM Studio through Codex CLI.");
  const home = await ensureIsolatedCodexHome(provider.entry);
  return {
    args: ["--oss", "--local-provider", localProvider, "--model", provider.model],
    env: safeCliEnv(provider.entry, { CODEX_HOME: home }),
  };
}

async function ensureIsolatedCodexHome(entry: AIEntryKind): Promise<string> {
  const home = path.join(tmpdir(), "reader-wiki-codex-home", entry);
  await mkdir(home, { recursive: true });
  return home;
}

function buildCodexProviderProfile(provider: AIProviderSettings, envKey: string): string {
  const baseUrl = (provider.baseUrl || "").trim().replace(/\/+$/, "");
  const wireApi = provider.apiFormat === "openaiCompatible" || provider.provider === "openaiCompatible" || provider.provider === "openai" ? "chat" : "chat";
  return [
    `model = ${tomlString(provider.model)}`,
    "model_provider = \"reader_wiki_ai_api\"",
    "",
    "[model_providers.reader_wiki_ai_api]",
    "name = \"Reader-Wiki AI API\"",
    `base_url = ${tomlString(baseUrl)}`,
    `env_key = ${tomlString(envKey)}`,
    `wire_api = ${tomlString(wireApi)}`,
    "",
  ].join("\n");
}

function parseCxJsonl(stdout: string): string {
  let last = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        last = event.item.text;
      }
    } catch {
      if (!last) last = line;
    }
  }
  return last || stdout;
}

function parseClaudeJson(stdout: string): string {
  const data = JSON.parse(stdout || "{}") as { is_error?: boolean; result?: string };
  if (data.is_error) throw new HttpError(502, sanitizeCliText(data.result || "Claude Code CLI request failed."));
  return data.result || "";
}

function diffChangedPaths(before: AIChangedPath[], after: AIChangedPath[]): AIChangedPath[] {
  const beforeMap = new Map(before.map((item) => [item.path, item.status]));
  return after.filter((item) => beforeMap.get(item.path) !== item.status || !beforeMap.has(item.path));
}

function collectSelectedFileSnapshots(context: AIChatContext): SelectedFileSnapshotResult {
  const snapshots: SelectedFileSnapshot[] = [];
  const warnings: string[] = [];
  for (const item of context.primaryItems) {
    if (snapshots.length >= MAX_SELECTED_FILE_SNAPSHOTS) break;
    if (item.kind !== "file") continue;
    if (!item.contentIncluded) {
      warnings.push(`Duplicate check skipped for ${item.path}: selected file content was not included.`);
      continue;
    }
    snapshots.push({ path: item.path, content: item.content });
  }
  return { snapshots, warnings };
}

function buildRuntimeWorkOrder(snapshots: SelectedFileSnapshot[]): string {
  const lines = [
    "Reader-Wiki runtime work order:",
    "- Treat this as a bounded work order for the selected repository context; do not invent target paths.",
    "- Prefer updating an existing matching section or block over appending a new one.",
    "- Same heading or exact content block must appear once after the edit unless the user explicitly asks for duplicates.",
    "- Reader-Wiki will perform a deterministic selected-file postflight after your run and may repair exact duplicate blocks created by this run.",
  ];
  if (!snapshots.length) {
    lines.push("- Selected primary file preflight: unavailable; rely on provided context and repo-scoped reads before editing.");
    return lines.join("\n");
  }
  lines.push("Selected primary file preflight:");
  for (const snapshot of snapshots) {
    lines.push(`- ${snapshot.path}: sha256=${hashContent(snapshot.content).slice(0, 16)}, ${lineCount(snapshot.content)} lines`);
    lines.push(`  headings: ${formatWorkOrderList(extractHeadingTitles(snapshot.content))}`);
    lines.push(`  existing exact duplicate candidates: ${formatWorkOrderList(existingDuplicateCandidatePreviews(snapshot.content))}`);
  }
  return lines.join("\n");
}

async function reviewSelectedFileSnapshots(repo: RepositoryConfig, snapshots: SelectedFileSnapshot[]): Promise<SelectedFileReview> {
  const changedPaths: AIChangedPath[] = [];
  const warnings: string[] = [];
  const repairs: string[] = [];
  for (const snapshot of snapshots) {
    const after = await readSelectedFileContent(repo, snapshot.path);
    if (after === null) {
      changedPaths.push({ path: snapshot.path, status: "deleted" });
      warnings.push(`Duplicate check skipped for ${snapshot.path}: selected file was removed or could not be read after AI Chat.`);
      continue;
    }
    if (after === snapshot.content) continue;
    let finalContent = after;
    const review = reviewDuplicatePostflight(snapshot.content, after, snapshot.path);
    if (review.repairedContent !== null) {
      try {
        await writeSelectedFileContent(repo, snapshot.path, review.repairedContent);
        finalContent = review.repairedContent;
        repairs.push(...review.repairs);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warnings.push(`Duplicate repair skipped for ${snapshot.path}: ${sanitizeCliText(message) || "selected file could not be written"}.`);
      }
    }
    if (finalContent !== snapshot.content) changedPaths.push({ path: snapshot.path, status: "changed" });
    warnings.push(...review.warnings);
  }
  return { changedPaths, warnings, repairs };
}

async function readSelectedFileContent(repo: RepositoryConfig, relativePath: string): Promise<string | null> {
  try {
    const resolved = await resolveRepoPath(repo, relativePath);
    const buffer = await readFile(resolved.realPath);
    if (buffer.includes(0)) return null;
    return buffer.toString("utf8");
  } catch {
    return null;
  }
}

async function writeSelectedFileContent(repo: RepositoryConfig, relativePath: string, content: string): Promise<void> {
  const resolved = await resolveRepoPath(repo, relativePath);
  await writeFile(resolved.realPath, content, "utf8");
}

function reviewDuplicatePostflight(before: string, after: string, relativePath: string): DuplicatePostflightReview {
  const groups = detectNewDuplicateBlockGroups(before, after).sort((a, b) => b.block.length - a.block.length);
  const selectedRanges: DuplicateRepairRange[] = [];
  const warnings: string[] = [];
  const repairs: string[] = [];
  for (const group of groups) {
    const duplicateOccurrences = group.afterOccurrences.slice(1);
    if (!duplicateOccurrences.length) continue;
    if (duplicateOccurrences.every((occurrence) => selectedRanges.some((range) => rangesOverlap(range, occurrence)))) continue;
    const preview = previewDuplicateBlock(group.block);
    if (group.beforeCount > 1) {
      warnings.push(`Duplicate edit detected in ${relativePath}: repeated block "${preview}"; automatic repair skipped because the duplicate already existed before this run.`);
      continue;
    }
    const candidateRanges = duplicateOccurrences.map((occurrence) => ({ startLine: occurrence.startLine, endLine: occurrence.endLine, block: group.block }));
    if (!rangesAreNonOverlapping(candidateRanges) || candidateRanges.some((range) => selectedRanges.some((selected) => rangesOverlap(selected, range)))) {
      warnings.push(`Duplicate edit detected in ${relativePath}: repeated block "${preview}"; automatic repair skipped because duplicate ranges overlap.`);
      continue;
    }
    selectedRanges.push(...candidateRanges);
    repairs.push(`Repaired duplicate edit in ${relativePath}: removed ${candidateRanges.length} repeated block${candidateRanges.length === 1 ? "" : "s"} "${preview}".`);
  }
  if (!selectedRanges.length) return { repairedContent: null, warnings, repairs };
  const repairedContent = removeLineRanges(after, selectedRanges);
  for (const duplicate of detectNewDuplicateBlocks(before, repairedContent)) {
    warnings.push(`Duplicate edit detected in ${relativePath}: repeated block "${previewDuplicateBlock(duplicate)}".`);
  }
  return { repairedContent, warnings, repairs };
}

function detectNewDuplicateBlocks(before: string, after: string): string[] {
  return detectNewDuplicateBlockGroups(before, after).map((group) => group.block);
}

function detectNewDuplicateBlockGroups(before: string, after: string): DuplicateBlockGroup[] {
  const beforeOccurrences = groupBlockOccurrences(extractDuplicateCandidateOccurrences(before));
  const afterOccurrences = groupBlockOccurrences(extractDuplicateCandidateOccurrences(after));
  const groups: DuplicateBlockGroup[] = [];
  for (const [block, occurrences] of afterOccurrences) {
    const beforeCount = beforeOccurrences.get(block)?.length || 0;
    if (occurrences.length > beforeCount && occurrences.length > 1) {
      groups.push({ block, beforeCount, afterOccurrences: occurrences.sort((a, b) => a.startLine - b.startLine) });
    }
  }
  return groups;
}

function countBlocks(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const block of extractDuplicateCandidateBlocks(text)) {
    counts.set(block, (counts.get(block) || 0) + 1);
  }
  return counts;
}

function groupBlockOccurrences(occurrences: DuplicateBlockOccurrence[]): Map<string, DuplicateBlockOccurrence[]> {
  const groups = new Map<string, DuplicateBlockOccurrence[]>();
  for (const occurrence of occurrences) {
    const next = groups.get(occurrence.block) || [];
    next.push(occurrence);
    groups.set(occurrence.block, next);
  }
  return groups;
}

function extractDuplicateCandidateBlocks(text: string): string[] {
  return extractDuplicateCandidateOccurrences(text).map((occurrence) => occurrence.block);
}

function extractDuplicateCandidateOccurrences(text: string): DuplicateBlockOccurrence[] {
  const { lines } = splitTextLines(text);
  if (!lines.some((line) => line.trim())) return [];
  const occurrences: DuplicateBlockOccurrence[] = [];
  const seen = new Set<string>();
  for (const occurrence of extractHeadingSectionOccurrences(lines)) addDuplicateCandidateOccurrence(occurrences, seen, occurrence);
  for (const occurrence of extractParagraphBlockOccurrences(lines)) addDuplicateCandidateOccurrence(occurrences, seen, occurrence);
  return occurrences;
}

function extractHeadingSectionOccurrences(lines: string[]): DuplicateBlockOccurrence[] {
  const sections: DuplicateBlockOccurrence[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(#{1,6})\s+\S/.exec(lines[index] || "");
    if (!match) continue;
    const level = match[1].length;
    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      const nextMatch = /^(#{1,6})\s+\S/.exec(lines[next] || "");
      if (nextMatch && nextMatch[1].length <= level) {
        end = next;
        break;
      }
    }
    const occurrence = occurrenceFromLineRange(lines, index, end);
    if (occurrence && occurrence.endLine > occurrence.startLine) sections.push(occurrence);
  }
  return sections;
}

function extractParagraphBlockOccurrences(lines: string[]): DuplicateBlockOccurrence[] {
  const blocks: DuplicateBlockOccurrence[] = [];
  let index = 0;
  while (index < lines.length) {
    while (index < lines.length && !lines[index].trim()) index += 1;
    const start = index;
    while (index < lines.length && lines[index].trim()) index += 1;
    const occurrence = occurrenceFromLineRange(lines, start, index);
    if (occurrence) blocks.push(occurrence);
  }
  return blocks;
}

function occurrenceFromLineRange(lines: string[], startLine: number, endExclusive: number): DuplicateBlockOccurrence | null {
  let start = startLine;
  let end = endExclusive - 1;
  while (start <= end && !lines[start].trim()) start += 1;
  while (end >= start && !lines[end].trim()) end -= 1;
  if (end < start) return null;
  const block = lines.slice(start, end + 1).join("\n").trim();
  if (block.length < 20) return null;
  return { block, startLine: start, endLine: end };
}

function addDuplicateCandidateOccurrence(occurrences: DuplicateBlockOccurrence[], seen: Set<string>, occurrence: DuplicateBlockOccurrence | null): void {
  if (!occurrence) return;
  const key = `${occurrence.startLine}:${occurrence.endLine}:${occurrence.block}`;
  if (seen.has(key)) return;
  seen.add(key);
  occurrences.push(occurrence);
}

function previewDuplicateBlock(block: string): string {
  const preview = block.replace(/\s+/g, " ").trim();
  return preview.length > DUPLICATE_BLOCK_PREVIEW_CHARS ? `${preview.slice(0, DUPLICATE_BLOCK_PREVIEW_CHARS - 1)}...` : preview;
}

function removeLineRanges(text: string, ranges: DuplicateRepairRange[]): string {
  const { lines, lineEnding, finalNewline } = splitTextLines(text);
  const nextLines = [...lines];
  const sortedRanges = [...ranges].sort((a, b) => b.startLine - a.startLine);
  for (const range of sortedRanges) {
    nextLines.splice(range.startLine, range.endLine - range.startLine + 1);
  }
  return joinTextLines(nextLines, lineEnding, finalNewline);
}

function splitTextLines(text: string): { lines: string[]; lineEnding: "\n" | "\r\n"; finalNewline: boolean } {
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const normalized = text.replace(/\r\n/g, "\n");
  const finalNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (finalNewline) lines.pop();
  return { lines, lineEnding, finalNewline };
}

function joinTextLines(lines: string[], lineEnding: "\n" | "\r\n", finalNewline: boolean): string {
  return `${lines.join(lineEnding)}${finalNewline ? lineEnding : ""}`;
}

function rangesAreNonOverlapping(ranges: Array<{ startLine: number; endLine: number }>): boolean {
  return ranges.every((range, index) => ranges.every((other, otherIndex) => index === otherIndex || !rangesOverlap(range, other)));
}

function rangesOverlap(first: { startLine: number; endLine: number }, second: { startLine: number; endLine: number }): boolean {
  return first.startLine <= second.endLine && second.startLine <= first.endLine;
}

function sanitizeFinalAnswerText(content: string): FinalAnswerReview {
  const warnings: string[] = [];
  const leakPattern = /<\|(?:channel|message|constrain)\|>|functions\.exec_command|functions\.[A-Za-z0-9_]+\s*<\|/;
  if (!leakPattern.test(content)) return { content, warnings };
  const tokenIndex = content.search(/<\|(?:channel|message|constrain)\|>|functions\.exec_command|functions\.[A-Za-z0-9_]+\s*<\|/);
  const sanitized = sanitizeCliText(content.slice(0, tokenIndex >= 0 ? tokenIndex : 0)).trim();
  warnings.push("AI Chat final answer contained tool-call markup; Reader-Wiki removed it before display.");
  return { content: sanitized || "AI Chat completed. Tool-call markup was removed from the final answer.", warnings };
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function lineCount(content: string): number {
  if (!content) return 0;
  return content.split(/\r?\n/).length;
}

function extractHeadingTitles(content: string): string[] {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => /^(#{1,6})\s+(.+)$/.exec(line)?.[2]?.trim() || "")
    .filter(Boolean)
    .slice(0, WORK_ORDER_PREVIEW_ITEMS);
}

function existingDuplicateCandidatePreviews(content: string): string[] {
  const counts = countBlocks(content);
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([block]) => previewDuplicateBlock(block))
    .slice(0, WORK_ORDER_PREVIEW_ITEMS);
}

function formatWorkOrderList(items: string[]): string {
  return items.length ? items.join(" | ") : "none";
}

function mergeChangedPaths(primary: AIChangedPath[], secondary: AIChangedPath[]): AIChangedPath[] {
  const merged = new Map<string, AIChangedPath>();
  for (const item of [...primary, ...secondary]) merged.set(item.path, item);
  return Array.from(merged.values());
}

function runWarnings(changedPaths: AIChangedPath[], before: GitChangeSnapshot, after: GitChangeSnapshot, ...warningGroups: string[][]): string[] {
  const warnings = warningGroups.flat();
  if (!changedPaths.length) {
    if (before.available && after.available) {
      warnings.push("No repository changes were detected.");
    } else {
      warnings.push("No selected file changes were detected; Git changed path summary is unavailable.");
    }
  }
  return Array.from(new Set(warnings));
}

function gitStatus(statusText: string): GitStatus {
  if (statusText.includes("D")) return "deleted";
  if (statusText.includes("?")) return "new";
  if (statusText.includes("A")) return "new";
  return "changed";
}

function normalizeGitPath(rawPath: string): string {
  return rawPath.replace(/^.* -> /, "").replace(/\\/g, "/");
}

function targetEntry(target: AIChatExecutionTarget): AIEntryKind {
  if (target.kind === "codexCli" || target.kind === "claudeCli") return target.entry;
  return target.provider.entry;
}

function targetSubstrate(target: AIChatExecutionTarget): "codexCli" | "claudeCli" {
  return target.kind === "claudeCli" ? "claudeCli" : "codexCli";
}

function runLocalCommand(binary: string, args: string[], cwd: string): Promise<AICommandResult> {
  return runAICommand(binary, args, {
    cwd,
    env: safeCliEnv("codexCli"),
    timeoutMs: 30_000,
    maxBuffer: 256 * 1024,
  });
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

export function sanitizeCliText(value: string): string {
  return value
    .replace(new RegExp(`"${["sess", "ion_id"].join("")}"\\s*:\\s*"[^"]*"`, "g"), `"${["sess", "ion_id"].join("")}":"[redacted]"`)
    .replace(/"uuid"\s*:\s*"[^"]*"/g, "\"uuid\":\"[redacted]\"")
    .replace(/Command failed: (codex|claude)[^\n]*/g, "Command failed: CLI invocation")
    .replace(new RegExp(["in-process app", "server client"].join("-"), "g"), "CLI runtime client")
    .replace(/\/var\/folders\/[^\s]+/g, "[local-temp]")
    .replace(/\/private\/tmp\/[^\s]+/g, "[local-temp]")
    .replace(/\/Users\/[^/\s]+/g, "[local-home]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/(READER_WIKI_AI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|CODEX_API_KEY)=\S+/g, "$1=[redacted]")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .slice(0, 12000);
}

function status(state: AIConnectionStatus["state"], message: string): AIConnectionStatus {
  return {
    state,
    code: state === "ready" ? "success" : "provider_http_error",
    severity: state === "ready" ? "success" : "error",
    message,
    nextAction: state === "ready" ? "Continue the conversation or check readiness again if CLI settings change." : "Check CLI readiness before trying again.",
    checkedAt: new Date().toISOString(),
  };
}
