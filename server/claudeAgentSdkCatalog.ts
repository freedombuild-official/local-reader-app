import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { runAICommand, safeCliEnv, type AICommandRunner } from "./aiCliAdapters.js";
import { HttpError } from "./errors.js";
import type { AICliEffortOption, AICliModelCatalog, AICliModelOption } from "./types.js";

const MAX_MODELS = 200;
const MAX_EFFORTS_PER_MODEL = 32;
const MAX_MODEL_ID_LENGTH = 160;
const MAX_MODEL_LABEL_LENGTH = 240;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_EFFORT_ID_LENGTH = 64;
const MAX_PATH_LENGTH = 4_096;
const MAX_CLI_VERSION_LENGTH = 160;
const WORKER_TIMEOUT_MS = 20_000;
const WORKER_MAX_OUTPUT_BYTES = 512 * 1_024;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const SDK_SCRIPT_SUFFIX = /\.(?:c?js|mjs|jsx|tsx?)$/iu;

export type ClaudeAgentSdkSession = {
  accountInfo(): Promise<unknown>;
  supportedModels(): Promise<unknown>;
  close(): void | Promise<void>;
};

export type ClaudeAgentSdkExecutionDescriptor = {
  binary: string;
  argvPrefix: string[];
  identityPath: string;
};

export type ClaudeAgentSdkSessionFactoryOptions = {
  execution: ClaudeAgentSdkExecutionDescriptor;
  cwd: string;
  abortController: AbortController;
};

export type ClaudeAgentSdkSessionFactory = (
  options: ClaudeAgentSdkSessionFactoryOptions,
) => ClaudeAgentSdkSession;

export type ClaudeAgentSdkQueryFunction = (params: {
  prompt: AsyncIterable<SDKUserMessage>;
  options: Options;
}) => ClaudeAgentSdkSession;

export type LoadClaudeAgentSdkCatalogOptions = {
  execution: ClaudeAgentSdkExecutionDescriptor;
  cwd: string;
  cliVersion: string;
  fetchedAt?: string;
  abortController?: AbortController;
  sessionFactory?: ClaudeAgentSdkSessionFactory;
  workerRunner?: AICommandRunner;
  platform?: NodeJS.Platform;
};

export type NormalizeClaudeAgentSdkCatalogOptions = {
  cliVersion: string;
  fetchedAt?: string;
  models: unknown;
};

function assertBoundedString(
  value: unknown,
  name: string,
  maximumLength: number,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") throw new Error(`${name} must be a string.`);
  if (!options.allowEmpty && value.length === 0) throw new Error(`${name} must not be empty.`);
  if (value.length > maximumLength) throw new Error(`${name} exceeds the maximum length.`);
  if (CONTROL_CHARACTERS.test(value)) throw new Error(`${name} contains control characters.`);
  if (value !== value.trim()) throw new Error(`${name} must not have surrounding whitespace.`);
  return value;
}

function assertAbsolutePath(value: unknown, name: string): string {
  const candidate = assertBoundedString(value, name, MAX_PATH_LENGTH);
  if (!path.isAbsolute(candidate)) throw new Error(`${name} must be an absolute path.`);
  return candidate;
}

export function normalizeClaudeAgentSdkExecution(value: unknown): ClaudeAgentSdkExecutionDescriptor {
  const source = asRecord(value, "execution");
  const binary = assertAbsolutePath(source.binary, "execution.binary");
  const identityPath = assertAbsolutePath(source.identityPath, "execution.identityPath");
  if (SDK_SCRIPT_SUFFIX.test(binary)) {
    throw new Error("execution.binary must be a native executable path that the Claude Agent SDK will not reinterpret as a script.");
  }
  if (!Array.isArray(source.argvPrefix) || source.argvPrefix.length > 1) {
    throw new Error("execution.argvPrefix must contain at most one launcher path.");
  }
  const argvPrefix = source.argvPrefix.map((argument, index) =>
    assertAbsolutePath(argument, `execution.argvPrefix ${index}`),
  );
  if (argvPrefix.length === 0 && binary !== identityPath) {
    throw new Error("A native Claude execution descriptor must execute its identity path directly.");
  }
  if (argvPrefix.length === 1 && argvPrefix[0] !== identityPath) {
    throw new Error("A scripted Claude execution descriptor must prefix its exact identity path.");
  }
  return { binary, argvPrefix, identityPath };
}

function normalizeFetchedAt(value: string | undefined): string {
  const fetchedAt = value ?? new Date().toISOString();
  assertBoundedString(fetchedAt, "fetchedAt", 64);
  const timestamp = Date.parse(fetchedAt);
  if (!Number.isFinite(timestamp)) throw new Error("fetchedAt must be a valid timestamp.");
  return fetchedAt;
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function effortLabel(id: string): string {
  return id
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function normalizeEfforts(model: Record<string, unknown>, modelId: string): {
  defaultEffort: string;
  efforts: AICliEffortOption[];
} {
  if (model.supportsEffort !== undefined && typeof model.supportsEffort !== "boolean") {
    throw new Error(`Model ${modelId} supportsEffort must be a boolean.`);
  }
  const rawEfforts = model.supportedEffortLevels;
  if (rawEfforts !== undefined && !Array.isArray(rawEfforts)) {
    throw new Error(`Model ${modelId} supportedEffortLevels must be an array.`);
  }
  const effortValues = rawEfforts ?? [];
  if (effortValues.length > MAX_EFFORTS_PER_MODEL) {
    throw new Error(`Model ${modelId} exceeds the effort limit.`);
  }
  if (model.supportsEffort === true && effortValues.length === 0) {
    throw new Error(`Model ${modelId} declares effort support without effort levels.`);
  }
  if (model.supportsEffort === false && effortValues.length > 0) {
    throw new Error(`Model ${modelId} returned effort levels while effort support is disabled.`);
  }

  if (effortValues.length === 0) {
    return {
      defaultEffort: "default",
      efforts: [{ id: "default", label: "Default", description: null, isDefault: true }],
    };
  }

  const effortIds = effortValues.map((value, index) =>
    assertBoundedString(value, `Model ${modelId} effort ${index}`, MAX_EFFORT_ID_LENGTH),
  );
  const duplicates = new Set<string>();
  for (const effortId of effortIds) {
    if (duplicates.has(effortId)) throw new Error(`Model ${modelId} has duplicate effort ${effortId}.`);
    duplicates.add(effortId);
  }

  const defaultEffort = effortIds.includes("high") ? "high" : effortIds[0];
  return {
    defaultEffort,
    efforts: effortIds.map((id) => ({
      id,
      label: effortLabel(id),
      description: null,
      isDefault: id === defaultEffort,
    })),
  };
}

function normalizeModels(value: unknown): AICliModelOption[] {
  if (!Array.isArray(value)) throw new Error("Claude Agent SDK models must be an array.");
  if (value.length === 0) throw new Error("Claude Agent SDK returned no models.");
  if (value.length > MAX_MODELS) throw new Error("Claude Agent SDK model catalog exceeds the model limit.");

  const seenModels = new Set<string>();
  const normalized: AICliModelOption[] = value.map((candidate, index) => {
    const model = asRecord(candidate, `Model ${index}`);
    const id = assertBoundedString(model.value, `Model ${index} value`, MAX_MODEL_ID_LENGTH);
    if (seenModels.has(id)) throw new Error(`Claude Agent SDK returned duplicate model ${id}.`);
    seenModels.add(id);

    const label = assertBoundedString(model.displayName, `Model ${id} displayName`, MAX_MODEL_LABEL_LENGTH);
    const rawDescription = assertBoundedString(
      model.description,
      `Model ${id} description`,
      MAX_DESCRIPTION_LENGTH,
      { allowEmpty: true },
    );
    const description = rawDescription === "" ? null : rawDescription;
    const effort = normalizeEfforts(model, id);
    return {
      id,
      label,
      description,
      isDefault: false,
      defaultEffort: effort.defaultEffort,
      efforts: effort.efforts,
    };
  });

  const explicitDefault = normalized.findIndex((model) => model.id === "default");
  normalized[explicitDefault >= 0 ? explicitDefault : 0].isDefault = true;
  return normalized;
}

function catalogRevision(cliVersion: string, models: AICliModelOption[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ entry: "claudeCli", cliVersion, models }))
    .digest("hex");
}

async function* metadataOnlyPrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  if (!signal.aborted) {
    await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  }
}

export function createClaudeAgentSdkSessionFactory(
  queryFunction: ClaudeAgentSdkQueryFunction = query,
): ClaudeAgentSdkSessionFactory {
  return ({ execution, cwd, abortController }) => {
    const normalizedExecution = normalizeClaudeAgentSdkExecution(execution);
    return queryFunction({
      prompt: metadataOnlyPrompt(abortController.signal),
      options: {
        abortController,
        cwd: assertAbsolutePath(cwd, "cwd"),
        env: definedEnvironment(safeCliEnv("claudeCli")),
        pathToClaudeCodeExecutable: normalizedExecution.binary,
        executableArgs: normalizedExecution.argvPrefix,
        settingSources: [],
        tools: [],
        permissionMode: "plan",
        mcpServers: {},
        strictMcpConfig: true,
        persistSession: false,
      },
    });
  };
}

function definedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export const productionClaudeAgentSdkSessionFactory = createClaudeAgentSdkSessionFactory();

export function normalizeClaudeAgentSdkModels({
  cliVersion,
  fetchedAt,
  models,
}: NormalizeClaudeAgentSdkCatalogOptions): AICliModelCatalog {
  const normalizedVersion = assertBoundedString(cliVersion, "cliVersion", MAX_CLI_VERSION_LENGTH);
  const normalizedModels = normalizeModels(models);
  return {
    entry: "claudeCli",
    cliVersion: normalizedVersion,
    revision: catalogRevision(normalizedVersion, normalizedModels),
    fetchedAt: normalizeFetchedAt(fetchedAt),
    models: normalizedModels,
  };
}

export async function loadClaudeAgentSdkCatalog({
  execution,
  cwd,
  cliVersion,
  fetchedAt,
  abortController = new AbortController(),
  sessionFactory,
  workerRunner = runAICommand,
  platform = process.platform,
}: LoadClaudeAgentSdkCatalogOptions): Promise<AICliModelCatalog> {
  const normalizedExecution = normalizeClaudeAgentSdkExecution(execution);
  const normalizedCwd = assertAbsolutePath(cwd, "cwd");
  if (sessionFactory) {
    return loadClaudeAgentSdkCatalogFromSession({
      execution: normalizedExecution,
      cwd: normalizedCwd,
      cliVersion,
      fetchedAt,
      abortController,
      sessionFactory,
    });
  }
  if (platform === "win32") {
    throw new HttpError(503, "Claude Agent SDK catalog loading is unavailable on Windows until stable process-tree ownership is implemented.");
  }
  const launch = claudeCatalogWorkerLaunch();
  const result = await workerRunner(launch.binary, launch.args, {
    cwd: normalizedCwd,
    env: safeCliEnv("claudeCli"),
    input: JSON.stringify({ execution: normalizedExecution, cwd: normalizedCwd }),
    timeoutMs: WORKER_TIMEOUT_MS,
    maxBuffer: WORKER_MAX_OUTPUT_BYTES,
    signal: abortController.signal,
  });
  let payload: Record<string, unknown>;
  try {
    payload = asRecord(JSON.parse(result.stdout), "Claude Agent SDK catalog worker response");
  } catch {
    throw new HttpError(502, "Claude Agent SDK catalog worker returned an invalid response.");
  }
  return normalizeClaudeAgentSdkModels({ cliVersion, fetchedAt, models: payload.models });
}

async function loadClaudeAgentSdkCatalogFromSession({
  execution,
  cwd,
  cliVersion,
  fetchedAt,
  abortController,
  sessionFactory,
}: Required<Pick<LoadClaudeAgentSdkCatalogOptions, "execution" | "cwd" | "cliVersion" | "abortController" | "sessionFactory">>
  & Pick<LoadClaudeAgentSdkCatalogOptions, "fetchedAt">): Promise<AICliModelCatalog> {
  const session = sessionFactory({ execution, cwd, abortController });
  try {
    await abortable(session.accountInfo(), abortController.signal);
    const models = await abortable(session.supportedModels(), abortController.signal);
    return normalizeClaudeAgentSdkModels({ cliVersion, fetchedAt, models });
  } finally {
    abortController.abort();
    await session.close();
  }
}

function claudeCatalogWorkerLaunch(): { binary: string; args: string[] } {
  const modulePath = fileURLToPath(import.meta.url);
  const sourceMode = modulePath.endsWith(".ts");
  const workerPath = path.join(path.dirname(modulePath), `claudeAgentSdkCatalogWorker.${sourceMode ? "ts" : "js"}`);
  return {
    binary: process.execPath,
    args: sourceMode ? ["--import", "tsx", workerPath] : [workerPath],
  };
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort)).catch(() => undefined);
  });
}

function abortError(): Error {
  const error = new Error("Claude Agent SDK catalog loading was canceled.");
  error.name = "AbortError";
  return error;
}
