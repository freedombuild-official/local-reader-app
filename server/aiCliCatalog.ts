import { createHash } from "node:crypto";

const MAX_PAGES = 8;
const MAX_MODELS = 200;
const MAX_EFFORTS_PER_MODEL = 32;
const MAX_IDENTIFIER_LENGTH = 160;
const MAX_CURSOR_LENGTH = 1_024;
const MAX_LABEL_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 2_000;
const MAX_VERSION_LENGTH = 200;

export type CodexReasoningOption = {
  reasoningEffort: string;
  description: string;
};

export type CodexModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: CodexReasoningOption[];
};

export type CodexModelCatalog = {
  cliVersion: string;
  revision: string;
  fetchedAt: string;
  models: CodexModelOption[];
};

export type CodexModelSelection = {
  model: string;
  reasoningEffort: string;
};

export type CodexCatalogFailureReason = "legacyShape" | "invalidCatalog";

export class CodexCatalogError extends Error {
  readonly reason: CodexCatalogFailureReason;

  constructor(reason: CodexCatalogFailureReason, message: string) {
    super(message);
    this.name = "CodexCatalogError";
    this.reason = reason;
  }
}

export type CodexModelListRequester = {
  request: <T = unknown>(method: string, params?: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<T>;
};

export type LoadCodexModelCatalogOptions = {
  cliVersion: string;
  now?: () => Date;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
};

export async function loadCodexModelCatalog(
  requester: CodexModelListRequester,
  options: LoadCodexModelCatalogOptions,
): Promise<CodexModelCatalog> {
  const cliVersion = boundedText(options.cliVersion, MAX_VERSION_LENGTH, false, "CLI version");
  const models: CodexModelOption[] = [];
  const modelIds = new Set<string>();
  const modelNames = new Set<string>();
  const cursors = new Set<string>();
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const rawResponse = await requester.request("model/list", {
      cursor,
      limit: 100,
      includeHidden: false,
    }, { signal: options.signal, timeoutMs: options.requestTimeoutMs });
    const response = readModelListResponse(rawResponse);

    for (const rawModel of response.data) {
      const model = normalizeCodexCatalogModel(rawModel);
      if (modelIds.has(model.id) || modelNames.has(model.model)) {
        throw invalidCatalog("Codex model catalog contained duplicate model identifiers.");
      }
      modelIds.add(model.id);
      modelNames.add(model.model);
      models.push(model);
      if (models.length > MAX_MODELS) throw invalidCatalog("Codex model catalog exceeded the model limit.");
    }

    if (response.nextCursor === null) return finalizeCatalog(models, cliVersion, options.now?.() ?? new Date());
    if (cursors.has(response.nextCursor)) throw invalidCatalog("Codex model catalog returned a repeated cursor.");
    cursors.add(response.nextCursor);
    cursor = response.nextCursor;
  }

  throw invalidCatalog("Codex model catalog exceeded the page limit.");
}

export function normalizeCodexCatalogModel(value: unknown): CodexModelOption {
  const source = requireRecord(value, "Codex returned an invalid picker model.");
  if (source.hidden !== false || typeof source.isDefault !== "boolean") {
    throw invalidCatalog("Codex returned an invalid picker model.");
  }

  const id = boundedIdentifier(source.id, "model id");
  const model = boundedIdentifier(source.model, "model name");
  const displayName = boundedText(source.displayName, MAX_LABEL_LENGTH, false, "model display name");
  const description = boundedText(source.description, MAX_DESCRIPTION_LENGTH, true, "model description");
  const defaultReasoningEffort = boundedIdentifier(source.defaultReasoningEffort, "default reasoning effort");
  if (
    !Array.isArray(source.supportedReasoningEfforts)
    || source.supportedReasoningEfforts.length === 0
    || source.supportedReasoningEfforts.length > MAX_EFFORTS_PER_MODEL
  ) {
    throw invalidCatalog("Codex returned invalid reasoning effort options.");
  }

  const supportedReasoningEfforts = source.supportedReasoningEfforts.map(normalizeReasoningOption);
  const effortNames = supportedReasoningEfforts.map((option) => option.reasoningEffort);
  if (new Set(effortNames).size !== effortNames.length || !effortNames.includes(defaultReasoningEffort)) {
    throw invalidCatalog("Codex returned invalid reasoning effort options.");
  }

  return { id, model, displayName, description, isDefault: source.isDefault, defaultReasoningEffort, supportedReasoningEfforts };
}

export function validateCodexModelSelection(catalog: CodexModelCatalog | undefined, selection: CodexModelSelection): void {
  const model = catalog?.models.find((candidate) => candidate.model === selection.model);
  if (!model?.supportedReasoningEfforts.some((option) => option.reasoningEffort === selection.reasoningEffort)) {
    throw new Error("The selected Codex model or reasoning effort is not available in the current catalog.");
  }
}

export function fingerprintCodexModelCatalog(cliVersion: string, models: readonly CodexModelOption[]): string {
  return createHash("sha256").update(JSON.stringify({ cliVersion, models })).digest("hex");
}

function readModelListResponse(value: unknown): { data: unknown[]; nextCursor: string | null } {
  const source = requireRecord(value, "Codex returned an invalid model catalog response.");
  if (Array.isArray(source.models) && !Array.isArray(source.data)) {
    throw new CodexCatalogError("legacyShape", "Codex returned the unsupported legacy model catalog shape.");
  }
  if (!Array.isArray(source.data) || !("nextCursor" in source)) {
    throw invalidCatalog("Codex returned an invalid model catalog response.");
  }
  const nextCursor = source.nextCursor;
  if (nextCursor !== null && (
    typeof nextCursor !== "string"
    || nextCursor.length === 0
    || nextCursor.length > MAX_CURSOR_LENGTH
    || /[\u0000-\u001f\u007f]/.test(nextCursor)
  )) {
    throw invalidCatalog("Codex model catalog returned an invalid cursor.");
  }
  return { data: source.data, nextCursor: nextCursor as string | null };
}

function finalizeCatalog(models: CodexModelOption[], cliVersion: string, fetchedAt: Date): CodexModelCatalog {
  if (!models.length || models.filter((model) => model.isDefault).length !== 1) {
    throw invalidCatalog("Codex model catalog must contain exactly one default model.");
  }
  if (Number.isNaN(fetchedAt.getTime())) throw invalidCatalog("Codex model catalog received an invalid fetch time.");
  return {
    cliVersion,
    revision: fingerprintCodexModelCatalog(cliVersion, models),
    fetchedAt: fetchedAt.toISOString(),
    models,
  };
}

function normalizeReasoningOption(value: unknown): CodexReasoningOption {
  const source = requireRecord(value, "Codex returned invalid reasoning effort options.");
  return {
    reasoningEffort: boundedIdentifier(source.reasoningEffort, "reasoning effort"),
    description: boundedText(source.description, MAX_DESCRIPTION_LENGTH, true, "reasoning effort description"),
  };
}

function boundedIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_IDENTIFIER_LENGTH
    || /[^\u0020-\u007e]/.test(value)
    || value.trim() !== value
  ) {
    throw invalidCatalog(`Codex returned an invalid ${label}.`);
  }
  return value;
}

function boundedText(value: unknown, maxLength: number, allowEmpty: boolean, label: string): string {
  if (
    typeof value !== "string"
    || value.length > maxLength
    || (!allowEmpty && value.trim().length === 0)
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw invalidCatalog(`Codex returned an invalid ${label}.`);
  }
  return value;
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidCatalog(message);
  return value as Record<string, unknown>;
}

function invalidCatalog(message: string): CodexCatalogError {
  return new CodexCatalogError("invalidCatalog", message);
}
