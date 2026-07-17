import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isUtf8 } from "node:buffer";
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";

const DEFAULT_MAX_JSONL_LINE_BYTES = 256 * 1_024;

type JsonObject = Record<string, unknown>;

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  signal?: AbortSignal;
  abortListener?: () => void;
};

export type JsonRpcServerRequest = { id: number | string; method: string; params?: unknown };
export type JsonRpcNotification = { method: string; params?: unknown };
export type JsonRpcErrorPayload = { code: number; message: string; data?: unknown };
export type JsonRpcRequestOptions = { signal?: AbortSignal; timeoutMs?: number };

export class JsonRpcRemoteError extends Error {
  readonly method: string;
  readonly code: number;
  readonly data?: unknown;

  constructor(method: string, payload: JsonRpcErrorPayload) {
    super(payload.message);
    this.name = "JsonRpcRemoteError";
    this.method = method;
    this.code = payload.code;
    this.data = payload.data;
  }
}

export type JsonlJsonRpcClientOptions = {
  input: Writable;
  output: Readable;
  errorOutput?: Readable;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
};

export class JsonlJsonRpcClient extends EventEmitter {
  private readonly input: Writable;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly requestTimeoutMs: number;
  private readonly maxLineBytes: number;
  private nextRequestId = 1;
  private buffer = Buffer.alloc(0);
  private closed = false;

  constructor(options: JsonlJsonRpcClientOptions) {
    super();
    this.input = options.input;
    this.requestTimeoutMs = positiveTimeout(options.requestTimeoutMs ?? 30_000, "request timeout");
    this.maxLineBytes = positiveInteger(options.maxLineBytes ?? DEFAULT_MAX_JSONL_LINE_BYTES, "maximum JSONL line size");
    options.output.on("data", (chunk: Buffer | string) => this.handleChunk(chunk));
    options.output.on("end", () => this.close(new Error("Codex app-server output ended.")));
    options.output.on("error", (error: Error) => this.fail(error));
    this.input.on("error", (error: Error) => this.fail(error));
    options.errorOutput?.setEncoding("utf8");
    options.errorOutput?.on("data", (chunk: string) => this.emit("stderr", chunk));
  }

  request<T = unknown>(method: string, params?: unknown, options: JsonRpcRequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Codex app-server connection is closed."));
    if (options.signal?.aborted) return Promise.reject(abortError());
    const timeoutMs = positiveTimeout(options.timeoutMs ?? this.requestTimeoutMs, "request timeout");
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timeout: setTimeout(() => {
          const current = this.takePending(id);
          current?.reject(new Error(`${method} timed out.`));
        }, timeoutMs),
        signal: options.signal,
      };
      if (options.signal) {
        pending.abortListener = () => {
          const current = this.takePending(id);
          current?.reject(abortError());
        };
        options.signal.addEventListener("abort", pending.abortListener, { once: true });
      }
      this.pending.set(id, pending);
      try {
        this.write({ id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        const current = this.takePending(id);
        current?.reject(asError(error));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: number | string, error: JsonRpcErrorPayload): void {
    this.write({ id, error });
  }

  close(reason = new Error("Codex app-server connection was closed.")): void {
    if (this.closed) return;
    this.closed = true;
    this.buffer = Buffer.alloc(0);
    for (const id of this.pending.keys()) {
      const pending = this.takePending(id);
      pending?.reject(reason);
    }
    try {
      this.input.end();
    } catch {
      // The process may already have closed stdin.
    }
    this.emit("closed", reason);
  }

  private handleChunk(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
    let offset = 0;
    while (!this.closed && offset < bytes.length) {
      const newlineIndex = bytes.indexOf(0x0a, offset);
      const end = newlineIndex < 0 ? bytes.length : newlineIndex;
      const segment = bytes.subarray(offset, end);
      if (this.buffer.length + segment.length > this.maxLineBytes) {
        this.fail(new Error(`Codex app-server JSONL line exceeded ${this.maxLineBytes} UTF-8 bytes.`));
        return;
      }
      if (segment.length > 0) {
        this.buffer = this.buffer.length === 0 ? Buffer.from(segment) : Buffer.concat([this.buffer, segment]);
      }
      if (newlineIndex < 0) return;
      const lineBytes = this.buffer;
      this.buffer = Buffer.alloc(0);
      if (!isUtf8(lineBytes)) {
        this.fail(new Error("Codex app-server emitted invalid UTF-8 JSONL output."));
        return;
      }
      const line = lineBytes.toString("utf8").trim();
      if (line) this.handleLine(line);
      offset = newlineIndex + 1;
    }
  }

  private handleLine(line: string): void {
    let parsed: JsonObject;
    try {
      const value = JSON.parse(line) as unknown;
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex app-server emitted a non-object JSONL message.");
      parsed = value as JsonObject;
    } catch (error) {
      this.fail(asError(error));
      return;
    }
    const id = parsed.id;
    if (isRequestId(id) && typeof parsed.method === "string") {
      this.emit("serverRequest", parsed as JsonRpcServerRequest);
      return;
    }
    if (isRequestId(id)) {
      this.handleResponse(id, parsed);
      return;
    }
    if (typeof parsed.method === "string") {
      this.emit("notification", parsed as JsonRpcNotification);
      return;
    }
    this.fail(new Error("Codex app-server emitted an invalid JSON-RPC message."));
  }

  private handleResponse(id: number | string, response: JsonObject): void {
    const pending = this.takePending(id);
    if (!pending) return;
    if (response.error && typeof response.error === "object" && !Array.isArray(response.error)) {
      const source = response.error as Record<string, unknown>;
      pending.reject(new JsonRpcRemoteError(pending.method, {
        code: typeof source.code === "number" && Number.isFinite(source.code) ? source.code : -32603,
        message: typeof source.message === "string" ? source.message : `${pending.method} failed.`,
        ...(source.data === undefined ? {} : { data: source.data }),
      }));
      return;
    }
    pending.resolve(response.result);
  }

  private takePending(id: number | string): PendingRequest | undefined {
    const pending = this.pending.get(id);
    if (!pending) return undefined;
    this.pending.delete(id);
    clearTimeout(pending.timeout);
    if (pending.signal && pending.abortListener) pending.signal.removeEventListener("abort", pending.abortListener);
    return pending;
  }

  private write(message: JsonObject): void {
    if (this.closed) throw new Error("Codex app-server connection is closed.");
    this.input.write(`${JSON.stringify(message)}\n`, (error?: Error | null) => {
      if (error) this.fail(error);
    });
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.close(error);
    this.emit("clientError", error);
  }
}

export type ProcessExit = { code: number | null; signal: NodeJS.Signals | null };
export type SpawnCodexAppServerOptions = {
  binary: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
  argvPrefix?: readonly string[];
  requestTimeoutMs?: number;
  signal?: AbortSignal;
  shutdownGraceMs?: number;
  maxLineBytes?: number;
  platform?: NodeJS.Platform;
};
export type CodexAppServerConnection = {
  child: ChildProcessWithoutNullStreams;
  client: JsonlJsonRpcClient;
  exited: Promise<ProcessExit>;
  termination: Promise<void>;
  shutdown: () => Promise<void>;
};

export function spawnCodexAppServer(options: SpawnCodexAppServerOptions): CodexAppServerConnection {
  if (options.signal?.aborted) throw abortError();
  const platform = options.platform ?? process.platform;
  if (platform === "win32") throw new Error("Codex app-server setup is unavailable on Windows until stable process-tree ownership is implemented.");
  const child = spawn(options.binary, [...(options.argvPrefix ?? []), "app-server", "--listen", "stdio://"], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    shell: false,
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const client = new JsonlJsonRpcClient({
    input: child.stdin,
    output: child.stdout,
    errorOutput: child.stderr,
    requestTimeoutMs: options.requestTimeoutMs,
    maxLineBytes: options.maxLineBytes,
  });
  const exited = new Promise<ProcessExit>((resolve, reject) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", reject);
  });

  let shutdownPromise: Promise<void> | undefined;
  let resolveTermination!: () => void;
  let rejectTermination!: (error: unknown) => void;
  const termination = new Promise<void>((resolve, reject) => {
    resolveTermination = resolve;
    rejectTermination = reject;
  });
  // The provider observes this promise in production. Keep a local rejection
  // handler too so a spawn failure before attachment never becomes unhandled.
  void termination.catch(() => undefined);
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    // Defer the body so shutdownPromise is assigned before client.close emits
    // synchronously and re-enters this single-flight function.
    shutdownPromise = Promise.resolve().then(async () => {
      client.close(new Error("Codex app-server is shutting down."));
      const pid = child.pid;
      if (!pid) {
        await exited.catch(() => undefined);
        return;
      }
      signalProcessGroup(pid, "SIGTERM");
      if (await processTreeSettlesWithin(exited, pid, options.shutdownGraceMs ?? 2_000)) return;
      signalProcessGroup(pid, "SIGKILL");
      if (!(await processTreeSettlesWithin(exited, pid, 2_000))) {
        throw new Error("Codex app-server process tree did not exit after shutdown.");
      }
    });
    void shutdownPromise.then(resolveTermination, rejectTermination);
    return shutdownPromise;
  };

  const requestLifecycleShutdown = () => {
    void shutdown().catch(() => undefined);
  };
  client.once("closed", requestLifecycleShutdown);
  child.once("exit", () => client.close(new Error("Codex app-server process exited.")));
  child.once("error", (error) => {
    client.emit("processError", error);
    client.close(error);
  });

  const abortListener = () => void shutdown().catch(() => undefined);
  options.signal?.addEventListener("abort", abortListener, { once: true });
  void exited.finally(() => options.signal?.removeEventListener("abort", abortListener)).catch(() => undefined);
  return { child, client, exited, termination, shutdown };
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!isErrnoException(error) || (error.code !== "ESRCH" && error.code !== "EPERM")) throw error;
    // ESRCH means the group is gone. EPERM remains alive and will fail the
    // liveness gate unless it exits independently, preserving fail-closed shutdown.
  }
}

function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (!isErrnoException(error)) throw error;
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

async function processTreeSettlesWithin(
  exited: Promise<ProcessExit>,
  processGroupId: number,
  milliseconds: number,
): Promise<boolean> {
  const timeoutMs = positiveTimeout(milliseconds, "shutdown timeout");
  const [directChildSettled, processGroupExited] = await Promise.all([
    settlesWithin(exited, timeoutMs),
    processGroupExitsWithin(processGroupId, timeoutMs),
  ]);
  return directChildSettled && processGroupExited;
}

async function processGroupExitsWithin(processGroupId: number, milliseconds: number): Promise<boolean> {
  const timeoutMs = positiveTimeout(milliseconds, "shutdown timeout");
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!isProcessGroupAlive(processGroupId)) return true;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return false;
    await delay(Math.min(25, remainingMs));
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isErrnoException(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}

function positiveTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number.`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
  return value;
}

function isRequestId(value: unknown): value is number | string {
  return (typeof value === "number" && Number.isFinite(value)) || typeof value === "string";
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

async function settlesWithin(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  const timeoutMs = positiveTimeout(milliseconds, "shutdown timeout");
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
