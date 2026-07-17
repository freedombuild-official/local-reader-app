// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  fingerprintCodexModelCatalog,
  loadCodexModelCatalog,
  normalizeCodexCatalogModel,
  type CodexModelListRequester,
} from "../server/aiCliCatalog.js";

function rawModel(index = 1, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `model-id-${index}`,
    model: `codex-model-${index}`,
    displayName: `Codex Model ${index}`,
    description: `Model ${index} description`,
    hidden: false,
    isDefault: index === 1,
    defaultReasoningEffort: "medium",
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast" },
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "Deep" },
    ],
    ...overrides,
  };
}

function requesterFor(responses: unknown[]): CodexModelListRequester {
  let index = 0;
  return { request: async <T>() => responses[index++] as T };
}

describe("Codex app-server model catalog", () => {
  it("retains Max, Ultra, and unknown reasoning efforts from the live-shaped response", async () => {
    const catalog = await loadCodexModelCatalog(requesterFor([{
      data: [rawModel(1, {
        defaultReasoningEffort: "max",
        supportedReasoningEfforts: [
          { reasoningEffort: "max", description: "Maximum" },
          { reasoningEffort: "ultra", description: "Provider-defined ultra" },
          { reasoningEffort: "future-depth", description: "A future effort level" },
        ],
      })],
      nextCursor: null,
    }]), { cliVersion: "codex-cli 1.2.3", now: () => new Date("2026-07-16T00:00:00.000Z") });

    expect(catalog.models[0]?.supportedReasoningEfforts.map((option) => option.reasoningEffort)).toEqual(["max", "ultra", "future-depth"]);
    expect(catalog).toMatchObject({ cliVersion: "codex-cli 1.2.3", fetchedAt: "2026-07-16T00:00:00.000Z" });
    expect(catalog.revision).toMatch(/^[a-f0-9]{64}$/);
  });

  it("paginates model/list with a bounded cursor contract", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const responses = [
      { data: [rawModel(1)], nextCursor: "page-2" },
      { data: [rawModel(2, { isDefault: false })], nextCursor: null },
    ];
    let index = 0;
    const requester: CodexModelListRequester = {
      request: async <T>(method: string, params?: unknown) => {
        calls.push({ method, params });
        return responses[index++] as T;
      },
    };
    const catalog = await loadCodexModelCatalog(requester, { cliVersion: "1.2.3" });
    expect(catalog.models).toHaveLength(2);
    expect(calls).toEqual([
      { method: "model/list", params: { cursor: null, limit: 100, includeHidden: false } },
      { method: "model/list", params: { cursor: "page-2", limit: 100, includeHidden: false } },
    ]);
  });

  it("propagates the setup abort signal and bounded request timeout to model/list", async () => {
    const controller = new AbortController();
    const calls: Array<{ signal?: AbortSignal; timeoutMs?: number }> = [];
    const requester: CodexModelListRequester = {
      request: async <T>(_method: string, _params?: unknown, options?: { signal?: AbortSignal; timeoutMs?: number }) => {
        calls.push(options || {});
        return { data: [rawModel(1)], nextCursor: null } as T;
      },
    };

    await loadCodexModelCatalog(requester, {
      cliVersion: "1.2.3",
      signal: controller.signal,
      requestTimeoutMs: 12_345,
    });

    expect(calls).toEqual([{ signal: controller.signal, timeoutMs: 12_345 }]);
  });

  it("rejects duplicate models and invalid defaults", async () => {
    await expect(loadCodexModelCatalog(requesterFor([
      { data: [rawModel(1)], nextCursor: "next" },
      { data: [rawModel(2, { id: "model-id-1", isDefault: false })], nextCursor: null },
    ]), { cliVersion: "1.2.3" })).rejects.toThrow(/duplicate/);

    await expect(loadCodexModelCatalog(requesterFor([{
      data: [rawModel(1, { isDefault: false })],
      nextCursor: null,
    }]), { cliVersion: "1.2.3" })).rejects.toThrow(/exactly one default model/);

    await expect(loadCodexModelCatalog(requesterFor([{
      data: [rawModel(1, {
        defaultReasoningEffort: "max",
        supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
      })],
      nextCursor: null,
    }]), { cliVersion: "1.2.3" })).rejects.toThrow(/reasoning effort/);
  });

  it("enforces effort, model, page, and bounded-string limits", async () => {
    expect(() => normalizeCodexCatalogModel(rawModel(1, {
      supportedReasoningEfforts: Array.from({ length: 33 }, (_, index) => ({ reasoningEffort: `effort-${index}`, description: "" })),
    }))).toThrow(/reasoning effort options/);
    expect(() => normalizeCodexCatalogModel(rawModel(1, { model: "x".repeat(161) }))).toThrow(/model name/);
    await expect(loadCodexModelCatalog(requesterFor([{
      data: Array.from({ length: 201 }, (_, index) => rawModel(index + 1, { isDefault: index === 0 })),
      nextCursor: null,
    }]), { cliVersion: "1.2.3" })).rejects.toThrow(/model limit/);

    let page = 0;
    const endlessRequester: CodexModelListRequester = { request: async <T>() => ({ data: [], nextCursor: `cursor-${++page}` }) as T };
    await expect(loadCodexModelCatalog(endlessRequester, { cliVersion: "1.2.3" })).rejects.toThrow(/page limit/);
  });

  it("creates a deterministic SHA-256 revision", () => {
    const model = normalizeCodexCatalogModel(rawModel(1));
    const first = fingerprintCodexModelCatalog("1.2.3", [model]);
    expect(fingerprintCodexModelCatalog("1.2.3", [model])).toBe(first);
    expect(fingerprintCodexModelCatalog("1.2.4", [model])).not.toBe(first);
    expect(first).toMatch(/^[a-f0-9]{64}$/);
  });
});
