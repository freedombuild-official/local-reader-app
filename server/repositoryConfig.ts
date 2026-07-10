import { createHash } from "node:crypto";
import { access, constants, mkdir, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { isAbsolute } from "node:path";
import { parse, stringify } from "yaml";
import { HttpError } from "./errors.js";
import { isExcludedPath, normalizeRelativePath } from "./pathGuard.js";
import type {
  RepositoryConfig,
  RepositoryConfigCheck,
  RepositoryConfigDraft,
  RepositoryConfigEntryDraft,
  RepositoryConfigPreview,
  RepositoryConfigSourceMode,
  RepositoryConfigState,
  RepositoryConfigValidation,
} from "./types.js";

type RawRegistry = {
  repositories?: unknown;
};

const configSaveTails = new Map<string, Promise<void>>();

export function configSourceMode(configPath: string, packageRoot = process.cwd()): RepositoryConfigSourceMode {
  const defaultPath = path.resolve(packageRoot, "repositories.yaml");
  return path.resolve(configPath) === defaultPath ? "default" : "env";
}

export async function loadRepositoryConfigState(configPath: string, packageRoot = process.cwd()): Promise<RepositoryConfigState> {
  const resolvedConfigPath = path.resolve(configPath);
  const sourceMode = configSourceMode(resolvedConfigPath, packageRoot);
  const fileState = await inspectConfigFile(resolvedConfigPath);
  if (!fileState.exists) {
    return {
      configPath: resolvedConfigPath,
      sourceMode,
      exists: false,
      readable: false,
      writable: fileState.writable,
      entries: [],
      configRevision: "missing",
      parseError: `Repository config was not found: ${resolvedConfigPath}`,
    };
  }

  const raw = await readFile(resolvedConfigPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    throw new HttpError(500, error.code === "EACCES" ? "Repository config is not readable." : "Repository config could not be read.");
  });
  try {
    const entries = parseRepositoryConfig(raw).map(toDraftEntry);
    const validation = await validateRepositoryConfigDraft({ entries }, resolvedConfigPath);
    return {
      configPath: resolvedConfigPath,
      sourceMode,
      exists: true,
      readable: true,
      writable: fileState.writable,
      entries,
      configRevision: hashConfig(raw),
      validation,
      yaml: generateRepositoryConfigYaml({ entries }),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      configPath: resolvedConfigPath,
      sourceMode,
      exists: true,
      readable: true,
      writable: fileState.writable,
      entries: [],
      configRevision: hashConfig(raw),
      parseError: message,
    };
  }
}

export function parseRepositoryConfig(raw: string): RepositoryConfig[] {
  const parsed = parse(raw) as RawRegistry;
  if (!Array.isArray(parsed?.repositories)) {
    throw new HttpError(500, "repositories.yaml must contain a repositories array.");
  }
  return parsed.repositories.map((entry, index) => normalizeRepositoryEntry(entry, index));
}

export async function validateRepositoryConfigDraft(draft: RepositoryConfigDraft, configPath: string): Promise<RepositoryConfigValidation> {
  const entries = normalizeDraftEntries(draft.entries);
  const checks: RepositoryConfigCheck[] = [];
  const ids = new Map<string, number>();

  for (const [index, entry] of entries.entries()) {
    if (entry.id) ids.set(entry.id, (ids.get(entry.id) || 0) + 1);
    checks.push(check(Boolean(entry.id), `entry:${index}:id`, `${entry.label || `Entry ${index + 1}`} has an ID`, "Repository ID is required."));
    checks.push(check(Boolean(entry.label), `entry:${index}:label`, `${entry.id || `Entry ${index + 1}`} has a label`, "Repository label is required."));
    checks.push(check(isAbsolute(entry.root), `entry:${index}:rootAbsolute`, `${entry.id || `Entry ${index + 1}`} root is absolute path`, "Root must be an absolute path."));
    checks.push(await rootExistsCheck(entry, index));
    checks.push(defaultPathRelativeCheck(entry, index));
    checks.push(defaultPathInsideRootCheck(entry, index));
    checks.push(excludesRelativeCheck(entry, index));
  }

  for (const [entryId, count] of ids.entries()) {
    checks.push(check(count === 1, `id:${entryId}:unique`, `${entryId} ID is unique`, "Repository IDs must be unique."));
  }
  checks.push(...await repositoryRootRelationshipChecks(entries));

  checks.push(await configFileWritableCheck(configPath));
  try {
    const yaml = generateRepositoryConfigYaml({ entries });
    parseRepositoryConfig(yaml);
    checks.push(check(true, "yaml:generated", "YAML can be generated", "YAML generation failed."));
  } catch (error) {
    checks.push(check(false, "yaml:generated", "YAML can be generated", error instanceof Error ? error.message : String(error)));
  }

  return { valid: checks.every((item) => item.status === "ready"), checks };
}

export async function previewRepositoryConfig(draft: RepositoryConfigDraft, configPath: string): Promise<RepositoryConfigPreview> {
  const entries = normalizeDraftEntries(draft.entries);
  const validation = await validateRepositoryConfigDraft({ entries }, configPath);
  return { yaml: generateRepositoryConfigYaml({ entries }), validation };
}

export async function saveRepositoryConfigDraft(draft: RepositoryConfigDraft, configPath: string): Promise<RepositoryConfigState> {
  const resolvedConfigPath = path.resolve(configPath);
  const entries = normalizeDraftEntries(draft.entries);
  const validation = await validateRepositoryConfigDraft({ entries }, resolvedConfigPath);
  if (!validation.valid) {
    throw new HttpError(400, "Repository config validation failed.");
  }
  return withConfigSaveLock(resolvedConfigPath, async () => {
    const yaml = generateRepositoryConfigYaml({ entries });
    const directory = path.dirname(resolvedConfigPath);
    await mkdir(directory, { recursive: true });
    await assertConfigRevision(resolvedConfigPath, draft.expectedConfigRevision);
    const tempPath = path.join(directory, `.repositories.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
    try {
      const handle = await open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(yaml, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await assertConfigRevision(resolvedConfigPath, draft.expectedConfigRevision);
      await rename(tempPath, resolvedConfigPath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
    return loadRepositoryConfigState(resolvedConfigPath);
  });
}

export function normalizeDraftEntries(entries: RepositoryConfigEntryDraft[]): RepositoryConfigEntryDraft[] {
  return entries.map((entry) => ({
    id: String(entry.id || "").trim(),
    label: String(entry.label || "").trim(),
    root: String(entry.root || "").trim(),
    defaultPath: String(entry.defaultPath || "").trim(),
    excludes: Array.isArray(entry.excludes) ? entry.excludes.map((item) => String(item || "").trim()).filter(Boolean) : [],
    fetchRemote: entry.fetchRemote === true,
  }));
}

export function generateRepositoryConfigYaml(draft: RepositoryConfigDraft): string {
  const repositories = normalizeDraftEntries(draft.entries).map((entry) => {
    const next: Record<string, unknown> = {
      id: entry.id,
      label: entry.label,
      root: entry.root,
    };
    if (entry.defaultPath) next.defaultPath = entry.defaultPath;
    if (entry.fetchRemote) next.fetchRemote = true;
    if (entry.excludes.length) next.excludes = entry.excludes;
    return next;
  });
  return stringify({ repositories }, { lineWidth: 0 });
}

function normalizeRepositoryEntry(entry: unknown, index: number): RepositoryConfig {
  if (!entry || typeof entry !== "object") {
    throw new HttpError(500, `repositories[${index}] must be an object.`);
  }
  const source = entry as Record<string, unknown>;
  const id = requiredString(source.id, `repositories[${index}].id`);
  const label = requiredString(source.label, `repositories[${index}].label`);
  const root = requiredString(source.root, `repositories[${index}].root`);
  if (!isAbsolute(root)) {
    throw new HttpError(500, `${id}.root must be an absolute path.`);
  }
  const defaultPath = typeof source.defaultPath === "string" ? source.defaultPath.trim() : "";
  const excludes = Array.isArray(source.excludes) ? source.excludes.filter((value): value is string => typeof value === "string") : [];
  const fetchRemote = source.fetchRemote === true;
  return { id, label, root, defaultPath, excludes, fetchRemote };
}

function toDraftEntry(entry: RepositoryConfig): RepositoryConfigEntryDraft {
  return {
    id: entry.id,
    label: entry.label,
    root: entry.root,
    defaultPath: entry.defaultPath || "",
    excludes: entry.excludes || [],
    fetchRemote: entry.fetchRemote === true,
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new HttpError(500, `${label} is required.`);
  return value.trim();
}

async function inspectConfigFile(configPath: string): Promise<{ exists: boolean; writable: boolean }> {
  try {
    await stat(configPath);
    const writable = await canWrite(configPath);
    return { exists: true, writable };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    return { exists: false, writable: await canWrite(path.dirname(configPath)) };
  }
}

async function canWrite(target: string): Promise<boolean> {
  try {
    await access(target, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function rootExistsCheck(entry: RepositoryConfigEntryDraft, index: number): Promise<RepositoryConfigCheck> {
  if (!isAbsolute(entry.root)) {
    return check(false, `entry:${index}:rootExists`, `${entry.id || `Entry ${index + 1}`} root exists`, "Root cannot be checked until it is absolute.");
  }
  try {
    const canonicalRoot = await realpath(entry.root);
    await access(canonicalRoot, constants.R_OK);
    const rootStat = await stat(canonicalRoot);
    return check(rootStat.isDirectory(), `entry:${index}:rootExists`, `${entry.id || `Entry ${index + 1}`} root is a readable directory`, "Root must be a readable directory, not a regular file.");
  } catch {
    return check(false, `entry:${index}:rootExists`, `${entry.id || `Entry ${index + 1}`} root exists`, "Root path was not found or is not readable.");
  }
}

async function repositoryRootRelationshipChecks(entries: RepositoryConfigEntryDraft[]): Promise<RepositoryConfigCheck[]> {
  const roots = await Promise.all(entries.map(async (entry, index) => {
    if (!isAbsolute(entry.root)) return null;
    try {
      return { index, id: entry.id || `Entry ${index + 1}`, root: await realpath(entry.root) };
    } catch {
      return null;
    }
  }));
  const checks: RepositoryConfigCheck[] = [];
  for (let leftIndex = 0; leftIndex < roots.length; leftIndex += 1) {
    const left = roots[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < roots.length; rightIndex += 1) {
      const right = roots[rightIndex];
      if (!right) continue;
      const leftFolded = left.root.normalize("NFC").toLocaleLowerCase("en-US");
      const rightFolded = right.root.normalize("NFC").toLocaleLowerCase("en-US");
      const duplicate = left.root === right.root;
      const caseCollision = !duplicate && leftFolded === rightFolded;
      const nested = pathInside(left.root, right.root) || pathInside(right.root, left.root);
      checks.push(check(!duplicate, `roots:${leftIndex}:${rightIndex}:duplicate`, `${left.id} and ${right.id} roots are distinct`, "Repository roots must not resolve to the same directory."));
      checks.push(check(!caseCollision, `roots:${leftIndex}:${rightIndex}:caseCollision`, `${left.id} and ${right.id} roots have distinct case-folded identities`, "Repository roots must not differ only by case or Unicode normalization."));
      checks.push(check(!nested, `roots:${leftIndex}:${rightIndex}:nested`, `${left.id} and ${right.id} roots are not nested`, "Nested repository roots are disabled to avoid overlapping visibility and AI execution boundaries."));
    }
  }
  return checks;
}

function pathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function assertConfigRevision(configPath: string, expectedRevision: string | undefined): Promise<void> {
  const current = await readFile(configPath).then((bytes) => hashConfig(bytes)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "missing";
    throw error;
  });
  if (!expectedRevision || expectedRevision !== current) {
    throw new HttpError(409, "Repository config changed after it was loaded. Reload Settings before saving.", { currentConfigRevision: current });
  }
}

function hashConfig(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("base64url").slice(0, 24);
}

async function withConfigSaveLock<T>(configPath: string, work: () => Promise<T>): Promise<T> {
  const previous = configSaveTails.get(configPath) || Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => gate);
  configSaveTails.set(configPath, tail);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (configSaveTails.get(configPath) === tail) configSaveTails.delete(configPath);
  }
}

function defaultPathRelativeCheck(entry: RepositoryConfigEntryDraft, index: number): RepositoryConfigCheck {
  if (!entry.defaultPath) return check(true, `entry:${index}:defaultRelative`, `${entry.id || `Entry ${index + 1}`} defaultPath is relative`, "Default path must be repository-relative.");
  try {
    normalizeRelativePath(entry.defaultPath);
    return check(true, `entry:${index}:defaultRelative`, `${entry.id || `Entry ${index + 1}`} defaultPath is relative`, "Default path must be repository-relative.");
  } catch (error) {
    return check(false, `entry:${index}:defaultRelative`, `${entry.id || `Entry ${index + 1}`} defaultPath is relative`, error instanceof Error ? error.message : String(error));
  }
}

function defaultPathInsideRootCheck(entry: RepositoryConfigEntryDraft, index: number): RepositoryConfigCheck {
  if (!entry.defaultPath) return check(true, `entry:${index}:defaultInside`, `${entry.id || `Entry ${index + 1}`} defaultPath stays inside root`, "Default path must stay inside the root.");
  if (!isAbsolute(entry.root)) {
    return check(false, `entry:${index}:defaultInside`, `${entry.id || `Entry ${index + 1}`} defaultPath stays inside root`, "Root must be absolute before defaultPath can be checked.");
  }
  try {
    const normalizedDefault = normalizeRelativePath(entry.defaultPath);
    const resolved = path.resolve(entry.root, normalizedDefault);
    const relative = path.relative(entry.root, resolved);
    const inside = relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    return check(inside, `entry:${index}:defaultInside`, `${entry.id || `Entry ${index + 1}`} defaultPath stays inside root`, "Default path must stay inside the root.");
  } catch (error) {
    return check(false, `entry:${index}:defaultInside`, `${entry.id || `Entry ${index + 1}`} defaultPath stays inside root`, error instanceof Error ? error.message : String(error));
  }
}

function excludesRelativeCheck(entry: RepositoryConfigEntryDraft, index: number): RepositoryConfigCheck {
  const invalid = entry.excludes.find((exclude) => {
    try {
      const normalized = normalizeRelativePath(exclude);
      return !normalized || isExcludedPath({ excludes: [] }, normalized) && normalized !== ".git";
    } catch {
      return true;
    }
  });
  return check(!invalid, `entry:${index}:excludesRelative`, `${entry.id || `Entry ${index + 1}`} excludes are repository-relative`, invalid ? `Invalid exclude entry: ${invalid}` : "Exclude entries must be repository-relative.");
}

async function configFileWritableCheck(configPath: string): Promise<RepositoryConfigCheck> {
  const state = await inspectConfigFile(configPath);
  return check(state.writable, "config:writable", "Config file is writable", "Reader-Wiki must be able to write the config file or its parent directory.");
}

function check(ok: boolean, id: string, label: string, message: string): RepositoryConfigCheck {
  return { id, label, status: ok ? "ready" : "error", message: ok ? "Ready" : message };
}
