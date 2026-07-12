import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildAIChatRuntimePrompt, buildConversationTranscript } from "./aiPromptPolicy.js";
import { HttpError } from "./errors.js";
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

export type CodexMcpDisableSpec = {
  name: string;
  transport: "stdio" | "http";
};

const CLI_TIMEOUT_MS = 120_000;
const CLI_MAX_BUFFER = 1024 * 1024;
const WINDOWS_CMD_SHIM_MAX_BYTES = 32 * 1024;
const TRUSTED_WINDOWS_CMD_PACKAGES: Readonly<Record<string, string>> = {
  codex: "/node_modules/@openai/codex/",
  claude: "/node_modules/@anthropic-ai/claude-code/",
};
const WORKSPACE_SNAPSHOT_MAX_FILES = 10_000;
const WORKSPACE_SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024;
const WORKSPACE_SNAPSHOT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const WORKSPACE_SNAPSHOT_MAX_MS = 5_000;
const WORKSPACE_SNAPSHOT_SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "dist", "dist-server", "coverage"]);
const CLAUDE_SECRET_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"] as const;
const CLAUDE_AUTH_ENV_KEYS = [...CLAUDE_SECRET_ENV_KEYS, "CLAUDE_CONFIG_DIR"] as const;
const CLAUDE_CURRENT_REPO_TOOLS = "Bash,Glob,Grep,Read,Edit,Write";
const CODEX_CURRENT_REPO_PERMISSION_FILESYSTEM = '{":minimal"="read",":workspace_roots"={"."="write",".git"="read",".git/**"="read",".codex"="read",".codex/**"="read",".agents"="read",".agents/**"="read"}}';
const CODEX_DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "computer_use",
  "hooks",
  "image_generation",
  "in_app_browser",
  "multi_agent",
  "plugins",
  "remote_plugin",
] as const;

export async function requestRepoWriteAIChatCompletion(request: RepoWriteChatRequest): Promise<{ content: string; status: AIConnectionStatus; run: AIChatRunSummary }> {
  if (request.target.kind !== "codexCli" && request.target.kind !== "claudeCli") {
    throw new HttpError(500, "Provider Current repo write must use the Local Reader App server edit protocol and cannot be routed through a CLI adapter.");
  }
  const runner = request.runner || runAICommand;
  const workspace = await resolveAIWorkspace(request.repo);
  const before = await collectWorkspaceSnapshot(workspace.root);
  const prompt = buildRepoWritePrompt(request.context, request.messages, request.attachments || [], request.modelBehavior);
  const entry = request.target.entry;
  const substrate = request.target.kind;
  let resultText = "";
  let executionError: unknown;
  try {
    resultText = substrate === "codexCli"
      ? await runCodexChat(runner, workspace.root, prompt, request.signal)
      : await runClaudeChat(runner, workspace.root, prompt, request.signal);
  } catch (error) {
    executionError = error;
  }

  const after = await collectWorkspaceSnapshot(workspace.root).catch((): WorkspaceSnapshot => ({
    files: new Map(),
    complete: false,
    warnings: ["Repository change audit is unverified because the postflight workspace snapshot failed."],
  }));
  const changedPaths = diffWorkspaceSnapshots(before, after);
  const finalAnswer = sanitizeFinalAnswerText(sanitizeCliText(resultText).trim());
  const warnings = runWarnings(changedPaths, before, after, finalAnswer.warnings);
  const run: AIChatRunSummary = {
    accessMode: "repoWrite",
    entry,
    substrate,
    auditState: before.complete && after.complete ? "verified" : "unverified",
    changedPaths,
    repairs: [],
    warnings,
  };
  if (executionError) {
    const httpError = userFacingCliError(entry, executionError);
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
      if (bytes.byteLength > remaining) terminate(new HttpError(502, "The CLI returned more information than Local Reader App can display safely. Ask for a smaller result and try again."));
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
      if (!terminationError) finishReject(new HttpError(502, userFacingCliFailure(binary, error)));
    });
    child.once("close", (code) => {
      if (terminationError || settled) return;
      const result = { stdout, stderr };
      if (code !== 0) {
        finishReject(new HttpError(502, userFacingCliFailure(binary, [stdout, stderr].filter(Boolean).join("\n"))));
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
        () => finishReject(new HttpError(error.status, "Local Reader App could not confirm that the CLI process stopped. Close the CLI, review the Current repo, restart the Local Reader App server, and reload the page before trying again.", { processTreeUnverified: true })),
      );
    };
    const abort = () => terminate(new HttpError(499, "CLI request was canceled."));
    const timeout = setTimeout(() => terminate(new HttpError(504, "The CLI did not finish before the time limit. Try a smaller request or try again.")), options.timeoutMs);
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

export function codexCurrentRepoArgs(profileName = `reader_wiki_${randomUUID().replaceAll("-", "")}`, disabledMcpServers: readonly CodexMcpDisableSpec[] = []): string[] {
  if (!/^reader_wiki_[a-z0-9_]+$/.test(profileName)) throw new HttpError(500, "Codex Current repo permission profile name is invalid.");
  const args = [
    "--strict-config",
    "--ignore-user-config",
    "-c",
    "approval_policy=\"never\"",
    "-c",
    `default_permissions="${profileName}"`,
    "-c",
    `permissions.${profileName}.filesystem=${CODEX_CURRENT_REPO_PERMISSION_FILESYSTEM}`,
    "-c",
    `permissions.${profileName}.network.enabled=false`,
    "-c",
    "web_search=\"disabled\"",
  ];
  for (const { name, transport } of disabledMcpServers) {
    if (!name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new HttpError(502, "Codex MCP isolation preflight returned an invalid server name.");
    }
    const disabledTransport = transport === "stdio"
      ? '{enabled=false,command="reader-wiki-disabled-mcp",args=[]}'
      : '{enabled=false,url="http://127.0.0.1/reader-wiki-disabled-mcp"}';
    args.push("-c", `mcp_servers.${JSON.stringify(name)}=${disabledTransport}`);
  }
  for (const feature of CODEX_DISABLED_FEATURES) args.push("--disable", feature);
  return args;
}

export function codexMcpListArgs(): string[] {
  return ["mcp", "list", "--json"];
}

export function parseCodexMcpServers(stdout: string): CodexMcpDisableSpec[] {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new HttpError(502, "Codex MCP isolation preflight returned invalid JSON.");
  }
  if (!Array.isArray(data)) throw new HttpError(502, "Codex MCP isolation preflight returned an invalid server list.");
  const servers = data.map((entry): CodexMcpDisableSpec => {
    const name = entry && typeof entry === "object" ? (entry as { name?: unknown }).name : undefined;
    if (typeof name !== "string" || !name || name.length > 256 || /[\u0000-\u001f\u007f]/.test(name)) {
      throw new HttpError(502, "Codex MCP isolation preflight returned an invalid server name.");
    }
    const transportType = (entry as { transport?: { type?: unknown } }).transport?.type;
    if (transportType !== "stdio" && transportType !== "streamable_http" && transportType !== "sse") {
      throw new HttpError(502, "Codex MCP isolation preflight returned an invalid transport.");
    }
    return { name, transport: transportType === "stdio" ? "stdio" : "http" };
  });
  return Array.from(new Map(servers.map((server) => [server.name, server])).values()).sort((left, right) => left.name.localeCompare(right.name));
}

export async function probeCodexProjectMcpServers(runner: AICommandRunner, cwd: string, signal?: AbortSignal): Promise<CodexMcpDisableSpec[]> {
  const probeHome = await mkdtemp(path.join(tmpdir(), "reader-wiki-codex-config-probe-"));
  try {
    await chmod(probeHome, 0o700);
    await writeFile(path.join(probeHome, "config.toml"), [
      `[projects.${JSON.stringify(cwd)}]`,
      "trust_level = \"trusted\"",
      "",
    ].join("\n"), { encoding: "utf8", mode: 0o600 });
    const result = await runner("codex", codexMcpListArgs(), {
      cwd,
      env: safeCliEnv("codexCli", { CODEX_HOME: probeHome }),
      timeoutMs: 30_000,
      maxBuffer: 256 * 1024,
      signal,
    });
    return parseCodexMcpServers(result.stdout);
  } catch (error) {
    if (error instanceof HttpError && error.status === 499) throw error;
    throw new HttpError(502, "Codex project MCP isolation preflight failed.");
  } finally {
    await rm(probeHome, { recursive: true, force: true });
  }
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
  if (entry === "claudeCli") {
    for (const key of CLAUDE_AUTH_ENV_KEYS) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  env.READER_WIKI_AI_CLI = "1";
  return { ...env, ...extra };
}

function buildRepoWritePrompt(context: AIChatContext, messages: AIChatMessage[], attachments: AIChatAttachment[], modelBehavior: AIModelBehavior | undefined): string {
  const runtime = buildAIChatRuntimePrompt(context, attachments, modelBehavior);
  const transcript = buildConversationTranscript(messages);
  return [
    runtime.systemPrompt,
    runtime.contextPrompt,
    transcript ? `Conversation:\n${transcript}` : "Conversation: [no prior messages]",
    [
      "Local Reader App CLI work order:",
      "- Use the CLI's native repository tools to complete the latest user request.",
      "- The active repository root is the only writable workspace for this run.",
      "- Local Reader App does not impose a file-count, directory-count, or edit-operation-count limit on this CLI run.",
      "- Inspect, create, update, rename, or delete repository files and directories as needed for the request, subject to the active repository boundary.",
      "- Report the result concisely with repository-relative paths.",
    ].join("\n"),
  ].filter(Boolean).join("\n\n");
}

function claudeNonInteractiveBaseArgs(): string[] {
  return [
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
    "--setting-sources",
    "",
    "--settings",
    claudeCurrentRepoSettings(),
  ];
}

export function claudeAuthenticationProbeArgs(): string[] {
  return [
    ...claudeNonInteractiveBaseArgs(),
    "--tools",
    "",
    "--permission-mode",
    "plan",
  ];
}

async function runCodexChat(runner: AICommandRunner, cwd: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const disabledMcpServers = await probeCodexProjectMcpServers(runner, cwd, signal);
  const result = await runner("codex", [
    "exec",
    ...codexCurrentRepoArgs(undefined, disabledMcpServers),
    "--ephemeral",
    "--skip-git-repo-check",
    "--json",
    "-C",
    cwd,
    "-",
  ], {
    cwd,
    env: safeCliEnv("codexCli"),
    input: prompt,
    timeoutMs: CLI_TIMEOUT_MS,
    maxBuffer: CLI_MAX_BUFFER,
    signal,
  });
  return parseCodexJsonl(result.stdout);
}

async function runClaudeChat(runner: AICommandRunner, cwd: string, prompt: string, signal?: AbortSignal): Promise<string> {
  const result = await runner("claude", [
    ...claudeNonInteractiveBaseArgs(),
    "--tools",
    CLAUDE_CURRENT_REPO_TOOLS,
    "--permission-mode",
    "acceptEdits",
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

export function claudeCurrentRepoSandboxSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== "win32";
}

export function claudeCurrentRepoSettings(): string {
  return JSON.stringify({
    permissions: {
      additionalDirectories: [],
      disableBypassPermissionsMode: "disable",
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      autoAllowBashIfSandboxed: true,
      excludedCommands: [],
      filesystem: {
        allowWrite: [],
      },
    },
  });
}

function parseCodexJsonl(stdout: string): string {
  let last = "";
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as { type?: string; item?: { type?: string; text?: string } };
      if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
        last = event.item.text;
      }
    } catch {
      // Codex runs with --json. Ignore non-protocol output instead of exposing CLI logs as the final answer.
    }
  }
  if (!last.trim()) throw new HttpError(502, "Codex CLI did not return a usable natural-language response. Try the request again.");
  return last;
}

function parseClaudeJson(stdout: string): string {
  let data: { is_error?: boolean; result?: string };
  try {
    data = JSON.parse(stdout || "{}") as { is_error?: boolean; result?: string };
  } catch {
    throw new HttpError(502, "Claude Code CLI returned invalid JSON output.");
  }
  if (data.is_error) throw new HttpError(502, userFacingCliFailure("claude", data.result || "Claude Code CLI request failed."));
  return data.result || "";
}

function userFacingCliError(entry: AIEntryKind, error: unknown): HttpError {
  const statusCode = error instanceof HttpError ? error.status : 502;
  const details = error instanceof HttpError ? error.details : undefined;
  return new HttpError(statusCode, userFacingCliFailure(entry, error, statusCode), details);
}

function userFacingCliFailure(entryOrBinary: AIEntryKind | string, error: unknown, statusCode = 502): string {
  const label = cliDisplayName(entryOrBinary);
  const raw = error instanceof Error ? error.message : String(error || "");
  const normalized = raw.toLowerCase();
  if (statusCode === 499 || /\b(?:cancel(?:ed|led)?|abort(?:ed)?)\b/.test(normalized)) {
    return "AI Chat request was canceled.";
  }
  if (/process tree|could not confirm that the cli process stopped|termination could not be verified/.test(normalized)) {
    return "Local Reader App could not confirm that the CLI process stopped. Close the CLI, review the Current repo, restart the Local Reader App server, and reload the page before trying again.";
  }
  if (statusCode === 504 || /timed? out|time limit|timeout/.test(normalized)) {
    return `${label} did not finish before the time limit. Try a smaller request or try again.`;
  }
  if (/invalid api key|not logged in|authentication|credential|sign.?in|unauthorized|\b401\b/.test(normalized)) {
    return `${label} could not authenticate. Open Settings, complete CLI sign-in, and check readiness again.`;
  }
  if (/output exceeded|byte limit|more information than (?:local reader app|reader-wiki)|response.*too large/.test(normalized)) {
    return `${label} returned more information than Local Reader App can display safely. Ask for a smaller result and try again.`;
  }
  if (/invalid json|usable natural-language response|empty response|did not return.*response/.test(normalized)) {
    return `${label} did not return a usable natural-language response. Try the request again.`;
  }
  if (/enoent|not found|could not be resolved|cannot find|failed to spawn|command type is not supported|unsupported windows.*shim/.test(normalized)) {
    return `${label} could not start. Check that it is installed and available to Local Reader App, then check readiness again.`;
  }
  if (/permission|sandbox|access denied|eperm|eacces/.test(normalized)) {
    return `${label} could not complete the request within the Current repo permissions. Check readiness and try again.`;
  }
  if (/closed its input|input failed/.test(normalized)) {
    return `${label} stopped before it received the request. Check readiness and try again.`;
  }
  return `${label} could not complete the request. Check readiness and try again.`;
}

function cliDisplayName(entryOrBinary: AIEntryKind | string): string {
  if (entryOrBinary === "codex" || entryOrBinary === "codexCli") return "Codex CLI";
  if (entryOrBinary === "claude" || entryOrBinary === "claudeCli") return "Claude Code CLI";
  return "The CLI";
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
      markIncomplete("Repository change audit is unverified because its time budget was reached; CLI execution remains enabled.");
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
        if (WORKSPACE_SNAPSHOT_SKIPPED_DIRECTORIES.has(entry.name)) {
          if (entry.name !== ".git") markIncomplete(`Repository change audit skipped generated directory ${relativePath}.`);
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
        markIncomplete("Repository change audit is unverified because its file scan budget was reached; CLI execution remains enabled.");
        break;
      }
      try {
        const fileStat = await stat(absolutePath);
        if (!fileStat.isFile()) {
          markIncomplete(`Repository change audit skipped non-regular path ${relativePath}.`);
          continue;
        }
        if (fileStat.size > WORKSPACE_SNAPSHOT_MAX_FILE_BYTES) {
          markIncomplete(`Repository change audit hash is unverified for ${relativePath}: the file exceeds the per-file audit budget.`);
          files.set(relativePath, { hash: `unverified:${fileStat.size}:${fileStat.mtimeMs}`, byteLength: fileStat.size });
          continue;
        }
        if (totalBytes + fileStat.size > WORKSPACE_SNAPSHOT_MAX_BYTES) {
          stop = true;
          markIncomplete("Repository change audit is unverified because its byte scan budget was reached; CLI execution remains enabled.");
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

function sanitizeFinalAnswerText(content: string): FinalAnswerReview {
  const warnings: string[] = [];
  const leakPattern = /<\|(?:channel|message|constrain)\|>|functions\.exec_command|functions\.[A-Za-z0-9_]+\s*<\|/;
  if (!leakPattern.test(content)) return { content, warnings };
  const tokenIndex = content.search(leakPattern);
  const sanitized = sanitizeCliText(content.slice(0, tokenIndex >= 0 ? tokenIndex : 0)).trim();
  warnings.push("AI Chat final answer contained tool-call markup; Local Reader App removed it before display.");
  return { content: sanitized || "AI Chat completed. Tool-call markup was removed from the final answer.", warnings };
}

function runWarnings(changedPaths: AIChangedPath[], before: WorkspaceSnapshot, after: WorkspaceSnapshot, ...warningGroups: string[][]): string[] {
  const warnings = [...before.warnings, ...after.warnings, ...warningGroups.flat()];
  if (!changedPaths.length && !(before.complete && after.complete)) {
    warnings.push("Repository changes are unverified because the bounded workspace audit was incomplete.");
  }
  return Array.from(new Set(warnings));
}

export function sanitizeCliText(value: string): string {
  let sanitized = value;
  for (const key of CLAUDE_SECRET_ENV_KEYS) {
    const secret = process.env[key];
    if (secret && secret.length >= 8) sanitized = sanitized.split(secret).join("[redacted]");
  }
  return sanitized
    .replace(new RegExp(`"${["sess", "ion_id"].join("")}"\\s*:\\s*"[^"]*"`, "g"), `"${["sess", "ion_id"].join("")}":"[redacted]"`)
    .replace(/"uuid"\s*:\s*"[^"]*"/g, "\"uuid\":\"[redacted]\"")
    .replace(/Command failed: (codex|claude)[^\n]*/g, "Command failed: CLI invocation")
    .replace(new RegExp(["in-process app", "server client"].join("-"), "g"), "CLI runtime client")
    .replace(/\/var\/folders\/[^\s]+/g, "[local-temp]")
    .replace(/\/private\/tmp\/[^\s]+/g, "[local-temp]")
    .replace(/\/Users\/[^/\s]+/g, "[local-home]")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/(READER_WIKI_AI_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|CODEX_API_KEY)=\S+/g, "$1=[redacted]")
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
