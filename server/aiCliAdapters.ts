import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpError } from "./errors.js";
import { buildAIChatRuntimePrompt, buildConversationTranscript } from "./aiPromptPolicy.js";
import { readGuardedRepoFile } from "./pathGuard.js";
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
  signal?: AbortSignal;
};

type GitChangeSnapshot = {
  available: boolean;
  paths: AIChangedPath[];
};

type SelectedFileSnapshot = {
  path: string;
  content: string | null;
  hash: string;
  byteLength: number;
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

type WorkspaceFileFingerprint = {
  hash: string;
  byteLength: number;
};

type WorkspaceSnapshot = {
  files: Map<string, WorkspaceFileFingerprint>;
  complete: boolean;
  warnings: string[];
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
  signal?: AbortSignal;
};

export type AICommandResult = {
  stdout: string;
  stderr: string;
};

export type AICommandLaunch = {
  binary: string;
  args: string[];
};

export type AICommandResolutionOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  nodeExecutable?: string;
};

export type AIWorkspace = {
  repoId: string;
  root: string;
};

const CLI_TIMEOUT_MS = 120_000;
const CLI_MAX_BUFFER = 1024 * 1024;
const WINDOWS_CMD_SHIM_MAX_BYTES = 32 * 1024;
const TRUSTED_WINDOWS_CMD_PACKAGES: Readonly<Record<string, string>> = {
  codex: "/node_modules/@openai/codex/",
  claude: "/node_modules/@anthropic-ai/claude-code/",
};
const MAX_SELECTED_FILE_SNAPSHOTS = 5;
const MAX_SELECTED_FILE_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const WORKSPACE_SNAPSHOT_MAX_FILES = 10_000;
const WORKSPACE_SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024;
const WORKSPACE_SNAPSHOT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const WORKSPACE_SNAPSHOT_MAX_MS = 5_000;
const WORKSPACE_SNAPSHOT_SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "dist-server", "coverage"]);
const DUPLICATE_BLOCK_PREVIEW_CHARS = 72;
const WORK_ORDER_PREVIEW_ITEMS = 8;

export async function requestRepoWriteAIChatCompletion(request: RepoWriteChatRequest): Promise<{ content: string; status: AIConnectionStatus; run: AIChatRunSummary }> {
  const runner = request.runner || runAICommand;
  const workspace = await resolveAIWorkspace(request.repo);
  const before = await collectWorkspaceSnapshot(workspace.root);
  const selectedSnapshots = await collectSelectedFileSnapshots(request.repo, request.context);
  const prompt = buildRepoWritePrompt(request.context, request.messages, request.attachments || [], request.modelBehavior, selectedSnapshots.snapshots);
  const entry = targetEntry(request.target);
  const substrate = targetSubstrate(request.target);
  let resultText = "";
  let executionError: unknown;
  try {
    resultText = substrate === "codexCli"
      ? await runCodexChat(runner, request.target, workspace.root, prompt, request.signal)
      : await runClaudeChat(runner, workspace.root, prompt, request.signal);
  } catch (error) {
    executionError = error;
  }

  const after = await collectWorkspaceSnapshot(workspace.root).catch((): WorkspaceSnapshot => ({
    files: new Map(),
    complete: false,
    warnings: ["Repository change audit is unverified because the postflight workspace snapshot failed."],
  }));
  const selectedReview = await reviewSelectedFileSnapshots(request.repo, selectedSnapshots.snapshots);
  const changedPaths = mergeChangedPaths(diffWorkspaceSnapshots(before, after), selectedReview.changedPaths);
  const finalAnswer = sanitizeFinalAnswerText(sanitizeCliText(resultText).trim());
  const warnings = runWarnings(changedPaths, before, after, selectedSnapshots.warnings, selectedReview.warnings, finalAnswer.warnings);
  const run: AIChatRunSummary = {
    accessMode: "repoWrite",
    entry,
    substrate,
    auditState: before.complete && after.complete ? "verified" : "unverified",
    changedPaths,
    repairs: selectedReview.repairs,
    warnings,
  };
  if (executionError) {
    const httpError = executionError instanceof HttpError
      ? executionError
      : new HttpError(502, sanitizeCliText(executionError instanceof Error ? executionError.message : String(executionError)) || "CLI adapter failed.");
    const processTreeUnverified = Boolean(httpError.details && typeof httpError.details === "object" && (httpError.details as { processTreeUnverified?: unknown }).processTreeUnverified === true);
    throw new HttpError(httpError.status, httpError.message, { run, ...(processTreeUnverified ? { processTreeUnverified: true } : {}) });
  }
  if (!finalAnswer.content) throw new HttpError(502, "CLI adapter returned an empty response.", { run });
  return { content: finalAnswer.content, status: status("ready", "CLI response received."), run };
}

export async function runAICommand(binary: string, args: string[], options: AICommandOptions): Promise<AICommandResult> {
  if (options.signal?.aborted) throw new HttpError(499, "CLI request was canceled.");
  const launch = await resolveAICommandLaunch(binary, args, {
    env: options.env,
    cwd: options.cwd,
  });
  if (options.signal?.aborted) throw new HttpError(499, "CLI request was canceled.");
  return new Promise((resolve, reject) => {
    let terminationError: HttpError | null = null;
    let settled = false;
    let collectingOutput = true;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    const child = spawn(launch.binary, launch.args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const appendOutput = (target: "stdout" | "stderr", value: Buffer | string) => {
      if (!collectingOutput) return;
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = Math.max(0, options.maxBuffer - outputBytes);
      const retained = bytes.subarray(0, remaining).toString("utf8");
      outputBytes += Math.min(bytes.byteLength, remaining);
      if (target === "stdout") stdout += retained;
      else stderr += retained;
      if (bytes.byteLength > remaining) terminate(new HttpError(502, "CLI output exceeded the Reader-Wiki byte limit."));
    };
    const onStdout = (value: Buffer | string) => appendOutput("stdout", value);
    const onStderr = (value: Buffer | string) => appendOutput("stderr", value);
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
      if (settled || terminationError) return;
      terminate(new HttpError(502, error.code === "EPIPE" ? "CLI closed its input before the request was sent." : "CLI input failed."));
    });
    child.once("error", (error) => {
      if (!terminationError) finishReject(new HttpError(502, sanitizeCliText(error.message) || "CLI adapter failed."));
    });
    child.once("close", (code) => {
      if (terminationError || settled) return;
      const result = { stdout, stderr };
      if (code !== 0) {
        const output = sanitizeCliText([stdout, stderr, `CLI exited with code ${code ?? "unknown"}.`].filter(Boolean).join("\n"));
        finishReject(new HttpError(502, output || "CLI adapter failed."));
        return;
      }
      finishResolve(result);
    });
    const terminate = (error: HttpError) => {
      if (terminationError) return;
      terminationError = error;
      collectingOutput = false;
      child.stdout.removeListener("data", onStdout);
      child.stderr.removeListener("data", onStderr);
      child.stdout.resume();
      child.stderr.resume();
      void terminateChildTree(child).then(
        () => finishReject(error),
        () => finishReject(new HttpError(error.status, `${error.message} Process tree termination could not be verified.`, { processTreeUnverified: true })),
      );
    };
    const abort = () => terminate(new HttpError(499, "CLI request was canceled."));
    const timeout = setTimeout(() => terminate(new HttpError(504, "CLI request timed out.")), options.timeoutMs);
    const cleanup = () => {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    };
    const finishResolve = (result: AICommandResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const finishReject = (error: HttpError) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    try {
      child.stdin?.end(options.input);
    } catch {
      terminate(new HttpError(502, "CLI input failed."));
    }
  });
}

export async function resolveAICommandLaunch(binary: string, args: string[], options: AICommandResolutionOptions = {}): Promise<AICommandLaunch> {
  const platform = options.platform || process.platform;
  if (platform !== "win32") return { binary, args: [...args] };
  if (!binary || binary.includes("\0") || args.some((argument) => argument.includes("\0"))) {
    throw new HttpError(502, "CLI command contains an invalid null byte.");
  }

  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const candidates = windowsCommandCandidates(binary, env, cwd);
  const extension = path.extname(binary).toLowerCase();
  if (extension && extension !== ".exe" && extension !== ".com" && extension !== ".cmd" && extension !== ".bat") {
    throw new HttpError(502, "CLI command type is not supported without a shell on Windows.");
  }

  if (!extension || extension === ".exe" || extension === ".com") {
    const nativeExtensions = extension ? [""] : [".exe", ".com"];
    for (const nativeExtension of nativeExtensions) {
      for (const candidate of candidates) {
        const nativePath = `${candidate}${nativeExtension}`;
        if (await isRegularFile(nativePath)) return { binary: nativePath, args: [...args] };
      }
    }
    if (extension) throw new HttpError(502, "CLI executable could not be resolved without a shell on Windows.");
  }

  if (!extension || extension === ".cmd") {
    for (const candidate of candidates) {
      const shimPath = extension ? candidate : `${candidate}.cmd`;
      if (await isRegularFile(shimPath)) {
        return resolveTrustedWindowsCmdShim(shimPath, args, options.nodeExecutable || process.execPath);
      }
    }
  }

  if (extension === ".bat") {
    throw new HttpError(502, "Batch CLI shims are not supported without a shell on Windows.");
  }
  if (!extension) {
    for (const candidate of candidates) {
      if (await isRegularFile(`${candidate}.bat`)) {
        throw new HttpError(502, "Batch CLI shims are not supported without a shell on Windows.");
      }
    }
  }
  throw new HttpError(502, "CLI executable could not be resolved without a shell on Windows.");
}

function windowsCommandCandidates(binary: string, env: NodeJS.ProcessEnv, cwd: string): string[] {
  if (path.isAbsolute(binary) || binary.includes("/") || binary.includes("\\")) {
    return [path.isAbsolute(binary) ? binary : path.resolve(cwd, binary)];
  }
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] || "";
  return pathValue
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean)
    .map((directory) => path.join(directory, binary));
}

async function resolveTrustedWindowsCmdShim(shimPath: string, args: string[], nodeExecutable: string): Promise<AICommandLaunch> {
  const shimName = path.basename(shimPath, path.extname(shimPath)).toLowerCase();
  const packageMarker = TRUSTED_WINDOWS_CMD_PACKAGES[shimName];
  if (!packageMarker) throw unsupportedWindowsCmdShim();
  const shimStat = await stat(shimPath).catch(() => null);
  if (!shimStat?.isFile() || shimStat.size > WINDOWS_CMD_SHIM_MAX_BYTES) throw unsupportedWindowsCmdShim();
  const source = await readFile(shimPath, "utf8");
  if (source.includes("\0")) throw unsupportedWindowsCmdShim();

  const entries = new Set<string>();
  const invocation = /(?:^|[&|])\s*(?:"%_prog%"|"node(?:\.exe)?"|node(?:\.exe)?|"(?:%~dp0|%dp0%)[\\/]node\.exe")\s+"((?:%~dp0|%dp0%)[^"\r\n]*\.js)"\s+%\*\s*\)?\s*$/i;
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(invocation);
    if (!match?.[1]) continue;
    const entry = resolveWindowsShimEntry(shimPath, match[1]);
    if (entry) entries.add(entry);
  }
  if (entries.size !== 1) throw unsupportedWindowsCmdShim();

  const [entry] = entries;
  const normalizedEntry = entry.replace(/\\/g, "/").toLowerCase();
  if (!normalizedEntry.includes(packageMarker)) throw unsupportedWindowsCmdShim();
  const shimDirectory = path.dirname(shimPath);
  const trustedRoot = path.basename(shimDirectory).toLowerCase() === ".bin" ? path.dirname(shimDirectory) : shimDirectory;
  const relativeEntry = path.relative(trustedRoot, entry);
  if (!relativeEntry || path.isAbsolute(relativeEntry) || relativeEntry === ".." || relativeEntry.startsWith(`..${path.sep}`)) {
    throw unsupportedWindowsCmdShim();
  }
  if (!(await isRegularFile(entry))) throw unsupportedWindowsCmdShim();
  return { binary: nodeExecutable, args: [entry, ...args] };
}

function resolveWindowsShimEntry(shimPath: string, rawEntry: string): string | null {
  if (!/^(?:%~dp0|%dp0%)[\\/]/i.test(rawEntry)) return null;
  const marker = "__READER_WIKI_SHIM_DIRECTORY__";
  const portableEntry = rawEntry
    .replace(/^(?:%~dp0|%dp0%)/i, marker)
    .replace(/[\\/]+/g, path.sep)
    .replace(marker, `${path.dirname(shimPath)}${path.sep}`);
  if (portableEntry.includes("%") || portableEntry.includes("!") || portableEntry.includes("\0")) return null;
  return path.resolve(portableEntry);
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function unsupportedWindowsCmdShim(): HttpError {
  return new HttpError(502, "Unsupported Windows .cmd shim; only trusted npm or pnpm Node launchers are allowed.");
}

async function terminateChildTree(child: ChildProcess, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (!child.pid) return;
  if (platform === "win32") {
    if (!processExists(child.pid)) return;
    const deadline = Date.now() + 10_000;
    let treeKillConfirmed = false;
    while (processExists(child.pid) && Date.now() < deadline) {
      try {
        await runTaskkill(child.pid, true);
        treeKillConfirmed = true;
      } catch {
        // Retry while the original process is still present; the repo lock remains held.
      }
      if (processExists(child.pid)) await delay(100);
    }
    if (processExists(child.pid) || !treeKillConfirmed) {
      throw new Error("Windows process tree termination could not be verified.");
    }
    return;
  }
  signalPosixProcessGroup(child, "SIGTERM");
  const gracefulDeadline = Date.now() + 1_500;
  while (processGroupExists(child.pid) && Date.now() < gracefulDeadline) await delay(50);
  if (processGroupExists(child.pid)) signalPosixProcessGroup(child, "SIGKILL");
  while (processGroupExists(child.pid)) await delay(50);
}

function signalPosixProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function runTaskkill(pid: number, force: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const taskkill = spawn("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.once("error", reject);
    taskkill.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`taskkill exited with code ${code ?? "unknown"}.`));
    });
  });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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

export function safeCliEnv(entry: AIEntryKind, extra: NodeJS.ProcessEnv = {}, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowedKeys = [
    "HOME",
    "PATH",
    "LANG",
    "LC_ALL",
    "TERM",
    "TEMP",
    "TMP",
  ];
  if (platform === "win32") {
    allowedKeys.push("USERPROFILE", "APPDATA", "LOCALAPPDATA", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT");
  }
  for (const key of allowedKeys) {
    if (process.env[key]) env[key] = process.env[key];
  }
  if ((entry === "codexCli" || entry === "claudeCli") && process.env.CODEX_HOME) {
    env.CODEX_HOME = process.env.CODEX_HOME;
  }
  env.READER_WIKI_AI_CLI = "1";
  return { ...env, ...extra };
}

export async function collectGitChangedPaths(cwd: string): Promise<GitChangeSnapshot> {
  const result = await runLocalCommand("git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-C", cwd, "status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd).catch(() => null);
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

async function runCodexChat(runner: AICommandRunner, target: AIChatExecutionTarget, cwd: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const substrate = target.kind === "codexBackedProvider"
    ? await codexProviderSubstrate(target.provider)
    : target.kind === "codexBackedLocal"
      ? await codexLocalSubstrate(target.provider)
      : { args: [], env: safeCliEnv("codexCli"), cleanup: async () => undefined };
  try {
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
      signal,
    });
    return parseCxJsonl(result.stdout);
  } finally {
    await substrate.cleanup();
  }
}

async function runClaudeChat(runner: AICommandRunner, cwd: string, prompt: string, signal?: AbortSignal): Promise<string> {
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
    signal,
  });
  return parseClaudeJson(result.stdout);
}

export async function codexProviderSubstrate(provider: AIProviderSettings): Promise<{ args: string[]; env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const home = await ensureIsolatedCodexHome(provider.entry);
  try {
    const envKey = "READER_WIKI_AI_API_KEY";
    const profile = "reader-wiki-ai-api";
    const profileHandle = await open(path.join(home, `${profile}.config.toml`), "wx", 0o600);
    try {
      await profileHandle.writeFile(buildCodexProviderProfile(provider, envKey), "utf8");
    } finally {
      await profileHandle.close();
    }
    return {
      args: ["--profile", profile],
      env: safeCliEnv(provider.entry, { CODEX_HOME: home, [envKey]: provider.credential || "" }),
      cleanup: () => rm(home, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

export async function codexLocalSubstrate(provider: AIProviderSettings): Promise<{ args: string[]; env: NodeJS.ProcessEnv; cleanup: () => Promise<void> }> {
  const localProvider = provider.runtime === "lmStudio" ? "lmstudio" : provider.runtime === "ollama" ? "ollama" : "";
  if (!localProvider) throw new HttpError(400, "Local AI write mode supports Ollama and LM Studio through Codex CLI.");
  const home = await ensureIsolatedCodexHome(provider.entry);
  return {
    args: ["--oss", "--local-provider", localProvider, "--model", provider.model],
    env: safeCliEnv(provider.entry, { CODEX_HOME: home }),
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

async function ensureIsolatedCodexHome(entry: AIEntryKind): Promise<string> {
  const home = await mkdtemp(path.join(tmpdir(), `reader-wiki-codex-home-${entry}-`));
  await chmod(home, 0o700);
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

async function collectWorkspaceSnapshot(root: string): Promise<WorkspaceSnapshot> {
  const files = new Map<string, WorkspaceFileFingerprint>();
  const warnings: string[] = [];
  const startedAt = Date.now();
  let totalBytes = 0;
  let complete = true;
  let stop = false;

  const markIncomplete = (message: string) => {
    complete = false;
    warnings.push(message);
  };
  const visit = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
    if (stop) return;
    if (Date.now() - startedAt > WORKSPACE_SNAPSHOT_MAX_MS) {
      stop = true;
      markIncomplete(`Repository change audit is unverified: the ${WORKSPACE_SNAPSHOT_MAX_MS} ms scan limit was reached.`);
      return;
    }
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      markIncomplete(`Repository change audit is unverified for ${relativeDirectory || "."}: the directory could not be read.`);
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (stop) break;
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolutePath = path.join(absoluteDirectory, entry.name);
      if (entry.isSymbolicLink()) {
        markIncomplete(`Repository change audit skipped symbolic link ${relativePath}.`);
        continue;
      }
      if (entry.isDirectory()) {
        if (entry.name === ".git") continue;
        if (WORKSPACE_SNAPSHOT_SKIPPED_DIRECTORIES.has(entry.name)) {
          markIncomplete(`Repository change audit skipped generated directory ${relativePath}.`);
          continue;
        }
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        markIncomplete(`Repository change audit skipped non-regular path ${relativePath}.`);
        continue;
      }
      if (files.size >= WORKSPACE_SNAPSHOT_MAX_FILES) {
        stop = true;
        markIncomplete(`Repository change audit is unverified: the ${WORKSPACE_SNAPSHOT_MAX_FILES}-file limit was reached.`);
        break;
      }
      try {
        const fileStat = await stat(absolutePath);
        if (!fileStat.isFile()) {
          markIncomplete(`Repository change audit skipped non-regular path ${relativePath}.`);
          continue;
        }
        if (fileStat.size > WORKSPACE_SNAPSHOT_MAX_FILE_BYTES) {
          markIncomplete(`Repository change audit hash is unverified for ${relativePath}: the file exceeds ${WORKSPACE_SNAPSHOT_MAX_FILE_BYTES} bytes.`);
          files.set(relativePath, { hash: `unverified:${fileStat.size}:${fileStat.mtimeMs}`, byteLength: fileStat.size });
          continue;
        }
        if (totalBytes + fileStat.size > WORKSPACE_SNAPSHOT_MAX_BYTES) {
          stop = true;
          markIncomplete(`Repository change audit is unverified: the ${WORKSPACE_SNAPSHOT_MAX_BYTES}-byte scan limit was reached.`);
          break;
        }
        const bytes = await readFile(absolutePath);
        totalBytes += bytes.byteLength;
        files.set(relativePath, { hash: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.byteLength });
      } catch {
        markIncomplete(`Repository change audit is unverified for ${relativePath}: the file changed or could not be read during the scan.`);
      }
    }
  };

  await visit(root, "");
  return { files, complete, warnings: Array.from(new Set(warnings)) };
}

function diffWorkspaceSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): AIChangedPath[] {
  const changed = new Map<string, AIChangedPath>();
  for (const [relativePath, fingerprint] of before.files) {
    const next = after.files.get(relativePath);
    if (!next) changed.set(relativePath, { path: relativePath, status: "deleted" });
    else if (next.hash !== fingerprint.hash || next.byteLength !== fingerprint.byteLength) changed.set(relativePath, { path: relativePath, status: "changed" });
  }
  for (const relativePath of after.files.keys()) {
    if (!before.files.has(relativePath)) changed.set(relativePath, { path: relativePath, status: "new" });
  }
  return Array.from(changed.values()).sort((left, right) => left.path.localeCompare(right.path));
}

async function collectSelectedFileSnapshots(repo: RepositoryConfig, context: AIChatContext): Promise<SelectedFileSnapshotResult> {
  const snapshots: SelectedFileSnapshot[] = [];
  const warnings: string[] = [];
  for (const item of context.primaryItems) {
    if (item.kind !== "file") continue;
    if (snapshots.length >= MAX_SELECTED_FILE_SNAPSHOTS) {
      warnings.push(`Selected file audit unverified for ${item.path}: the ${MAX_SELECTED_FILE_SNAPSHOTS}-file snapshot limit was reached.`);
      continue;
    }
    const snapshot = await readSelectedFileSnapshot(repo, item.path);
    if (snapshot === null) {
      warnings.push(`Duplicate check unverified for ${item.path}: a complete disk snapshot could not be obtained.`);
      continue;
    }
    if (snapshot.content === null) {
      warnings.push(`Duplicate check unverified for ${item.path}: the file is binary or exceeds ${MAX_SELECTED_FILE_SNAPSHOT_BYTES} bytes; hash-only change auditing remains enabled.`);
    }
    snapshots.push(snapshot);
  }
  return { snapshots, warnings };
}

function buildRuntimeWorkOrder(snapshots: SelectedFileSnapshot[]): string {
  const lines = [
    "Reader-Wiki runtime work order:",
    "- Treat this as a bounded work order for the selected repository context; do not invent target paths.",
    "- Prefer updating an existing matching section or block over appending a new one.",
    "- Same heading or exact content block must appear once after the edit unless the user explicitly asks for duplicates.",
    "- Reader-Wiki will perform a deterministic selected-file postflight after your run and report exact duplicate blocks without rewriting the file.",
  ];
  if (!snapshots.length) {
    lines.push("- Selected primary file preflight: unavailable; rely on provided context and repo-scoped reads before editing.");
    return lines.join("\n");
  }
  lines.push("Selected primary file preflight:");
  for (const snapshot of snapshots) {
    lines.push(`- ${snapshot.path}: sha256=${snapshot.hash.slice(0, 16)}, ${snapshot.byteLength} bytes${snapshot.content === null ? ", full text unavailable" : `, ${lineCount(snapshot.content)} lines`}`);
    if (snapshot.content !== null) {
      lines.push(`  headings: ${formatWorkOrderList(extractHeadingTitles(snapshot.content))}`);
      lines.push(`  existing exact duplicate candidates: ${formatWorkOrderList(existingDuplicateCandidatePreviews(snapshot.content))}`);
    }
  }
  return lines.join("\n");
}

async function reviewSelectedFileSnapshots(repo: RepositoryConfig, snapshots: SelectedFileSnapshot[]): Promise<SelectedFileReview> {
  const changedPaths: AIChangedPath[] = [];
  const warnings: string[] = [];
  const repairs: string[] = [];
  for (const snapshot of snapshots) {
    const after = await readSelectedFileSnapshot(repo, snapshot.path);
    if (after === null) {
      changedPaths.push({ path: snapshot.path, status: "deleted" });
      warnings.push(`Duplicate check skipped for ${snapshot.path}: selected file was removed or could not be read after AI Chat.`);
      continue;
    }
    if (after.hash === snapshot.hash && after.byteLength === snapshot.byteLength) continue;
    changedPaths.push({ path: snapshot.path, status: "changed" });
    if (snapshot.content === null || after.content === null) {
      warnings.push(`Duplicate check unverified for ${snapshot.path}: full before/after text was unavailable; no postflight write was applied.`);
      continue;
    }
    const review = reviewDuplicatePostflight(snapshot.content, after.content, snapshot.path);
    if (review.repairedContent !== null) {
      warnings.push(...review.repairs.map((repair) => repair.replace(/^Repaired duplicate edit/, "Duplicate edit detected").replace(/: removed /, ": would remove ")));
      warnings.push(`Automatic duplicate repair is disabled for ${snapshot.path}; no postflight write was applied.`);
    }
    warnings.push(...review.warnings);
  }
  return { changedPaths, warnings, repairs };
}

async function readSelectedFileSnapshot(repo: RepositoryConfig, relativePath: string): Promise<SelectedFileSnapshot | null> {
  try {
    const buffer = (await readGuardedRepoFile(repo, relativePath, WORKSPACE_SNAPSHOT_MAX_FILE_BYTES)).bytes;
    return {
      path: relativePath,
      hash: createHash("sha256").update(buffer).digest("hex"),
      byteLength: buffer.byteLength,
      content: buffer.byteLength <= MAX_SELECTED_FILE_SNAPSHOT_BYTES && !buffer.includes(0) ? buffer.toString("utf8") : null,
    };
  } catch {
    return null;
  }
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

function runWarnings(changedPaths: AIChangedPath[], before: WorkspaceSnapshot, after: WorkspaceSnapshot, ...warningGroups: string[][]): string[] {
  const warnings = [...before.warnings, ...after.warnings, ...warningGroups.flat()];
  if (!changedPaths.length) {
    if (before.complete && after.complete) {
      warnings.push("No repository changes were detected.");
    } else {
      warnings.push("Repository changes are unverified because the bounded workspace audit was incomplete.");
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
