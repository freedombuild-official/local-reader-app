import { afterEach, describe, expect, it, vi } from "vitest";
import { activeAIChatTarget, activeAIProvider, aiReady, defaultAISettings, effectiveAIStatus, loadBasicSettings, normalizeAISettingsState, persistBasicSettings, type AISettingsState } from "../src/settingsState";
import type { AIProviderSettings, CliAIEntrySettings } from "../src/types";

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
