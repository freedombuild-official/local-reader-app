import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  JsonlJsonRpcClient,
  JsonRpcRemoteError,
  spawnCodexAppServer,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
} from "../server/codexAppServerClient";

function createHarness(maxLineBytes?: number) {
  const input = new PassThrough();
  const output = new PassThrough();
  const errorOutput = new PassThrough();
  input.setEncoding("utf8");
  const client = new JsonlJsonRpcClient({ input, output, errorOutput, requestTimeoutMs: 1_000, maxLineBytes });
  return { client, input, output, errorOutput };
}

function nextWrittenLine(input: PassThrough): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    input.once("data", (chunk: string) => resolve(JSON.parse(chunk.trim()) as Record<string, unknown>));
  });
}

function waitForDescendantReady(client: JsonlJsonRpcClient): Promise<number> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for the test descendant."));
    }, 2_000);
    const onNotification = (notification: JsonRpcNotification) => {
      const params = notification.params;
      if (
        notification.method !== "test/ready"
        || !params
        || typeof params !== "object"
        || !("pid" in params)
        || typeof params.pid !== "number"
      ) return;
      cleanup();
      resolve(params.pid);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      client.off("notification", onNotification);
      client.off("clientError", onError);
      client.off("processError", onError);
    };
    client.on("notification", onNotification);
    client.on("clientError", onError);
    client.on("processError", onError);
  });
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function processGroupExists(processGroupId: number): boolean {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function forceCleanupProcessTree(processGroupId: number | undefined, descendantPid: number | undefined): Promise<void> {
  if (processGroupId && processGroupExists(processGroupId)) {
    try {
      process.kill(-processGroupId, "SIGKILL");
    } catch {
      // Best-effort cleanup continues with the known descendant PID below.
    }
  }
  if (descendantPid && processExists(descendantPid)) {
    try {
      process.kill(descendantPid, "SIGKILL");
    } catch {
      // The descendant may have exited between the liveness check and signal.
    }
  }
  const deadline = Date.now() + 2_000;
  while (
    Date.now() < deadline
    && ((processGroupId !== undefined && processGroupExists(processGroupId))
      || (descendantPid !== undefined && processExists(descendantPid)))
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (
    (processGroupId !== undefined && processGroupExists(processGroupId))
    || (descendantPid !== undefined && processExists(descendantPid))
  ) {
    throw new Error("Test process-tree cleanup did not complete.");
  }
}

describe("JsonlJsonRpcClient", () => {
  it("correlates fragmented responses and emits notifications and server requests", async () => {
    const { client, input, output } = createHarness();
    const written = nextWrittenLine(input);
    const pending = client.request<{ ok: boolean }>("model/list", { cursor: null });
    const request = await written;

    expect(request).toMatchObject({ id: 1, method: "model/list", params: { cursor: null } });
    output.write('{"id":1,"result":{"ok":');
    output.write('true}}\n');
    await expect(pending).resolves.toEqual({ ok: true });

    let notification: JsonRpcNotification | undefined;
    let serverRequest: JsonRpcServerRequest | undefined;
    client.once("notification", (value) => { notification = value as JsonRpcNotification; });
    client.once("serverRequest", (value) => { serverRequest = value as JsonRpcServerRequest; });
    output.write(`${JSON.stringify({ method: "account/updated", params: { authenticated: true } })}\n`);
    output.write(`${JSON.stringify({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { command: "fixed" } })}\n`);

    expect(notification).toEqual({ method: "account/updated", params: { authenticated: true } });
    expect(serverRequest).toEqual({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { command: "fixed" } });

    const responseWritten = nextWrittenLine(input);
    client.respondError("approval-1", { code: -32_000, message: "Denied." });
    await expect(responseWritten).resolves.toEqual({ id: "approval-1", error: { code: -32_000, message: "Denied." } });
    client.close();
  });

  it("surfaces remote errors and aborts pending requests without accepting a late response", async () => {
    const { client, input, output } = createHarness();
    const errorWritten = nextWrittenLine(input);
    const errorRequest = client.request("account/read");
    const errorMessage = await errorWritten;
    output.write(`${JSON.stringify({ id: errorMessage.id, error: { code: -32_001, message: "Not signed in.", data: { retry: false } } })}\n`);
    await expect(errorRequest).rejects.toMatchObject({
      name: "JsonRpcRemoteError",
      method: "account/read",
      code: -32_001,
      data: { retry: false },
    } satisfies Partial<JsonRpcRemoteError>);

    const controller = new AbortController();
    const abortedWritten = nextWrittenLine(input);
    const abortedRequest = client.request("model/list", undefined, { signal: controller.signal });
    const abortedMessage = await abortedWritten;
    controller.abort();
    await expect(abortedRequest).rejects.toMatchObject({ name: "AbortError" });
    output.write(`${JSON.stringify({ id: abortedMessage.id, result: { data: [] } })}\n`);
    client.close();
  });

  it("closes and rejects pending work when stdout is malformed", async () => {
    const { client, input, output } = createHarness();
    const written = nextWrittenLine(input);
    const pending = client.request("model/list");
    await written;
    const clientError = new Promise<Error>((resolve) => client.once("clientError", resolve));

    output.write("not-json\n");

    await expect(pending).rejects.toThrow();
    await expect(clientError).resolves.toBeInstanceOf(Error);
    await expect(client.request("account/read")).rejects.toThrow("closed");
  });

  it("bounds an unterminated JSONL line by UTF-8 bytes", async () => {
    const { client, output } = createHarness(8);
    const clientError = new Promise<Error>((resolve) => client.once("clientError", resolve));

    output.write("😀");
    output.write("😀");
    output.write("😀");

    await expect(clientError).resolves.toMatchObject({ message: "Codex app-server JSONL line exceeded 8 UTF-8 bytes." });
    await expect(client.request("account/read")).rejects.toThrow("closed");
  });
});

describe("spawnCodexAppServer", () => {
  it("fails closed on Windows before spawning an unmanaged process tree", () => {
    expect(() => spawnCodexAppServer({ binary: "codex", cwd: process.cwd(), platform: "win32" }))
      .toThrow("stable process-tree ownership");
  });

  it.skipIf(process.platform === "win32")(
    "kills the remaining POSIX process group when the direct child has already exited",
    async () => {
      const descendantScript = [
        'process.on("SIGTERM", () => {});',
        'process.stdout.write("ready\\n");',
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      const parentScript = [
        'import { spawn } from "node:child_process";',
        `const descendant = spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(descendantScript)}], { detached: false, stdio: ["ignore", "pipe", "ignore"] });`,
        'descendant.stdout.setEncoding("utf8");',
        "descendant.stdout.once(\"data\", () => {",
        "  const announce = () => process.stdout.write(`${JSON.stringify({ method: \"test/ready\", params: { pid: descendant.pid } })}\\n`);",
        "  announce();",
        "  setInterval(announce, 25);",
        "  setTimeout(() => process.exit(0), 100);",
        "});",
        'descendant.once("error", (error) => { process.stderr.write(`${String(error)}\\n`); process.exit(1); });',
        'process.on("SIGTERM", () => process.exit(0));',
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      let connection: ReturnType<typeof spawnCodexAppServer> | undefined;
      let processGroupId: number | undefined;
      let descendantPid: number | undefined;

      try {
        connection = spawnCodexAppServer({
          binary: process.execPath,
          argvPrefix: ["--input-type=module", "--eval", parentScript],
          cwd: process.cwd(),
          shutdownGraceMs: 300,
        });
        processGroupId = connection.child.pid;
        descendantPid = await waitForDescendantReady(connection.client);
        expect(processGroupId).toBeTypeOf("number");
        expect(processExists(descendantPid)).toBe(true);

        await expect(connection.exited).resolves.toMatchObject({ code: 0 });
        await expect(connection.termination).resolves.toBeUndefined();
        await expect(connection.shutdown()).resolves.toBeUndefined();

        expect(processGroupExists(processGroupId!)).toBe(false);
        expect(processExists(descendantPid)).toBe(false);
      } finally {
        await connection?.shutdown().catch(() => undefined);
        await forceCleanupProcessTree(processGroupId, descendantPid);
      }
    },
    10_000,
  );

  it.skipIf(process.platform === "win32")(
    "automatically reaps the POSIX process group after malformed stdout",
    async () => {
      const descendantScript = [
        'process.on("SIGTERM", () => {});',
        'process.stdout.write("ready\\n");',
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      const parentScript = [
        'import { spawn } from "node:child_process";',
        `const descendant = spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(descendantScript)}], { detached: false, stdio: ["ignore", "pipe", "ignore"] });`,
        'descendant.stdout.setEncoding("utf8");',
        'descendant.stdout.once("data", () => {',
        '  process.stdout.write(`${JSON.stringify({ method: "test/ready", params: { pid: descendant.pid } })}\\n`);',
        '  setTimeout(() => process.stdout.write("not-json\\n"), 150);',
        "});",
        'descendant.once("error", (error) => { process.stderr.write(`${String(error)}\\n`); process.exit(1); });',
        'process.on("SIGTERM", () => process.exit(0));',
        "setInterval(() => {}, 1_000);",
      ].join("\n");
      let connection: ReturnType<typeof spawnCodexAppServer> | undefined;
      let processGroupId: number | undefined;
      let descendantPid: number | undefined;

      try {
        connection = spawnCodexAppServer({
          binary: process.execPath,
          argvPrefix: ["--input-type=module", "--eval", parentScript],
          cwd: process.cwd(),
          shutdownGraceMs: 300,
        });
        processGroupId = connection.child.pid;
        descendantPid = await waitForDescendantReady(connection.client);
        const pending = connection.client.request("model/list");

        await expect(pending).rejects.toThrow();
        await expect(connection.termination).resolves.toBeUndefined();
        expect(processGroupExists(processGroupId!)).toBe(false);
        expect(processExists(descendantPid)).toBe(false);
      } finally {
        await connection?.shutdown().catch(() => undefined);
        await forceCleanupProcessTree(processGroupId, descendantPid);
      }
    },
    10_000,
  );
});
