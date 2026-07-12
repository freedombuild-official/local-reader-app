import { HttpError } from "./errors.js";

export const GUARDED_EDIT_PROTOCOL_VERSION = "reader-wiki.edit-protocol.v1";
export const GUARDED_EDIT_RESPONSE_FIELDS = ["version", "type", "paths", "operations", "message"] as const;
export const GUARDED_EDIT_REQUIRED_RESPONSE_FIELDS = ["version", "type"] as const;
export const GUARDED_EDIT_OPERATION_FIELDS = ["op", "path", "content", "oldText", "newText"] as const;
export const GUARDED_EDIT_MAX_OPERATIONS = 32;
const GUARDED_EDIT_MAX_MESSAGE_CHARS = 8_000;

export type GuardedEditRead = { type: "read"; paths: string[] };
export type GuardedEditWriteOperation = { op: "write"; path: string; content: string };
export type GuardedEditReplaceOperation = { op: "replace"; path: string; oldText: string; newText: string };
export type GuardedEditDeleteOperation = { op: "delete"; path: string };
export type GuardedEditOperation = GuardedEditWriteOperation | GuardedEditReplaceOperation | GuardedEditDeleteOperation;
export type GuardedEditApply = { type: "apply"; operations: GuardedEditOperation[]; message: string };
export type GuardedEditComplete = { type: "complete"; message: string };
export type GuardedEditResponse = GuardedEditRead | GuardedEditApply | GuardedEditComplete;

type ProtocolShapePhase = "response" | "operation";
type ProtocolShapeDetails = {
  phase: ProtocolShapePhase;
  responseType?: string;
  operationType?: string;
  missingFields: string[];
  unknownFields: string[];
};

export const GUARDED_EDIT_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "reader_wiki_edit_protocol",
    strict: false,
    schema: {
      type: "object",
      properties: {
        version: { type: "string", enum: [GUARDED_EDIT_PROTOCOL_VERSION] },
        type: { type: "string", enum: ["read", "apply", "complete"] },
        paths: { type: "array", items: { type: "string" } },
        operations: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: { type: "string", enum: ["write", "replace", "delete"] },
              path: { type: "string" },
              content: { type: "string" },
              oldText: { type: "string" },
              newText: { type: "string" },
            },
            required: ["op", "path"],
            additionalProperties: false,
          },
        },
        message: { type: "string" },
      },
      required: [...GUARDED_EDIT_REQUIRED_RESPONSE_FIELDS],
      additionalProperties: false,
    },
  },
} as const;

export const GUARDED_EDIT_SYSTEM_PROMPT = [
  "You are Local Reader App's constrained repository edit planner.",
  "You have no shell, filesystem, Git, network, plugin, browser, or application tools.",
  "Local Reader App alone performs bounded reads and validated text-file operations inside the active Current repo.",
  "Return exactly one JSON object and no Markdown, code fences, commentary, or hidden reasoning.",
  "Return only the fields required by the selected response type. If the response engine adds an inactive known field, it must be an empty string or empty array.",
  "Every operation must contain op and path plus only the fields required by that op. If the response engine adds an inactive known field, it must be an empty string.",
  "Use one of these response shapes:",
  `{"version":"${GUARDED_EDIT_PROTOCOL_VERSION}","type":"read","paths":["relative/path"]}`,
  `{"version":"${GUARDED_EDIT_PROTOCOL_VERSION}","type":"apply","operations":[{"op":"write","path":"relative/path","content":"full text"},{"op":"replace","path":"relative/path","oldText":"exact unique text","newText":"replacement"},{"op":"delete","path":"relative/path"}],"message":"concise user-facing result"}`,
  `{"version":"${GUARDED_EDIT_PROTOCOL_VERSION}","type":"complete","message":"concise user-facing answer when no repository change is needed"}`,
  "Rules:",
  "- Paths must be repository-relative. Never use absolute paths or parent traversal.",
  "- Request a read before modifying or deleting every existing file. A new file may be written without a prior read.",
  "- Read only files needed for the user's explicit request. Selected paths are hints, not an edit boundary.",
  "- Never target .git, .codex, .agents, excluded paths, symlinks, binary files, or Local Reader App temporary names.",
  "- Use replace when a small exact change is sufficient. oldText must occur exactly once in the last read content.",
  "- Make changes idempotent. If the requested result already exists, return complete or an apply plan without duplicate content.",
  "- Delete only paths listed in the task's deleteAuthorizations array. Local Reader App derives that list from exact `DELETE: relative/path` lines in the user's latest message.",
  "- Do not claim a file changed unless it appears in operations. Local Reader App reports the authoritative changed path list.",
].join("\n");

export function parseGuardedEditResponse(content: string): GuardedEditResponse {
  const value = parseProtocolJson(content);
  if (!isRecord(value)) {
    throw protocolShapeError("response", {}, ["version", "type"], []);
  }

  const responseType = safeResponseType(value.type);
  const unknownFields = unknownKeys(value, GUARDED_EDIT_RESPONSE_FIELDS);
  const missingBaseFields = [
    ...(value.version === undefined || value.version === null || value.version === "" ? ["version"] : []),
    ...(value.type === undefined || value.type === null || value.type === "" ? ["type"] : []),
  ];
  if (missingBaseFields.length) {
    throw protocolShapeError("response", { responseType }, missingBaseFields, unknownFields);
  }
  if (value.version !== GUARDED_EDIT_PROTOCOL_VERSION) {
    throw new HttpError(502, "The selected model returned an unknown guarded edit protocol version.", {
      phase: "response",
      responseType,
      missingFields: [],
      unknownFields: [],
    } satisfies ProtocolShapeDetails);
  }

  if (value.type === "read") {
    const conflictingFields = [
      ...unknownFields,
      ...(!isEmptyArrayField(value.operations) ? ["operations"] : []),
      ...(!isEmptyTextField(value.message) ? ["message"] : []),
    ];
    const missingFields = !Array.isArray(value.paths) || value.paths.length === 0 ? ["paths"] : [];
    if (missingFields.length || conflictingFields.length) {
      throw protocolShapeError("response", { responseType: "read" }, missingFields, conflictingFields);
    }
    const paths = value.paths as unknown[];
    if (paths.some((item: unknown) => typeof item !== "string" || !item.trim())) {
      throw protocolShapeError("response", { responseType: "read" }, ["paths"], []);
    }
    return { type: "read", paths: Array.from(new Set(paths as string[])) };
  }

  if (value.type === "complete") {
    const conflictingFields = [
      ...unknownFields,
      ...(!isEmptyArrayField(value.paths) ? ["paths"] : []),
      ...(!isEmptyArrayField(value.operations) ? ["operations"] : []),
    ];
    const missingFields = typeof value.message !== "string" || !value.message.trim() ? ["message"] : [];
    if (missingFields.length || conflictingFields.length) {
      throw protocolShapeError("response", { responseType: "complete" }, missingFields, conflictingFields);
    }
    return { type: "complete", message: protocolMessage(value.message as string) };
  }

  if (value.type !== "apply") {
    throw new HttpError(502, "The selected model returned an unknown guarded edit response type.", {
      phase: "response",
      responseType,
      missingFields: [],
      unknownFields: [],
    } satisfies ProtocolShapeDetails);
  }

  const conflictingFields = [
    ...unknownFields,
    ...(!isEmptyArrayField(value.paths) ? ["paths"] : []),
  ];
  const missingFields = [
    ...(!Array.isArray(value.operations) ? ["operations"] : []),
    ...(typeof value.message !== "string" || !value.message.trim() ? ["message"] : []),
  ];
  if (missingFields.length || conflictingFields.length) {
    throw protocolShapeError("response", { responseType: "apply" }, missingFields, conflictingFields);
  }
  if ((value.operations as unknown[]).length > GUARDED_EDIT_MAX_OPERATIONS) {
    throw new HttpError(502, `The guarded edit response supports at most ${GUARDED_EDIT_MAX_OPERATIONS} operations.`);
  }
  return {
    type: "apply",
    operations: (value.operations as unknown[]).map(parseProtocolOperation),
    message: protocolMessage(value.message as string),
  };
}

export function serializeGuardedEditResponse(response: GuardedEditResponse): string {
  const operations = response.type === "apply"
    ? response.operations.map((operation) => operation.op === "write"
      ? { op: operation.op, path: operation.path, content: operation.content }
      : operation.op === "replace"
        ? { op: operation.op, path: operation.path, oldText: operation.oldText, newText: operation.newText }
        : { op: operation.op, path: operation.path })
    : [];
  return JSON.stringify(response.type === "read"
    ? { version: GUARDED_EDIT_PROTOCOL_VERSION, type: response.type, paths: response.paths }
    : response.type === "apply"
      ? { version: GUARDED_EDIT_PROTOCOL_VERSION, type: response.type, operations, message: response.message }
      : { version: GUARDED_EDIT_PROTOCOL_VERSION, type: response.type, message: response.message });
}

function parseProtocolOperation(value: unknown): GuardedEditOperation {
  if (!isRecord(value)) throw protocolShapeError("operation", {}, ["op", "path"], []);
  const operationType = safeOperationType(value.op);
  const unknownFields = unknownKeys(value, GUARDED_EDIT_OPERATION_FIELDS);
  const missingBaseFields = [
    ...(typeof value.op !== "string" || !value.op.trim() ? ["op"] : []),
    ...(typeof value.path !== "string" || !value.path.trim() ? ["path"] : []),
  ];
  if (missingBaseFields.length) {
    throw protocolShapeError("operation", { operationType }, missingBaseFields, unknownFields);
  }

  if (value.op === "write") {
    const missingFields = typeof value.content !== "string" ? ["content"] : [];
    const conflictingFields = [
      ...unknownFields,
      ...(!isEmptyTextField(value.oldText) ? ["oldText"] : []),
      ...(!isEmptyTextField(value.newText) ? ["newText"] : []),
    ];
    if (missingFields.length || conflictingFields.length) {
      throw protocolShapeError("operation", { operationType: "write" }, missingFields, conflictingFields);
    }
    return { op: "write", path: value.path as string, content: value.content as string };
  }

  if (value.op === "replace") {
    const missingFields = [
      ...(typeof value.oldText !== "string" || !value.oldText ? ["oldText"] : []),
      ...(typeof value.newText !== "string" ? ["newText"] : []),
    ];
    const conflictingFields = [
      ...unknownFields,
      ...(!isEmptyTextField(value.content) ? ["content"] : []),
    ];
    if (missingFields.length || conflictingFields.length) {
      throw protocolShapeError("operation", { operationType: "replace" }, missingFields, conflictingFields);
    }
    return { op: "replace", path: value.path as string, oldText: value.oldText as string, newText: value.newText as string };
  }

  if (value.op === "delete") {
    const conflictingFields = [
      ...unknownFields,
      ...["content", "oldText", "newText"].filter((field) => !isEmptyTextField(value[field])),
    ];
    if (conflictingFields.length) {
      throw protocolShapeError("operation", { operationType: "delete" }, [], conflictingFields);
    }
    return { op: "delete", path: value.path as string };
  }

  throw new HttpError(502, "The selected model returned an unsupported guarded edit operation.", {
    phase: "operation",
    operationType,
    missingFields: [],
    unknownFields: [],
  } satisfies ProtocolShapeDetails);
}

function parseProtocolJson(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]);
      } catch {
        // Report the same fail-closed protocol error below.
      }
    }
  }
  throw new HttpError(502, "The selected model did not return a valid guarded edit JSON object.");
}

function protocolShapeError(
  phase: ProtocolShapePhase,
  type: { responseType?: string; operationType?: string },
  missingFields: string[],
  unknownFields: string[],
): HttpError {
  const safeMissingFields = safeFieldNames(missingFields);
  const safeUnknownFields = safeFieldNames(unknownFields);
  const typeName = type.responseType || type.operationType || "unknown";
  const diagnostics = [
    `phase: ${phase}`,
    `type: ${typeName}`,
    ...(safeMissingFields.length ? [`missing fields: ${safeMissingFields.join(", ")}`] : []),
    ...(safeUnknownFields.length ? [`unknown or conflicting fields: ${safeUnknownFields.join(", ")}`] : []),
  ];
  return new HttpError(502, `The selected model returned an invalid guarded edit object (${diagnostics.join("; ")}).`, {
    phase,
    ...type,
    missingFields: safeMissingFields,
    unknownFields: safeUnknownFields,
  } satisfies ProtocolShapeDetails);
}

function protocolMessage(value: string): string {
  if (value.length > GUARDED_EDIT_MAX_MESSAGE_CHARS) throw new HttpError(502, "The guarded edit response message exceeded the character limit.");
  return value.trim();
}

function unknownKeys(value: Record<string, unknown>, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key));
}

function isEmptyArrayField(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && value.length === 0);
}

function isEmptyTextField(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

function safeFieldNames(fields: string[]): string[] {
  return Array.from(new Set(fields.map(safeProtocolToken))).slice(0, 16);
}

function safeProtocolToken(value: unknown): string {
  if (typeof value !== "string") return "unknown";
  const trimmed = value.trim();
  return /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(trimmed) ? trimmed : "unknown";
}

function safeResponseType(value: unknown): string {
  return value === "read" || value === "apply" || value === "complete" ? value : "unknown";
}

function safeOperationType(value: unknown): string {
  return value === "write" || value === "replace" || value === "delete" ? value : "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
