import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import { HttpError, isHttpError } from "./errors.js";
import {
  GUARDED_EDIT_PROTOCOL_VERSION,
  GUARDED_EDIT_SYSTEM_PROMPT,
  parseGuardedEditResponse,
  serializeGuardedEditResponse,
  type GuardedEditOperation,
} from "./guardedEditProtocol.js";
import { buildAIChatRuntimePrompt } from "./aiPromptPolicy.js";
import { requestAIChatCompletion } from "./aiProviders.js";
import { isExcludedPath, isInsideRoot, normalizeRelativePath, readGuardedRepoFile } from "./pathGuard.js";
import { readTreeSnapshot } from "./repoFiles.js";
import type {
  AIChangedPath,
  AIChatAttachment,
  AIChatContext,
  AIChatContextRequest,
  AIChatMessage,
  AIChatRunSummary,
  AIConnectionStatus,
  AIModelBehavior,
  AIProviderSettings,
  RepositoryConfig,
} from "./types.js";

export type GuardedProviderRequester = typeof requestAIChatCompletion;

type GuardedRepoWriteRequest = {
  provider: AIProviderSettings;
  repo: RepositoryConfig;
  messages: AIChatMessage[];
  context: AIChatContext;
  attachments?: AIChatAttachment[];
  modelBehavior?: AIModelBehavior;
  signal?: AbortSignal;
  requester?: GuardedProviderRequester;
  pathPolicy?: GuardedRepoPathPolicy;
  mutationFaultInjector?: (phase: "before-commit" | "after-backup" | "before-postflight" | "before-rollback", index: number, relativePath: string) => Promise<void> | void;
};

export type GuardedRepoPathPolicy = {
  rootRealPath: string;
  rootDevice: number;
  rootInode: number;
  protectedPaths: string[];
  protectedPrefixes: string[];
};

type ReadState = {
  path: string;
  absolutePath: string;
  exists: boolean;
  content: string;
  hash: string;
  size: number;
  mode: number;
  device: number;
  inode: number;
};

type FileFingerprint = {
  hash: string;
  size: number;
  mode: number;
  device: number;
  inode: number;
};

type OwnedArtifact = {
  path: string;
  fingerprint: FileFingerprint;
};

type CreatedDirectory = PinnedDirectory;

type PinnedRepositoryRoot = {
  rootRealPath: string;
  device: number;
  inode: number;
};

type PinnedDirectory = {
  path: string;
  device: number;
  inode: number;
};

type PreparedOperation = {
  path: string;
  absolutePath: string;
  existed: boolean;
  previousHash: string;
  previousContent: string;
  previousSize: number;
  previousDevice: number;
  previousInode: number;
  mode: number;
  nextContent: string | null;
  status: AIChangedPath["status"];
  stagedPath?: string;
  stagedFingerprint?: FileFingerprint;
  backupPath?: string;
  backupFingerprint?: FileFingerprint;
  placed?: boolean;
  originalBackedUp?: boolean;
  placedFingerprint?: FileFingerprint;
  recoveryArtifacts?: OwnedArtifact[];
  parent?: PinnedDirectory;
};

const PROTOCOL_MAX_ROUNDS = 6;
const PROTOCOL_MAX_READ_ROUNDS = 4;
const PROTOCOL_MAX_READ_PATHS = 24;
const PROTOCOL_MAX_TOTAL_READ_PATHS = 64;
const PROTOCOL_MAX_READ_FILE_BYTES = 256 * 1024;
const PROTOCOL_MAX_TOTAL_READ_BYTES = 768 * 1024;
const PROTOCOL_MAX_WRITE_FILE_BYTES = 256 * 1024;
const PROTOCOL_MAX_TOTAL_WRITE_BYTES = 768 * 1024;
const PROTOCOL_MAX_TREE_ITEMS = 5_000;
const PROTOCOL_MAX_TREE_BYTES = 128 * 1024;
const RESERVED_TEMP_MARKER = ".reader-wiki-ai-";
const PROTECTED_ROOT_SEGMENTS = new Set([".git", ".codex", ".agents"]);
const READINESS_PROBE_PATH = "reader-wiki-capability-probe.md";
const READINESS_PROBE_BEFORE = "Local Reader App capability probe: before";
const READINESS_PROBE_AFTER = "Local Reader App capability probe: after";

export async function buildGuardedRepoPathPolicy(repo: RepositoryConfig, controlPaths: string[]): Promise<GuardedRepoPathPolicy> {
  const pin = await pinRepositoryRoot(repo);
  const protectedPaths: string[] = [];
  const protectedPrefixes: string[] = [];
  for (const controlPath of controlPaths) {
    const resolvedControlPath = path.resolve(controlPath);
    const absolutePath = await realpath(resolvedControlPath).catch(async () => {
      const parent = await realpath(path.dirname(resolvedControlPath)).catch(() => "");
      return parent ? path.join(parent, path.basename(resolvedControlPath)) : resolvedControlPath;
    });
    if (!isInsideRoot(pin.rootRealPath, absolutePath)) continue;
    const relativePath = path.relative(pin.rootRealPath, absolutePath).split(path.sep).join("/");
    if (!relativePath) continue;
    protectedPaths.push(relativePath);
    const directory = path.posix.dirname(relativePath);
    protectedPrefixes.push(`${directory === "." ? "" : `${directory}/`}.repositories.`);
  }
  return {
    rootRealPath: pin.rootRealPath,
    rootDevice: pin.device,
    rootInode: pin.inode,
    protectedPaths: Array.from(new Set(protectedPaths)),
    protectedPrefixes: Array.from(new Set(protectedPrefixes)),
  };
}

export async function assertGuardedRepoContextPaths(repo: RepositoryConfig, request: AIChatContextRequest, pathPolicy?: GuardedRepoPathPolicy): Promise<void> {
  const rootPin = pathPolicy
    ? { rootRealPath: pathPolicy.rootRealPath, device: pathPolicy.rootDevice, inode: pathPolicy.rootInode }
    : await pinRepositoryRoot(repo);
  await assertPinnedRepositoryRoot(rootPin);
  const requestedPaths = [
    request.path,
    ...(Array.isArray(request.primaryPaths) ? request.primaryPaths.map((item) => item.path) : []),
    ...(Array.isArray(request.rulePaths) ? request.rulePaths.map((item) => item.path) : []),
  ];
  for (const requestedPath of requestedPaths) {
    if (typeof requestedPath === "string" && requestedPath.trim()) {
      await assertGuardedContextPath(repo, requestedPath, rootPin, pathPolicy);
    }
  }
}

export function sanitizeGuardedAIChatContext(repo: RepositoryConfig, context: AIChatContext, pathPolicy?: GuardedRepoPathPolicy): AIChatContext {
  const sanitizeItem = (item: AIChatContext["primaryItems"][number]) => {
    guardedRelativePath(repo, item.path, pathPolicy);
    if (item.kind !== "directory" || !item.contentIncluded) return item;
    const content = item.content.split(/\r?\n/).filter((line) => {
      const match = line.match(/^- \[(?:file|directory)\] (.+)$/);
      if (!match) return false;
      try {
        guardedRelativePath(repo, match[1], pathPolicy);
        return true;
      } catch (error) {
        if (isHttpError(error) && (error.status === 400 || error.status === 403)) return false;
        throw error;
      }
    }).join("\n");
    return {
      ...item,
      content: content || "[Directory has no provider-visible direct children.]",
      lineCount: content ? content.split(/\r?\n/).length : 1,
      byteLength: Buffer.byteLength(content || "[Directory has no provider-visible direct children.]", "utf8"),
    };
  };
  return {
    ...context,
    primaryItems: context.primaryItems.map(sanitizeItem),
    ruleItems: context.ruleItems.map(sanitizeItem),
  };
}

export async function probeGuardedRepoWriteCapability(
  provider: AIProviderSettings,
  signal?: AbortSignal,
  requester: GuardedProviderRequester | undefined = requestAIChatCompletion,
): Promise<{ ok: boolean; message: string; status?: AIConnectionStatus }> {
  let lastStatus: AIConnectionStatus | undefined;
  try {
    const providerRequester = requester || requestAIChatCompletion;
    const messages: AIChatMessage[] = [{
      role: "user",
      content: JSON.stringify({
        version: GUARDED_EDIT_PROTOCOL_VERSION,
        type: "capability_check",
        phase: "read",
        syntheticPath: READINESS_PROBE_PATH,
        instruction: "Return a read response for exactly the synthetic path. Do not return complete.",
      }),
    }];
    const readResult = await providerRequester({
      provider,
      systemPrompt: GUARDED_EDIT_SYSTEM_PROMPT,
      messages,
      signal,
    });
    lastStatus = readResult.status;
    const readResponse = parseGuardedEditResponse(readResult.content);
    if (readResponse.type !== "read" || readResponse.paths.length !== 1 || readResponse.paths[0] !== READINESS_PROBE_PATH) {
      return { ok: false, message: "The selected model did not return the required synthetic guarded read response.", status: readResult.status };
    }
    messages.push({ role: "assistant", content: serializeGuardedEditResponse(readResponse) });
    messages.push({
      role: "user",
      content: JSON.stringify({
        version: GUARDED_EDIT_PROTOCOL_VERSION,
        type: "read_result",
        synthetic: true,
        files: [{
          path: READINESS_PROBE_PATH,
          exists: true,
          sha256: hashText(READINESS_PROBE_BEFORE),
          content: READINESS_PROBE_BEFORE,
        }],
        instruction: `Return one apply response with one replace operation that changes ${JSON.stringify(READINESS_PROBE_BEFORE)} to ${JSON.stringify(READINESS_PROBE_AFTER)}. The message must be exactly ready.`,
      }),
    });
    const applyResult = await providerRequester({
      provider,
      systemPrompt: GUARDED_EDIT_SYSTEM_PROMPT,
      messages,
      signal,
    });
    lastStatus = applyResult.status;
    const applyResponse = parseGuardedEditResponse(applyResult.content);
    const operation = applyResponse.type === "apply" && applyResponse.operations.length === 1 ? applyResponse.operations[0] : undefined;
    const validSyntheticOperation = operation?.path === READINESS_PROBE_PATH
      && ((operation.op === "replace"
        && countOccurrences(READINESS_PROBE_BEFORE, operation.oldText) === 1
        && READINESS_PROBE_BEFORE.replace(operation.oldText, operation.newText) !== READINESS_PROBE_BEFORE)
        || (operation.op === "write" && operation.content !== READINESS_PROBE_BEFORE));
    if (applyResponse.type !== "apply"
      || !validSyntheticOperation) {
      const responseType = applyResponse.type;
      const operationType = operation?.op || "none";
      const mismatchFields = [
        ...(applyResponse.type !== "apply" ? ["type"] : []),
        ...(applyResponse.type === "apply" && applyResponse.operations.length !== 1 ? ["operations"] : []),
        ...(applyResponse.type === "apply" && operation?.path !== READINESS_PROBE_PATH ? ["path"] : []),
        ...(applyResponse.type === "apply" && operation?.op === "replace" && countOccurrences(READINESS_PROBE_BEFORE, operation.oldText) !== 1 ? ["oldText"] : []),
        ...(applyResponse.type === "apply" && operation?.op === "replace" && READINESS_PROBE_BEFORE.replace(operation.oldText, operation.newText) === READINESS_PROBE_BEFORE ? ["newText"] : []),
        ...(applyResponse.type === "apply" && operation?.op === "write" && operation.content === READINESS_PROBE_BEFORE ? ["content"] : []),
        ...(applyResponse.type === "apply" && operation?.op === "delete" ? ["op"] : []),
      ];
      return {
        ok: false,
        message: `The selected model did not return the required synthetic guarded apply response (response type: ${responseType}; operation type: ${operationType}; mismatched fields: ${mismatchFields.join(", ") || "operation"}).`,
        status: applyResult.status,
      };
    }
    return { ok: true, message: "The endpoint and selected model completed the synthetic read and apply protocol without receiving filesystem access.", status: applyResult.status };
  } catch (error) {
    return { ok: false, message: safeProtocolError(error), status: lastStatus };
  }
}

export async function requestGuardedRepoWriteAIChatCompletion(request: GuardedRepoWriteRequest): Promise<{
  content: string;
  status: AIConnectionStatus;
  run: AIChatRunSummary;
}> {
  if (request.signal?.aborted) throw new HttpError(499, "AI provider request was canceled.");
  const requester = request.requester || requestAIChatCompletion;
  const rootPin = request.pathPolicy
    ? { rootRealPath: request.pathPolicy.rootRealPath, device: request.pathPolicy.rootDevice, inode: request.pathPolicy.rootInode }
    : await pinRepositoryRoot(request.repo);
  await assertPinnedRepositoryRoot(rootPin);
  const repo = { ...request.repo, root: rootPin.rootRealPath };
  const pathPolicy = request.pathPolicy;
  const deleteAuthorizations = authorizedDeletePaths(repo, request.messages, pathPolicy);
  const runtime = buildAIChatRuntimePrompt(request.context, request.attachments || [], request.modelBehavior);
  const tree = await buildTreeManifest(repo, pathPolicy);
  const protocolMessages: AIChatMessage[] = [{
    role: "user",
    content: JSON.stringify({
      type: "task",
      version: GUARDED_EDIT_PROTOCOL_VERSION,
      repository: {
        id: request.repo.id,
        tree: tree.items,
        treeTruncated: tree.truncated,
        treeWarnings: tree.warnings,
      },
      visibleContext: runtime.contextPrompt,
      conversation: request.messages,
      deleteAuthorizations: Array.from(deleteAuthorizations),
    }),
  }];
  const readStates = new Map<string, ReadState>();
  let readRounds = 0;
  let totalReadBytes = 0;
  let lastStatus: AIConnectionStatus | undefined;

  for (let round = 0; round < PROTOCOL_MAX_ROUNDS; round += 1) {
    if (request.signal?.aborted) throw new HttpError(499, "AI provider request was canceled.");
    await assertPinnedRepositoryRoot(rootPin);
    const completion = await requester({
      provider: request.provider,
      systemPrompt: `${runtime.systemPrompt}\n\n${GUARDED_EDIT_SYSTEM_PROMPT}`,
      messages: protocolMessages,
      signal: request.signal,
    });
    throwIfAborted(request.signal);
    lastStatus = completion.status;
    const response = parseGuardedEditResponse(completion.content);
    throwIfAborted(request.signal);
    protocolMessages.push({ role: "assistant", content: serializeGuardedEditResponse(response) });

    if (response.type === "read") {
      readRounds += 1;
      if (readRounds > PROTOCOL_MAX_READ_ROUNDS) throw new HttpError(502, "The selected model exceeded the guarded repository read-round limit.");
      if (response.paths.length > PROTOCOL_MAX_READ_PATHS) throw new HttpError(502, `The selected model requested more than ${PROTOCOL_MAX_READ_PATHS} files in one guarded read round.`);
      const newReadPathCount = response.paths.filter((item) => !readStates.has(guardedRelativePath(repo, item, pathPolicy))).length;
      if (readStates.size + newReadPathCount > PROTOCOL_MAX_TOTAL_READ_PATHS) throw new HttpError(502, `The guarded edit protocol supports at most ${PROTOCOL_MAX_TOTAL_READ_PATHS} distinct file reads.`);
      const files = [];
      for (const requestedPath of response.paths) {
        await assertPinnedRepositoryRoot(rootPin);
        const state = await readTextState(repo, requestedPath, PROTOCOL_MAX_READ_FILE_BYTES, rootPin.rootRealPath, pathPolicy);
        totalReadBytes += Buffer.byteLength(state.content, "utf8");
        if (totalReadBytes > PROTOCOL_MAX_TOTAL_READ_BYTES) throw new HttpError(413, "Guarded repository reads exceeded the aggregate byte limit.");
        readStates.set(state.path, state);
        files.push(state.exists
          ? { path: state.path, exists: true, sha256: state.hash, content: state.content }
          : { path: state.path, exists: false });
      }
      await assertPinnedRepositoryRoot(rootPin);
      protocolMessages.push({ role: "user", content: JSON.stringify({ version: GUARDED_EDIT_PROTOCOL_VERSION, type: "read_result", files }) });
      continue;
    }

    if (response.type === "complete") {
      return {
        content: response.message,
        status: lastStatus,
        run: guardedRunSummary(request.provider.entry, [], tree.warnings, Array.from(readStates.keys())),
      };
    }

    throwIfAborted(request.signal);
    const applied = await applyProtocolOperations(repo, response.operations, readStates, rootPin, pathPolicy, deleteAuthorizations, request.signal, request.mutationFaultInjector);
    return {
      content: finalUserMessage(response.message, applied.changedPaths),
      status: lastStatus,
      run: guardedRunSummary(request.provider.entry, applied.changedPaths, [...tree.warnings, ...applied.warnings], Array.from(readStates.keys())),
    };
  }
  throw new HttpError(502, "The selected model did not finish the guarded repository edit protocol within the round limit.");
}

function guardedRunSummary(entry: AIProviderSettings["entry"], changedPaths: AIChangedPath[], warnings: string[], readPaths: string[]): AIChatRunSummary {
  return {
    accessMode: "repoWrite",
    entry,
    substrate: "serverEditProtocol",
    auditState: warnings.some((warning) => warning.startsWith("Cleanup warning:")) ? "unverified" : "verified",
    readPaths,
    changedPaths,
    repairs: [],
    warnings: [
      "Guarded provider execution: the model received no filesystem or shell access; Local Reader App applied only validated Current repo text operations.",
      ...warnings,
    ],
  };
}

async function buildTreeManifest(repo: RepositoryConfig, pathPolicy?: GuardedRepoPathPolicy): Promise<{ items: Array<{ path: string; type: "file" | "directory" }>; truncated: boolean; warnings: string[] }> {
  const snapshot = await readTreeSnapshot(repo);
  const byPath = new Map<string, "file" | "directory">();
  for (const nodes of Object.values(snapshot.tree)) {
    for (const node of nodes) byPath.set(node.path, node.type);
  }
  const items: Array<{ path: string; type: "file" | "directory" }> = [];
  let bytes = 0;
  let truncated = snapshot.truncated;
  for (const [itemPath, type] of Array.from(byPath.entries()).sort(([left], [right]) => left.localeCompare(right))) {
    try {
      guardedRelativePath(repo, itemPath, pathPolicy);
    } catch (error) {
      if (isHttpError(error) && (error.status === 400 || error.status === 403)) continue;
      throw error;
    }
    const item = { path: itemPath, type };
    const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (items.length >= PROTOCOL_MAX_TREE_ITEMS || bytes + itemBytes > PROTOCOL_MAX_TREE_BYTES) {
      truncated = true;
      break;
    }
    items.push(item);
    bytes += itemBytes;
  }
  return {
    items,
    truncated,
    warnings: truncated ? Array.from(new Set([...snapshot.warnings, "Repository tree context was bounded; request explicit reads only for visible paths."])) : snapshot.warnings,
  };
}

async function applyProtocolOperations(
  repo: RepositoryConfig,
  operations: GuardedEditOperation[],
  readStates: Map<string, ReadState>,
  rootPin: PinnedRepositoryRoot,
  pathPolicy: GuardedRepoPathPolicy | undefined,
  deleteAuthorizations: Set<string>,
  signal?: AbortSignal,
  mutationFaultInjector?: GuardedRepoWriteRequest["mutationFaultInjector"],
): Promise<{ changedPaths: AIChangedPath[]; warnings: string[] }> {
  const rootRealPath = rootPin.rootRealPath;
  const prepared: PreparedOperation[] = [];
  const seen = new Set<string>();
  let totalWriteBytes = 0;
  await assertPinnedRepositoryRoot(rootPin);

  for (const operation of operations) {
    throwIfAborted(signal);
    const relativePath = guardedRelativePath(repo, operation.path, pathPolicy);
    const collisionKey = relativePath.normalize("NFC").toLocaleLowerCase("en-US");
    if (seen.has(collisionKey)) throw new HttpError(502, `The guarded edit response contains colliding operations for ${relativePath}.`);
    seen.add(collisionKey);
    if (operation.op === "delete" && !deleteAuthorizations.has(relativePath)) {
      throw new HttpError(403, `Deleting ${relativePath} requires an exact DELETE: ${relativePath} line in the user's latest message.`);
    }
    const current = await readTextState(repo, relativePath, PROTOCOL_MAX_WRITE_FILE_BYTES, rootRealPath, pathPolicy);
    const priorRead = readStates.get(relativePath);
    if (current.exists && (!priorRead?.exists || !sameReadIdentity(priorRead, current))) {
      throw new HttpError(409, `The existing file ${relativePath} was not read by this run or changed after it was read. Retry the request.`);
    }

    let nextContent: string | null;
    if (operation.op === "delete") {
      if (!current.exists) continue;
      nextContent = null;
    } else if (operation.op === "replace") {
      if (!current.exists) throw new HttpError(409, `The replace target ${relativePath} does not exist.`);
      const occurrences = countOccurrences(current.content, operation.oldText);
      if (occurrences !== 1) throw new HttpError(409, `The guarded replace target in ${relativePath} must occur exactly once; found ${occurrences}.`);
      nextContent = current.content.replace(operation.oldText, operation.newText);
    } else {
      nextContent = operation.content;
    }

    if (nextContent !== null) {
      const bytes = Buffer.byteLength(nextContent, "utf8");
      if (bytes > PROTOCOL_MAX_WRITE_FILE_BYTES) throw new HttpError(413, `The guarded write target ${relativePath} exceeds the per-file byte limit.`);
      totalWriteBytes += bytes;
      if (totalWriteBytes > PROTOCOL_MAX_TOTAL_WRITE_BYTES) throw new HttpError(413, "Guarded repository writes exceeded the aggregate byte limit.");
      if (nextContent.includes("\0")) throw new HttpError(400, "Guarded repository writes support text files only.");
      if (current.exists && hashText(nextContent) === current.hash) continue;
    }

    prepared.push({
      path: relativePath,
      absolutePath: current.absolutePath,
      existed: current.exists,
      previousHash: current.hash,
      previousContent: current.content,
      previousSize: current.size,
      previousDevice: current.device,
      previousInode: current.inode,
      mode: current.mode || 0o644,
      nextContent,
      status: nextContent === null ? "deleted" : current.exists ? "changed" : "new",
    });
  }

  if (!prepared.length) return { changedPaths: [], warnings: [] };
  const createdDirectories: CreatedDirectory[] = [];
  const warnings: string[] = [];
  try {
    for (const operation of prepared) {
      throwIfAborted(signal);
      const parentPath = path.dirname(operation.absolutePath);
      if (operation.nextContent !== null) {
        await ensureParentDirectories(repo, rootPin, parentPath, createdDirectories, pathPolicy);
      }
      operation.parent = await pinDirectory(rootPin, parentPath);
      if (operation.nextContent === null) continue;
      await assertPinnedDirectory(rootPin, operation.parent);
      const stagedPath = path.join(parentPath, `${RESERVED_TEMP_MARKER}${randomUUID()}.tmp`);
      const handle = await open(stagedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, operation.mode);
      operation.stagedPath = stagedPath;
      try {
        await handle.writeFile(operation.nextContent, "utf8");
        await handle.sync();
        const stagedStat = await handle.stat();
        operation.stagedFingerprint = {
          hash: hashText(operation.nextContent),
          size: stagedStat.size,
          mode: stagedStat.mode & 0o777,
          device: stagedStat.dev,
          inode: stagedStat.ino,
        };
      } finally {
        await handle.close();
      }
    }

    throwIfAborted(signal);
    for (const operation of prepared) {
      await assertPinnedRepositoryRoot(rootPin);
      if (operation.parent) await assertPinnedDirectory(rootPin, operation.parent);
      const current = await readTextState(repo, operation.path, PROTOCOL_MAX_WRITE_FILE_BYTES, rootRealPath, pathPolicy);
      if (!matchesPreparedState(operation, current)) {
        throw new HttpError(409, `The file ${operation.path} changed during guarded edit preflight. No operation was committed.`);
      }
    }

    for (const [index, operation] of prepared.entries()) {
      await mutationFaultInjector?.("before-commit", index, operation.path);
      throwIfAborted(signal);
      await assertPinnedRepositoryRoot(rootPin);
      if (!operation.parent) throw new HttpError(500, "Guarded repository parent identity is missing.");
      await assertPinnedDirectory(rootPin, operation.parent);
      const current = await readTextState(repo, operation.path, PROTOCOL_MAX_WRITE_FILE_BYTES, rootRealPath, pathPolicy);
      if (!matchesPreparedState(operation, current)) {
        throw new HttpError(409, `The file ${operation.path} changed immediately before guarded commit.`);
      }
      if (operation.stagedPath && operation.stagedFingerprint) {
        const stagedFingerprint = await readOwnedFileFingerprint(operation.stagedPath);
        if (!sameFingerprint(stagedFingerprint, operation.stagedFingerprint)) {
          throw new HttpError(409, `The staged file for ${operation.path} changed immediately before guarded commit.`);
        }
      }
      if (operation.existed) {
        operation.backupPath = path.join(path.dirname(operation.absolutePath), `${RESERVED_TEMP_MARKER}${randomUUID()}.bak`);
        await rename(operation.absolutePath, operation.backupPath);
        operation.originalBackedUp = true;
        operation.backupFingerprint = await readOwnedFileFingerprint(operation.backupPath);
        if (!sameFingerprint(operation.backupFingerprint, originalFingerprint(operation))) {
          throw new HttpError(409, `The file ${operation.path} changed while guarded commit created its recovery backup.`);
        }
        await mutationFaultInjector?.("after-backup", index, operation.path);
      }
      if (operation.nextContent !== null && operation.stagedPath) {
        await link(operation.stagedPath, operation.absolutePath);
        operation.placed = true;
        await unlink(operation.stagedPath);
        operation.stagedPath = undefined;
        operation.placedFingerprint = operation.stagedFingerprint;
      } else if (operation.nextContent === null && operation.originalBackedUp) {
        operation.placed = true;
      }
    }

    await mutationFaultInjector?.("before-postflight", prepared.length, "");
    throwIfAborted(signal);
    await assertPinnedRepositoryRoot(rootPin);
    for (const operation of prepared) {
      if (operation.parent) await assertPinnedDirectory(rootPin, operation.parent);
      const verified = await readTextState(repo, operation.path, PROTOCOL_MAX_WRITE_FILE_BYTES, rootRealPath, pathPolicy);
      if (operation.nextContent === null
        ? verified.exists
        : !verified.exists || !operation.placedFingerprint || !sameFingerprint(fingerprintFromReadState(verified), operation.placedFingerprint)) {
        throw new HttpError(500, `The guarded post-write verification failed for ${operation.path}.`);
      }
    }
  } catch (error) {
    const injectorWarnings: string[] = [];
    try {
      await mutationFaultInjector?.("before-rollback", prepared.length, "");
    } catch (injectionError) {
      injectorWarnings.push(`rollback preparation: ${safeFsError(injectionError)}`);
    }
    const rollbackWarnings = await rollbackPreparedOperations(repo, rootPin, pathPolicy, prepared, createdDirectories);
    const baseMessage = isHttpError(error) ? error.message : "Guarded repository apply failed.";
    const rollbackIncomplete = injectorWarnings.length > 0 || rollbackWarnings.length > 0;
    const recoveryConflict = rollbackWarnings.some((warning) => warning.startsWith("Recovery warning:"));
    throw new HttpError(
      recoveryConflict ? 409 : isHttpError(error) ? error.status : 500,
      `${baseMessage}${rollbackIncomplete ? ` Rollback warnings: ${[...injectorWarnings, ...rollbackWarnings].join("; ")}` : " Changes were rolled back and verified."}`,
      rollbackIncomplete
        ? { code: "guarded_rollback_incomplete", rollbackState: "unverified" }
        : isHttpError(error) ? error.details : undefined,
    );
  }

  for (const operation of prepared) {
    if (operation.backupPath && operation.backupFingerprint) {
      await removeOwnedArtifact(
        { path: operation.backupPath, fingerprint: operation.backupFingerprint },
        warnings,
        `Cleanup warning: ${operation.path} backup`,
      );
    }
    if (operation.stagedPath && operation.stagedFingerprint) {
      await removeOwnedArtifact(
        { path: operation.stagedPath, fingerprint: operation.stagedFingerprint },
        warnings,
        `Cleanup warning: ${operation.path} staged file`,
      );
    }
  }
  for (const operation of prepared) {
    for (const artifactPath of [operation.backupPath, operation.stagedPath].filter((item): item is string => Boolean(item))) {
      if (await pathExists(artifactPath)) warnings.push(`Cleanup warning: ${operation.path} run artifact still exists after cleanup.`);
    }
  }

  return {
    changedPaths: prepared.map(({ path: changedPath, status }) => ({ path: changedPath, status })),
    warnings,
  };
}

async function rollbackPreparedOperations(
  repo: RepositoryConfig,
  rootPin: PinnedRepositoryRoot,
  pathPolicy: GuardedRepoPathPolicy | undefined,
  operations: PreparedOperation[],
  createdDirectories: CreatedDirectory[],
): Promise<string[]> {
  const warnings: string[] = [];
  for (const operation of [...operations].reverse()) {
    try {
      await assertPinnedRepositoryRoot(rootPin);
      if (operation.parent) await assertPinnedDirectory(rootPin, operation.parent);
      let targetRecovery: OwnedArtifact | undefined;
      let targetConflict = false;

      if (operation.placed && operation.nextContent !== null) {
        const current = await readTextState(repo, operation.path, PROTOCOL_MAX_WRITE_FILE_BYTES, rootPin.rootRealPath, pathPolicy);
        if (!current.exists || !operation.placedFingerprint || !sameFingerprint(fingerprintFromReadState(current), operation.placedFingerprint)) {
          warnings.push(`Recovery warning: ${operation.path} changed after Local Reader App placed it; the current file and recovery backup were preserved.`);
          targetConflict = true;
        } else {
          const recoveryPath = path.join(path.dirname(operation.absolutePath), `${RESERVED_TEMP_MARKER}${randomUUID()}.recovery`);
          await rename(operation.absolutePath, recoveryPath);
          const movedFingerprint = await readOwnedFileFingerprint(recoveryPath);
          targetRecovery = { path: recoveryPath, fingerprint: movedFingerprint };
          if (!sameFingerprint(movedFingerprint, operation.placedFingerprint)) {
            await link(recoveryPath, operation.absolutePath).catch(() => undefined);
            operation.recoveryArtifacts = [...(operation.recoveryArtifacts || []), targetRecovery];
            warnings.push(`Recovery warning: ${operation.path} changed while rollback isolated it; ${path.basename(recoveryPath)} was retained.`);
            targetConflict = true;
          }
        }
      } else if ((operation.placed || operation.originalBackedUp) && operation.nextContent === null) {
        if (await pathExists(operation.absolutePath)) {
          warnings.push(`Recovery warning: ${operation.path} reappeared after Local Reader App deleted it; the current file and recovery backup were preserved.`);
          targetConflict = true;
        }
      } else if (operation.originalBackedUp && await pathExists(operation.absolutePath)) {
        warnings.push(`Recovery warning: ${operation.path} reappeared before rollback; the current file and recovery backup were preserved.`);
        targetConflict = true;
      }

      if (!targetConflict && operation.backupPath && operation.backupFingerprint) {
        const restored = await restoreOwnedBackup(repo, rootPin, pathPolicy, operation, warnings);
        if (!restored && targetRecovery) {
          await link(targetRecovery.path, operation.absolutePath).catch(() => undefined);
          operation.recoveryArtifacts = [...(operation.recoveryArtifacts || []), targetRecovery];
        } else if (restored && targetRecovery) {
          await removeOwnedArtifact(targetRecovery, warnings, `Recovery warning: ${operation.path} placed result`);
        }
      } else if (!targetConflict && targetRecovery) {
        await removeOwnedArtifact(targetRecovery, warnings, `Recovery warning: ${operation.path} placed result`);
      }

      if (operation.stagedPath && operation.stagedFingerprint) {
        await removeOwnedArtifact(
          { path: operation.stagedPath, fingerprint: operation.stagedFingerprint },
          warnings,
          `Recovery warning: ${operation.path} staged file`,
        );
      }
    } catch (error) {
      warnings.push(`${operation.path}: ${safeFsError(error)}`);
    }
  }
  for (const directory of [...createdDirectories].reverse()) {
    try {
      await assertPinnedRepositoryRoot(rootPin);
      const directoryStat = await lstat(directory.path);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()
        || directoryStat.dev !== directory.device || directoryStat.ino !== directory.inode) {
        throw new HttpError(409, "Created directory identity changed during rollback.");
      }
      const directoryRealPath = await realpath(directory.path);
      if (!isInsideRoot(rootPin.rootRealPath, directoryRealPath)) throw new HttpError(403, "Created directory escaped the Current repo during rollback.");
      await rmdir(directory.path);
    } catch (error) {
      if (!isMissingPathError(error)) warnings.push(`directory cleanup: ${safeFsError(error)}`);
    }
  }
  for (const operation of operations) {
    try {
      const restored = await readTextState(repo, operation.path, PROTOCOL_MAX_WRITE_FILE_BYTES, rootPin.rootRealPath, pathPolicy);
      const restoredCorrectly = operation.existed
        ? matchesOriginalContent(operation, restored)
        : !restored.exists;
      if (!restoredCorrectly && !warnings.some((warning) => warning.includes(operation.path))) {
        warnings.push(`${operation.path}: rollback verification did not restore the original state`);
      }
    } catch (error) {
      warnings.push(`${operation.path}: rollback verification failed (${safeFsError(error)})`);
    }
    const artifactPaths = [
      operation.backupPath,
      operation.stagedPath,
      ...(operation.recoveryArtifacts || []).map((artifact) => artifact.path),
    ].filter((item): item is string => Boolean(item));
    for (const artifactPath of artifactPaths) {
      if (await pathExists(artifactPath)) warnings.push(`${operation.path}: guarded run artifact remains after rollback`);
    }
  }
  return warnings;
}

async function restoreOwnedBackup(
  repo: RepositoryConfig,
  rootPin: PinnedRepositoryRoot,
  pathPolicy: GuardedRepoPathPolicy | undefined,
  operation: PreparedOperation,
  warnings: string[],
): Promise<boolean> {
  if (!operation.backupPath || !operation.backupFingerprint) return false;
  if (await pathExists(operation.absolutePath)) {
    warnings.push(`Recovery warning: ${operation.path} is occupied; ${path.basename(operation.backupPath)} was retained.`);
    return false;
  }
  const actualBackup = await readOwnedFileFingerprint(operation.backupPath);
  if (!sameFingerprint(actualBackup, operation.backupFingerprint)) {
    warnings.push(`Recovery warning: ${operation.path} backup identity changed; ${path.basename(operation.backupPath)} was retained.`);
    return false;
  }
  const backupRecoveryPath = path.join(path.dirname(operation.absolutePath), `${RESERVED_TEMP_MARKER}${randomUUID()}.recovery`);
  await rename(operation.backupPath, backupRecoveryPath);
  const backupRecovery = { path: backupRecoveryPath, fingerprint: operation.backupFingerprint };
  operation.backupPath = backupRecoveryPath;
  const movedBackup = await readOwnedFileFingerprint(backupRecoveryPath);
  if (!sameFingerprint(movedBackup, backupRecovery.fingerprint)) {
    operation.recoveryArtifacts = [...(operation.recoveryArtifacts || []), { path: backupRecoveryPath, fingerprint: movedBackup }];
    warnings.push(`Recovery warning: ${operation.path} backup changed while rollback isolated it; ${path.basename(backupRecoveryPath)} was retained.`);
    return false;
  }
  let restoreHandle;
  try {
    restoreHandle = await open(operation.absolutePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, operation.mode);
    await restoreHandle.writeFile(operation.previousContent, "utf8");
    await restoreHandle.chmod(operation.mode);
    await restoreHandle.sync();
  } catch (error) {
    warnings.push(`Recovery warning: ${operation.path} could not be restored without replacing another file; ${path.basename(backupRecoveryPath)} was retained (${safeFsError(error)}).`);
    return false;
  } finally {
    await restoreHandle?.close().catch(() => undefined);
  }
  const restored = await readTextState(repo, operation.path, PROTOCOL_MAX_WRITE_FILE_BYTES, rootPin.rootRealPath, pathPolicy);
  if (!restored.exists || !matchesOriginalContent(operation, restored)) {
    warnings.push(`Recovery warning: ${operation.path} restoration could not be verified; ${path.basename(backupRecoveryPath)} was retained.`);
    return false;
  }
  await removeOwnedArtifact(backupRecovery, warnings, `Recovery warning: ${operation.path} backup`);
  operation.backupPath = undefined;
  operation.backupFingerprint = undefined;
  return true;
}

function originalFingerprint(operation: PreparedOperation): FileFingerprint {
  return {
    hash: operation.previousHash,
    size: operation.previousSize,
    mode: operation.mode,
    device: operation.previousDevice,
    inode: operation.previousInode,
  };
}

function matchesOriginalContent(operation: PreparedOperation, state: ReadState): boolean {
  return state.exists
    && state.hash === operation.previousHash
    && state.size === operation.previousSize
    && state.mode === operation.mode
    && state.device === operation.previousDevice;
}

function fingerprintFromReadState(state: ReadState): FileFingerprint {
  return {
    hash: state.hash,
    size: state.size,
    mode: state.mode,
    device: state.device,
    inode: state.inode,
  };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.hash === right.hash
    && left.size === right.size
    && left.mode === right.mode
    && left.device === right.device
    && left.inode === right.inode;
}

async function readOwnedFileFingerprint(artifactPath: string): Promise<FileFingerprint> {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const handle = await open(artifactPath, constants.O_RDONLY | noFollow);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > PROTOCOL_MAX_WRITE_FILE_BYTES) {
      throw new HttpError(409, "A guarded recovery artifact is not an expected regular file.");
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mode !== after.mode) {
      throw new HttpError(409, "A guarded recovery artifact changed while it was inspected.");
    }
    return {
      hash: createHash("sha256").update(bytes).digest("hex"),
      size: after.size,
      mode: after.mode & 0o777,
      device: after.dev,
      inode: after.ino,
    };
  } finally {
    await handle.close();
  }
}

async function removeOwnedArtifact(artifact: OwnedArtifact, warnings: string[], label: string): Promise<boolean> {
  try {
    const current = await readOwnedFileFingerprint(artifact.path);
    if (!sameFingerprint(current, artifact.fingerprint)) {
      warnings.push(`${label} identity changed; ${path.basename(artifact.path)} was retained.`);
      return false;
    }
    await unlink(artifact.path);
    return true;
  } catch (error) {
    warnings.push(`${label} could not be safely removed; ${path.basename(artifact.path)} was retained (${safeFsError(error)}).`);
    return false;
  }
}

function matchesPreparedState(operation: PreparedOperation, current: ReadState): boolean {
  if (current.exists !== operation.existed) return false;
  if (!current.exists) return true;
  return current.hash === operation.previousHash
    && current.size === operation.previousSize
    && current.mode === operation.mode
    && current.device === operation.previousDevice
    && current.inode === operation.previousInode;
}

function sameReadIdentity(left: ReadState, right: ReadState): boolean {
  return left.exists === right.exists
    && left.hash === right.hash
    && left.size === right.size
    && left.mode === right.mode
    && left.device === right.device
    && left.inode === right.inode;
}

async function readTextState(repo: RepositoryConfig, inputPath: string, maxBytes: number, knownRootRealPath?: string, pathPolicy?: GuardedRepoPathPolicy): Promise<ReadState> {
  const relativePath = guardedRelativePath(repo, inputPath, pathPolicy);
  const rootRealPath = knownRootRealPath || await realpath(repo.root);
  const absolutePath = path.join(rootRealPath, ...relativePath.split("/"));
  if (!isInsideRoot(rootRealPath, absolutePath)) throw new HttpError(403, "Paths outside the Current repo are not allowed.");
  const segments = relativePath.split("/");
  let current = rootRealPath;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let targetStat;
    try {
      targetStat = await lstat(current);
    } catch (error) {
      if (isMissingPathError(error)) return { path: relativePath, absolutePath, exists: false, content: "", hash: "", size: 0, mode: 0o644, device: 0, inode: 0 };
      throw error;
    }
    if (targetStat.isSymbolicLink()) throw new HttpError(403, "Symbolic links are disabled by the guarded repository edit policy.");
    if (index < segments.length - 1 && !targetStat.isDirectory()) throw new HttpError(400, "A guarded repository path ancestor is not a directory.");
    if (index === segments.length - 1 && !targetStat.isFile()) throw new HttpError(400, "Guarded repository edits support regular text files only.");
    const currentRealPath = await realpath(current);
    if (!isInsideRoot(rootRealPath, currentRealPath)) throw new HttpError(403, "A guarded repository path escaped the Current repo.");
    const canonicalRelativePath = path.relative(rootRealPath, currentRealPath).split(path.sep).join("/");
    guardedRelativePath(repo, canonicalRelativePath, pathPolicy);
  }
  const guarded = await readGuardedRepoFile(repo, relativePath, maxBytes);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(guarded.bytes);
  } catch {
    throw new HttpError(415, "Guarded repository edits support UTF-8 text files only.");
  }
  if (content.includes("\0")) throw new HttpError(415, "Guarded repository edits support text files only.");
  return {
    path: relativePath,
    absolutePath,
    exists: true,
    content,
    hash: hashText(content),
    size: guarded.stat.size,
    mode: guarded.stat.mode & 0o777,
    device: guarded.stat.dev,
    inode: guarded.stat.ino,
  };
}

async function ensureParentDirectories(repo: RepositoryConfig, rootPin: PinnedRepositoryRoot, parentPath: string, created: CreatedDirectory[], pathPolicy?: GuardedRepoPathPolicy): Promise<void> {
  await assertPinnedRepositoryRoot(rootPin);
  if (!isInsideRoot(rootPin.rootRealPath, parentPath)) throw new HttpError(403, "A guarded repository parent escaped the Current repo.");
  const relative = path.relative(rootPin.rootRealPath, parentPath);
  if (!relative) return;
  let current = rootPin.rootRealPath;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let createdNow = false;
    try {
      const targetStat = await lstat(current);
      if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) throw new HttpError(403, "Guarded repository directories cannot traverse symbolic links or files.");
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      await mkdir(current, { mode: 0o755 });
      createdNow = true;
    }
    const currentRealPath = await realpath(current);
    if (!isInsideRoot(rootPin.rootRealPath, currentRealPath)) throw new HttpError(403, "A guarded repository directory escaped the Current repo.");
    const canonicalRelativePath = path.relative(rootPin.rootRealPath, currentRealPath).split(path.sep).join("/");
    guardedRelativePath(repo, canonicalRelativePath, pathPolicy);
    if (createdNow) {
      const createdStat = await lstat(current);
      created.push({ path: current, device: createdStat.dev, inode: createdStat.ino });
    }
  }
}

function guardedRelativePath(repo: RepositoryConfig, inputPath: string, pathPolicy?: GuardedRepoPathPolicy): string {
  const rawPath = inputPath.trim().replaceAll("\\", "/");
  if (path.win32.isAbsolute(rawPath) || /^[A-Za-z]:/.test(rawPath)) {
    throw new HttpError(400, "Only repository-relative paths are allowed.");
  }
  const relativePath = normalizeRelativePath(inputPath);
  if (!relativePath) throw new HttpError(400, "Guarded repository operations require a file path.");
  if (/[\u0001-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u.test(relativePath)) {
    throw new HttpError(400, "The guarded repository path contains control characters.");
  }
  const segments = relativePath.split("/");
  if (segments.some((segment) => PROTECTED_ROOT_SEGMENTS.has(segment.toLowerCase()))) throw new HttpError(403, "Protected repository metadata paths cannot be read or edited by AI Chat.");
  if (isExcludedPath(repo, relativePath) || isExcludedPath({ excludes: (repo.excludes || []).map((item) => item.toLowerCase()) }, relativePath.toLowerCase())) {
    throw new HttpError(403, "This repository path is excluded from AI Chat.");
  }
  if (segments.some((segment) => segment.toLowerCase().startsWith(RESERVED_TEMP_MARKER))) {
    throw new HttpError(403, "Local Reader App guarded edit temporary names are reserved.");
  }
  if (segments.some((segment) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment) || /[. ]$/.test(segment) || segment.includes(":"))) {
    throw new HttpError(400, "The guarded repository path is not portable across supported filesystems.");
  }
  const comparisonPath = relativePath.normalize("NFC").toLocaleLowerCase("en-US");
  if (pathPolicy?.protectedPaths.some((item) => item.normalize("NFC").toLocaleLowerCase("en-US") === comparisonPath)
    || pathPolicy?.protectedPrefixes.some((item) => comparisonPath.startsWith(item.normalize("NFC").toLocaleLowerCase("en-US")))) {
    throw new HttpError(403, "Local Reader App control-plane files cannot be read or edited by AI Chat.");
  }
  return relativePath;
}

async function pinRepositoryRoot(repo: RepositoryConfig): Promise<PinnedRepositoryRoot> {
  const configuredRoot = await lstat(repo.root).catch(() => {
    throw new HttpError(409, "The Current repo root is unavailable.");
  });
  if (configuredRoot.isSymbolicLink()) throw new HttpError(403, "Current repo write does not allow a symbolic-link repository root.");
  if (!configuredRoot.isDirectory()) throw new HttpError(400, "Current repo write requires a directory root.");
  const rootRealPath = await realpath(repo.root);
  const rootStat = await lstat(rootRealPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new HttpError(403, "Current repo write requires a stable real directory root.");
  return { rootRealPath, device: rootStat.dev, inode: rootStat.ino };
}

async function assertGuardedContextPath(
  repo: RepositoryConfig,
  inputPath: string,
  rootPin: PinnedRepositoryRoot,
  pathPolicy?: GuardedRepoPathPolicy,
): Promise<void> {
  const relativePath = guardedRelativePath(repo, inputPath, pathPolicy);
  let current = rootPin.rootRealPath;
  for (const segment of relativePath.split("/")) {
    current = path.join(current, segment);
    let component;
    try {
      component = await lstat(current);
    } catch (error) {
      if (isMissingPathError(error)) return;
      throw error;
    }
    if (component.isSymbolicLink()) throw new HttpError(403, "Symbolic links are disabled for guarded AI context.");
    const componentRealPath = await realpath(current);
    if (!isInsideRoot(rootPin.rootRealPath, componentRealPath)) throw new HttpError(403, "Guarded AI context escaped the Current repo.");
    const canonicalRelativePath = path.relative(rootPin.rootRealPath, componentRealPath).split(path.sep).join("/");
    guardedRelativePath(repo, canonicalRelativePath, pathPolicy);
  }
  await assertPinnedRepositoryRoot(rootPin);
}

async function assertPinnedRepositoryRoot(rootPin: PinnedRepositoryRoot): Promise<void> {
  const rootStat = await lstat(rootPin.rootRealPath).catch(() => {
    throw new HttpError(409, "The Current repo root changed during the guarded run.");
  });
  const currentRealPath = await realpath(rootPin.rootRealPath).catch(() => {
    throw new HttpError(409, "The Current repo root changed during the guarded run.");
  });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || currentRealPath !== rootPin.rootRealPath
    || rootStat.dev !== rootPin.device || rootStat.ino !== rootPin.inode) {
    throw new HttpError(409, "The Current repo root identity changed during the guarded run.");
  }
}

async function pinDirectory(rootPin: PinnedRepositoryRoot, directoryPath: string): Promise<PinnedDirectory> {
  await assertPinnedRepositoryRoot(rootPin);
  if (!isInsideRoot(rootPin.rootRealPath, directoryPath)) throw new HttpError(403, "A guarded repository parent escaped the Current repo.");
  const directoryStat = await lstat(directoryPath);
  const directoryRealPath = await realpath(directoryPath);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryRealPath !== directoryPath
    || !isInsideRoot(rootPin.rootRealPath, directoryRealPath)) {
    throw new HttpError(409, "A guarded repository parent identity is not stable.");
  }
  return { path: directoryPath, device: directoryStat.dev, inode: directoryStat.ino };
}

async function assertPinnedDirectory(rootPin: PinnedRepositoryRoot, directory: PinnedDirectory): Promise<void> {
  await assertPinnedRepositoryRoot(rootPin);
  const directoryStat = await lstat(directory.path).catch(() => {
    throw new HttpError(409, "A guarded repository parent changed during the run.");
  });
  const directoryRealPath = await realpath(directory.path).catch(() => {
    throw new HttpError(409, "A guarded repository parent changed during the run.");
  });
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || directoryRealPath !== directory.path
    || !isInsideRoot(rootPin.rootRealPath, directoryRealPath)
    || directoryStat.dev !== directory.device || directoryStat.ino !== directory.inode) {
    throw new HttpError(409, "A guarded repository parent identity changed during the run.");
  }
}

function authorizedDeletePaths(repo: RepositoryConfig, messages: AIChatMessage[], pathPolicy?: GuardedRepoPathPolicy): Set<string> {
  const latestUserMessage = [...messages].reverse().find((message) => message.role === "user")?.content || "";
  const authorized = new Set<string>();
  for (const line of latestUserMessage.split(/\r?\n/)) {
    const match = line.match(/^DELETE:\s*(\S(?:.*\S)?)\s*$/);
    if (!match) continue;
    authorized.add(guardedRelativePath(repo, match[1], pathPolicy));
  }
  return authorized;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new HttpError(499, "AI provider request was canceled.");
}

function finalUserMessage(message: string, changedPaths: AIChangedPath[]): string {
  if (!changedPaths.length) return message;
  return `${message}\n\nChanged repository paths:\n${changedPaths.map((item) => `- ${item.path} (${item.status})`).join("\n")}`;
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(needle, offset);
    if (index < 0) return count;
    count += 1;
    offset = index + Math.max(needle.length, 1);
  }
}

function hashText(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function isMissingPathError(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && (error as { code?: string }).code === "ENOENT";
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await lstat(targetPath);
    return true;
  } catch (error) {
    if (isMissingPathError(error)) return false;
    return true;
  }
}

function safeFsError(error: unknown): string {
  const code = error !== null && typeof error === "object" && "code" in error && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : "";
  return /^(?:EACCES|EBUSY|EEXIST|EIO|EISDIR|ENOENT|ENOTDIR|ENOTEMPTY|EPERM|EROFS|EXDEV)$/.test(code)
    ? `filesystem ${code}`
    : "filesystem error";
}

function safeProtocolError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\/[\w./-]+/g, "[path]").slice(0, 500) || "Guarded edit protocol capability check failed.";
}
