import type {
  AIChatExecutionTarget,
  AIConnectionStatus,
  AICliEntryKind,
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
  colorMode: "light" | "dark";
  layout: "compact" | "comfortable" | "focused";
};

export type AISettingsState = {
  activeEntry: AIEntryKind | null;
  entries: Record<AIEntryKind, AIEntrySettings>;
  statuses: Record<AIEntryKind, AIConnectionStatus | null>;
  lastCheckedAtByEntry: Record<AIEntryKind, string>;
  modelBehaviorByEntry: Record<AIEntryKind, AIModelBehavior>;
};

export type AIModelBehaviorCapability =
  | { kind: "none"; label: string; description: string }
  | { kind: "intelligence"; label: string; description: string; levels: AIIntelligenceLevel[] }
  | { kind: "thinking"; label: string; description: string };

const BASIC_SETTINGS_KEY = "readerWiki.basicSettings.v1";

export const defaultBasicSettings: BasicSettings = {
  readerFontScale: 1,
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
    },
    localAi: {
      entry: "localAi",
      runtime: "ollama",
      model: "",
      baseUrl: "http://127.0.0.1:11434/v1",
      apiFormat: "openaiCompatible",
      credential: "",
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

export function activeAIChatTarget(settings: AISettingsState): AIChatExecutionTarget | null {
  const entry = activeAIEntry(settings);
  if (!entry) return null;
  const status = effectiveAIStatus(settings, entry.entry);
  if (status.state !== "ready" || !aiReady(entry)) return null;
  if (isProviderSettings(entry)) return entry.entry === "localAi" ? { kind: "codexBackedLocal", provider: entry, status } : { kind: "codexBackedProvider", provider: entry, status };
  return entry.entry === "claudeCli" ? { kind: "claudeCli", entry: "claudeCli", status } : { kind: "codexCli", entry: "codexCli", status };
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
      return aiStatus("ready", "success", "success", entry.readinessMessage || "CLI Current repo write wrapper is ready.", "Use this entry for Current repo AI Chat or check again.", entry.lastCheckedAt || "");
    }
    if (entry.authState === "configured") {
      return aiStatus("configured", "wrapper_not_ready", "warning", entry.readinessMessage || "CLI auth is configured, but the repo-scoped write wrapper is not confirmed.", "Run readiness check for this CLI entry.", entry.lastCheckedAt || "");
    }
    if (entry.authState === "notConfigured") {
      return aiStatus("notConfigured", "cli_auth_missing", "warning", entry.readinessMessage || "CLI auth is not configured.", "Complete persistent sign-in with the CLI outside Reader-Wiki, then check readiness again.", entry.lastCheckedAt || "");
    }
    return aiStatus("notConfigured", "needs_test", "info", entry.readinessMessage || "CLI readiness has not been checked.", "Run readiness check for this CLI entry.", entry.lastCheckedAt || "");
  }
  if (aiConfigured(entry)) {
    return aiStatus("configured", "needs_test", "warning", "Endpoint and model readiness have not been tested.", "Check readiness before using this context-only entry for AI Chat.");
  }
  return aiStatus("notConfigured", "not_configured", "info", "Connection settings are incomplete.", providerNextAction(entry));
}

export function effectiveAIStatus(settings: AISettingsState, entry: AIEntryKind): AIConnectionStatus {
  const normalized = normalizeAIEntryKind(entry);
  return storedAIStatus(settings, normalized) || derivedAIStatus(settings.entries[normalized]);
}

export function updateAIEntry(settings: AISettingsState, entry: AIEntryKind, update: Partial<AIEntrySettings>): AISettingsState {
  const normalized = normalizeAIEntryKind(entry);
  return {
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
  };
}

export function updateCliEntryReadiness(settings: AISettingsState, readiness: CliAIEntryReadiness): AISettingsState {
  const entry = normalizeAIEntryKind(readiness.entry);
  const status = readiness.status;
  return {
    ...settings,
    entries: {
      ...settings.entries,
      [entry]: readiness.settings,
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

export function normalizeAISettingsState(value: AISettingsState): AISettingsState {
  const activeEntry = normalizeOptionalAIEntryKind(value.activeEntry);
  const entries = value.entries as Partial<Record<AIEntryKind, AIEntrySettings>>;
  const statuses = value.statuses as Partial<Record<AIEntryKind, AIConnectionStatus | null>>;
  const checkedAtByEntry = value.lastCheckedAtByEntry as Partial<Record<AIEntryKind, string>>;
  const modelBehaviorByEntry = (value.modelBehaviorByEntry || {}) as Partial<Record<AIEntryKind, AIModelBehavior>>;
  const nextEntries = {
    aiApi: { ...defaultAISettings.entries.aiApi, ...(entries.aiApi || {}), entry: "aiApi" } as AIProviderSettings,
    localAi: { ...defaultAISettings.entries.localAi, ...(entries.localAi || {}), entry: "localAi" } as AIProviderSettings,
    codexCli: normalizeCliSettings("codexCli", entries.codexCli),
    claudeCli: normalizeCliSettings("claudeCli", entries.claudeCli),
  };
  return {
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
  };
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
        description: "Choose the response depth used when the Codex CLI write adapter receives the chat prompt.",
        levels: ["low", "medium", "high", "xhigh"],
      };
    }
    return {
      kind: "none",
      label: "Claude Code default",
      description: "Claude Code CLI uses its configured default model behavior. Reader-Wiki does not override it.",
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
      description: "This local model does not advertise a Reader-Wiki behavior control.",
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
