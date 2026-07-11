// @vitest-environment node

import express from "express";
import { type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { requestAIChatCompletion, requestAIChatCompletionStream, testAIConnection } from "../server/aiProviders.js";
import type { AIProviderSettings } from "../server/types.js";

async function listen(app: express.Express): Promise<{ url: string; close: () => Promise<void> }> {
  const server = await new Promise<Server>((resolve, reject) => {
    const next = app.listen(0, "127.0.0.1");
    next.once("listening", () => resolve(next));
    next.once("error", reject);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function localProvider(baseUrl: string): AIProviderSettings {
  return {
    entry: "localAi",
    runtime: "lmStudio",
    model: "wanted-model",
    baseUrl,
    apiFormat: "openaiCompatible",
    credential: "",
  };
}

function remoteProvider(baseUrl: string): AIProviderSettings {
  return {
    entry: "aiApi",
    provider: "openaiCompatible",
    model: "wanted-model",
    baseUrl,
    apiFormat: "openaiCompatible",
    credential: "test-token",
  };
}

describe("AI provider network boundary", () => {
  it("rejects loopback, private, link-local, and metadata destinations for remote AI API entries", async () => {
    for (const baseUrl of [
      "https://127.0.0.1/v1",
      "https://10.0.0.1/v1",
      "https://169.254.169.254/latest",
      "https://[::1]/v1",
      "https://[fe80::1]/v1",
    ]) {
      await expect(testAIConnection(remoteProvider(baseUrl))).resolves.toMatchObject({
        state: "failed",
        code: "invalid_endpoint",
      });
    }
  });

  it("blocks cross-origin redirects before the redirected server is contacted", async () => {
    let redirectedHits = 0;
    const redirectedApp = express();
    redirectedApp.get("/models", (_request, response) => {
      redirectedHits += 1;
      response.json({ data: [{ id: "wanted-model" }] });
    });
    const redirected = await listen(redirectedApp);
    const originApp = express();
    originApp.get("/v1/models", (_request, response) => response.redirect(`${redirected.url}/models`));
    const origin = await listen(originApp);
    try {
      await expect(testAIConnection(localProvider(`${origin.url}/v1`))).resolves.toMatchObject({
        state: "failed",
        code: "invalid_endpoint",
        message: expect.stringContaining("exact configured origin"),
      });
      expect(redirectedHits).toBe(0);
    } finally {
      await Promise.all([origin.close(), redirected.close()]);
    }
  });

  it("allows same-origin redirects and requires a non-empty protocol response", async () => {
    const app = express();
    let emptyResponse = false;
    app.use(express.json());
    app.get("/v1/models", (_request, response) => response.redirect("/v1/redirected-models"));
    app.get("/v1/redirected-models", (_request, response) => response.json({ data: [{ id: "wanted-model" }] }));
    app.post("/v1/chat/completions", (_request, response) => response.json({ choices: [{ message: { content: emptyResponse ? "" : "Reader-Wiki ready." } }] }));
    const server = await listen(app);
    try {
      await expect(testAIConnection(localProvider(`${server.url}/v1`))).resolves.toMatchObject({
        state: "ready",
        code: "success",
      });
      emptyResponse = true;
      await expect(testAIConnection(localProvider(`${server.url}/v1`))).resolves.toMatchObject({
        state: "failed",
        code: "provider_http_error",
        message: expect.stringContaining("empty"),
      });
    } finally {
      await server.close();
    }
  });

  it("sends a caller-supplied protocol instruction as an OpenAI-compatible system message", async () => {
    const app = express();
    let receivedMessages: Array<{ role?: string; content?: string }> = [];
    let receivedTemperature: number | undefined;
    let receivedResponseFormat: { type?: string; json_schema?: { strict?: boolean; schema?: { additionalProperties?: boolean } } } | undefined;
    app.use(express.json());
    app.post("/v1/chat/completions", (request, response) => {
      const body = request.body as {
        messages?: Array<{ role?: string; content?: string }>;
        temperature?: number;
        response_format?: typeof receivedResponseFormat;
      };
      receivedMessages = body.messages || [];
      receivedTemperature = body.temperature;
      receivedResponseFormat = body.response_format;
      response.json({ choices: [{ message: { content: "ok" } }] });
    });
    const server = await listen(app);
    try {
      await expect(requestAIChatCompletion({
        provider: localProvider(`${server.url}/v1`),
        systemPrompt: "Return only the versioned protocol object.",
        messages: [{ role: "user", content: "plan" }],
      })).resolves.toMatchObject({ content: "ok" });
      expect(receivedMessages).toEqual([
        { role: "system", content: "Return only the versioned protocol object." },
        { role: "user", content: "plan" },
      ]);
      expect(receivedTemperature).toBe(0);
      expect(receivedResponseFormat).toMatchObject({
        type: "json_schema",
        json_schema: { strict: false, schema: { additionalProperties: false } },
      });
    } finally {
      await server.close();
    }
  });

  it("stops oversized JSON and streaming responses at their byte budgets", async () => {
    const app = express();
    app.use(express.json());
    app.get("/oversized/models", (_request, response) => {
      response.type("application/json").send(JSON.stringify({ data: [{ id: "x".repeat(1024 * 1024 + 64) }] }));
    });
    app.get("/stream/models", (_request, response) => response.json({ data: [{ id: "wanted-model" }] }));
    app.post("/stream/chat/completions", (_request, response) => {
      response.setHeader("Content-Type", "text/event-stream");
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "x".repeat(2 * 1024 * 1024 + 64) } }] })}\n\n`);
    });
    const server = await listen(app);
    try {
      await expect(testAIConnection(localProvider(`${server.url}/oversized`))).resolves.toMatchObject({
        state: "failed",
        code: "provider_http_error",
        message: expect.stringContaining("byte limit"),
      });
      await expect(requestAIChatCompletionStream({
        provider: localProvider(`${server.url}/stream`),
        messages: [{ role: "user", content: "stream" }],
      }, () => undefined)).rejects.toMatchObject({
        status: 502,
        message: expect.stringContaining("byte limit"),
      });
    } finally {
      await server.close();
    }
  });

  it("aborts the underlying provider response when the caller cancels", async () => {
    let markStarted: (() => void) | null = null;
    let markClosed: (() => void) | null = null;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    const app = express();
    app.use(express.json());
    app.post("/v1/chat/completions", (_request, response) => {
      response.setHeader("Content-Type", "text/event-stream");
      response.once("close", () => markClosed?.());
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "started" } }] })}\n\n`);
      markStarted?.();
    });
    const server = await listen(app);
    const controller = new AbortController();
    try {
      const run = requestAIChatCompletionStream({
        provider: localProvider(`${server.url}/v1`),
        messages: [{ role: "user", content: "cancel" }],
        signal: controller.signal,
      }, () => undefined);
      await started;
      controller.abort();
      await expect(run).rejects.toMatchObject({ status: 499 });
      await Promise.race([
        closed,
        new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("Provider response did not close after cancellation.")), 2_000)),
      ]);
    } finally {
      controller.abort();
      await server.close();
    }
  });
});
