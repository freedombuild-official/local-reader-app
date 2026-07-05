import type { AIChatExecutionTarget, AIConnectionStatus, AICliEntryKind, AIEntryKind, AIEntrySettings, AIProviderEntryKind, AIProviderSettings, CliAIEntryReadiness, CliAIEntrySettings } from "./types";

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
};

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
      readinessMessage: "Run readiness check before using this entry.",
    },
    claudeCli: {
      entry: "claudeCli",
      binaryName: "claude",
      version: "",
      authState: "unknown",
      readOnlyWrapperState: "unknown",
      executionMode: "unknown",
      readinessMessage: "Run readiness check before using this entry.",
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
  if (!entry || !aiVerifiedReady(settings, entry.entry)) return null;
  if (isProviderSettings(entry)) return { kind: "provider", provider: entry };
  return { kind: "cli", entry: entry.entry };
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
    return entry.authState === "configured" && entry.readOnlyWrapperState === "ready" && entry.executionMode === "readOnly";
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
      return aiStatus("ready", "success", "success", entry.readinessMessage || "CLI read-only wrapper is ready.", "Use this entry for read-only AI Chat or check again.", entry.lastCheckedAt || "");
    }
    if (entry.authState === "configured") {
      return aiStatus("configured", "wrapper_not_ready", "warning", entry.readinessMessage || "CLI auth is configured, but the read-only wrapper is not confirmed.", "Run readiness check for this CLI entry.", entry.lastCheckedAt || "");
    }
    if (entry.authState === "notConfigured") {
      return aiStatus("notConfigured", "cli_auth_missing", "warning", entry.readinessMessage || "CLI auth is not configured.", "Sign in with the CLI outside Reader-Wiki, then check readiness again.", entry.lastCheckedAt || "");
    }
    return aiStatus("notConfigured", "needs_test", "info", entry.readinessMessage || "CLI readiness has not been checked.", "Run readiness check for this CLI entry.", entry.lastCheckedAt || "");
  }
  if (aiConfigured(entry)) {
    return aiStatus("configured", "needs_test", "warning", "Connection has not been tested.", "Test this entry before using it for AI Chat.");
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

export function updateCliEntryReadiness(settings: AISettingsState, readiness: CliAIEntryReadiness): AISettingsState {
  const entry = normalizeAIEntryKind(readiness.entry) as AICliEntryKind;
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
  return {
    activeEntry,
    entries: {
      aiApi: { ...defaultAISettings.entries.aiApi, ...(entries.aiApi || {}), entry: "aiApi" } as AIProviderSettings,
      localAi: { ...defaultAISettings.entries.localAi, ...(entries.localAi || {}), entry: "localAi" } as AIProviderSettings,
      codexCli: normalizeCliSettings("codexCli", entries.codexCli),
      claudeCli: normalizeCliSettings("claudeCli", entries.claudeCli),
    },
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
    executionMode: source?.executionMode === "readOnly" ? "readOnly" : defaults.executionMode,
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
