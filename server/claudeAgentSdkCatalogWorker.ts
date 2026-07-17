import {
  createClaudeAgentSdkSessionFactory,
  normalizeClaudeAgentSdkExecution,
  type ClaudeAgentSdkExecutionDescriptor,
} from "./claudeAgentSdkCatalog.js";

const MAX_INPUT_BYTES = 32 * 1_024;
const MAX_PATH_LENGTH = 4_096;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;

type WorkerInput = {
  execution: ClaudeAgentSdkExecutionDescriptor;
  cwd: string;
};

async function main(): Promise<{ models: unknown }> {
  const input = parseInput(await readInput());
  const abortController = new AbortController();
  const session = createClaudeAgentSdkSessionFactory()({
    execution: input.execution,
    cwd: input.cwd,
    abortController,
  });
  try {
    await session.accountInfo();
    return { models: await session.supportedModels() };
  } finally {
    abortController.abort();
    await session.close();
  }
}

function readInput(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    process.stdin.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > MAX_INPUT_BYTES) {
        reject(new Error("Worker input exceeds the maximum size."));
        process.stdin.destroy();
        return;
      }
      chunks.push(buffer);
    });
    process.stdin.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.once("error", reject);
  });
}

function parseInput(value: string): WorkerInput {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Worker input must be an object.");
  const source = parsed as Record<string, unknown>;
  return {
    execution: normalizeClaudeAgentSdkExecution(source.execution),
    cwd: absolutePath(source.cwd, "cwd"),
  };
}

function absolutePath(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_PATH_LENGTH || CONTROL_CHARACTERS.test(value)) {
    throw new Error(`${name} is invalid.`);
  }
  if (!value.startsWith("/")) throw new Error(`${name} must be absolute.`);
  return value;
}

void main().then(
  (result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
  },
  () => {
    process.stderr.write("Claude Agent SDK catalog worker failed.\n", () => process.exit(1));
  },
);
