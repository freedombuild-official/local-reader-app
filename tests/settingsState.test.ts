import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeAIChatTarget,
  activeAIModelBehavior,
  activeAIProvider,
  applyCliSetupSnapshot,
  applyCliSetupSnapshotAndBindSelection,
  aiModelBehaviorCapability,
  aiReady,
  defaultAISettings,
  effectiveAIStatus,
  invalidateAIReadiness,
  invalidateCliReadinessForRepositoryChange,
  loadBasicSettings,
  normalizeAISettingsState,
  persistBasicSettings,
  providerExecutionMode,
  selectAIEntry,
  selectCliEffort,
  selectCliModel,
  selectCliSpeedMode,
  updateAIEntry,
  updateCliEntryReadiness,
  updateAIModelBehavior,
  validCliModelSelection,
  validateCliModelSelection,
  type AISettingsState,
} from "../src/settingsState";
import type { AICliEntryKind, AICliSetupSnapshot, AIEntryReadiness, AIProviderSettings, CliAIEntrySettings } from "../src/types";

describe("settings state", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses ×1 as the default reader font scale and migrates legacy font size values", () => {
    installLocalStorageMock();
    expect(loadBasicSettings().settings.readerFontScale).toBe(1);
    expect(loadBasicSettings().settings.colorMode).toBe("light");

    window.localStorage.setItem("readerWiki.basicSettings.v1", JSON.stringify({ fontSize: "small", layout: "focused" }));
    expect(loadBasicSettings().settings).toMatchObject({ readerFontScale: 1, layout: "focused" });

    window.localStorage.setItem("readerWiki.basicSettings.v1", JSON.stringify({ fontSize: "large" }));
    expect(loadBasicSettings().settings.readerFontScale).toBe(1.5);

    const error = persistBasicSettings({ ...loadBasicSettings().settings, readerFontScale: 2 });
    expect(error).toBe("");
    const stored = JSON.parse(window.localStorage.getItem("readerWiki.basicSettings.v1") || "{}") as Record<string, unknown>;
    expect(stored.readerFontScale).toBe(2);
    expect(stored.fontSize).toBeUndefined();
  });

  it("uses Light as the default color mode and migrates legacy System values", () => {
    installLocalStorageMock();
    expect(loadBasicSettings().settings.colorMode).toBe("light");

    window.localStorage.setItem("readerWiki.basicSettings.v1", JSON.stringify({ colorMode: "system" }));
    expect(loadBasicSettings().settings.colorMode).toBe("light");

    window.localStorage.setItem("readerWiki.basicSettings.v1", JSON.stringify({ colorMode: "dark" }));
    expect(loadBasicSettings().settings.colorMode).toBe("dark");

    const error = persistBasicSettings({ ...loadBasicSettings().settings, colorMode: "light" });
    expect(error).toBe("");
    const stored = JSON.parse(window.localStorage.getItem("readerWiki.basicSettings.v1") || "{}") as Record<string, unknown>;
    expect(stored.colorMode).toBe("light");
    expect(stored.colorMode).not.toBe("system");
  });

  it("uses Comfortable as the default reader layout and normalizes invalid layout values", () => {
    installLocalStorageMock();
    expect(loadBasicSettings().settings.layout).toBe("comfortable");

    window.localStorage.setItem("readerWiki.basicSettings.v1", JSON.stringify({ layout: "compact" }));
    expect(loadBasicSettings().settings.layout).toBe("compact");

    window.localStorage.setItem("readerWiki.basicSettings.v1", JSON.stringify({ layout: "focused" }));
    expect(loadBasicSettings().settings.layout).toBe("focused");

    window.localStorage.setItem("readerWiki.basicSettings.v1", JSON.stringify({ layout: "hidden" }));
    expect(loadBasicSettings().settings.layout).toBe("comfortable");

    const error = persistBasicSettings({ ...loadBasicSettings().settings, layout: "compact" });
    expect(error).toBe("");
    const stored = JSON.parse(window.localStorage.getItem("readerWiki.basicSettings.v1") || "{}") as Record<string, unknown>;
    expect(stored.layout).toBe("compact");
  });

  it("ignores legacy display visibility settings and does not persist them again", () => {
    installLocalStorageMock();
    window.localStorage.setItem(
      "readerWiki.basicSettings.v1",
      JSON.stringify({ layout: "focused", showOutline: false, showSourceMetadata: false }),
    );

    const loaded = loadBasicSettings().settings;
    expect(loaded.layout).toBe("focused");
    expect("showOutline" in loaded).toBe(false);
    expect("showSourceMetadata" in loaded).toBe(false);

    const error = persistBasicSettings({ ...loaded, layout: "compact" });
    expect(error).toBe("");
    const stored = JSON.parse(window.localStorage.getItem("readerWiki.basicSettings.v1") || "{}") as Record<string, unknown>;
    expect(stored.layout).toBe("compact");
    expect(stored.showOutline).toBeUndefined();
    expect(stored.showSourceMetadata).toBeUndefined();
  });

  it("starts without an active AI provider", () => {
    expect(defaultAISettings.activeEntry).toBeNull();
    expect(activeAIProvider(defaultAISettings)).toBeNull();
    expect(Object.keys(defaultAISettings.entries)).toEqual(["aiApi", "localAi", "codexCli", "claudeCli"]);
    expect(defaultAISettings.cliSetupByEntry).toEqual({ codexCli: null, claudeCli: null });
    expect(defaultAISettings.cliModelSelectionByEntry).toEqual({ codexCli: null, claudeCli: null });
    expect(effectiveAIStatus(defaultAISettings, "aiApi")).toMatchObject({ state: "notConfigured", code: "not_configured", message: "Connection settings are incomplete." });
  });

  it("normalizes CLI entries without carrying old app-only state", () => {
    const legacyBridgeKey = "bridge" + "State";
    const legacy = {
      activeEntry: "codexCli",
      entries: {
        codexCli: {
          entry: "codexCli",
          binaryName: "codex",
          authState: "configured",
          readOnlyWrapperState: "ready",
          executionMode: "readOnly",
          [legacyBridgeKey]: "connected",
        },
        aiApi: defaultAISettings.entries.aiApi,
        localAi: defaultAISettings.entries.localAi,
      },
      statuses: {
        codexCli: { state: "ready", message: "old status", checkedAt: "2026-07-03T00:00:00.000Z" },
        aiApi: null,
        localAi: null,
      },
      lastCheckedAtByEntry: {
        codexCli: "2026-07-03T00:00:00.000Z",
        aiApi: "",
        localAi: "",
      },
    } as unknown as AISettingsState;

    const migrated = normalizeAISettingsState(legacy);
    expect(migrated.activeEntry).toBe("codexCli");
    expect(Object.keys(migrated.entries)).toEqual(["aiApi", "localAi", "codexCli", "claudeCli"]);
    expect(JSON.stringify(migrated)).not.toContain(legacyBridgeKey);
    expect(migrated.cliSetupByEntry).toEqual({ codexCli: null, claudeCli: null });
    expect(migrated.cliModelSelectionByEntry).toEqual({ codexCli: null, claudeCli: null });
    expect(activeAIChatTarget(migrated)).toBeUndefined();
    expect(effectiveAIStatus(migrated, "codexCli")).toMatchObject({ state: "ready", message: "old status" });
  });

  it("defaults legacy provider access to context-only and invalidates readiness when the mode changes", () => {
    const legacy = {
      ...defaultAISettings,
      entries: {
        ...defaultAISettings.entries,
        aiApi: { ...(defaultAISettings.entries.aiApi as AIProviderSettings), executionMode: undefined },
        localAi: { ...(defaultAISettings.entries.localAi as AIProviderSettings), executionMode: "unknown" },
      },
    } as unknown as AISettingsState;
    const normalized = normalizeAISettingsState(legacy);
    expect(providerExecutionMode(normalized.entries.aiApi as AIProviderSettings)).toBe("readOnly");
    expect(providerExecutionMode(normalized.entries.localAi as AIProviderSettings)).toBe("readOnly");

    const ready = {
      ...normalized,
      statuses: {
        ...normalized.statuses,
        aiApi: { state: "ready", code: "success", message: "Ready.", checkedAt: "2026-07-11T00:00:00.000Z" },
      },
      lastCheckedAtByEntry: { ...normalized.lastCheckedAtByEntry, aiApi: "2026-07-11T00:00:00.000Z" },
    } as AISettingsState;
    const updated = updateAIEntry(ready, "aiApi", { executionMode: "repoWrite" });
    expect(providerExecutionMode(updated.entries.aiApi as AIProviderSettings)).toBe("repoWrite");
    expect(updated.statuses.aiApi).toBeNull();
    expect(updated.lastCheckedAtByEntry.aiApi).toBe("");
  });

  it("keeps the browser-held provider credential when readiness returns only public settings", () => {
    const currentProvider = {
      ...(defaultAISettings.entries.aiApi as AIProviderSettings),
      credential: "browser-only-secret",
      executionMode: "repoWrite" as const,
    };
    const readiness: AIEntryReadiness = {
      entry: "aiApi",
      settings: {
        ...currentProvider,
        credential: undefined,
      },
      status: {
        state: "ready",
        code: "success",
        message: "Ready.",
        checkedAt: "2026-07-11T00:00:00.000Z",
      },
      ready: true,
      checks: [],
    };

    const updated = updateCliEntryReadiness({
      ...defaultAISettings,
      entries: { ...defaultAISettings.entries, aiApi: currentProvider },
    }, readiness);
    expect((updated.entries.aiApi as AIProviderSettings).credential).toBe("browser-only-secret");
    expect(updated.statuses.aiApi).toMatchObject({ state: "ready", code: "success" });
  });

  it("selects verified provider and CLI chat targets", () => {
    const localAiReady: AIProviderSettings = { ...(defaultAISettings.entries.localAi as AIProviderSettings), model: "local-model" };
    const aiApiReady: AIProviderSettings = { ...(defaultAISettings.entries.aiApi as AIProviderSettings), credential: "local-test-key" };
    const codexReady: CliAIEntrySettings = {
      ...(defaultAISettings.entries.codexCli as CliAIEntrySettings),
      authState: "configured",
      readOnlyWrapperState: "ready",
      executionMode: "repoWrite",
    };
    const codexReadOnly: CliAIEntrySettings = {
      ...codexReady,
      executionMode: "readOnly",
    };

    expect(activeAIChatTarget({ ...defaultAISettings, activeEntry: "aiApi" })).toBeNull();
    expect(activeAIChatTarget({ ...defaultAISettings, activeEntry: "codexCli" })).toBeUndefined();
    expect(aiReady(localAiReady)).toBe(true);
    expect(activeAIChatTarget({ ...defaultAISettings, activeEntry: "localAi", entries: { ...defaultAISettings.entries, localAi: localAiReady } })).toBeNull();
    expect(activeAIChatTarget({ ...defaultAISettings, activeEntry: "aiApi", entries: { ...defaultAISettings.entries, aiApi: aiApiReady } })).toBeNull();
    expect(activeAIChatTarget({
      ...defaultAISettings,
      activeEntry: "localAi",
      entries: { ...defaultAISettings.entries, localAi: localAiReady },
      statuses: { ...defaultAISettings.statuses, localAi: { state: "ready", code: "success", severity: "success", message: "Connected.", nextAction: "Ready.", checkedAt: "2026-07-05T00:00:00.000Z" } },
    })).toMatchObject({
      kind: "codexBackedLocal",
      provider: localAiReady,
      status: { state: "ready", code: "success" },
    });
    expect(activeAIChatTarget({
      ...defaultAISettings,
      activeEntry: "aiApi",
      entries: { ...defaultAISettings.entries, aiApi: aiApiReady },
      statuses: { ...defaultAISettings.statuses, aiApi: { state: "ready", code: "success", severity: "success", message: "Connected.", nextAction: "Ready.", checkedAt: "2026-07-05T00:00:00.000Z" } },
    })).toMatchObject({
      kind: "codexBackedProvider",
      provider: aiApiReady,
      status: { state: "ready", code: "success" },
    });
    expect(activeAIChatTarget({ ...defaultAISettings, activeEntry: "codexCli", entries: { ...defaultAISettings.entries, codexCli: codexReady } })).toBeUndefined();
    const codexSetup = cliSetupSnapshot("codexCli", "catalog-r1");
    const codexSelection = { model: "codex-current", effort: "Max", speedMode: "standard" as const, catalogRevision: "catalog-r1", setupGeneration: 1 };
    expect(activeAIChatTarget({
      ...defaultAISettings,
      activeEntry: "codexCli",
      entries: { ...defaultAISettings.entries, codexCli: codexReady },
      cliSetupByEntry: { ...defaultAISettings.cliSetupByEntry, codexCli: codexSetup },
      cliModelSelectionByEntry: { ...defaultAISettings.cliModelSelectionByEntry, codexCli: codexSelection },
    })).toMatchObject({ kind: "codexCli", entry: "codexCli", selection: codexSelection });
    expect(activeAIChatTarget({
      ...defaultAISettings,
      activeEntry: "codexCli",
      entries: { ...defaultAISettings.entries, codexCli: codexReadOnly },
      cliSetupByEntry: { ...defaultAISettings.cliSetupByEntry, codexCli: codexSetup },
      cliModelSelectionByEntry: { ...defaultAISettings.cliModelSelectionByEntry, codexCli: codexSelection },
    })).toBeUndefined();
  });

  it("keeps arbitrary catalog effort identifiers and requires a current model selection", () => {
    const snapshot = cliSetupSnapshot("codexCli", "catalog-r1");
    let settings = applyCliSetupSnapshot(defaultAISettings, snapshot);
    expect(settings.cliSetupByEntry.codexCli).toBe(snapshot);
    expect(settings.cliModelSelectionByEntry.codexCli).toBeNull();

    settings = selectCliModel(settings, "codexCli", "codex-current");
    expect(settings.cliModelSelectionByEntry.codexCli).toEqual({
      model: "codex-current",
      effort: "Max",
      speedMode: "standard",
      catalogRevision: "catalog-r1",
      setupGeneration: 1,
    });
    expect(validCliModelSelection(settings, "codexCli")).toEqual(settings.cliModelSelectionByEntry.codexCli);

    settings = selectCliEffort(settings, "codexCli", "Ultra");
    expect(settings.cliModelSelectionByEntry.codexCli?.effort).toBe("Ultra");
    expect(validateCliModelSelection(snapshot, settings.cliModelSelectionByEntry.codexCli)).toBe(true);

    settings = selectCliEffort(settings, "codexCli", "adaptive-super");
    expect(settings.cliModelSelectionByEntry.codexCli?.effort).toBe("adaptive-super");
    expect(validCliModelSelection(settings, "codexCli")?.effort).toBe("adaptive-super");
  });

  it("keeps fresh CLI readiness while model, effort, and speed selections change", () => {
    const snapshot = cliSetupSnapshot("codexCli", "catalog-r1");
    snapshot.catalog!.models.push({
      id: "codex-standard-only",
      label: "Standard-only model",
      description: null,
      isDefault: false,
      defaultEffort: "Max",
      efforts: [{ id: "Max", label: "Max", description: null, isDefault: true }],
      defaultSpeedMode: "standard",
      speedModes: [{ id: "standard", label: "Standard", description: null, isDefault: true }],
    });
    const checkedAt = "2026-07-17T00:00:00.000Z";
    const readyEntry: CliAIEntrySettings = {
      ...(defaultAISettings.entries.codexCli as CliAIEntrySettings),
      authState: "configured",
      readOnlyWrapperState: "ready",
      executionMode: "repoWrite",
      lastCheckedAt: checkedAt,
    };
    let settings: AISettingsState = {
      ...selectCliModel(applyCliSetupSnapshot(defaultAISettings, snapshot), "codexCli", "codex-current"),
      entries: { ...defaultAISettings.entries, codexCli: readyEntry },
      statuses: {
        ...defaultAISettings.statuses,
        codexCli: { state: "ready", code: "success", message: "Ready.", checkedAt },
      },
      lastCheckedAtByEntry: { ...defaultAISettings.lastCheckedAtByEntry, codexCli: checkedAt },
    };

    settings = selectCliEffort(settings, "codexCli", "Ultra");
    expect(settings.statuses.codexCli?.state).toBe("ready");
    expect((settings.entries.codexCli as CliAIEntrySettings).executionMode).toBe("repoWrite");
    expect(settings.lastCheckedAtByEntry.codexCli).toBe(checkedAt);

    settings = selectCliSpeedMode(settings, "codexCli", "fast");
    expect(settings.cliModelSelectionByEntry.codexCli?.speedMode).toBe("fast");
    expect(settings.statuses.codexCli?.state).toBe("ready");

    settings = selectCliModel(settings, "codexCli", "codex-standard-only");
    expect(settings.cliModelSelectionByEntry.codexCli).toMatchObject({
      model: "codex-standard-only",
      effort: "Max",
      speedMode: "standard",
    });
    expect(settings.statuses.codexCli?.state).toBe("ready");
    expect((settings.entries.codexCli as CliAIEntrySettings).readOnlyWrapperState).toBe("ready");
    expect(activeAIChatTarget({ ...settings, activeEntry: "codexCli" })).toMatchObject({ kind: "codexCli" });
  });

  it("binds only the explicit default model and its declared default effort for an initial activation", () => {
    const snapshot = cliSetupSnapshot("codexCli", "catalog-r1");
    snapshot.catalog!.models = [
      {
        id: "first-model",
        label: "First model",
        description: null,
        isDefault: false,
        defaultEffort: "first-default",
        efforts: [{ id: "first-default", label: "First default", description: null, isDefault: true }],
        defaultSpeedMode: "standard",
        speedModes: [{ id: "standard", label: "Standard", description: null, isDefault: true }],
      },
      {
        id: "explicit-default",
        label: "Explicit default",
        description: null,
        isDefault: true,
        defaultEffort: "declared-effort",
        efforts: [
          { id: "flagged-effort", label: "Flagged effort", description: null, isDefault: true },
          { id: "declared-effort", label: "Declared effort", description: null, isDefault: false },
        ],
        defaultSpeedMode: "standard",
        speedModes: [{ id: "standard", label: "Standard", description: null, isDefault: true }],
      },
    ];

    const applied = applyCliSetupSnapshotAndBindSelection(defaultAISettings, snapshot);

    expect(applied.cliSetupByEntry.codexCli).toBe(snapshot);
    expect(applied.cliModelSelectionByEntry.codexCli).toEqual({
      model: "explicit-default",
      effort: "declared-effort",
      speedMode: "standard",
      catalogRevision: "catalog-r1",
      setupGeneration: 1,
    });
    expect(validCliModelSelection(applied, "codexCli")).toEqual(applied.cliModelSelectionByEntry.codexCli);
  });

  it("leaves an initial activation unselected without a usable explicit catalog default", () => {
    const withoutDefault = cliSetupSnapshot("codexCli", "catalog-without-default");
    withoutDefault.catalog!.models[0].isDefault = false;

    const missingDeclaredEffort = cliSetupSnapshot("codexCli", "catalog-missing-effort");
    missingDeclaredEffort.catalog!.models[0].defaultEffort = "missing-effort";

    expect(applyCliSetupSnapshotAndBindSelection(defaultAISettings, withoutDefault).cliModelSelectionByEntry.codexCli).toBeNull();
    expect(applyCliSetupSnapshotAndBindSelection(defaultAISettings, missingDeclaredEffort).cliModelSelectionByEntry.codexCli).toBeNull();
  });

  it("rebinds an existing model and effort to a fresh catalog revision and setup generation", () => {
    const first = cliSetupSnapshot("codexCli", "catalog-r1");
    const selected = selectCliEffort(
      selectCliModel(applyCliSetupSnapshot(defaultAISettings, first), "codexCli", "codex-current"),
      "codexCli",
      "Ultra",
    );
    const refreshed = { ...cliSetupSnapshot("codexCli", "catalog-r2"), setupGeneration: 2 };
    refreshed.catalog!.models[0].isDefault = false;
    refreshed.catalog!.models.unshift({
      id: "new-default",
      label: "New default",
      description: null,
      isDefault: true,
      defaultEffort: "medium",
      efforts: [{ id: "medium", label: "Medium", description: null, isDefault: true }],
      defaultSpeedMode: "standard",
      speedModes: [{ id: "standard", label: "Standard", description: null, isDefault: true }],
    });

    const applied = applyCliSetupSnapshotAndBindSelection(selected, refreshed);

    expect(applied.cliSetupByEntry.codexCli).toBe(refreshed);
    expect(applied.cliModelSelectionByEntry.codexCli).toEqual({
      model: "codex-current",
      effort: "Ultra",
      speedMode: "standard",
      catalogRevision: "catalog-r2",
      setupGeneration: 2,
    });
    expect(validCliModelSelection(applied, "codexCli")).toEqual(applied.cliModelSelectionByEntry.codexCli);
  });

  it("can rebind the selection captured before an overlapping refresh cleared browser state", () => {
    const first = cliSetupSnapshot("codexCli", "catalog-r1");
    const selected = selectCliEffort(
      selectCliModel(applyCliSetupSnapshot(defaultAISettings, first), "codexCli", "codex-current"),
      "codexCli",
      "Ultra",
    );
    const preferred = selected.cliModelSelectionByEntry.codexCli;
    const cleared = {
      ...selected,
      cliModelSelectionByEntry: { ...selected.cliModelSelectionByEntry, codexCli: null },
    };
    const refreshed = { ...cliSetupSnapshot("codexCli", "catalog-r2"), setupGeneration: 2 };

    const applied = applyCliSetupSnapshotAndBindSelection(cleared, refreshed, preferred);

    expect(applied.cliModelSelectionByEntry.codexCli).toEqual({
      model: "codex-current",
      effort: "Ultra",
      speedMode: "standard",
      catalogRevision: "catalog-r2",
      setupGeneration: 2,
    });
  });

  it("does not fall back to a default when an existing model or effort disappears", () => {
    const first = cliSetupSnapshot("codexCli", "catalog-r1");
    const selected = selectCliEffort(
      selectCliModel(applyCliSetupSnapshot(defaultAISettings, first), "codexCli", "codex-current"),
      "codexCli",
      "Ultra",
    );
    const missingModel = { ...cliSetupSnapshot("codexCli", "catalog-r2"), setupGeneration: 2 };
    missingModel.catalog!.models = [{
      id: "new-default",
      label: "New default",
      description: null,
      isDefault: true,
      defaultEffort: "medium",
      efforts: [{ id: "medium", label: "Medium", description: null, isDefault: true }],
      defaultSpeedMode: "standard",
      speedModes: [{ id: "standard", label: "Standard", description: null, isDefault: true }],
    }];
    const missingEffort = { ...cliSetupSnapshot("codexCli", "catalog-r3"), setupGeneration: 2 };
    missingEffort.catalog!.models[0].efforts = missingEffort.catalog!.models[0].efforts.filter((effort) => effort.id !== "Ultra");

    expect(applyCliSetupSnapshotAndBindSelection(selected, missingModel).cliModelSelectionByEntry.codexCli).toBeNull();
    expect(applyCliSetupSnapshotAndBindSelection(selected, missingEffort).cliModelSelectionByEntry.codexCli).toBeNull();
  });

  it("keeps non-ready snapshots unselected even when a prior selection exists", () => {
    const first = cliSetupSnapshot("codexCli", "catalog-r1");
    const selected = selectCliModel(applyCliSetupSnapshot(defaultAISettings, first), "codexCli", "codex-current");
    const loginRequired: AICliSetupSnapshot = {
      ...first,
      setupGeneration: 2,
      phase: "loginRequired",
      catalog: undefined,
      authentication: { state: "idle" },
    };

    const applied = applyCliSetupSnapshotAndBindSelection(selected, loginRequired);

    expect(applied.cliSetupByEntry.codexCli).toBe(loginRequired);
    expect(applied.cliModelSelectionByEntry.codexCli).toBeNull();
  });

  it("does not rebind from lower-generation or delayed transitional snapshots", () => {
    const currentSnapshot = { ...cliSetupSnapshot("codexCli", "catalog-r3"), setupGeneration: 3 };
    const current = selectCliModel(
      applyCliSetupSnapshot(defaultAISettings, currentSnapshot),
      "codexCli",
      "codex-current",
    );
    const lowerGeneration = { ...cliSetupSnapshot("codexCli", "catalog-r2"), setupGeneration: 2 };
    const delayedInspecting: AICliSetupSnapshot = {
      ...currentSnapshot,
      phase: "inspecting",
      catalog: undefined,
    };

    const lowerResult = applyCliSetupSnapshotAndBindSelection(current, lowerGeneration);
    const delayedResult = applyCliSetupSnapshotAndBindSelection(current, delayedInspecting);

    expect(lowerResult).toBe(current);
    expect(delayedResult).toBe(current);
    expect(current.cliModelSelectionByEntry.codexCli).toEqual({
      model: "codex-current",
      effort: "Max",
      speedMode: "standard",
      catalogRevision: "catalog-r3",
      setupGeneration: 3,
    });
  });

  it("invalidates stale catalog selections and repo readiness fail closed", () => {
    const readyCli: CliAIEntrySettings = {
      ...(defaultAISettings.entries.codexCli as CliAIEntrySettings),
      authState: "configured",
      readOnlyWrapperState: "ready",
      executionMode: "repoWrite",
      lastCheckedAt: "2026-07-16T00:00:00.000Z",
    };
    let settings: AISettingsState = {
      ...defaultAISettings,
      activeEntry: "codexCli",
      entries: { ...defaultAISettings.entries, codexCli: readyCli },
      statuses: {
        ...defaultAISettings.statuses,
        codexCli: { state: "ready", code: "success", message: "Ready.", checkedAt: "2026-07-16T00:00:00.000Z" },
      },
      lastCheckedAtByEntry: { ...defaultAISettings.lastCheckedAtByEntry, codexCli: "2026-07-16T00:00:00.000Z" },
      cliSetupByEntry: { ...defaultAISettings.cliSetupByEntry, codexCli: cliSetupSnapshot("codexCli", "catalog-r1") },
      cliModelSelectionByEntry: {
        ...defaultAISettings.cliModelSelectionByEntry,
        codexCli: { model: "codex-current", effort: "Max", speedMode: "standard", catalogRevision: "catalog-r1", setupGeneration: 1 },
      },
    };
    expect(activeAIChatTarget(settings)).toMatchObject({ kind: "codexCli" });

    settings = applyCliSetupSnapshot(settings, cliSetupSnapshot("codexCli", "catalog-r2"));
    expect(settings.cliModelSelectionByEntry.codexCli).toBeNull();
    expect(settings.statuses.codexCli).toBeNull();
    expect((settings.entries.codexCli as CliAIEntrySettings).executionMode).toBe("unknown");
    expect(activeAIChatTarget(settings)).toBeUndefined();

    settings = selectCliModel(settings, "codexCli", "codex-current");
    expect(settings.cliModelSelectionByEntry.codexCli?.catalogRevision).toBe("catalog-r2");
    settings = invalidateAIReadiness(settings);
    expect(settings.cliModelSelectionByEntry).toEqual({ codexCli: null, claudeCli: null });
  });

  it("invalidates readiness and selection when setup generation changes with the same catalog revision", () => {
    const readyCli: CliAIEntrySettings = {
      ...(defaultAISettings.entries.codexCli as CliAIEntrySettings),
      authState: "configured",
      readOnlyWrapperState: "ready",
      executionMode: "repoWrite",
      lastCheckedAt: "2026-07-16T00:00:00.000Z",
    };
    const first = cliSetupSnapshot("codexCli", "catalog-r1");
    const settings: AISettingsState = {
      ...defaultAISettings,
      activeEntry: "codexCli",
      entries: { ...defaultAISettings.entries, codexCli: readyCli },
      statuses: { ...defaultAISettings.statuses, codexCli: { state: "ready", code: "success", message: "Ready.", checkedAt: "2026-07-16T00:00:00.000Z" } },
      cliSetupByEntry: { ...defaultAISettings.cliSetupByEntry, codexCli: first },
      cliModelSelectionByEntry: {
        ...defaultAISettings.cliModelSelectionByEntry,
        codexCli: { model: "codex-current", effort: "Max", speedMode: "standard", catalogRevision: "catalog-r1", setupGeneration: 1 },
      },
    };

    const refreshed = applyCliSetupSnapshot(settings, { ...first, setupGeneration: 2 });

    expect(refreshed.statuses.codexCli).toBeNull();
    expect(refreshed.cliModelSelectionByEntry.codexCli).toBeNull();
    expect((refreshed.entries.codexCli as CliAIEntrySettings).executionMode).toBe("unknown");
    expect(activeAIChatTarget(refreshed)).toBeUndefined();
  });

  it("ignores lower-generation and same-generation transitional setup snapshots", () => {
    const ready = { ...cliSetupSnapshot("codexCli", "catalog-r1"), setupGeneration: 3 };
    const settings = applyCliSetupSnapshot(defaultAISettings, ready);

    const lowerGeneration = applyCliSetupSnapshot(settings, {
      ...ready,
      setupGeneration: 2,
      phase: "failed",
      catalog: undefined,
      failureReason: "stale-response",
    });
    const delayedInspecting = applyCliSetupSnapshot(settings, {
      ...ready,
      phase: "inspecting",
      catalog: undefined,
    });
    const delayedUpdate = applyCliSetupSnapshot(settings, {
      ...ready,
      phase: "updateRequired",
      catalog: undefined,
      update: { state: "running", startedAt: "2026-07-16T00:00:00.000Z" },
    });

    expect(lowerGeneration).toBe(settings);
    expect(delayedInspecting).toBe(settings);
    expect(delayedUpdate).toBe(settings);
    expect(settings.cliSetupByEntry.codexCli).toMatchObject({ phase: "ready", setupGeneration: 3 });
  });

  it("requires a new readiness check when switching back to a CLI entry", () => {
    const readyCli: CliAIEntrySettings = {
      ...(defaultAISettings.entries.codexCli as CliAIEntrySettings),
      authState: "configured",
      readOnlyWrapperState: "ready",
      executionMode: "repoWrite",
      lastCheckedAt: "2026-07-16T00:00:00.000Z",
    };
    const settings: AISettingsState = {
      ...defaultAISettings,
      activeEntry: "claudeCli",
      entries: { ...defaultAISettings.entries, codexCli: readyCli },
      statuses: { ...defaultAISettings.statuses, codexCli: { state: "ready", code: "success", message: "Ready.", checkedAt: "2026-07-16T00:00:00.000Z" } },
      cliSetupByEntry: { ...defaultAISettings.cliSetupByEntry, codexCli: cliSetupSnapshot("codexCli", "catalog-r1") },
      cliModelSelectionByEntry: {
        ...defaultAISettings.cliModelSelectionByEntry,
        codexCli: { model: "codex-current", effort: "Max", speedMode: "standard", catalogRevision: "catalog-r1", setupGeneration: 1 },
      },
    };

    const switched = selectAIEntry(settings, "codexCli");

    expect(switched.activeEntry).toBe("codexCli");
    expect(switched.statuses.codexCli).toBeNull();
    expect((switched.entries.codexCli as CliAIEntrySettings).executionMode).toBe("unknown");
    expect(switched.cliModelSelectionByEntry.codexCli).toEqual(settings.cliModelSelectionByEntry.codexCli);
    expect(activeAIChatTarget(switched)).toBeUndefined();
  });

  it("invalidates only CLI repo readiness while preserving setup, selections, and provider state", () => {
    const readyCli = {
      ...(defaultAISettings.entries.codexCli as CliAIEntrySettings),
      authState: "configured" as const,
      readOnlyWrapperState: "ready" as const,
      executionMode: "repoWrite" as const,
      lastCheckedAt: "2026-07-16T00:00:00.000Z",
    };
    const providerStatus = { state: "ready", code: "success", message: "Ready.", checkedAt: "2026-07-16T00:00:00.000Z" } as const;
    const settings: AISettingsState = {
      ...defaultAISettings,
      activeEntry: "codexCli",
      entries: { ...defaultAISettings.entries, codexCli: readyCli },
      statuses: { ...defaultAISettings.statuses, aiApi: providerStatus, codexCli: providerStatus },
      lastCheckedAtByEntry: {
        ...defaultAISettings.lastCheckedAtByEntry,
        aiApi: providerStatus.checkedAt,
        codexCli: providerStatus.checkedAt,
      },
      cliSetupByEntry: { ...defaultAISettings.cliSetupByEntry, codexCli: cliSetupSnapshot("codexCli", "catalog-r1") },
      cliModelSelectionByEntry: {
        ...defaultAISettings.cliModelSelectionByEntry,
        codexCli: { model: "codex-current", effort: "Max", speedMode: "standard", catalogRevision: "catalog-r1", setupGeneration: 1 },
      },
    };

    const invalidated = invalidateCliReadinessForRepositoryChange(settings);
    expect(invalidated.cliSetupByEntry).toEqual(settings.cliSetupByEntry);
    expect(invalidated.cliModelSelectionByEntry).toEqual(settings.cliModelSelectionByEntry);
    expect(invalidated.statuses.aiApi).toBe(providerStatus);
    expect(invalidated.statuses.codexCli).toBeNull();
    expect((invalidated.entries.codexCli as CliAIEntrySettings)).toMatchObject({
      readOnlyWrapperState: "unknown",
      executionMode: "unknown",
      lastCheckedAt: "",
      readinessMessage: "The Current repo changed. Run readiness again before sending.",
    });
    expect(activeAIChatTarget(invalidated)).toBeUndefined();
  });

  it("clears CLI setup state when the CLI entry changes but leaves provider model behavior unchanged", () => {
    const configured = selectCliModel(
      applyCliSetupSnapshot(defaultAISettings, cliSetupSnapshot("claudeCli", "claude-r1")),
      "claudeCli",
      "codex-current",
    );
    const providerBehavior = configured.modelBehaviorByEntry.aiApi;
    const updated = updateAIEntry(configured, "claudeCli", { binaryName: "claude" });
    expect(updated.cliSetupByEntry.claudeCli).toBeNull();
    expect(updated.cliModelSelectionByEntry.claudeCli).toBeNull();
    expect(updated.modelBehaviorByEntry.aiApi).toEqual(providerBehavior);
    expect(updated.modelBehaviorByEntry.localAi).toEqual(configured.modelBehaviorByEntry.localAi);
  });

  it("normalizes AI model behavior by active entry and model capability", () => {
    const codexSettings = { ...defaultAISettings, activeEntry: "codexCli" as const };
    expect(aiModelBehaviorCapability(codexSettings, "codexCli")).toMatchObject({ kind: "intelligence", label: "Codex intelligence", levels: ["low", "medium", "high", "xhigh"] });
    expect(activeAIModelBehavior(codexSettings)).toEqual({ kind: "intelligence", level: "medium" });
    expect(activeAIModelBehavior(updateAIModelBehavior(codexSettings, "codexCli", { kind: "intelligence", level: "xhigh" }))).toEqual({ kind: "intelligence", level: "xhigh" });

    const gptApi: AIProviderSettings = { ...(defaultAISettings.entries.aiApi as AIProviderSettings), provider: "openai", model: "gpt-5" };
    const gptSettings = {
      ...defaultAISettings,
      activeEntry: "aiApi" as const,
      entries: { ...defaultAISettings.entries, aiApi: gptApi },
    };
    expect(aiModelBehaviorCapability(gptSettings, "aiApi")).toMatchObject({ kind: "intelligence", levels: ["low", "medium", "high"] });
    expect(activeAIModelBehavior(gptSettings)).toEqual({ kind: "intelligence", level: "medium" });
    expect(activeAIModelBehavior(updateAIModelBehavior(gptSettings, "aiApi", { kind: "intelligence", level: "high" }))).toEqual({ kind: "intelligence", level: "high" });

    const qwenLocal: AIProviderSettings = { ...(defaultAISettings.entries.localAi as AIProviderSettings), model: "qwen3:latest" };
    const qwenSettings = {
      ...defaultAISettings,
      activeEntry: "localAi" as const,
      entries: { ...defaultAISettings.entries, localAi: qwenLocal },
    };
    expect(aiModelBehaviorCapability(qwenSettings, "localAi")).toMatchObject({ kind: "thinking" });
    expect(activeAIModelBehavior(qwenSettings)).toEqual({ kind: "thinking", enabled: true });
    expect(activeAIModelBehavior(updateAIModelBehavior(qwenSettings, "localAi", { kind: "thinking", enabled: false }))).toEqual({ kind: "thinking", enabled: false });

    const unknownLocal: AIProviderSettings = { ...qwenLocal, model: "llama-local" };
    const unknownSettings = {
      ...defaultAISettings,
      activeEntry: "localAi" as const,
      entries: { ...defaultAISettings.entries, localAi: unknownLocal },
    };
    expect(aiModelBehaviorCapability(unknownSettings, "localAi")).toMatchObject({ kind: "none" });
    expect(activeAIModelBehavior(unknownSettings)).toEqual({ kind: "none" });
  });
});

function installLocalStorageMock(): void {
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
    } satisfies Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear">,
  });
}

function cliSetupSnapshot(entry: AICliEntryKind, revision: string): AICliSetupSnapshot {
  return {
    entry,
    setupGeneration: 1,
    phase: "ready",
    message: "Authentication and model catalog are ready.",
    cliVersion: "1.0.0",
    checkedAt: "2026-07-16T00:00:00.000Z",
    compatibility: "compatible",
    authentication: { state: "succeeded" },
    update: { state: "idle" },
    catalog: {
      entry,
      cliVersion: "1.0.0",
      revision,
      fetchedAt: "2026-07-16T00:00:00.000Z",
      models: [
        {
          id: "codex-current",
          label: "Current model",
          description: null,
          isDefault: true,
          defaultEffort: "Max",
          efforts: [
            { id: "Max", label: "Max", description: null, isDefault: true },
            { id: "Ultra", label: "Ultra", description: null, isDefault: false },
            { id: "adaptive-super", label: "Adaptive super", description: null, isDefault: false },
          ],
          defaultSpeedMode: "standard",
          speedModes: [
            { id: "standard", label: "Standard", description: "Regular service tier.", isDefault: true },
            { id: "fast", label: "Fast", description: "Faster inference when supported.", isDefault: false },
          ],
        },
      ],
    },
  };
}
