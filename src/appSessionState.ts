import {
  applyCliSetupSnapshotAndBindSelection,
  defaultAISettings,
  validateCliModelSelection,
  type AISettingsState,
} from "./settingsState";
import type {
  AICliEntryKind,
  AICliModelSelection,
  AICliSetupSnapshot,
  AIChatContextChip,
  AIChatMessage,
  AIChatSessionState,
  AIConnectionStatus,
  AIModelBehavior,
  CliAIEntrySettings,
} from "./types";

export const AI_WORKSPACE_SESSION_STORAGE_KEY = "readerWiki.aiWorkspaceSession.v1";
export const AI_WORKSPACE_SESSION_VERSION = 1;
export const AI_WORKSPACE_SESSION_MAX_BYTES = 4 * 1024 * 1024;
export const AI_CHAT_RELOAD_INTERRUPTION_MESSAGE = "AI Chat request was interrupted by a page reload.";

const CLI_ENTRIES = ["codexCli", "claudeCli"] as const satisfies readonly AICliEntryKind[];
const MAX_REPOSITORIES = 32;
const MAX_MESSAGES_PER_REPOSITORY = 200;
const MAX_CONTEXT_CHIPS_PER_REPOSITORY = 128;
const MAX_DISMISSED_KEYS_PER_REPOSITORY = 256;
const MAX_REPO_ID_LENGTH = 512;
const MAX_SHORT_STRING_LENGTH = 512;
const MAX_PATH_LENGTH = 4_096;
const MAX_STATUS_STRING_LENGTH = 8_192;
const MAX_CHAT_STRING_LENGTH = 128 * 1024;

type CliEntryRecord<T> = Record<AICliEntryKind, T>;

export type AIWorkspaceSessionState = {
  activeRepoId: string;
  activeEntry: AICliEntryKind | null;
  cliEntries: CliEntryRecord<CliAIEntrySettings>;
  statuses: CliEntryRecord<AIConnectionStatus | null>;
  lastCheckedAtByEntry: CliEntryRecord<string>;
  modelBehaviorByEntry: CliEntryRecord<AIModelBehavior>;
  cliModelSelectionByEntry: CliEntryRecord<AICliModelSelection | null>;
  aiChatSessionsByRepo: Record<string, AIChatSessionState>;
};

export type AIWorkspaceSessionLoadResult = {
  state: AIWorkspaceSessionState;
  error: string;
};

type StoredAIChatSession = {
  messages: AIChatMessage[];
  draft: string;
  pending: boolean;
  lastRequest: string;
  contextChips: AIChatContextChip[];
  dismissedRulePathKeys: string[];
};

type StoredAIWorkspaceSession = {
  version: typeof AI_WORKSPACE_SESSION_VERSION;
  activeRepoId: string;
  activeEntry: AICliEntryKind | null;
  cliEntries: CliEntryRecord<CliAIEntrySettings>;
  statuses: CliEntryRecord<AIConnectionStatus | null>;
  lastCheckedAtByEntry: CliEntryRecord<string>;
  modelBehaviorByEntry: CliEntryRecord<AIModelBehavior>;
  cliModelSelectionByEntry: CliEntryRecord<AICliModelSelection | null>;
  aiChatSessionsByRepo: Record<string, StoredAIChatSession>;
};

class SessionSchemaError extends Error {}

export function createDefaultAIChatSession(): AIChatSessionState {
  return {
    messages: [],
    draft: "",
    pending: false,
    error: "",
    requestKey: "",
    refreshingRepository: false,
    repositoryRefreshError: "",
    suppressRequestRetry: false,
    lastRequest: "",
    attachments: [],
    contextChips: [],
    dismissedRulePathKeys: [],
  };
}

export function createDefaultAIWorkspaceSession(): AIWorkspaceSessionState {
  return {
    activeRepoId: "",
    activeEntry: null,
    cliEntries: {
      codexCli: { ...(defaultAISettings.entries.codexCli as CliAIEntrySettings) },
      claudeCli: { ...(defaultAISettings.entries.claudeCli as CliAIEntrySettings) },
    },
    statuses: { codexCli: null, claudeCli: null },
    lastCheckedAtByEntry: { codexCli: "", claudeCli: "" },
    modelBehaviorByEntry: {
      codexCli: { ...defaultAISettings.modelBehaviorByEntry.codexCli },
      claudeCli: { ...defaultAISettings.modelBehaviorByEntry.claudeCli },
    },
    cliModelSelectionByEntry: { codexCli: null, claudeCli: null },
    aiChatSessionsByRepo: {},
  };
}

export function createAISettingsFromWorkspaceSession(persisted: AIWorkspaceSessionState): AISettingsState {
  return {
    ...defaultAISettings,
    activeEntry: persisted.activeEntry,
    entries: {
      aiApi: { ...defaultAISettings.entries.aiApi },
      localAi: { ...defaultAISettings.entries.localAi },
      codexCli: { ...persisted.cliEntries.codexCli },
      claudeCli: { ...persisted.cliEntries.claudeCli },
    },
    statuses: {
      aiApi: null,
      localAi: null,
      codexCli: persisted.statuses.codexCli ? { ...persisted.statuses.codexCli } : null,
      claudeCli: persisted.statuses.claudeCli ? { ...persisted.statuses.claudeCli } : null,
    },
    lastCheckedAtByEntry: {
      aiApi: "",
      localAi: "",
      codexCli: persisted.lastCheckedAtByEntry.codexCli,
      claudeCli: persisted.lastCheckedAtByEntry.claudeCli,
    },
    modelBehaviorByEntry: {
      aiApi: { ...defaultAISettings.modelBehaviorByEntry.aiApi },
      localAi: { ...defaultAISettings.modelBehaviorByEntry.localAi },
      codexCli: { ...persisted.modelBehaviorByEntry.codexCli },
      claudeCli: { ...persisted.modelBehaviorByEntry.claudeCli },
    },
    cliSetupByEntry: { codexCli: null, claudeCli: null },
    cliModelSelectionByEntry: {
      codexCli: persisted.cliModelSelectionByEntry.codexCli ? { ...persisted.cliModelSelectionByEntry.codexCli } : null,
      claudeCli: persisted.cliModelSelectionByEntry.claudeCli ? { ...persisted.cliModelSelectionByEntry.claudeCli } : null,
    },
  };
}

export function createAIWorkspaceSessionState(
  activeRepoId: string,
  aiSettings: AISettingsState,
  aiChatSessionsByRepo: Record<string, AIChatSessionState>,
): AIWorkspaceSessionState {
  return {
    activeRepoId,
    activeEntry: aiSettings.activeEntry === "codexCli" || aiSettings.activeEntry === "claudeCli" ? aiSettings.activeEntry : null,
    cliEntries: {
      codexCli: normalizeCliEntry("codexCli", aiSettings.entries.codexCli),
      claudeCli: normalizeCliEntry("claudeCli", aiSettings.entries.claudeCli),
    },
    statuses: {
      codexCli: normalizeStatus(aiSettings.statuses.codexCli),
      claudeCli: normalizeStatus(aiSettings.statuses.claudeCli),
    },
    lastCheckedAtByEntry: {
      codexCli: aiSettings.lastCheckedAtByEntry.codexCli,
      claudeCli: aiSettings.lastCheckedAtByEntry.claudeCli,
    },
    modelBehaviorByEntry: {
      codexCli: normalizeModelBehavior(aiSettings.modelBehaviorByEntry.codexCli),
      claudeCli: normalizeModelBehavior(aiSettings.modelBehaviorByEntry.claudeCli),
    },
    cliModelSelectionByEntry: {
      codexCli: normalizeSelection(aiSettings.cliModelSelectionByEntry.codexCli),
      claudeCli: normalizeSelection(aiSettings.cliModelSelectionByEntry.claudeCli),
    },
    aiChatSessionsByRepo: Object.fromEntries(
      Object.entries(aiChatSessionsByRepo).map(([repoId, session]) => [repoId, {
        ...createDefaultAIChatSession(),
        messages: session.messages.map((message) => ({ role: message.role, content: message.content })),
        draft: session.draft,
        pending: session.pending,
        lastRequest: session.lastRequest,
        contextChips: session.contextChips.map((chip) => ({
          id: chip.id,
          repoId: chip.repoId,
          path: chip.path,
          kind: chip.kind,
          role: chip.role,
          source: chip.source,
          removable: chip.removable,
        })),
        dismissedRulePathKeys: [...session.dismissedRulePathKeys],
      }]),
    ),
  };
}

export function loadAIWorkspaceSession(): AIWorkspaceSessionLoadResult {
  const empty = createDefaultAIWorkspaceSession();
  const storage = browserSessionStorage();
  if (!storage) return { state: empty, error: "Browser session storage is not available." };

  try {
    const raw = storage.getItem(AI_WORKSPACE_SESSION_STORAGE_KEY);
    if (!raw) return { state: empty, error: "" };
    if (utf8ByteLength(raw) > AI_WORKSPACE_SESSION_MAX_BYTES) {
      discardSavedSession(storage);
      return { state: empty, error: "Saved AI workspace session exceeds the 4 MiB limit." };
    }
    const stored = parseStoredSession(JSON.parse(raw) as unknown);
    return { state: restoreStoredSession(stored), error: "" };
  } catch (error) {
    discardSavedSession(storage);
    return { state: empty, error: errorMessage(error) };
  }
}

export function persistAIWorkspaceSession(state: AIWorkspaceSessionState): string {
  const storage = browserSessionStorage();
  if (!storage) return "Browser session storage is not available.";

  try {
    const raw = JSON.stringify(serializeSession(state));
    if (utf8ByteLength(raw) > AI_WORKSPACE_SESSION_MAX_BYTES) {
      discardSavedSession(storage);
      return "AI workspace session exceeds the 4 MiB limit and was not saved.";
    }
    if (storage.getItem(AI_WORKSPACE_SESSION_STORAGE_KEY) === raw) return "";
    storage.setItem(AI_WORKSPACE_SESSION_STORAGE_KEY, raw);
    return "";
  } catch (error) {
    discardSavedSession(storage);
    return errorMessage(error);
  }
}

function discardSavedSession(storage: Storage): void {
  try {
    storage.removeItem(AI_WORKSPACE_SESSION_STORAGE_KEY);
  } catch {
    // The in-memory App state remains usable when browser storage is unavailable.
  }
}

/**
 * Rebinds stored model choices to the first live setup snapshot that can prove
 * the same model/effort/speed tuple is still valid. Persisted readiness is only
 * restored after that proof; setup/authentication/update snapshots never come
 * from browser storage.
 */
export function restoreAIWorkspaceCliState(
  current: AISettingsState,
  persisted: AIWorkspaceSessionState,
  currentSetupSnapshots: CliEntryRecord<AICliSetupSnapshot | null> = current.cliSetupByEntry,
): AISettingsState {
  let next: AISettingsState = {
    ...current,
    activeEntry: persisted.activeEntry || (current.activeEntry === "aiApi" || current.activeEntry === "localAi" ? current.activeEntry : null),
    modelBehaviorByEntry: {
      ...current.modelBehaviorByEntry,
      codexCli: persisted.modelBehaviorByEntry.codexCli,
      claudeCli: persisted.modelBehaviorByEntry.claudeCli,
    },
  };

  for (const entry of CLI_ENTRIES) {
    const snapshot = currentSetupSnapshots[entry];
    const hadLiveSnapshot = current.cliSetupByEntry[entry] !== null;
    next = {
      ...next,
      cliSetupByEntry: { ...next.cliSetupByEntry, [entry]: snapshot },
    };
    if (snapshot?.phase !== "ready" || !snapshot.catalog) {
      next = failClosedCliReadiness(next, entry);
      continue;
    }

    const currentSelection = validateCliModelSelection(snapshot, next.cliModelSelectionByEntry[entry])
      ? next.cliModelSelectionByEntry[entry]
      : null;
    if (hadLiveSnapshot && currentSelection) continue;
    const preferredSelection = currentSelection || persisted.cliModelSelectionByEntry[entry];
    if (!preferredSelection) {
      next = failClosedCliReadiness(next, entry);
      continue;
    }

    if (!currentSelection) {
      const withoutSnapshot: AISettingsState = {
        ...next,
        cliSetupByEntry: { ...next.cliSetupByEntry, [entry]: null },
        cliModelSelectionByEntry: { ...next.cliModelSelectionByEntry, [entry]: null },
      };
      const rebound = applyCliSetupSnapshotAndBindSelection(withoutSnapshot, snapshot, preferredSelection);
      next = {
        ...next,
        cliSetupByEntry: { ...next.cliSetupByEntry, [entry]: snapshot },
        cliModelSelectionByEntry: {
          ...next.cliModelSelectionByEntry,
          [entry]: rebound.cliModelSelectionByEntry[entry],
        },
      };
    }

    const selection = next.cliModelSelectionByEntry[entry];
    const storedSelection = persisted.cliModelSelectionByEntry[entry];
    const storedSelectionMatchesSnapshot = Boolean(
      storedSelection
      && storedSelection.catalogRevision === snapshot.catalog.revision
      && storedSelection.setupGeneration === snapshot.setupGeneration,
    );
    const storedEntry = persisted.cliEntries[entry];
    const storedStatus = persisted.statuses[entry];
    if (
      !validateCliModelSelection(snapshot, selection)
      || !storedSelectionMatchesSnapshot
      || storedStatus?.state !== "ready"
      || storedEntry.authState !== "configured"
      || storedEntry.readOnlyWrapperState !== "ready"
      || storedEntry.executionMode !== "repoWrite"
    ) {
      next = failClosedCliReadiness(next, entry);
      continue;
    }

    const checkedAt = persisted.lastCheckedAtByEntry[entry] || storedStatus.checkedAt || storedEntry.lastCheckedAt || "";
    next = {
      ...next,
      entries: {
        ...next.entries,
        [entry]: {
          ...storedEntry,
          entry,
          binaryName: entry === "codexCli" ? "codex" : "claude",
          lastCheckedAt: checkedAt,
        },
      },
      statuses: { ...next.statuses, [entry]: { ...storedStatus, checkedAt } },
      lastCheckedAtByEntry: { ...next.lastCheckedAtByEntry, [entry]: checkedAt },
    };
  }

  return next;
}

function failClosedCliReadiness(settings: AISettingsState, entry: AICliEntryKind): AISettingsState {
  const currentEntry = settings.entries[entry] as CliAIEntrySettings;
  return {
    ...settings,
    entries: {
      ...settings.entries,
      [entry]: {
        ...currentEntry,
        readOnlyWrapperState: "unknown",
        executionMode: "unknown",
        lastCheckedAt: "",
      },
    },
    statuses: { ...settings.statuses, [entry]: null },
    lastCheckedAtByEntry: { ...settings.lastCheckedAtByEntry, [entry]: "" },
  };
}

function serializeSession(state: AIWorkspaceSessionState): StoredAIWorkspaceSession {
  const repoEntries = Object.entries(state.aiChatSessionsByRepo || {});
  if (repoEntries.length > MAX_REPOSITORIES) throw new SessionSchemaError("AI workspace session contains too many repositories.");
  const aiChatSessionsByRepo = Object.create(null) as Record<string, StoredAIChatSession>;
  for (const [repoId, session] of repoEntries) {
    const safeRepoId = boundedString(repoId, MAX_REPO_ID_LENGTH, "repository id", false);
    aiChatSessionsByRepo[safeRepoId] = serializeChatSession(session, safeRepoId);
  }

  return {
    version: AI_WORKSPACE_SESSION_VERSION,
    activeRepoId: boundedString(state.activeRepoId, MAX_REPO_ID_LENGTH, "active repository id"),
    activeEntry: cliEntryOrNull(state.activeEntry),
    cliEntries: mapCliEntries((entry) => normalizeCliEntry(entry, state.cliEntries[entry])),
    statuses: mapCliEntries((entry) => normalizeStatus(state.statuses[entry])),
    lastCheckedAtByEntry: mapCliEntries((entry) => boundedString(state.lastCheckedAtByEntry[entry], MAX_SHORT_STRING_LENGTH, `${entry} last checked time`)),
    modelBehaviorByEntry: mapCliEntries((entry) => normalizeModelBehavior(state.modelBehaviorByEntry[entry])),
    cliModelSelectionByEntry: mapCliEntries((entry) => normalizeSelection(state.cliModelSelectionByEntry[entry])),
    aiChatSessionsByRepo,
  };
}

function parseStoredSession(value: unknown): StoredAIWorkspaceSession {
  const source = objectValue(value, "AI workspace session");
  if (source.version !== AI_WORKSPACE_SESSION_VERSION) throw new SessionSchemaError("Unsupported AI workspace session version.");
  const sessions = objectValue(source.aiChatSessionsByRepo, "AI Chat sessions");
  const repoEntries = Object.entries(sessions);
  if (repoEntries.length > MAX_REPOSITORIES) throw new SessionSchemaError("Saved AI workspace session contains too many repositories.");
  const aiChatSessionsByRepo = Object.create(null) as Record<string, StoredAIChatSession>;
  for (const [repoId, session] of repoEntries) {
    const safeRepoId = boundedString(repoId, MAX_REPO_ID_LENGTH, "repository id", false);
    aiChatSessionsByRepo[safeRepoId] = parseStoredChatSession(session, safeRepoId);
  }

  const cliEntries = objectValue(source.cliEntries, "CLI entries");
  const statuses = objectValue(source.statuses, "CLI statuses");
  const checkedAt = objectValue(source.lastCheckedAtByEntry, "CLI checked times");
  const behaviors = objectValue(source.modelBehaviorByEntry, "CLI model behaviors");
  const selections = objectValue(source.cliModelSelectionByEntry, "CLI model selections");
  return {
    version: AI_WORKSPACE_SESSION_VERSION,
    activeRepoId: boundedString(source.activeRepoId, MAX_REPO_ID_LENGTH, "active repository id"),
    activeEntry: cliEntryOrNull(source.activeEntry),
    cliEntries: mapCliEntries((entry) => normalizeCliEntry(entry, cliEntries[entry])),
    statuses: mapCliEntries((entry) => normalizeStatus(statuses[entry])),
    lastCheckedAtByEntry: mapCliEntries((entry) => boundedString(checkedAt[entry], MAX_SHORT_STRING_LENGTH, `${entry} last checked time`)),
    modelBehaviorByEntry: mapCliEntries((entry) => normalizeModelBehavior(behaviors[entry])),
    cliModelSelectionByEntry: mapCliEntries((entry) => normalizeSelection(selections[entry])),
    aiChatSessionsByRepo,
  };
}

function restoreStoredSession(stored: StoredAIWorkspaceSession): AIWorkspaceSessionState {
  return {
    activeRepoId: stored.activeRepoId,
    activeEntry: stored.activeEntry,
    cliEntries: stored.cliEntries,
    statuses: stored.statuses,
    lastCheckedAtByEntry: stored.lastCheckedAtByEntry,
    modelBehaviorByEntry: stored.modelBehaviorByEntry,
    cliModelSelectionByEntry: stored.cliModelSelectionByEntry,
    aiChatSessionsByRepo: Object.fromEntries(
      Object.entries(stored.aiChatSessionsByRepo).map(([repoId, session]) => [repoId, restoreChatSession(session)]),
    ),
  };
}

function serializeChatSession(session: AIChatSessionState, repoId: string): StoredAIChatSession {
  return {
    messages: normalizeMessages(session.messages),
    draft: boundedString(session.draft, MAX_CHAT_STRING_LENGTH, "AI Chat draft"),
    pending: booleanValue(session.pending, "AI Chat pending marker"),
    lastRequest: boundedString(session.lastRequest, MAX_CHAT_STRING_LENGTH, "AI Chat last request"),
    contextChips: normalizeContextChips(session.contextChips, repoId),
    dismissedRulePathKeys: normalizeStringArray(session.dismissedRulePathKeys, MAX_DISMISSED_KEYS_PER_REPOSITORY, MAX_PATH_LENGTH, "dismissed rule path key"),
  };
}

function parseStoredChatSession(value: unknown, repoId: string): StoredAIChatSession {
  const source = objectValue(value, "AI Chat session");
  return {
    messages: normalizeMessages(source.messages),
    draft: boundedString(source.draft, MAX_CHAT_STRING_LENGTH, "AI Chat draft"),
    pending: booleanValue(source.pending, "AI Chat pending marker"),
    lastRequest: boundedString(source.lastRequest, MAX_CHAT_STRING_LENGTH, "AI Chat last request"),
    contextChips: normalizeContextChips(source.contextChips, repoId),
    dismissedRulePathKeys: normalizeStringArray(source.dismissedRulePathKeys, MAX_DISMISSED_KEYS_PER_REPOSITORY, MAX_PATH_LENGTH, "dismissed rule path key"),
  };
}

function restoreChatSession(stored: StoredAIChatSession): AIChatSessionState {
  const session = createDefaultAIChatSession();
  const messages = stored.messages.map((message) => ({ ...message }));
  if (stored.pending) {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage?.role === "assistant") {
      lastMessage.content = [lastMessage.content, AI_CHAT_RELOAD_INTERRUPTION_MESSAGE].filter(Boolean).join("\n\n");
    }
  }
  return {
    ...session,
    messages,
    draft: stored.draft,
    pending: false,
    error: stored.pending ? AI_CHAT_RELOAD_INTERRUPTION_MESSAGE : "",
    requestKey: "",
    lastRequest: stored.lastRequest,
    attachments: [],
    contextChips: stored.contextChips.map((chip) => ({ ...chip })),
    dismissedRulePathKeys: [...stored.dismissedRulePathKeys],
  };
}

function normalizeMessages(value: unknown): AIChatMessage[] {
  if (!Array.isArray(value) || value.length > MAX_MESSAGES_PER_REPOSITORY) {
    throw new SessionSchemaError(`AI Chat messages must contain at most ${MAX_MESSAGES_PER_REPOSITORY} items.`);
  }
  return value.map((item, index) => {
    const source = objectValue(item, `AI Chat message ${index + 1}`);
    if (source.role !== "user" && source.role !== "assistant") throw new SessionSchemaError("AI Chat message role is invalid.");
    return {
      role: source.role,
      content: boundedString(source.content, MAX_CHAT_STRING_LENGTH, "AI Chat message content"),
    };
  });
}

function normalizeContextChips(value: unknown, expectedRepoId: string): AIChatContextChip[] {
  if (!Array.isArray(value) || value.length > MAX_CONTEXT_CHIPS_PER_REPOSITORY) {
    throw new SessionSchemaError(`AI Chat context chips must contain at most ${MAX_CONTEXT_CHIPS_PER_REPOSITORY} items.`);
  }
  return value.map((item, index) => {
    const source = objectValue(item, `AI Chat context chip ${index + 1}`);
    if (source.kind !== "file" && source.kind !== "directory") throw new SessionSchemaError("AI Chat context kind is invalid.");
    if (source.role !== "primary" && source.role !== "rule") throw new SessionSchemaError("AI Chat context role is invalid.");
    if (source.source !== "tree-menu" && source.source !== "manual" && source.source !== "auto-root-rule" && source.source !== "legacy") {
      throw new SessionSchemaError("AI Chat context source is invalid.");
    }
    const repoId = boundedString(source.repoId, MAX_REPO_ID_LENGTH, "AI Chat context repository id", false);
    if (repoId !== expectedRepoId) throw new SessionSchemaError("AI Chat context repository does not match its conversation.");
    return {
      id: boundedString(source.id, MAX_SHORT_STRING_LENGTH, "AI Chat context id", false),
      repoId,
      path: boundedString(source.path, MAX_PATH_LENGTH, "AI Chat context path"),
      kind: source.kind,
      role: source.role,
      source: source.source,
      removable: booleanValue(source.removable, "AI Chat context removable flag"),
    };
  });
}

function normalizeStringArray(value: unknown, maxItems: number, maxLength: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new SessionSchemaError(`${label} list is invalid or too large.`);
  return value.map((item) => boundedString(item, maxLength, label));
}

function normalizeCliEntry(entry: AICliEntryKind, value: unknown): CliAIEntrySettings {
  const source = objectValue(value, `${entry} settings`);
  const authState = enumValue(source.authState, ["unknown", "configured", "notConfigured"] as const, `${entry} auth state`);
  const wrapperState = enumValue(source.readOnlyWrapperState, ["unknown", "ready", "notReady"] as const, `${entry} wrapper state`);
  const executionMode = enumValue(source.executionMode, ["unknown", "readOnly", "repoWrite"] as const, `${entry} execution mode`);
  return {
    entry,
    binaryName: entry === "codexCli" ? "codex" : "claude",
    version: boundedString(source.version, MAX_SHORT_STRING_LENGTH, `${entry} version`),
    authState,
    readOnlyWrapperState: wrapperState,
    executionMode,
    lastCheckedAt: boundedString(source.lastCheckedAt ?? "", MAX_SHORT_STRING_LENGTH, `${entry} last checked time`),
    readinessMessage: boundedString(source.readinessMessage ?? "", MAX_STATUS_STRING_LENGTH, `${entry} readiness message`),
  };
}

function normalizeStatus(value: unknown): AIConnectionStatus | null {
  if (value === null) return null;
  const source = objectValue(value, "CLI status");
  const state = enumValue(source.state, ["notConfigured", "configured", "ready", "failed"] as const, "CLI status state");
  const status: AIConnectionStatus = {
    state,
    message: boundedString(source.message, MAX_STATUS_STRING_LENGTH, "CLI status message"),
    checkedAt: boundedString(source.checkedAt, MAX_SHORT_STRING_LENGTH, "CLI status checked time"),
  };
  if (source.code !== undefined) status.code = enumValue(source.code, ["not_configured", "needs_test", "endpoint_unreachable", "invalid_endpoint", "model_missing", "credential_required", "provider_http_error", "timeout_or_abort", "cli_auth_missing", "wrapper_not_ready", "substrate_missing", "workspace_not_ready", "unsupported_provider", "readiness_renewal_failed", "authenticationInvalidated", "success"] as const, "CLI status code");
  if (source.severity !== undefined) status.severity = enumValue(source.severity, ["info", "success", "warning", "error"] as const, "CLI status severity");
  if (source.nextAction !== undefined) status.nextAction = boundedString(source.nextAction, MAX_STATUS_STRING_LENGTH, "CLI status next action");
  if (source.detail !== undefined) status.detail = boundedString(source.detail, MAX_STATUS_STRING_LENGTH, "CLI status detail");
  return status;
}

function normalizeModelBehavior(value: unknown): AIModelBehavior {
  const source = objectValue(value, "CLI model behavior");
  if (source.kind === "none") return { kind: "none" };
  if (source.kind === "thinking") return { kind: "thinking", enabled: booleanValue(source.enabled, "thinking enabled flag") };
  if (source.kind === "intelligence") {
    return { kind: "intelligence", level: enumValue(source.level, ["low", "medium", "high", "xhigh"] as const, "intelligence level") };
  }
  throw new SessionSchemaError("CLI model behavior is invalid.");
}

function normalizeSelection(value: unknown): AICliModelSelection | null {
  if (value === null) return null;
  const source = objectValue(value, "CLI model selection");
  const setupGeneration = source.setupGeneration;
  if (!Number.isSafeInteger(setupGeneration) || (setupGeneration as number) < 0) throw new SessionSchemaError("CLI setup generation is invalid.");
  return {
    model: boundedString(source.model, MAX_SHORT_STRING_LENGTH, "CLI model", false),
    effort: boundedString(source.effort, MAX_SHORT_STRING_LENGTH, "CLI effort", false),
    speedMode: enumValue(source.speedMode, ["standard", "fast"] as const, "CLI speed mode"),
    catalogRevision: boundedString(source.catalogRevision, MAX_SHORT_STRING_LENGTH, "CLI catalog revision", false),
    setupGeneration: setupGeneration as number,
  };
}

function mapCliEntries<T>(mapper: (entry: AICliEntryKind) => T): CliEntryRecord<T> {
  return { codexCli: mapper("codexCli"), claudeCli: mapper("claudeCli") };
}

function cliEntryOrNull(value: unknown): AICliEntryKind | null {
  if (value === null) return null;
  if (value === "codexCli" || value === "claudeCli") return value;
  throw new SessionSchemaError("Active AI Entry must be a CLI entry or null.");
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionSchemaError(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, maxLength: number, label: string, allowEmpty = true): string {
  if (typeof value !== "string" || value.length > maxLength || (!allowEmpty && !value)) {
    throw new SessionSchemaError(`${label} is invalid or too long.`);
  }
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new SessionSchemaError(`${label} is invalid.`);
  return value;
}

function enumValue<const T extends readonly string[]>(value: unknown, values: T, label: string): T[number] {
  if (typeof value !== "string" || !values.includes(value)) throw new SessionSchemaError(`${label} is invalid.`);
  return value as T[number];
}

function browserSessionStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage || null;
  } catch {
    return null;
  }
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
