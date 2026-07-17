import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_CHAT_RELOAD_INTERRUPTION_MESSAGE,
  AI_WORKSPACE_SESSION_MAX_BYTES,
  AI_WORKSPACE_SESSION_STORAGE_KEY,
  createAISettingsFromWorkspaceSession,
  createDefaultAIChatSession,
  createDefaultAIWorkspaceSession,
  createAIWorkspaceSessionState,
  loadAIWorkspaceSession,
  persistAIWorkspaceSession,
  restoreAIWorkspaceCliState,
  type AIWorkspaceSessionState,
} from "../src/appSessionState";
import { defaultAISettings, type AISettingsState } from "../src/settingsState";
import type { AICliEntryKind, AICliSetupSnapshot, AIConnectionStatus, AIProviderSettings, CliAIEntrySettings } from "../src/types";

describe("AI workspace session state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips bounded CLI state and repo-scoped AI Chat state", () => {
    const storage = installSessionStorageMock();
    const state = readyWorkspaceSession();
    state.aiChatSessionsByRepo.repo = {
      ...createDefaultAIChatSession(),
      messages: [
        { role: "user", content: "Inspect this repository." },
        { role: "assistant", content: "Repository inspected." },
      ],
      draft: "Follow up",
      lastRequest: "Inspect this repository.",
      contextChips: [{ id: "file:README.md", repoId: "repo", path: "README.md", kind: "file", role: "primary", source: "manual", removable: true }],
      dismissedRulePathKeys: ["repo\u0000AGENTS.md"],
    };

    expect(persistAIWorkspaceSession(state)).toBe("");
    const loaded = loadAIWorkspaceSession();

    expect(loaded.error).toBe("");
    expect(loaded.state).toMatchObject({
      activeRepoId: "repo",
      activeEntry: "codexCli",
      statuses: { codexCli: { state: "ready", code: "success" } },
      lastCheckedAtByEntry: { codexCli: "2026-07-17T00:00:00.000Z" },
      modelBehaviorByEntry: { codexCli: { kind: "intelligence", level: "high" } },
      cliModelSelectionByEntry: { codexCli: { model: "codex-current", effort: "Max", speedMode: "fast" } },
      aiChatSessionsByRepo: {
        repo: {
          messages: [
            { role: "user", content: "Inspect this repository." },
            { role: "assistant", content: "Repository inspected." },
          ],
          draft: "Follow up",
          pending: false,
          lastRequest: "Inspect this repository.",
          attachments: [],
        },
      },
    });
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("creates initial AI settings without carrying provider state or transient setup snapshots", () => {
    const persisted = readyWorkspaceSession();
    const settings = createAISettingsFromWorkspaceSession(persisted);

    expect(settings.activeEntry).toBe("codexCli");
    expect(settings.entries.aiApi).toEqual(defaultAISettings.entries.aiApi);
    expect(settings.entries.localAi).toEqual(defaultAISettings.entries.localAi);
    expect("credential" in settings.entries.aiApi ? settings.entries.aiApi.credential : undefined).toBe("");
    expect(settings.entries.codexCli).toEqual(persisted.cliEntries.codexCli);
    expect(settings.statuses.codexCli).toEqual(persisted.statuses.codexCli);
    expect(settings.lastCheckedAtByEntry.codexCli).toBe(persisted.lastCheckedAtByEntry.codexCli);
    expect(settings.modelBehaviorByEntry.codexCli).toEqual(persisted.modelBehaviorByEntry.codexCli);
    expect(settings.cliModelSelectionByEntry.codexCli).toEqual(persisted.cliModelSelectionByEntry.codexCli);
    expect(settings.cliSetupByEntry).toEqual({ codexCli: null, claudeCli: null });
  });

  it("captures only the CLI allowlist from AI settings for App persistence", () => {
    const workspace = readyWorkspaceSession();
    const settings = createAISettingsFromWorkspaceSession(workspace);
    settings.entries.aiApi = { ...(settings.entries.aiApi as AIProviderSettings), credential: "PROVIDER_SECRET" };
    (settings.entries.codexCli as CliAIEntrySettings & { executablePath?: string }).executablePath = "/secret/custom/codex";
    settings.activeEntry = "aiApi";
    settings.cliSetupByEntry.codexCli = {
      ...setupSnapshot("codexCli", "catalog-current", 7, "codex-current"),
      authentication: { state: "waiting", verificationUrl: "https://auth.example/SECRET", userCode: "USER_SECRET" },
    };
    const chat = {
      ...createDefaultAIChatSession(),
      messages: [{ role: "user" as const, content: "Hello", credential: "MESSAGE_SECRET" }],
      attachments: [{ id: "a", name: "a.txt", mimeType: "text/plain", sizeBytes: 6, contentIncluded: true, content: "SECRET" }],
    };

    const captured = createAIWorkspaceSessionState("repo", settings, { repo: chat });

    expect(captured.activeEntry).toBeNull();
    expect("aiApi" in captured).toBe(false);
    expect("cliSetupByEntry" in captured).toBe(false);
    expect(captured.aiChatSessionsByRepo.repo.attachments).toEqual([]);
    expect(JSON.stringify(captured)).not.toContain("PROVIDER_SECRET");
    expect(JSON.stringify(captured)).not.toContain("USER_SECRET");
    expect(JSON.stringify(captured)).not.toContain("/secret/custom/codex");
    expect(JSON.stringify(captured)).not.toContain("MESSAGE_SECRET");
  });

  it("never serializes provider credentials, setup auth transients, HTTP tokens, leases, executables, or attachment content", () => {
    installSessionStorageMock();
    const state = readyWorkspaceSession() as AIWorkspaceSessionState & Record<string, unknown>;
    state.aiChatSessionsByRepo.repo = {
      ...createDefaultAIChatSession(),
      attachments: [{
        id: "secret-attachment",
        name: "secret.txt",
        mimeType: "text/plain",
        sizeBytes: 18,
        contentIncluded: true,
        content: "ATTACHMENT_SECRET",
      }],
    };
    Object.assign(state, {
      aiApi: { credential: "API_CREDENTIAL_SECRET" },
      localAi: { credential: "LOCAL_CREDENTIAL_SECRET" },
      setupSnapshot: {
        authentication: { verificationUrl: "https://auth.example/SECRET", userCode: "USER_CODE_SECRET" },
        update: { nonce: "UPDATE_NONCE_SECRET" },
      },
      httpToken: "HTTP_TOKEN_SECRET",
      serverLease: "SERVER_LEASE_SECRET",
      executable: "/secret/custom/codex",
    });

    expect(persistAIWorkspaceSession(state)).toBe("");
    const raw = window.sessionStorage.getItem(AI_WORKSPACE_SESSION_STORAGE_KEY) || "";

    for (const secret of ["API_CREDENTIAL_SECRET", "LOCAL_CREDENTIAL_SECRET", "ATTACHMENT_SECRET", "USER_CODE_SECRET", "UPDATE_NONCE_SECRET", "HTTP_TOKEN_SECRET", "SERVER_LEASE_SECRET", "/secret/custom/codex"]) {
      expect(raw).not.toContain(secret);
    }
    expect(loadAIWorkspaceSession().state.aiChatSessionsByRepo.repo.attachments).toEqual([]);
  });

  it("restores interrupted requests as non-pending without request keys or attachments and marks the partial assistant response", () => {
    installSessionStorageMock();
    const state = readyWorkspaceSession();
    state.aiChatSessionsByRepo.repo = {
      ...createDefaultAIChatSession(),
      messages: [
        { role: "user", content: "Continue." },
        { role: "assistant", content: "Partial response" },
      ],
      pending: true,
      requestKey: "request-secret",
      attachments: [{ id: "a", name: "a.txt", mimeType: "text/plain", sizeBytes: 4, contentIncluded: true, content: "data" }],
    };

    expect(persistAIWorkspaceSession(state)).toBe("");
    const restored = loadAIWorkspaceSession().state.aiChatSessionsByRepo.repo;

    expect(restored.pending).toBe(false);
    expect(restored.requestKey).toBe("");
    expect(restored.attachments).toEqual([]);
    expect(restored.error).toBe(AI_CHAT_RELOAD_INTERRUPTION_MESSAGE);
    expect(restored.messages.at(-1)?.content).toBe(`Partial response\n\n${AI_CHAT_RELOAD_INTERRUPTION_MESSAGE}`);
  });

  it("fails the whole payload closed for corrupt JSON, version mismatch, and oversized raw data", () => {
    installSessionStorageMock();
    const expectedEmpty = createDefaultAIWorkspaceSession();

    window.sessionStorage.setItem(AI_WORKSPACE_SESSION_STORAGE_KEY, "{broken");
    expect(loadAIWorkspaceSession()).toMatchObject({ state: expectedEmpty, error: expect.any(String) });
    expect(window.sessionStorage.getItem(AI_WORKSPACE_SESSION_STORAGE_KEY)).toBeNull();

    window.sessionStorage.setItem(AI_WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify({ version: 2 }));
    expect(loadAIWorkspaceSession()).toMatchObject({ state: expectedEmpty, error: "Unsupported AI workspace session version." });
    expect(window.sessionStorage.getItem(AI_WORKSPACE_SESSION_STORAGE_KEY)).toBeNull();

    window.sessionStorage.setItem(AI_WORKSPACE_SESSION_STORAGE_KEY, "x".repeat(AI_WORKSPACE_SESSION_MAX_BYTES + 1));
    expect(loadAIWorkspaceSession()).toMatchObject({ state: expectedEmpty, error: "Saved AI workspace session exceeds the 4 MiB limit." });
    expect(window.sessionStorage.getItem(AI_WORKSPACE_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("fails closed when a repository exceeds the message bound", () => {
    installSessionStorageMock();
    const state = readyWorkspaceSession();
    state.aiChatSessionsByRepo.repo = {
      ...createDefaultAIChatSession(),
      messages: Array.from({ length: 201 }, () => ({ role: "user" as const, content: "message" })),
    };

    expect(persistAIWorkspaceSession(state)).toContain("at most 200");
    expect(window.sessionStorage.getItem(AI_WORKSPACE_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("fails the whole payload closed when a conversation contains cross-repo context", () => {
    installSessionStorageMock();
    const state = readyWorkspaceSession();
    state.aiChatSessionsByRepo.repo = {
      ...createDefaultAIChatSession(),
      contextChips: [{ id: "cross", repoId: "other", path: "README.md", kind: "file", role: "primary", source: "manual", removable: true }],
    };

    expect(persistAIWorkspaceSession(state)).toBe("AI Chat context repository does not match its conversation.");
    expect(window.sessionStorage.getItem(AI_WORKSPACE_SESSION_STORAGE_KEY)).toBeNull();

    const valid = readyWorkspaceSession();
    valid.aiChatSessionsByRepo.repo = {
      ...createDefaultAIChatSession(),
      contextChips: [{ id: "valid", repoId: "repo", path: "README.md", kind: "file", role: "primary", source: "manual", removable: true }],
    };
    expect(persistAIWorkspaceSession(valid)).toBe("");
    const tampered = JSON.parse(window.sessionStorage.getItem(AI_WORKSPACE_SESSION_STORAGE_KEY) || "{}") as {
      aiChatSessionsByRepo: { repo: { contextChips: Array<{ repoId: string }> } };
    };
    tampered.aiChatSessionsByRepo.repo.contextChips[0].repoId = "other";
    window.sessionStorage.setItem(AI_WORKSPACE_SESSION_STORAGE_KEY, JSON.stringify(tampered));

    expect(loadAIWorkspaceSession()).toMatchObject({
      state: createDefaultAIWorkspaceSession(),
      error: "AI Chat context repository does not match its conversation.",
    });
  });

  it("skips sessionStorage writes when polling produces the same serialized state", () => {
    const storage = installSessionStorageMock();
    const state = readyWorkspaceSession();

    expect(persistAIWorkspaceSession(state)).toBe("");
    expect(persistAIWorkspaceSession(state)).toBe("");

    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it("returns an error instead of throwing when sessionStorage writes fail", () => {
    const storage = installSessionStorageMock();
    expect(persistAIWorkspaceSession(readyWorkspaceSession())).toBe("");
    expect(window.sessionStorage.getItem(AI_WORKSPACE_SESSION_STORAGE_KEY)).not.toBeNull();
    storage.setItem.mockImplementation(() => {
      throw new Error("quota denied");
    });
    const changed = readyWorkspaceSession();
    changed.aiChatSessionsByRepo.repo = { ...createDefaultAIChatSession(), draft: "newer in-memory state" };

    expect(persistAIWorkspaceSession(changed)).toBe("quota denied");
    expect(window.sessionStorage.getItem(AI_WORKSPACE_SESSION_STORAGE_KEY)).toBeNull();
  });

  it("restores readiness when the stored selection matches the current catalog and setup generation", () => {
    const persisted = readyWorkspaceSession();
    const currentSnapshot = setupSnapshot("codexCli", "catalog-current", 7, "codex-current");
    persisted.cliModelSelectionByEntry.codexCli = {
      model: "codex-current",
      effort: "Max",
      speedMode: "fast",
      catalogRevision: "catalog-current",
      setupGeneration: 7,
    };

    const restored = restoreAIWorkspaceCliState(defaultAISettings, persisted, {
      codexCli: currentSnapshot,
      claudeCli: null,
    });

    expect(restored.cliModelSelectionByEntry.codexCli).toEqual({
      model: "codex-current",
      effort: "Max",
      speedMode: "fast",
      catalogRevision: "catalog-current",
      setupGeneration: 7,
    });
    expect(restored.statuses.codexCli).toMatchObject({ state: "ready", code: "success" });
    expect(restored.entries.codexCli).toMatchObject({ authState: "configured", readOnlyWrapperState: "ready", executionMode: "repoWrite" });
  });

  it("rebinds a valid model tuple but fails readiness closed when the setup generation changed", () => {
    const persisted = readyWorkspaceSession();
    const currentSnapshot = setupSnapshot("codexCli", "catalog-old", 2, "codex-current");

    const restored = restoreAIWorkspaceCliState(defaultAISettings, persisted, {
      codexCli: currentSnapshot,
      claudeCli: null,
    });

    expect(restored.cliModelSelectionByEntry.codexCli).toEqual({
      model: "codex-current",
      effort: "Max",
      speedMode: "fast",
      catalogRevision: "catalog-old",
      setupGeneration: 2,
    });
    expect(restored.statuses.codexCli).toBeNull();
    expect(restored.lastCheckedAtByEntry.codexCli).toBe("");
    expect(restored.entries.codexCli).toMatchObject({ readOnlyWrapperState: "unknown", executionMode: "unknown", lastCheckedAt: "" });
  });

  it("fails readiness closed when the stored model tuple is stale for the current snapshot", () => {
    const persisted = readyWorkspaceSession();
    const currentSnapshot = setupSnapshot("codexCli", "catalog-current", 7, "different-model");
    const current = {
      ...defaultAISettings,
      statuses: { ...defaultAISettings.statuses, codexCli: readyStatus() },
      entries: {
        ...defaultAISettings.entries,
        codexCli: persisted.cliEntries.codexCli,
      },
    } as AISettingsState;

    const restored = restoreAIWorkspaceCliState(current, persisted, {
      codexCli: currentSnapshot,
      claudeCli: null,
    });

    expect(restored.cliModelSelectionByEntry.codexCli).toBeNull();
    expect(restored.statuses.codexCli).toBeNull();
    expect(restored.lastCheckedAtByEntry.codexCli).toBe("");
    expect(restored.entries.codexCli).toMatchObject({ readOnlyWrapperState: "unknown", executionMode: "unknown", lastCheckedAt: "" });
  });

  it("does not reapply persisted readiness after a live selection is already bound", () => {
    const persisted = readyWorkspaceSession();
    const snapshot = setupSnapshot("codexCli", "catalog-current", 7, "codex-current");
    const liveFailure: AIConnectionStatus = { state: "failed", code: "workspace_not_ready", message: "Live check failed.", checkedAt: "2026-07-17T01:00:00.000Z" };
    const current: AISettingsState = {
      ...defaultAISettings,
      cliSetupByEntry: { ...defaultAISettings.cliSetupByEntry, codexCli: snapshot },
      cliModelSelectionByEntry: {
        ...defaultAISettings.cliModelSelectionByEntry,
        codexCli: { model: "codex-current", effort: "Max", speedMode: "fast", catalogRevision: "catalog-current", setupGeneration: 7 },
      },
      statuses: { ...defaultAISettings.statuses, codexCli: liveFailure },
    };

    const restored = restoreAIWorkspaceCliState(current, persisted, { codexCli: snapshot, claudeCli: null });

    expect(restored.statuses.codexCli).toBe(liveFailure);
    expect(restored.cliModelSelectionByEntry.codexCli).toEqual(current.cliModelSelectionByEntry.codexCli);
  });
});

function readyWorkspaceSession(): AIWorkspaceSessionState {
  const state = createDefaultAIWorkspaceSession();
  const checkedAt = "2026-07-17T00:00:00.000Z";
  return {
    ...state,
    activeRepoId: "repo",
    activeEntry: "codexCli",
    cliEntries: {
      ...state.cliEntries,
      codexCli: {
        entry: "codexCli",
        binaryName: "codex",
        version: "1.2.3",
        authState: "configured",
        readOnlyWrapperState: "ready",
        executionMode: "repoWrite",
        lastCheckedAt: checkedAt,
        readinessMessage: "Current repo write readiness is verified.",
      },
    },
    statuses: { ...state.statuses, codexCli: readyStatus() },
    lastCheckedAtByEntry: { ...state.lastCheckedAtByEntry, codexCli: checkedAt },
    modelBehaviorByEntry: { ...state.modelBehaviorByEntry, codexCli: { kind: "intelligence", level: "high" } },
    cliModelSelectionByEntry: {
      ...state.cliModelSelectionByEntry,
      codexCli: { model: "codex-current", effort: "Max", speedMode: "fast", catalogRevision: "catalog-old", setupGeneration: 1 },
    },
  };
}

function readyStatus(): AIConnectionStatus {
  return {
    state: "ready",
    code: "success",
    severity: "success",
    message: "Ready.",
    nextAction: "Use AI Chat.",
    checkedAt: "2026-07-17T00:00:00.000Z",
  };
}

function setupSnapshot(entry: AICliEntryKind, revision: string, setupGeneration: number, modelId: string): AICliSetupSnapshot {
  return {
    entry,
    setupGeneration,
    phase: "ready",
    message: "Ready.",
    cliVersion: "1.2.3",
    checkedAt: "2026-07-17T00:00:00.000Z",
    compatibility: "compatible",
    authentication: { state: "succeeded" },
    update: { state: "idle" },
    catalog: {
      entry,
      cliVersion: "1.2.3",
      revision,
      fetchedAt: "2026-07-17T00:00:00.000Z",
      models: [{
        id: modelId,
        label: modelId,
        description: null,
        isDefault: true,
        defaultEffort: "Max",
        efforts: [{ id: "Max", label: "Max", description: null, isDefault: true }],
        defaultSpeedMode: "standard",
        speedModes: [
          { id: "standard", label: "Standard", description: null, isDefault: true },
          { id: "fast", label: "Fast", description: null, isDefault: false },
        ],
      }],
    },
  };
}

function installSessionStorageMock(): {
  getItem: ReturnType<typeof vi.fn>;
  setItem: ReturnType<typeof vi.fn>;
  removeItem: ReturnType<typeof vi.fn>;
  clear: ReturnType<typeof vi.fn>;
} {
  const store = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => {
      store.clear();
    }),
  };
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: storage });
  return storage;
}
