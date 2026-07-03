import { describe, expect, it } from "vitest";
import { activeAIChatTarget, activeAIProvider, aiReady, defaultAISettings, effectiveAIStatus, normalizeAISettingsState, type AISettingsState } from "../src/settingsState";
import type { AIProviderSettings, CliAIEntrySettings } from "../src/types";

describe("settings state", () => {
  it("starts without an active AI provider", () => {
    expect(defaultAISettings.activeEntry).toBeNull();
    expect(activeAIProvider(defaultAISettings)).toBeNull();
    expect(Object.keys(defaultAISettings.entries)).toEqual(["aiApi", "localAi", "codexCli", "claudeCli"]);
    expect(effectiveAIStatus(defaultAISettings, "aiApi").message).toBe("Provider settings are not configured.");
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
    expect(activeAIChatTarget(migrated)).toEqual({ kind: "cli", entry: "codexCli" });
  });

  it("selects provider and CLI chat targets only when the active entry is ready", () => {
    const localAiReady: AIProviderSettings = { ...(defaultAISettings.entries.localAi as AIProviderSettings), model: "local-model" };
    const aiApiReady: AIProviderSettings = { ...(defaultAISettings.entries.aiApi as AIProviderSettings), credential: "local-test-key" };
    const codexReady: CliAIEntrySettings = {
      ...(defaultAISettings.entries.codexCli as CliAIEntrySettings),
      authState: "configured",
      readOnlyWrapperState: "ready",
      executionMode: "readOnly",
    };

    expect(activeAIChatTarget({ ...defaultAISettings, activeEntry: "aiApi" })).toBeNull();
    expect(activeAIChatTarget({ ...defaultAISettings, activeEntry: "codexCli" })).toBeNull();
    expect(aiReady(localAiReady)).toBe(true);
    expect(activeAIChatTarget({ ...defaultAISettings, activeEntry: "localAi", entries: { ...defaultAISettings.entries, localAi: localAiReady } })).toEqual({
      kind: "provider",
      provider: localAiReady,
    });
    expect(activeAIChatTarget({ ...defaultAISettings, activeEntry: "aiApi", entries: { ...defaultAISettings.entries, aiApi: aiApiReady } })).toEqual({
      kind: "provider",
      provider: aiApiReady,
    });
    expect(activeAIChatTarget({ ...defaultAISettings, activeEntry: "codexCli", entries: { ...defaultAISettings.entries, codexCli: codexReady } })).toEqual({
      kind: "cli",
      entry: "codexCli",
    });
  });
});
