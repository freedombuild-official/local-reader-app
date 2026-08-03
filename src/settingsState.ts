import type {
  AIChatExecutionTarget,
  AIConnectionStatus,
  AICliEntryKind,
  AICliModelSelection,
  AICliSetupSnapshot,
  AIEntryKind,
  AIEntrySettings,
  AIIntelligenceLevel,
  AIModelBehavior,
  AIProviderEntryKind,
  AIProviderSettings,
  CliAIEntryReadiness,
  CliAIEntrySettings,
} from "./types";

export const READER_FONT_SCALE_OPTIONS = [1, 1.5, 2] as const;
export type ReaderFontScale = (typeof READER_FONT_SCALE_OPTIONS)[number];

export type BasicSettings = {
  readerFontScale: ReaderFontScale;
  aiChatFontScale: ReaderFontScale;
  colorMode: "light" | "dark";
  layout: "compact" | "comfortable" | "focused";
};

export type AISettingsState = {
  activeEntry: AIEntryKind | null;
  entries: Record<AIEntryKind, AIEntrySettings>;
  statuses: Record<AIEntryKind, AIConnectionStatus | null>;
  lastCheckedAtByEntry: Record<AIEntryKind, string>;
  modelBehaviorByEntry: Record<AIEntryKind, AIModelBehavior>;
  cliSetupByEntry: Record<AICliEntryKind, AICliSetupSnapshot | null>;
  cliModelSelectionByEntry: Record<AICliEntryKind, AICliModelSelection | null>;
};

export type AIModelBehaviorCapability =
  | { kind: "none"; label: string; description: string }
  | { kind: "intelligence"; label: string; description: string; levels: AIIntelligenceLevel[] }
  | { kind: "thinking"; label: string; description: string };

const BASIC_SETTINGS_KEY = "readerWiki.basicSettings.v1";

export const defaultBasicSettings: BasicSettings = {
  readerFontScale: 1,
  aiChatFontScale: 1,
  colorMode: "light",
  layout: "comfortable",
};

export const defaultAISettings: AISettingsState = {
  activeEntry: null,
  entries: {
    aiApi: {
      entry: "aiApi",
      provider: "openai",
      model: "gpt-5.5",
      baseUrl: "",
      apiFormat: "openaiCompatible",
      credential: "",
      executionMode: "readOnly",
    },
    localAi: {
      entry: "localAi",
      runtime: "ollama",
      model: "",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiFormat: "openaiCompatible",
      credential: "",
      executionMode: "readOnly",
    },
    codexCli: {
      entry: "codexCli",
      binaryName: "codex",
      version: "",
      authState: "unknown",
      readOnlyWrapperState: "unknown",
      executionMode: "unknown",
      readinessMessage: "Run Current repo write readiness check before using this entry.",
    },
    claudeCli: {
      entry: "claudeCli",
      binaryName: "claude",
      version: "",
      authState: "unknown",
      readOnlyWrapperState: "unknown",
      executionMode: "unknown",
      readinessMessage: "Run Current repo write readiness check before using this entry.",
    },
  },
  statuses: {
    aiApi: null,
    localAi: null,
    codexCli: null,
    claudeCli: null,
  },
  lastCheckedAtByEntry: {
    aiApi: "",
    localAi: "",
    codexCli: "",
    claudeCli: "",
  },
  modelBehaviorByEntry: {
    aiApi: { kind: "intelligence", level: "medium" },
    localAi: { kind: "none" },
    codexCli: { kind: "intelligence", level: "medium" },
    claudeCli: { kind: "none" },
  },
  cliSetupByEntry: {
    codexCli: null,
    claudeCli: null,
  },
  cliModelSelectionByEntry: {
    codexCli: null,
    claudeCli: null,
  },
};

export function loadBasicSettings(): { settings: BasicSettings; error: string } {
  try {
    const storage = browserStorage();
    if (!storage) return { settings: defaultBasicSettings, error: "" };
    const raw = storage.getItem(BASIC_SETTINGS_KEY);
    if (!raw) return { settings: defaultBasicSettings, error: "" };
    const parsed = JSON.parse(raw) as Partial<BasicSettings> & { fontSize?: unknown };
    return { settings: normalizeBasicSettings(parsed), error: "" };
  } catch (error) {
    return { settings: defaultBasicSettings, error: error instanceof Error ? error.message : String(error) };
  }
}

export function persistBasicSettings(settings: BasicSettings): string {
  try {
    const storage = browserStorage();
    if (!storage) return "Browser storage is not available.";
    storage.setItem(BASIC_SETTINGS_KEY, JSON.stringify(settings));
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage || null;
  } catch {
    return null;
  }
}

export function activeAIEntry(settings: AISettingsState): AIEntrySettings | null {
  const normalized = normalizeOptionalAIEntryKind(settings.activeEntry);
  return normalized ? settings.entries[normalized] : null;
}

export function activeAIProvider(settings: AISettingsState): AIProviderSettings | null {
  const entry = activeAIEntry(settings);
  return isProviderSettings(entry) ? entry : null;
}

export function activeAIChatTarget(settings: AISettingsState): AIChatExecutionTarget | null | undefined {
  const entry = activeAIEntry(settings);
  if (!entry) return null;
  const status = effectiveAIStatus(settings, entry.entry);
  if (status.state !== "ready" || !aiReady(entry)) return isCliSettings(entry) ? undefined : null;
  if (isProviderSettings(entry)) return entry.entry === "localAi" ? { kind: "codexBackedLocal", provider: entry, status } : { kind: "codexBackedProvider", provider: entry, status };
  const selection = validCliModelSelection(settings, entry.entry);
  if (!selection) return undefined;
  return entry.entry === "claudeCli"
    ? { kind: "claudeCli", entry: "claudeCli", selection, status }
    : { kind: "codexCli", entry: "codexCli", selection, status };
}

export function selectAIEntry(settings: AISettingsState, entry: AIEntryKind | null): AISettingsState {
  const previous = normalizeOptionalAIEntryKind(settings.activeEntry);
  const nextEntry = normalizeOptionalAIEntryKind(entry);
  const next = { ...settings, activeEntry: nextEntry };
  if (previous !== nextEntry && isCliEntryKind(nextEntry)) {
    return invalidateCliEntryReadiness(next, nextEntry);
  }
  return next;
}

export function applyCliSetupSnapshot(settings: AISettingsState, snapshot: AICliSetupSnapshot): AISettingsState {
  const entry = snapshot.entry;
  const previous = settings.cliSetupByEntry[entry];
  if (shouldIgnoreCliSetupSnapshot(previous, snapshot)) return settings;
  const previousRevision = previous?.catalog?.revision || "";
  const nextRevision = snapshot.catalog?.revision || "";
  const catalogChanged = previousRevision !== nextRevision;
  const setupGenerationChanged = Boolean(previous) && previous?.setupGeneration !== snapshot.setupGeneration;
  const catalogReady = snapshot.phase === "ready" && snapshot.catalog?.entry === entry && Boolean(nextRevision);
  const currentSelection = settings.cliModelSelectionByEntry[entry];
  const selectionRemainsValid = !setupGenerationChanged && catalogReady && validateCliModelSelection(snapshot, currentSelection);
  const shouldInvalidate = setupGenerationChanged || catalogChanged || !catalogReady || !selectionRemainsValid;
  const next: AISettingsState = {
    ...settings,
    cliSetupByEntry: {
      ...settings.cliSetupByEntry,
      [entry]: snapshot,
    },
    cliModelSelectionByEntry: {
      ...settings.cliModelSelectionByEntry,
      [entry]: selectionRemainsValid ? currentSelection : null,
    },
  };
  return shouldInvalidate ? invalidateCliEntryReadiness(next, entry) : next;
}

export function applyCliSetupSnapshotAndBindSelection(
  settings: AISettingsState,
  snapshot: AICliSetupSnapshot,
  preferredSelection: AICliModelSelection | null = settings.cliModelSelectionByEntry[snapshot.entry],
): AISettingsState {
  const entry = snapshot.entry;
  const previousSelection = preferredSelection;
  const applied = applyCliSetupSnapshot(settings, snapshot);
  if (applied === settings) return settings;

  const acceptedSnapshot = applied.cliSetupByEntry[entry];
  const catalog = acceptedSnapshot?.phase === "ready"
    && acceptedSnapshot.catalog?.entry === entry
    && acceptedSnapshot.catalog.revision
    ? acceptedSnapshot.catalog
    : undefined;
  if (!catalog || !acceptedSnapshot) return applied;

  const model = previousSelection
    ? catalog.models.find((candidate) => candidate.id === previousSelection.model)
    : catalog.models.find((candidate) => candidate.isDefault);
  const effortId = previousSelection?.effort || model?.defaultEffort;
  const effort = model?.efforts.find((candidate) => candidate.id === effortId);
  const speedModeId = previousSelection?.speedMode || model?.defaultSpeedMode;
  const speedMode = model?.speedModes.find((candidate) => candidate.id === speedModeId);
  if (!model || !effort || !speedMode) return applied;

  return {
    ...applied,
    cliModelSelectionByEntry: {
      ...applied.cliModelSelectionByEntry,
      [entry]: {
        model: model.id,
        effort: effort.id,
        speedMode: speedMode.id,
        catalogRevision: catalog.revision,
        setupGeneration: acceptedSnapshot.setupGeneration,
      },
    },
  };
}

export function selectCliModel(settings: AISettingsState, entry: AICliEntryKind, modelId: string): AISettingsState {
  const snapshot = settings.cliSetupByEntry[entry];
  const catalog = snapshot?.phase === "ready" && snapshot.catalog?.entry === entry ? snapshot.catalog : undefined;
  const model = catalog?.models.find((candidate) => candidate.id === modelId);
  const defaultEffort = model?.efforts.find((effort) => effort.id === model.defaultEffort)
    || model?.efforts.find((effort) => effort.isDefault)
    || model?.efforts[0];
  const defaultSpeedMode = model?.speedModes.find((speedMode) => speedMode.id === model.defaultSpeedMode)
    || model?.speedModes.find((speedMode) => speedMode.isDefault)
    || model?.speedModes[0];
  const selection = snapshot && model && defaultEffort && defaultSpeedMode && catalog
    ? { model: model.id, effort: defaultEffort.id, speedMode: defaultSpeedMode.id, catalogRevision: catalog.revision, setupGeneration: snapshot.setupGeneration }
    : null;
  return {
    ...settings,
    cliModelSelectionByEntry: {
      ...settings.cliModelSelectionByEntry,
      [entry]: selection,
    },
  };
}

function shouldIgnoreCliSetupSnapshot(
  previous: AICliSetupSnapshot | null | undefined,
  next: AICliSetupSnapshot,
): boolean {
  if (!previous) return false;
  if (next.setupGeneration < previous.setupGeneration) return true;
  if (next.setupGeneration > previous.setupGeneration) return false;
  const transitionalPhases = new Set<AICliSetupSnapshot["phase"]>(["inspecting", "authenticating", "loadingCatalog"]);
  const previousIsTransitional = transitionalPhases.has(previous.phase) || previous.update.state === "running";
  const nextIsTransitional = transitionalPhases.has(next.phase) || next.update.state === "running";
  return !previousIsTransitional && nextIsTransitional;
}

export function selectCliEffort(settings: AISettingsState, entry: AICliEntryKind, effortId: string): AISettingsState {
  const snapshot = settings.cliSetupByEntry[entry];
  const current = settings.cliModelSelectionByEntry[entry];
  const model = snapshot?.phase === "ready" && snapshot.catalog?.entry === entry
    ? snapshot.catalog.models.find((candidate) => candidate.id === current?.model)
    : undefined;
  const effort = model?.efforts.find((candidate) => candidate.id === effortId);
  const selection = current && effort && snapshot?.catalog
    ? { model: current.model, effort: effort.id, speedMode: current.speedMode, catalogRevision: snapshot.catalog.revision, setupGeneration: snapshot.setupGeneration }
    : null;
  return {
    ...settings,
    cliModelSelectionByEntry: {
      ...settings.cliModelSelectionByEntry,
      [entry]: selection,
    },
  };
}

export function selectCliSpeedMode(settings: AISettingsState, entry: AICliEntryKind, speedModeId: string): AISettingsState {
  const snapshot = settings.cliSetupByEntry[entry];
  const current = settings.cliModelSelectionByEntry[entry];
  const model = snapshot?.phase === "ready" && snapshot.catalog?.entry === entry
    ? snapshot.catalog.models.find((candidate) => candidate.id === current?.model)
    : undefined;
  const speedMode = model?.speedModes.find((candidate) => candidate.id === speedModeId);
  const selection = current && speedMode && snapshot?.catalog
    ? { model: current.model, effort: current.effort, speedMode: speedMode.id, catalogRevision: snapshot.catalog.revision, setupGeneration: snapshot.setupGeneration }
    : null;
  return {
    ...settings,
    cliModelSelectionByEntry: {
      ...settings.cliModelSelectionByEntry,
      [entry]: selection,
    },
  };
}

export function validateCliModelSelection(
  snapshot: AICliSetupSnapshot | null | undefined,
  selection: AICliModelSelection | null | undefined,
): selection is AICliModelSelection {
  if (!snapshot || snapshot.phase !== "ready" || !snapshot.catalog || !selection) return false;
  if (
    snapshot.catalog.entry !== snapshot.entry
    || selection.catalogRevision !== snapshot.catalog.revision
    || selection.setupGeneration !== snapshot.setupGeneration
  ) return false;
  const model = snapshot.catalog.models.find((candidate) => candidate.id === selection.model);
  return Boolean(
    model?.efforts.some((effort) => effort.id === selection.effort)
    && model.speedModes.some((speedMode) => speedMode.id === selection.speedMode),
  );
}

export function validCliModelSelection(settings: AISettingsState, entry: AICliEntryKind): AICliModelSelection | null {
  const selection = settings.cliModelSelectionByEntry[entry];
  return validateCliModelSelection(settings.cliSetupByEntry[entry], selection) ? selection : null;
}

export function activeAIRuleFileName(settings: AISettingsState): "AGENTS.md" | "CLAUDE.md" | null {
  const entry = normalizeOptionalAIEntryKind(settings.activeEntry);
  if (!entry) return null;
  return aiRuleFileNameForEntry(entry);
}

export function aiRuleFileNameForEntry(entry: AIEntryKind): "AGENTS.md" | "CLAUDE.md" {
  return entry === "claudeCli" ? "CLAUDE.md" : "AGENTS.md";
}

export function activeAIModelBehavior(settings: AISettingsState): AIModelBehavior {
  const entry = normalizeOptionalAIEntryKind(settings.activeEntry);
  if (!entry) return { kind: "none" };
  return aiModelBehavior(settings, entry);
}

export function aiModelBehavior(settings: AISettingsState, entry: AIEntryKind): AIModelBehavior {
  const normalized = normalizeAIEntryKind(entry);
  return normalizeAIModelBehavior(settings.modelBehaviorByEntry[normalized], aiModelBehaviorCapability(settings, normalized));
}

export function aiModelBehaviorCapability(settings: AISettingsState, entry: AIEntryKind): AIModelBehaviorCapability {
  return modelBehaviorCapabilityForEntry(settings.entries[normalizeAIEntryKind(entry)]);
}

export function updateAIModelBehavior(settings: AISettingsState, entry: AIEntryKind, behavior: AIModelBehavior): AISettingsState {
  const normalized = normalizeAIEntryKind(entry);
  return {
    ...settings,
    modelBehaviorByEntry: {
      ...settings.modelBehaviorByEntry,
      [normalized]: normalizeAIModelBehavior(behavior, aiModelBehaviorCapability(settings, normalized)),
    },
  };
}

export function aiEntrySettings(settings: AISettingsState, entry: AIEntryKind): AIEntrySettings {
  return settings.entries[entry];
}

export function aiEntryProvider(settings: AISettingsState, entry: AIProviderEntryKind): AIProviderSettings {
  return settings.entries[entry] as AIProviderSettings;
}

export function aiEntryCli(settings: AISettingsState, entry: AICliEntryKind): CliAIEntrySettings {
  return settings.entries[entry] as CliAIEntrySettings;
}

export function isProviderEntryKind(entry: AIEntryKind | null): entry is AIProviderEntryKind {
  return entry === "aiApi" || entry === "localAi";
}

export function isCliEntryKind(entry: AIEntryKind | null): entry is AICliEntryKind {
  return entry === "codexCli" || entry === "claudeCli";
}

export function isProviderSettings(entry: AIEntrySettings | null): entry is AIProviderSettings {
  return Boolean(entry && isProviderEntryKind(entry.entry));
}

export function isCliSettings(entry: AIEntrySettings | null): entry is CliAIEntrySettings {
  return Boolean(entry && isCliEntryKind(entry.entry));
}

export function aiConfigured(entry: AIEntrySettings | null): boolean {
  if (!entry) return false;
  if (isCliSettings(entry)) return entry.authState === "configured";
  if (!entry.model.trim()) return false;
  if (entry.entry === "aiApi") return Boolean(entry.credential?.trim());
  return Boolean(entry.baseUrl.trim());
}

export function aiReady(entry: AIEntrySettings | null): boolean {
  if (!entry) return false;
  if (isCliSettings(entry)) {
    return entry.authState === "configured" && entry.readOnlyWrapperState === "ready" && entry.executionMode === "repoWrite";
  }
  if (!aiConfigured(entry)) return false;
  if (entry.provider === "openaiCompatible" || entry.provider === "custom") return Boolean(entry.baseUrl.trim());
  return true;
}

export function storedAIStatus(settings: AISettingsState, entry: AIEntryKind): AIConnectionStatus | null {
  return settings.statuses[entry] || null;
}

export function aiVerifiedReady(settings: AISettingsState, entry: AIEntryKind | null): boolean {
  if (!entry) return false;
  return effectiveAIStatus(settings, entry).state === "ready";
}

export function derivedAIStatus(entry: AIEntrySettings | null): AIConnectionStatus {
  if (!entry) {
    return aiStatus("notConfigured", "not_configured", "info", "No active AI Entry is selected.", "Select one entry before running checks or sending AI Chat.");
  }
  if (isCliSettings(entry)) {
    if (aiReady(entry)) {
      return aiStatus("ready", "success", "success", entry.readinessMessage || "CLI Current repo execution is ready.", "Use this entry for AI Chat or check again.", entry.lastCheckedAt || "");
    }
    if (entry.authState === "configured") {
      return aiStatus("configured", "wrapper_not_ready", "warning", entry.readinessMessage || "CLI auth is configured, but the repo-scoped write wrapper is not confirmed.", "Run readiness check for this CLI entry.", entry.lastCheckedAt || "");
    }
    if (entry.authState === "notConfigured") {
      return aiStatus("notConfigured", "cli_auth_missing", "warning", entry.readinessMessage || "CLI auth is not configured.", "Complete persistent sign-in with the CLI outside Local Reader App, then check readiness again.", entry.lastCheckedAt || "");
    }
    return aiStatus("notConfigured", "needs_test", "info", entry.readinessMessage || "CLI readiness has not been checked.", "Run readiness check for this CLI entry.", entry.lastCheckedAt || "");
  }
  if (aiConfigured(entry)) {
    const mode = providerExecutionMode(entry);
    return aiStatus(
      "configured",
      "needs_test",
      "warning",
      "Endpoint, model, and access policy readiness have not been tested.",
      `Check readiness before using this ${mode === "repoWrite" ? "Current repo write" : "context-only"} entry for AI Chat.`,
    );
  }
  return aiStatus("notConfigured", "not_configured", "info", "Connection settings are incomplete.", providerNextAction(entry));
}

export function effectiveAIStatus(settings: AISettingsState, entry: AIEntryKind): AIConnectionStatus {
  const normalized = normalizeAIEntryKind(entry);
  return storedAIStatus(settings, normalized) || derivedAIStatus(settings.entries[normalized]);
}

export function updateAIEntry(settings: AISettingsState, entry: AIEntryKind, update: Partial<AIEntrySettings>): AISettingsState {
  const normalized = normalizeAIEntryKind(entry);
  const next: AISettingsState = {
    ...settings,
    entries: {
      ...settings.entries,
      [normalized]: { ...settings.entries[normalized], ...update, entry: normalized } as AIEntrySettings,
    },
    statuses: {
      ...settings.statuses,
      [normalized]: null,
    },
    lastCheckedAtByEntry: {
      ...settings.lastCheckedAtByEntry,
      [normalized]: "",
    },
  };
  if (!isCliEntryKind(normalized)) return next;
  return {
    ...next,
    cliSetupByEntry: { ...next.cliSetupByEntry, [normalized]: null },
    cliModelSelectionByEntry: { ...next.cliModelSelectionByEntry, [normalized]: null },
  };
}

export function updateAIEntryStatus(settings: AISettingsState, entry: AIEntryKind, status: AIConnectionStatus): AISettingsState {
  const normalized = normalizeAIEntryKind(entry);
  return {
    ...settings,
    statuses: {
      ...settings.statuses,
      [normalized]: status,
    },
    lastCheckedAtByEntry: {
      ...settings.lastCheckedAtByEntry,
      [normalized]: status.checkedAt,
    },
    entries: {
      ...settings.entries,
      [normalized]: { ...settings.entries[normalized], lastCheckedAt: status.checkedAt } as AIEntrySettings,
    },
  };
}

export function invalidateAIReadiness(settings: AISettingsState): AISettingsState {
  return {
    ...settings,
    entries: {
      ...settings.entries,
      codexCli: { ...settings.entries.codexCli, readOnlyWrapperState: "unknown", executionMode: "unknown", lastCheckedAt: "" } as CliAIEntrySettings,
      claudeCli: { ...settings.entries.claudeCli, readOnlyWrapperState: "unknown", executionMode: "unknown", lastCheckedAt: "" } as CliAIEntrySettings,
    },
    statuses: { aiApi: null, localAi: null, codexCli: null, claudeCli: null },
    lastCheckedAtByEntry: { aiApi: "", localAi: "", codexCli: "", claudeCli: "" },
    cliModelSelectionByEntry: { codexCli: null, claudeCli: null },
  };
}

export function invalidateCliReadinessForRepositoryChange(
  settings: AISettingsState,
  readinessMessage = "The Current repo changed. Run readiness again before sending.",
): AISettingsState {
  return {
    ...settings,
    entries: {
      ...settings.entries,
      codexCli: {
        ...settings.entries.codexCli,
        readOnlyWrapperState: "unknown",
        executionMode: "unknown",
        lastCheckedAt: "",
        readinessMessage,
      } as CliAIEntrySettings,
      claudeCli: {
        ...settings.entries.claudeCli,
        readOnlyWrapperState: "unknown",
        executionMode: "unknown",
        lastCheckedAt: "",
        readinessMessage,
      } as CliAIEntrySettings,
    },
    statuses: { ...settings.statuses, codexCli: null, claudeCli: null },
    lastCheckedAtByEntry: { ...settings.lastCheckedAtByEntry, codexCli: "", claudeCli: "" },
  };
}

function invalidateCliEntryReadiness(settings: AISettingsState, entry: AICliEntryKind): AISettingsState {
  return {
    ...settings,
    entries: {
      ...settings.entries,
      [entry]: {
        ...settings.entries[entry],
        readOnlyWrapperState: "unknown",
        executionMode: "unknown",
        lastCheckedAt: "",
      } as CliAIEntrySettings,
    },
    statuses: { ...settings.statuses, [entry]: null },
    lastCheckedAtByEntry: { ...settings.lastCheckedAtByEntry, [entry]: "" },
  };
}

export function updateCliEntryReadiness(settings: AISettingsState, readiness: CliAIEntryReadiness): AISettingsState {
  const entry = normalizeAIEntryKind(readiness.entry);
  const status = readiness.status;
  const nextEntry = isProviderEntryKind(entry)
    ? mergeProviderReadinessSettings(settings.entries[entry] as AIProviderSettings, readiness.settings as AIProviderSettings)
    : readiness.settings;
  return {
    ...settings,
    entries: {
      ...settings.entries,
      [entry]: nextEntry,
    },
    statuses: {
      ...settings.statuses,
      [entry]: status,
    },
    lastCheckedAtByEntry: {
      ...settings.lastCheckedAtByEntry,
      [entry]: status.checkedAt,
    },
  };
}

function mergeProviderReadinessSettings(current: AIProviderSettings, response: AIProviderSettings): AIProviderSettings {
  const { credential: _responseCredential, ...publicResponse } = response;
  return { ...current, ...publicResponse, credential: current.credential };
}

export function normalizeAISettingsState(value: AISettingsState): AISettingsState {
  const activeEntry = normalizeOptionalAIEntryKind(value.activeEntry);
  const entries = value.entries as Partial<Record<AIEntryKind, AIEntrySettings>>;
  const statuses = value.statuses as Partial<Record<AIEntryKind, AIConnectionStatus | null>>;
  const checkedAtByEntry = value.lastCheckedAtByEntry as Partial<Record<AIEntryKind, string>>;
  const modelBehaviorByEntry = (value.modelBehaviorByEntry || {}) as Partial<Record<AIEntryKind, AIModelBehavior>>;
  const cliSetupByEntry = (value.cliSetupByEntry || {}) as Partial<Record<AICliEntryKind, AICliSetupSnapshot | null>>;
  const cliModelSelectionByEntry = (value.cliModelSelectionByEntry || {}) as Partial<Record<AICliEntryKind, AICliModelSelection | null>>;
  const nextEntries = {
    aiApi: normalizeProviderSettings("aiApi", entries.aiApi),
    localAi: normalizeProviderSettings("localAi", entries.localAi),
    codexCli: normalizeCliSettings("codexCli", entries.codexCli),
    claudeCli: normalizeCliSettings("claudeCli", entries.claudeCli),
  };
  const normalizedSetupByEntry: Record<AICliEntryKind, AICliSetupSnapshot | null> = {
    codexCli: normalizeCliSetupSnapshot("codexCli", cliSetupByEntry.codexCli),
    claudeCli: normalizeCliSetupSnapshot("claudeCli", cliSetupByEntry.claudeCli),
  };
  const next: AISettingsState = {
    activeEntry,
    entries: nextEntries,
    statuses: {
      aiApi: statuses.aiApi || null,
      localAi: statuses.localAi || null,
      codexCli: statuses.codexCli || null,
      claudeCli: statuses.claudeCli || null,
    },
    lastCheckedAtByEntry: {
      aiApi: checkedAtByEntry.aiApi || "",
      localAi: checkedAtByEntry.localAi || "",
      codexCli: checkedAtByEntry.codexCli || "",
      claudeCli: checkedAtByEntry.claudeCli || "",
    },
    modelBehaviorByEntry: {
      aiApi: normalizeAIModelBehavior(modelBehaviorByEntry.aiApi, modelBehaviorCapabilityForEntry(nextEntries.aiApi)),
      localAi: normalizeAIModelBehavior(modelBehaviorByEntry.localAi, modelBehaviorCapabilityForEntry(nextEntries.localAi)),
      codexCli: normalizeAIModelBehavior(modelBehaviorByEntry.codexCli, modelBehaviorCapabilityForEntry(nextEntries.codexCli)),
      claudeCli: normalizeAIModelBehavior(modelBehaviorByEntry.claudeCli, modelBehaviorCapabilityForEntry(nextEntries.claudeCli)),
    },
    cliSetupByEntry: normalizedSetupByEntry,
    cliModelSelectionByEntry: {
      codexCli: null,
      claudeCli: null,
    },
  };
  for (const entry of ["codexCli", "claudeCli"] as const) {
    const selection = cliModelSelectionByEntry[entry];
    if (validateCliModelSelection(normalizedSetupByEntry[entry], selection)) {
      next.cliModelSelectionByEntry[entry] = selection;
    }
  }
  return next;
}

function normalizeCliSetupSnapshot(entry: AICliEntryKind, snapshot: AICliSetupSnapshot | null | undefined): AICliSetupSnapshot | null {
  if (!snapshot || snapshot.entry !== entry) return null;
  return snapshot;
}

export function normalizeReaderFontScale(value: unknown): ReaderFontScale {
  const numericValue = typeof value === "number" ? value : Number(value);
  return READER_FONT_SCALE_OPTIONS.find((option) => option === numericValue) ?? 1;
}

export function formatReaderFontScaleLabel(scale: ReaderFontScale): string {
  return `×${normalizeReaderFontScale(scale)}`;
}

function normalizeLegacyFontSize(value: unknown): ReaderFontScale {
  if (value === "large") return 1.5;
  return 1;
}

function normalizeBasicSettings(value: Partial<BasicSettings> & { fontSize?: unknown }): BasicSettings {
  return {
    readerFontScale: value.readerFontScale === undefined ? normalizeLegacyFontSize(value.fontSize) : normalizeReaderFontScale(value.readerFontScale),
    aiChatFontScale: normalizeReaderFontScale(value.aiChatFontScale),
    colorMode: value.colorMode === "dark" ? "dark" : "light",
    layout: value.layout === "compact" || value.layout === "focused" ? value.layout : "comfortable",
  };
}

function normalizeCliSettings(entry: AICliEntryKind, value: AIEntrySettings | undefined): CliAIEntrySettings {
  const source = value as Partial<CliAIEntrySettings> | undefined;
  const defaults = defaultAISettings.entries[entry] as CliAIEntrySettings;
  return {
    entry,
    binaryName: entry === "codexCli" ? "codex" : "claude",
    version: typeof source?.version === "string" ? source.version : defaults.version,
    authState: source?.authState === "configured" || source?.authState === "notConfigured" ? source.authState : defaults.authState,
    readOnlyWrapperState: source?.readOnlyWrapperState === "ready" || source?.readOnlyWrapperState === "notReady" ? source.readOnlyWrapperState : defaults.readOnlyWrapperState,
    executionMode: source?.executionMode === "readOnly" || source?.executionMode === "repoWrite" ? source.executionMode : defaults.executionMode,
    lastCheckedAt: typeof source?.lastCheckedAt === "string" ? source.lastCheckedAt : defaults.lastCheckedAt,
    readinessMessage: typeof source?.readinessMessage === "string" ? source.readinessMessage : defaults.readinessMessage,
  };
}

function normalizeProviderSettings(entry: AIProviderEntryKind, value: AIEntrySettings | undefined): AIProviderSettings {
  const source = value as Partial<AIProviderSettings> | undefined;
  const defaults = defaultAISettings.entries[entry] as AIProviderSettings;
  return {
    ...defaults,
    ...source,
    entry,
    executionMode: source?.executionMode === "repoWrite" ? "repoWrite" : "readOnly",
  };
}

export function providerExecutionMode(entry: AIProviderSettings): "readOnly" | "repoWrite" {
  return entry.executionMode === "repoWrite" ? "repoWrite" : "readOnly";
}

function normalizeOptionalAIEntryKind(entry: unknown): AIEntryKind | null {
  if (entry == null || entry === "") return null;
  if (entry === "aiApi" || entry === "localAi" || entry === "codexCli" || entry === "claudeCli") return entry;
  return null;
}

function normalizeAIEntryKind(entry: unknown): AIEntryKind {
  if (entry === "aiApi" || entry === "localAi" || entry === "codexCli" || entry === "claudeCli") return entry;
  return "aiApi";
}

function modelBehaviorCapabilityForEntry(entry: AIEntrySettings): AIModelBehaviorCapability {
  if (isCliSettings(entry)) {
    if (entry.entry === "codexCli") {
      return {
        kind: "intelligence",
        label: "Codex intelligence",
        description: "Choose the response depth used by Codex CLI.",
        levels: ["low", "medium", "high", "xhigh"],
      };
    }
    return {
      kind: "none",
      label: "Claude Code default",
      description: "Claude Code CLI uses its configured default model behavior.",
    };
  }

  const model = entry.model.trim().toLowerCase();
  const provider = (entry.provider || "").toLowerCase();
  const runtime = (entry.runtime || "").toLowerCase();
  if (model.includes("qwen")) {
    return {
      kind: "thinking",
      label: "Thinking mode",
      description: "Toggle thinking mode for Qwen-style models when the endpoint supports it.",
    };
  }
  if (provider === "openai" || model.startsWith("gpt-") || /^o\d/.test(model) || model.includes("gpt")) {
    return {
      kind: "intelligence",
      label: "Intelligence",
      description: "Choose the response depth for GPT-style models.",
      levels: ["low", "medium", "high"],
    };
  }
  if (entry.entry === "localAi" && (runtime === "ollama" || provider === "openaicompatible")) {
    return {
      kind: "none",
      label: "Model default",
      description: "This local model does not advertise a Local Reader App behavior control.",
    };
  }
  return {
    kind: "none",
    label: "Model default",
    description: "No behavior control is available for this active model.",
  };
}

function normalizeAIModelBehavior(value: AIModelBehavior | undefined, capability: AIModelBehaviorCapability): AIModelBehavior {
  if (capability.kind === "intelligence") {
    const level = value?.kind === "intelligence" && capability.levels.includes(value.level) ? value.level : "medium";
    return { kind: "intelligence", level };
  }
  if (capability.kind === "thinking") {
    return { kind: "thinking", enabled: value?.kind === "thinking" ? value.enabled === true : true };
  }
  return { kind: "none" };
}

function aiStatus(
  state: AIConnectionStatus["state"],
  code: NonNullable<AIConnectionStatus["code"]>,
  severity: NonNullable<AIConnectionStatus["severity"]>,
  message: string,
  nextAction: string,
  checkedAt = "",
  detail = "",
): AIConnectionStatus {
  return { state, code, severity, message, nextAction, checkedAt, ...(detail ? { detail } : {}) };
}

function providerNextAction(entry: AIProviderSettings): string {
  if (!entry.model.trim()) return "Enter a model name.";
  if (entry.entry === "aiApi" && !entry.credential?.trim()) return "Enter the API credential for this provider.";
  if (!entry.baseUrl.trim() && (entry.entry === "localAi" || entry.provider === "openaiCompatible" || entry.provider === "custom")) return "Enter the endpoint URL.";
  return "Complete the connection fields.";
}
