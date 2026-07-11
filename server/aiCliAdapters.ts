import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpError } from "./errors.js";
import type {
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

const WINDOWS_CMD_SHIM_MAX_BYTES = 32 * 1024;
const TRUSTED_WINDOWS_CMD_PACKAGES: Readonly<Record<string, string>> = {
  codex: "/node_modules/@openai/codex/",
  claude: "/node_modules/@anthropic-ai/claude-code/",
};

export async function requestRepoWriteAIChatCompletion(request: RepoWriteChatRequest): Promise<{ content: string; status: AIConnectionStatus; run: AIChatRunSummary }> {
  if (request.target.kind === "codexCli") {
    throw new HttpError(409, "Codex CLI Current repo write is unavailable because the current macOS :minimal runtime profile also grants shared system temp read/write access, so Reader-Wiki cannot enforce a Current repo-only boundary.");
  }
  if (request.target.kind === "claudeCli") {
    throw new HttpError(409, "Claude Code CLI Current repo write is unavailable because Reader-Wiki cannot yet prove repo-outside read and protected-path write confinement.");
  }
  throw new HttpError(500, "Provider Current repo write must use the Reader-Wiki server edit protocol and cannot be routed through a CLI adapter.");
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
