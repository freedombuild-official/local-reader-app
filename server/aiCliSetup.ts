import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  resolveAICommandLaunch,
  runAICommand,
  safeCliEnv,
  type AICommandRunner,
} from "./aiCliAdapters.js";
import {
  loadCodexModelCatalog,
  type CodexModelCatalog,
  CodexCatalogError,
} from "./aiCliCatalog.js";
import {
  spawnCodexAppServer,
  JsonRpcRemoteError,
  type CodexAppServerConnection,
  type JsonRpcNotification,
  type JsonRpcServerRequest,
} from "./codexAppServerClient.js";
import {
  loadClaudeAgentSdkCatalog,
  type LoadClaudeAgentSdkCatalogOptions,
} from "./claudeAgentSdkCatalog.js";
import { HttpError, isHttpError } from "./errors.js";
import type {
  AICliEntryKind,
  AICliModelCatalog,
  AICliModelSelection,
  AICliSetupSnapshot,
  AICliUpdateState,
} from "./types.js";

const ENTRIES = ["codexCli", "claudeCli"] as const satisfies readonly AICliEntryKind[];
const DEFAULT_NONCE_TTL_MS = 2 * 60 * 1_000;
const VERSION_TIMEOUT_MS = 10_000;
const INSPECTION_TIMEOUT_MS = 20_000;
const AUTHENTICATION_TIMEOUT_MS = 10 * 60 * 1_000;
const UPDATE_TIMEOUT_MS = 3 * 60 * 1_000;
const MAX_OUTPUT_BYTES = 256 * 1_024;

export type AiCliSetupErrorCode =
  | "invalidEntry"
  | "busy"
  | "invalidState"
  | "unsupportedPlatform"
  | "updateNotAllowed"
  | "confirmationExpired"
  | "confirmationInvalid"
  | "invalidSelection"
  | "shuttingDown";

export class AiCliSetupError extends Error {
  readonly code: AiCliSetupErrorCode;

  constructor(code: AiCliSetupErrorCode, message: string) {
    super(message);
    this.name = "AiCliSetupError";
    this.code = code;
  }
}

class AiCliProcessTreeUnverifiedError extends HttpError {
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(502, message, { processTreeUnverified: true });
    this.name = "AiCliProcessTreeUnverifiedError";
    this.cause = cause;
  }
}

class AiCliCompatibilityUpdateRequiredError extends Error {
  readonly inspection: AiCliProviderInspection;

  constructor(inspection: AiCliProviderInspection) {
    super(inspection.message);
    this.name = "AiCliCompatibilityUpdateRequiredError";
    this.inspection = inspection;
  }
}

export type AiCliAuthenticationLaunch = {
  state: "waiting" | "succeeded";
  verificationUrl?: string;
  userCode?: string;
  message: string;
};

export type AiCliProviderInspection = {
  installed: boolean;
  cliVersion?: string;
  managed: boolean;
  compatibility: "unknown" | "compatible" | "updateRequired" | "unmanaged";
  authenticated: boolean;
  message: string;
  catalog?: AICliModelCatalog;
  failureReason?: string;
  foundationOnly?: boolean;
};

export type AiCliProviderEvent =
  | { type: "authenticationSucceeded"; message?: string }
  | { type: "authenticationFailed"; message?: string }
  | { type: "authenticationInvalidated"; message?: string }
  | { type: "catalogInvalidated"; message?: string }
  | { type: "processTreeUnverified"; error: unknown; message?: string };

export type AiCliSetupProvider = {
  readonly entry: AICliEntryKind;
  inspect(signal: AbortSignal): Promise<AiCliProviderInspection>;
  currentVersion(signal: AbortSignal): Promise<string>;
  currentExecution(signal: AbortSignal): Promise<{ version: string; executable: ResolvedAiCliExecutable }>;
  startAuthentication(signal: AbortSignal, executable: ResolvedAiCliExecutable): Promise<AiCliAuthenticationLaunch>;
  cancelAuthentication(signal: AbortSignal): Promise<void>;
  update(signal: AbortSignal): Promise<void>;
  shutdown(): Promise<void>;
  setEventListener?(listener: (event: AiCliProviderEvent) => void): void;
};

export type AiCliSetupServiceOptions = {
  providers: Record<AICliEntryKind, AiCliSetupProvider>;
  now?: () => Date;
  randomNonce?: () => string;
  nonceTtlMs?: number;
};

type ActiveOperation = {
  entry: AICliEntryKind;
  kind: "inspect" | "authenticate" | "cancelAuthentication" | "update";
  controller: AbortController;
};

function initialSnapshot(entry: AICliEntryKind): AICliSetupSnapshot {
  return {
    entry,
    setupGeneration: 0,
    phase: "idle",
    message: "Inspect the CLI before selecting a model.",
    compatibility: "unknown",
    managedUpdateSupported: false,
    authentication: { state: "idle" },
    update: { state: "idle" },
    ...(entry === "claudeCli" ? { foundationOnly: true } : {}),
  };
}

export class AiCliSetupService {
  private readonly providers: Record<AICliEntryKind, AiCliSetupProvider>;
  private readonly now: () => Date;
  private readonly randomNonce: () => string;
  private readonly nonceTtlMs: number;
  private readonly snapshots: Record<AICliEntryKind, AICliSetupSnapshot> = {
    codexCli: initialSnapshot("codexCli"),
    claudeCli: initialSnapshot("claudeCli"),
  };
  private readonly managed = new Map<AICliEntryKind, boolean>();
  private readonly providerStateGeneration: Record<AICliEntryKind, number> = { codexCli: 0, claudeCli: 0 };
  private readonly setupGeneration: Record<AICliEntryKind, number> = { codexCli: 0, claudeCli: 0 };
  private readonly pendingProviderRefresh = new Set<AICliEntryKind>();
  private readonly providerRefreshInFlight = new Set<AICliEntryKind>();
  private activeOperation: ActiveOperation | null = null;
  private activeOperationPromise: Promise<AICliSetupSnapshot> | null = null;
  private processTreeUnverifiedError: unknown = null;
  private readonly processTreeUnverifiedListeners = new Set<() => void>();
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private providerShutdownPromise: Promise<PromiseSettledResult<void>[]> | null = null;

  constructor(options: AiCliSetupServiceOptions) {
    this.providers = options.providers;
    this.now = options.now ?? (() => new Date());
    this.randomNonce = options.randomNonce ?? (() => randomBytes(32).toString("base64url"));
    this.nonceTtlMs = options.nonceTtlMs ?? DEFAULT_NONCE_TTL_MS;
    if (!Number.isFinite(this.nonceTtlMs) || this.nonceTtlMs <= 0) {
      throw new Error("nonceTtlMs must be a positive number.");
    }
    for (const entry of ENTRIES) {
      if (this.providers[entry]?.entry !== entry) throw new Error(`Missing setup provider for ${entry}.`);
      this.providers[entry].setEventListener?.((event) => this.handleProviderEvent(entry, event));
    }
  }

  getSnapshots(): Record<AICliEntryKind, AICliSetupSnapshot> {
    return {
      codexCli: structuredClone(this.snapshots.codexCli),
      claudeCli: structuredClone(this.snapshots.claudeCli),
    };
  }

  getSetupGeneration(entry: AICliEntryKind): number {
    return this.setupGeneration[this.requireEntry(entry)];
  }

  reportUnverifiedProcessTree(entry: AICliEntryKind, error: unknown): void {
    const validEntry = this.requireEntry(entry);
    if (!isUnverifiedProcessTreeFailure(error)) {
      throw new Error("Only a verified processTreeUnverified failure can enter the fatal CLI setup latch.");
    }
    this.latchUnverifiedProcessTree(validEntry, error);
  }

  reportAuthenticationInvalidated(entry: AICliEntryKind, message?: string): void {
    const validEntry = this.requireEntry(entry);
    this.handleProviderEvent(validEntry, { type: "authenticationInvalidated", message });
  }

  assertNoUnverifiedProcessTree(): void {
    if (this.processTreeUnverifiedError) throw this.processTreeUnverifiedError;
  }

  onUnverifiedProcessTree(listener: () => void): () => void {
    if (this.processTreeUnverifiedError) {
      listener();
      return () => undefined;
    }
    this.processTreeUnverifiedListeners.add(listener);
    return () => this.processTreeUnverifiedListeners.delete(listener);
  }

  async inspect(entry: AICliEntryKind): Promise<AICliSetupSnapshot> {
    const validEntry = this.requireEntry(entry);
    return this.withOperation(validEntry, "inspect", async (signal) => {
      const invalidationGeneration = this.providerStateGeneration[validEntry];
      const previous = this.snapshots[validEntry];
      this.snapshots[validEntry] = {
        ...previous,
        phase: "inspecting",
        message: "Inspecting the CLI installation and authentication state.",
        update: { state: "idle" },
        failureReason: undefined,
      };
      try {
        const inspection = await this.providers[validEntry].inspect(signal);
        if (this.providerStateGeneration[validEntry] !== invalidationGeneration) {
          return this.snapshot(validEntry);
        }
        this.applyInspection(validEntry, inspection, { state: "idle" });
      } catch (error) {
        if (isUnverifiedProcessTreeFailure(error)) {
          this.latchUnverifiedProcessTree(validEntry, error);
          throw error;
        }
        if (this.providerStateGeneration[validEntry] !== invalidationGeneration) {
          return this.snapshot(validEntry);
        }
        this.applyFailure(
          validEntry,
          error instanceof AiCliSetupError ? error.message : "CLI inspection failed.",
          error,
        );
      }
      return this.snapshot(validEntry);
    });
  }

  async startAuthentication(entry: AICliEntryKind): Promise<AICliSetupSnapshot> {
    const validEntry = this.requireEntry(entry);
    this.assertAvailable();
    const current = this.snapshots[validEntry];
    if (current.phase !== "loginRequired" && current.authentication.state !== "failed") {
      throw new AiCliSetupError("invalidState", "Inspect the CLI and confirm that login is required before starting authentication.");
    }
    return this.withOperation(validEntry, "authenticate", async (signal) => {
      const startedAt = this.timestamp();
      const operationGeneration = this.setupGeneration[validEntry];
      this.snapshots[validEntry] = {
        ...this.snapshots[validEntry],
        phase: "authenticating",
        message: "Starting CLI authentication.",
        authentication: { state: "waiting", startedAt, message: "Starting authentication." },
        update: { state: "idle" },
        failureReason: undefined,
      };
      try {
        const execution = await this.captureAuthenticationExecution(validEntry, current.cliVersion, signal);
        if (this.setupGeneration[validEntry] !== operationGeneration || this.snapshots[validEntry].phase !== "authenticating") {
          throw new AiCliSetupError("invalidState", "CLI authentication state changed before sign-in could start. Inspect the CLI again.");
        }
        const launch = await this.providers[validEntry].startAuthentication(signal, execution);
        if (this.processTreeUnverifiedError) throw this.processTreeUnverifiedError;
        if (this.setupGeneration[validEntry] !== operationGeneration) return this.snapshot(validEntry);
        const providerEventSnapshot = this.snapshots[validEntry];
        if (
          providerEventSnapshot.phase === "loginRequired"
          && providerEventSnapshot.authentication.state === "failed"
          && providerEventSnapshot.failureReason === "authenticationFailed"
        ) return this.snapshot(validEntry);
        if (
          providerEventSnapshot.phase === "loadingCatalog"
          && providerEventSnapshot.authentication.state === "succeeded"
        ) return this.snapshot(validEntry);
        this.bumpSetupGeneration(validEntry);
        if (launch.state === "succeeded") {
          this.snapshots[validEntry] = {
            ...this.snapshots[validEntry],
            phase: "loadingCatalog",
            message: launch.message,
            authentication: { state: "succeeded", startedAt, message: launch.message },
          };
          this.pendingProviderRefresh.add(validEntry);
        } else {
          this.snapshots[validEntry] = {
            ...this.snapshots[validEntry],
            phase: "authenticating",
            message: launch.message,
            authentication: {
              state: "waiting",
              startedAt,
              message: launch.message,
              ...(launch.verificationUrl ? { verificationUrl: launch.verificationUrl } : {}),
              ...(launch.userCode ? { userCode: launch.userCode } : {}),
            },
          };
        }
      } catch (error) {
        if (isUnverifiedProcessTreeFailure(error)) {
          this.latchUnverifiedProcessTree(validEntry, error);
          throw error;
        }
        if (error instanceof AiCliCompatibilityUpdateRequiredError) {
          this.snapshots[validEntry] = {
            ...this.snapshots[validEntry],
            authentication: { state: "idle" },
          };
          this.applyInspection(validEntry, error.inspection, { state: "idle" });
          return this.snapshot(validEntry);
        }
        if (error instanceof AiCliSetupError && (error.code === "invalidSelection" || error.code === "invalidState")) {
          throw error;
        }
        this.snapshots[validEntry] = {
          ...this.snapshots[validEntry],
          phase: "loginRequired",
          message: "CLI authentication could not be started.",
          authentication: { state: "failed", startedAt, message: safeFailureMessage(error) },
          failureReason: "authenticationStartFailed",
        };
      }
      return this.snapshot(validEntry);
    });
  }

  async cancelAuthentication(entry: AICliEntryKind): Promise<AICliSetupSnapshot> {
    const validEntry = this.requireEntry(entry);
    this.assertAvailable();
    const current = this.snapshots[validEntry];
    if (current.phase !== "authenticating" && current.authentication.state !== "waiting") {
      throw new AiCliSetupError("invalidState", "There is no active CLI authentication to cancel.");
    }
    return this.withOperation(validEntry, "cancelAuthentication", async (signal) => {
      const operationGeneration = this.setupGeneration[validEntry];
      try {
        await this.providers[validEntry].cancelAuthentication(signal);
        if (this.setupGeneration[validEntry] !== operationGeneration) return this.snapshot(validEntry);
        this.snapshots[validEntry] = {
          ...this.snapshots[validEntry],
          phase: "loginRequired",
          message: "CLI authentication was canceled.",
          authentication: { state: "idle" },
          failureReason: undefined,
        };
      } catch (error) {
        if (isUnverifiedProcessTreeFailure(error)) {
          this.latchUnverifiedProcessTree(validEntry, error);
          throw error;
        }
        if (this.setupGeneration[validEntry] !== operationGeneration) return this.snapshot(validEntry);
        this.snapshots[validEntry] = {
          ...this.snapshots[validEntry],
          phase: "loginRequired",
          message: "CLI authentication could not be canceled cleanly.",
          authentication: { state: "failed", message: safeFailureMessage(error) },
          failureReason: "authenticationCancelFailed",
        };
      }
      return this.snapshot(validEntry);
    });
  }

  prepareUpdate(entry: AICliEntryKind): AICliSetupSnapshot {
    const validEntry = this.requireEntry(entry);
    this.assertAvailable();
    if (this.isBusy()) throw this.busyError();
    const current = this.snapshots[validEntry];
    const updateKind = this.eligibleUpdateKind(validEntry, current);
    if (!updateKind) {
      throw new AiCliSetupError("updateNotAllowed", "This CLI is not an inspected managed installation eligible for an in-app update.");
    }
    if (current.authentication.state === "waiting") {
      throw new AiCliSetupError("busy", "Finish or cancel CLI authentication before preparing an update.");
    }
    this.bumpSetupGeneration(validEntry);
    const nonce = this.randomNonce();
    if (!nonce || nonce.length > 512 || /[\u0000-\u001f\u007f]/u.test(nonce)) throw new Error("randomNonce returned an invalid value.");
    const expiresAt = new Date(this.nowDate().getTime() + this.nonceTtlMs).toISOString();
    this.snapshots[validEntry] = {
      ...this.snapshots[validEntry],
      update: {
        state: "confirmationRequired",
        kind: updateKind,
        nonce,
        expiresAt,
        message: updateKind === "compatibility"
          ? "Confirm this compatibility update before the short-lived approval expires."
          : "Confirm running the managed CLI updater. It will check for and apply a newer release if one is available.",
      },
    };
    return this.snapshot(validEntry);
  }

  async confirmUpdate(entry: AICliEntryKind, nonce: string): Promise<AICliSetupSnapshot> {
    const validEntry = this.requireEntry(entry);
    this.assertAvailable();
    const current = this.snapshots[validEntry];
    const confirmation = current.update;
    const updateKind = confirmation.kind;
    if (!updateKind || this.eligibleUpdateKind(validEntry, current) !== updateKind) {
      throw new AiCliSetupError("updateNotAllowed", "The inspected CLI is no longer eligible for this in-app update.");
    }
    if (confirmation.state !== "confirmationRequired" || !confirmation.nonce || !confirmation.expiresAt) {
      throw new AiCliSetupError("confirmationInvalid", "Prepare a new CLI update confirmation before updating.");
    }
    if (this.nowDate().getTime() >= Date.parse(confirmation.expiresAt)) {
      this.bumpSetupGeneration(validEntry);
      this.snapshots[validEntry] = { ...this.snapshots[validEntry], update: { state: "idle" } };
      throw new AiCliSetupError("confirmationExpired", "The CLI update confirmation expired. Prepare it again.");
    }
    if (typeof nonce !== "string" || nonce !== confirmation.nonce) {
      throw new AiCliSetupError("confirmationInvalid", "The CLI update confirmation did not match.");
    }

    // Consume the nonce before any awaited work so it cannot be replayed.
    this.snapshots[validEntry] = { ...current, update: { state: "idle" } };
    return this.withOperation(validEntry, "update", async (signal) => {
      const invalidationGeneration = this.providerStateGeneration[validEntry];
      const startedAt = this.timestamp();
      this.snapshots[validEntry] = {
        ...this.snapshots[validEntry],
        message: updateKind === "compatibility"
          ? "Updating the managed CLI installation for compatibility."
          : "Checking for and applying a newer managed CLI release if available.",
        update: {
          state: "running",
          kind: updateKind,
          startedAt,
          message: updateKind === "compatibility" ? "Compatibility update is running." : "Managed CLI updater is running.",
        },
        failureReason: undefined,
      };
      try {
        await this.providers[validEntry].update(signal);
        const finishedAt = this.timestamp();
        const succeeded: AICliUpdateState = {
          state: "succeeded",
          kind: updateKind,
          startedAt,
          finishedAt,
          message: updateKind === "compatibility"
            ? "CLI compatibility update completed. The installation was inspected again."
            : "The managed CLI updater completed. The installation was inspected again.",
        };
        const inspection = await this.providers[validEntry].inspect(signal);
        if (this.providerStateGeneration[validEntry] !== invalidationGeneration) {
          return this.snapshot(validEntry);
        }
        this.applyInspection(validEntry, inspection, succeeded);
      } catch (error) {
        if (isUnverifiedProcessTreeFailure(error)) {
          this.latchUnverifiedProcessTree(validEntry, error);
          throw error;
        }
        if (this.providerStateGeneration[validEntry] !== invalidationGeneration) {
          return this.snapshot(validEntry);
        }
        const failedUpdate: AICliUpdateState = {
          state: "failed",
          kind: updateKind,
          startedAt,
          finishedAt: this.timestamp(),
          message: safeFailureMessage(error),
        };
        this.snapshots[validEntry] = updateKind === "compatibility"
          ? {
              ...this.snapshots[validEntry],
              phase: "updateRequired",
              message: "The CLI compatibility update failed.",
              update: failedUpdate,
              failureReason: "updateFailed",
            }
          : {
              ...this.snapshots[validEntry],
              phase: "failed",
              message: "The managed CLI updater failed. Inspect the installation again before using it.",
              compatibility: "unknown",
              update: failedUpdate,
              catalog: undefined,
              failureReason: "updateFailed",
            };
      }
      return this.snapshot(validEntry);
    });
  }

  validateSelection(entry: AICliEntryKind, selection: AICliModelSelection): AICliModelSelection {
    const validEntry = this.requireEntry(entry);
    const snapshot = this.snapshots[validEntry];
    const catalog = snapshot.phase === "ready"
      && snapshot.update.state !== "confirmationRequired"
      && snapshot.update.state !== "running"
      ? snapshot.catalog
      : undefined;
    if (
      !catalog
      || selection.catalogRevision !== catalog.revision
      || selection.setupGeneration !== this.setupGeneration[validEntry]
    ) {
      throw new AiCliSetupError("invalidSelection", "The selected CLI model catalog is unavailable or stale. Inspect and select again.");
    }
    const model = catalog.models.find((candidate) => candidate.id === selection.model);
    if (
      !model
      || !model.efforts.some((effort) => effort.id === selection.effort)
      || !model.speedModes.some((speedMode) => speedMode.id === selection.speedMode)
    ) {
      throw new AiCliSetupError("invalidSelection", "The selected CLI model, effort, or inference speed is not available in the current catalog.");
    }
    return structuredClone(selection);
  }

  async assertCurrentExecution(entry: AICliEntryKind, selection: AICliModelSelection, signal: AbortSignal): Promise<{ version: string; executable: ResolvedAiCliExecutable }> {
    const validEntry = this.requireEntry(entry);
    this.assertAvailable();
    if (this.isBusy()) throw this.busyError();
    this.validateSelection(validEntry, selection);
    const expectedCatalog = this.snapshots[validEntry].catalog;
    if (!expectedCatalog) throw new AiCliSetupError("invalidSelection", "The selected CLI model catalog is unavailable or stale. Inspect and select again.");
    let observed: { version: string; executable: ResolvedAiCliExecutable };
    try {
      observed = await this.providers[validEntry].currentExecution(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (isUnverifiedProcessTreeFailure(error)) {
        this.latchUnverifiedProcessTree(validEntry, error);
        throw error;
      }
      this.invalidateChangedCliCatalog(validEntry);
      throw new AiCliSetupError("invalidSelection", "The inspected CLI executable changed or is unavailable. Inspect the CLI and select again.");
    }
    const currentCatalog = this.snapshots[validEntry].catalog;
    if (
      observed.version !== expectedCatalog.cliVersion
      || !currentCatalog
      || currentCatalog.revision !== expectedCatalog.revision
      || currentCatalog.cliVersion !== expectedCatalog.cliVersion
      || currentCatalog.revision !== selection.catalogRevision
    ) {
      this.invalidateChangedCliCatalog(validEntry);
      throw new AiCliSetupError("invalidSelection", "The CLI version or model catalog changed. Inspect the CLI and select again.");
    }
    return structuredClone(observed);
  }

  async assertCurrentVersion(entry: AICliEntryKind, selection: AICliModelSelection, signal: AbortSignal): Promise<string> {
    return (await this.assertCurrentExecution(entry, selection, signal)).version;
  }

  private async captureAuthenticationExecution(
    entry: AICliEntryKind,
    expectedVersion: string | undefined,
    signal: AbortSignal,
  ): Promise<ResolvedAiCliExecutable> {
    try {
      const observed = await this.providers[entry].currentExecution(signal);
      if (!expectedVersion || observed.version !== expectedVersion) throw new Error("The inspected CLI version changed.");
      return observed.executable;
    } catch (error) {
      if (signal.aborted || isUnverifiedProcessTreeFailure(error)) throw error;
      this.invalidateChangedCliCatalog(entry);
      throw new AiCliSetupError("invalidSelection", "The inspected CLI executable changed. Inspect the CLI again before signing in.");
    }
  }

  isBusy(entry?: AICliEntryKind): boolean {
    if (this.processTreeUnverifiedError) return true;
    const waitingEntries = ENTRIES.filter((candidate) => this.hasBackgroundSetupActivity(candidate));
    if (entry === undefined) return Boolean(this.activeOperation || waitingEntries.length);
    return this.activeOperation?.entry === entry || waitingEntries.includes(entry);
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.activeOperation?.controller.abort();
    this.pendingProviderRefresh.clear();
    this.shutdownPromise = (async () => {
      const providerShutdown = this.startProviderShutdown();
      const activeOperation = this.activeOperationPromise
        ? Promise.allSettled([this.activeOperationPromise])
        : Promise.resolve([] as PromiseSettledResult<AICliSetupSnapshot>[]);
      const [activeResults, providerResults] = await Promise.all([activeOperation, providerShutdown]);
      for (const entry of ENTRIES) {
        this.snapshots[entry] = {
          ...this.snapshots[entry],
          phase: "unavailable",
          message: "CLI setup service is shut down.",
          authentication: { state: "idle" },
          update: { state: "idle" },
          catalog: undefined,
        };
      }
      const failures = [...activeResults, ...providerResults]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason);
      if (this.processTreeUnverifiedError && !failures.includes(this.processTreeUnverifiedError)) {
        failures.push(this.processTreeUnverifiedError);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "One or more CLI process trees could not be stopped cleanly.");
    })();
    return this.shutdownPromise;
  }

  private async withOperation(
    entry: AICliEntryKind,
    kind: ActiveOperation["kind"],
    work: (signal: AbortSignal) => Promise<AICliSetupSnapshot>,
  ): Promise<AICliSetupSnapshot> {
    this.assertAvailable();
    if (this.activeOperation) throw this.busyError();
    const waitingEntries = ENTRIES.filter((candidate) => this.hasBackgroundSetupActivity(candidate));
    const allowsWaitingTransition = (kind === "cancelAuthentication" && this.hasBackgroundSetupActivity(entry))
      || (kind === "inspect" && this.providerRefreshInFlight.has(entry) && this.snapshots[entry].phase === "loadingCatalog");
    if (waitingEntries.length && !allowsWaitingTransition) throw this.busyError();
    const controller = new AbortController();
    this.bumpSetupGeneration(entry);
    this.activeOperation = { entry, kind, controller };
    const operation = work(controller.signal);
    this.activeOperationPromise = operation;
    try {
      const result = await operation;
      if (this.processTreeUnverifiedError) {
        this.latchUnverifiedProcessTree(entry, this.processTreeUnverifiedError);
        throw this.processTreeUnverifiedError;
      }
      return result;
    } catch (error) {
      if (this.processTreeUnverifiedError) {
        this.latchUnverifiedProcessTree(entry, this.processTreeUnverifiedError);
        throw this.processTreeUnverifiedError;
      }
      throw error;
    } finally {
      if (this.activeOperation?.controller === controller) this.activeOperation = null;
      if (this.activeOperationPromise === operation) this.activeOperationPromise = null;
      this.flushProviderRefresh();
    }
  }

  private applyInspection(entry: AICliEntryKind, inspection: AiCliProviderInspection, update: AICliUpdateState): void {
    if (this.processTreeUnverifiedError) return;
    this.managed.set(entry, inspection.managed);
    const currentAuthentication = this.snapshots[entry].authentication;
    const common = {
      entry,
      setupGeneration: this.setupGeneration[entry],
      message: inspection.message,
      compatibility: inspection.compatibility,
      managedUpdateSupported: inspection.managed,
      authentication: inspection.authenticated
        ? (currentAuthentication.state === "succeeded" ? currentAuthentication : { state: "idle" as const })
        : (currentAuthentication.state === "waiting" ? currentAuthentication : { state: "idle" as const }),
      update,
      checkedAt: this.timestamp(),
      ...(inspection.cliVersion ? { cliVersion: inspection.cliVersion } : {}),
      ...(inspection.foundationOnly ? { foundationOnly: true } : {}),
      ...(inspection.failureReason ? { failureReason: inspection.failureReason } : {}),
    };
    if (!inspection.installed) {
      this.snapshots[entry] = { ...common, phase: "notInstalled", catalog: undefined };
      return;
    }
    if (inspection.compatibility === "updateRequired") {
      this.snapshots[entry] = { ...common, phase: "updateRequired", catalog: undefined };
      return;
    }
    if (inspection.compatibility === "unmanaged" && inspection.failureReason === "compatibilityUpdateRequired") {
      this.snapshots[entry] = { ...common, phase: "unavailable", catalog: undefined };
      return;
    }
    if (!inspection.authenticated) {
      this.snapshots[entry] = {
        ...common,
        phase: currentAuthentication.state === "waiting" ? "authenticating" : "loginRequired",
        catalog: undefined,
      };
      return;
    }
    if (!inspection.catalog) {
      this.snapshots[entry] = { ...common, phase: "unavailable", catalog: undefined };
      return;
    }
    this.snapshots[entry] = { ...common, phase: "ready", catalog: structuredClone(inspection.catalog) };
  }

  private hasBackgroundSetupActivity(entry: AICliEntryKind): boolean {
    const snapshot = this.snapshots[entry];
    return snapshot.phase === "authenticating"
      || snapshot.phase === "loadingCatalog"
      || snapshot.authentication.state === "waiting";
  }

  private invalidateChangedCliCatalog(entry: AICliEntryKind): void {
    this.bumpSetupGeneration(entry);
    this.snapshots[entry] = {
      ...this.snapshots[entry],
      phase: "failed",
      message: "The CLI version or model catalog changed. Inspect the CLI again.",
      catalog: undefined,
      update: { state: "idle" },
      failureReason: "cliVersionChanged",
      checkedAt: this.timestamp(),
    };
  }

  private applyFailure(entry: AICliEntryKind, message: string, error: unknown): void {
    if (this.processTreeUnverifiedError) return;
    const current = this.snapshots[entry];
    this.snapshots[entry] = {
      ...current,
      phase: "failed",
      message,
      checkedAt: this.timestamp(),
      update: { state: "idle" },
      catalog: undefined,
      failureReason: safeFailureMessage(error),
    };
  }

  private handleProviderEvent(entry: AICliEntryKind, event: AiCliProviderEvent): void {
    if (event.type === "processTreeUnverified") {
      this.latchUnverifiedProcessTree(entry, event.error);
      return;
    }
    if (this.shuttingDown || this.processTreeUnverifiedError) return;
    this.bumpSetupGeneration(entry);
    this.providerStateGeneration[entry] += 1;
    const current = this.snapshots[entry];
    if (event.type === "catalogInvalidated") {
      this.pendingProviderRefresh.delete(entry);
      this.snapshots[entry] = {
        ...current,
        phase: "failed",
        message: event.message || "The CLI model service stopped. Inspect the CLI again before continuing.",
        authentication: { state: "idle" },
        update: { state: "idle" },
        catalog: undefined,
        failureReason: "providerConnectionClosed",
        checkedAt: this.timestamp(),
      };
      return;
    }
    if (event.type === "authenticationInvalidated") {
      this.pendingProviderRefresh.delete(entry);
      this.snapshots[entry] = {
        ...current,
        phase: "loginRequired",
        message: event.message || "CLI authentication changed. Sign in again before using the model catalog.",
        authentication: { state: "idle" },
        update: { state: "idle" },
        catalog: undefined,
        failureReason: "authenticationChanged",
        checkedAt: this.timestamp(),
      };
      return;
    }
    if (event.type === "authenticationFailed") {
      this.snapshots[entry] = {
        ...current,
        phase: "loginRequired",
        message: event.message || "CLI authentication failed.",
        authentication: { state: "failed", startedAt: current.authentication.startedAt, message: event.message || "Authentication failed." },
        failureReason: "authenticationFailed",
      };
      return;
    }
    this.snapshots[entry] = {
      ...current,
      phase: "loadingCatalog",
      message: event.message || "Authentication completed. Refreshing the model catalog.",
      authentication: { state: "succeeded", startedAt: current.authentication.startedAt, message: event.message || "Authentication completed." },
      failureReason: undefined,
    };
    this.pendingProviderRefresh.add(entry);
    this.flushProviderRefresh();
  }

  private flushProviderRefresh(): void {
    if (this.shuttingDown || this.activeOperation || this.pendingProviderRefresh.size === 0) return;
    const entry = this.pendingProviderRefresh.values().next().value as AICliEntryKind | undefined;
    if (!entry) return;
    this.pendingProviderRefresh.delete(entry);
    if (this.snapshots[entry].phase !== "loadingCatalog") {
      queueMicrotask(() => this.flushProviderRefresh());
      return;
    }
    this.providerRefreshInFlight.add(entry);
    queueMicrotask(() => {
      if (this.shuttingDown) {
        this.providerRefreshInFlight.delete(entry);
        return;
      }
      if (this.activeOperation) {
        this.pendingProviderRefresh.add(entry);
        this.providerRefreshInFlight.delete(entry);
        return;
      }
      void this.inspect(entry)
        .then((snapshot) => {
          if (snapshot.phase === "loadingCatalog") this.pendingProviderRefresh.add(entry);
        })
        .catch(() => {
          if (this.snapshots[entry].phase === "loadingCatalog") this.pendingProviderRefresh.add(entry);
        })
        .finally(() => {
          this.providerRefreshInFlight.delete(entry);
          this.flushProviderRefresh();
        });
    });
  }

  private requireEntry(entry: AICliEntryKind): AICliEntryKind {
    if (!ENTRIES.includes(entry)) throw new AiCliSetupError("invalidEntry", "Unknown CLI setup entry.");
    return entry;
  }

  private snapshot(entry: AICliEntryKind): AICliSetupSnapshot {
    return structuredClone(this.snapshots[entry]);
  }

  private nowDate(): Date {
    const value = this.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error("now returned an invalid date.");
    return value;
  }

  private timestamp(): string {
    return this.nowDate().toISOString();
  }

  private assertAvailable(): void {
    if (this.processTreeUnverifiedError) throw this.processTreeUnverifiedError;
    if (this.shuttingDown) throw new AiCliSetupError("shuttingDown", "CLI setup service is shutting down.");
  }

  private latchUnverifiedProcessTree(entry: AICliEntryKind, error: unknown): void {
    const firstFatal = !this.processTreeUnverifiedError;
    if (firstFatal) this.processTreeUnverifiedError = error;
    for (const affectedEntry of ENTRIES) {
      this.providerStateGeneration[affectedEntry] += 1;
      this.bumpSetupGeneration(affectedEntry);
      const current = this.snapshots[affectedEntry];
      this.snapshots[affectedEntry] = {
        ...current,
        phase: "unavailable",
        message: "Local Reader App could not confirm that a CLI process tree stopped. Restart the server before continuing.",
        authentication: {
          state: "failed",
          startedAt: current.authentication.startedAt,
          message: affectedEntry === entry
            ? "CLI process cleanup could not be verified. Restart Local Reader App."
            : "Another CLI lost verified process ownership. Restart Local Reader App.",
        },
        update: { state: "idle" },
        catalog: undefined,
        failureReason: "processTreeUnverified",
      };
    }
    if (firstFatal) {
      this.activeOperation?.controller.abort();
      this.pendingProviderRefresh.clear();
      void this.startProviderShutdown();
      for (const listener of this.processTreeUnverifiedListeners) {
        try {
          listener();
        } catch {
          // Fatal state is already retained; one observer cannot prevent the others from stopping.
        }
      }
    }
  }

  private startProviderShutdown(): Promise<PromiseSettledResult<void>[]> {
    if (!this.providerShutdownPromise) {
      this.providerShutdownPromise = Promise.allSettled(ENTRIES.map((entry) => this.providers[entry].shutdown()));
    }
    return this.providerShutdownPromise;
  }

  private bumpSetupGeneration(entry: AICliEntryKind): void {
    this.setupGeneration[entry] += 1;
    this.snapshots[entry] = {
      ...this.snapshots[entry],
      setupGeneration: this.setupGeneration[entry],
    };
  }

  private eligibleUpdateKind(entry: AICliEntryKind, snapshot: AICliSetupSnapshot): "compatibility" | "latest" | null {
    if (this.managed.get(entry) !== true) return null;
    if (snapshot.phase === "updateRequired" && snapshot.compatibility === "updateRequired") return "compatibility";
    if (snapshot.phase === "ready" && snapshot.compatibility === "compatible" && snapshot.catalog) return "latest";
    return null;
  }

  private busyError(): AiCliSetupError {
    return new AiCliSetupError("busy", "Another CLI setup operation is already running.");
  }
}

export type ResolvedAiCliExecutable = {
  binary: string;
  argvPrefix: string[];
  identityPath: string;
};

export type AiCliFileIdentity = {
  path: string;
  dev: string;
  ino: string;
  size: number;
  mtimeMs: number;
  sha256: string;
};

export type AiCliManagedRuntimeIdentity = {
  entry: AICliEntryKind;
  layout: "codexNpm" | "claudeNpmNative" | "claudeNpmNode" | "claudeOfficialNative";
  execution: ResolvedAiCliExecutable;
  members: Array<{
    role: "launcher" | "packageManifest" | "platformPackageManifest" | "runtimeManifest" | "payload" | "nodeInterpreter";
    file: AiCliFileIdentity;
  }>;
};

export type AiCliUnmanagedRuntimeIdentity = {
  entry: AICliEntryKind;
  layout: "customNative" | "customScript";
  execution: ResolvedAiCliExecutable;
  members: Array<{
    role: "launcher" | "interpreter";
    file: AiCliFileIdentity;
  }>;
};

export type AiCliExecutableLocator = (
  entry: AICliEntryKind,
  binary: "codex" | "claude",
  cwd: string,
) => Promise<ResolvedAiCliExecutable | null>;

export type AiCliManagedExecutableInspector = (
  entry: AICliEntryKind,
  executable: ResolvedAiCliExecutable,
) => Promise<AiCliManagedRuntimeIdentity | null>;

export type AiCliUnmanagedExecutableInspector = (
  entry: AICliEntryKind,
  executable: ResolvedAiCliExecutable,
) => Promise<AiCliUnmanagedRuntimeIdentity>;

export type AiCliDefaultProviderDependencies = {
  runner?: AICommandRunner;
  locateExecutable?: AiCliExecutableLocator;
  inspectManagedExecutable?: AiCliManagedExecutableInspector;
  inspectUnmanagedExecutable?: AiCliUnmanagedExecutableInspector;
  spawnCodexConnection?: typeof spawnCodexAppServer;
  loadCodexCatalog?: typeof loadCodexModelCatalog;
  loadClaudeCatalog?: (options: LoadClaudeAgentSdkCatalogOptions) => Promise<AICliModelCatalog>;
  now?: () => Date;
  platform?: NodeJS.Platform;
};

abstract class DefaultAiCliProvider implements AiCliSetupProvider {
  abstract readonly entry: AICliEntryKind;
  protected readonly packageRoot: string;
  protected readonly runner: AICommandRunner;
  protected readonly locateExecutable: AiCliExecutableLocator;
  protected readonly inspectManagedExecutable: AiCliManagedExecutableInspector;
  protected readonly inspectUnmanagedExecutable: AiCliUnmanagedExecutableInspector;
  protected readonly now: () => Date;
  protected readonly platform: NodeJS.Platform;
  protected executable: ResolvedAiCliExecutable | null = null;
  protected managedIdentity: AiCliManagedRuntimeIdentity | null = null;
  protected unmanagedIdentity: AiCliUnmanagedRuntimeIdentity | null = null;
  protected managed = false;
  protected listener: ((event: AiCliProviderEvent) => void) | undefined;

  constructor(packageRoot: string, dependencies: AiCliDefaultProviderDependencies) {
    this.packageRoot = path.resolve(packageRoot);
    this.runner = dependencies.runner ?? runAICommand;
    this.locateExecutable = dependencies.locateExecutable ?? locateAiCliExecutable;
    this.inspectManagedExecutable = dependencies.inspectManagedExecutable ?? inspectManagedAiCliExecutable;
    this.inspectUnmanagedExecutable = dependencies.inspectUnmanagedExecutable ?? inspectUnmanagedAiCliExecutable;
    this.now = dependencies.now ?? (() => new Date());
    this.platform = dependencies.platform ?? process.platform;
  }

  setEventListener(listener: (event: AiCliProviderEvent) => void): void {
    this.listener = listener;
  }

  abstract inspect(signal: AbortSignal): Promise<AiCliProviderInspection>;
  abstract startAuthentication(signal: AbortSignal, executable: ResolvedAiCliExecutable): Promise<AiCliAuthenticationLaunch>;
  abstract cancelAuthentication(signal: AbortSignal): Promise<void>;
  abstract update(signal: AbortSignal): Promise<void>;
  abstract shutdown(): Promise<void>;

  async currentExecution(signal: AbortSignal): Promise<{ version: string; executable: ResolvedAiCliExecutable }> {
    this.assertStableProcessTreeSupported();
    const inspected = this.executable;
    if (!inspected) {
      throw new Error("The inspected CLI executable changed. Inspect it again.");
    }
    const result = await this.runPinned(inspected, ["--version"], signal, VERSION_TIMEOUT_MS);
    return {
      version: normalizeVersion(result.stdout || result.stderr, this.entry === "codexCli" ? "Codex" : "Claude"),
      executable: structuredClone(inspected),
    };
  }

  async currentVersion(signal: AbortSignal): Promise<string> {
    return (await this.currentExecution(signal)).version;
  }

  protected async revalidatePinnedExecution(expected: ResolvedAiCliExecutable): Promise<ResolvedAiCliExecutable> {
    const binary = this.entry === "codexCli" ? "codex" : "claude";
    const located = await this.locateExecutable(this.entry, binary, this.packageRoot);
    if (!located) throw new Error("The inspected CLI executable changed. Inspect it again.");
    let current: ResolvedAiCliExecutable;
    if (this.managedIdentity) {
      const managed = await this.inspectManagedExecutable(this.entry, located);
      if (!managed || !sameManagedRuntimeIdentity(this.managedIdentity, managed)) {
        throw new Error("The inspected managed CLI runtime changed. Inspect it again.");
      }
      current = managed.execution;
    } else if (this.unmanagedIdentity) {
      const unmanaged = await this.inspectUnmanagedExecutable(this.entry, located);
      if (!sameUnmanagedRuntimeIdentity(this.unmanagedIdentity, unmanaged)) {
        throw new Error("The inspected unmanaged CLI runtime changed. Inspect it again.");
      }
      current = unmanaged.execution;
    } else {
      throw new Error("The inspected CLI runtime identity is unavailable. Inspect it again.");
    }
    if (!sameExecutionDescriptor(expected, current)) {
      throw new Error("The inspected CLI execution descriptor changed. Inspect it again.");
    }
    return structuredClone(current);
  }

  protected async resolveExecutable(binary: "codex" | "claude"): Promise<ResolvedAiCliExecutable | null> {
    this.assertStableProcessTreeSupported();
    this.executable = null;
    this.managedIdentity = null;
    this.unmanagedIdentity = null;
    this.managed = false;
    const located = await this.locateExecutable(this.entry, binary, this.packageRoot);
    if (!located) return null;
    const managedIdentity = await this.inspectManagedExecutable(this.entry, located);
    const unmanagedIdentity = managedIdentity ? null : await this.inspectUnmanagedExecutable(this.entry, located);
    this.managedIdentity = managedIdentity ? structuredClone(managedIdentity) : null;
    this.unmanagedIdentity = unmanagedIdentity ? structuredClone(unmanagedIdentity) : null;
    this.managed = this.managedIdentity !== null;
    this.executable = structuredClone(this.managedIdentity?.execution ?? this.unmanagedIdentity?.execution ?? null);
    return this.executable;
  }

  protected async run(executable: ResolvedAiCliExecutable, args: string[], signal: AbortSignal, timeoutMs: number) {
    this.assertStableProcessTreeSupported();
    return this.runner(executable.binary, [...executable.argvPrefix, ...args], {
      cwd: this.packageRoot,
      env: safeCliEnv(this.entry),
      timeoutMs,
      maxBuffer: MAX_OUTPUT_BYTES,
      signal,
    });
  }

  protected async runPinned(executable: ResolvedAiCliExecutable, args: string[], signal: AbortSignal, timeoutMs: number) {
    return this.withPinnedExecution(executable, (current) => this.run(current, args, signal, timeoutMs));
  }

  protected async withPinnedExecution<T>(
    executable: ResolvedAiCliExecutable,
    operation: (current: ResolvedAiCliExecutable) => Promise<T>,
  ): Promise<T> {
    const current = await this.revalidatePinnedExecution(executable);
    let result: T | undefined;
    let operationFailed = false;
    let operationError: unknown;
    try {
      result = await operation(current);
    } catch (error) {
      operationFailed = true;
      operationError = error;
    }
    let identityError: unknown;
    try {
      await this.revalidatePinnedExecution(current);
    } catch (error) {
      identityError = error;
    }
    if (operationFailed && isUnverifiedProcessTreeFailure(operationError)) throw operationError;
    if (identityError) throw identityError;
    if (operationFailed) throw operationError;
    return result as T;
  }

  protected async assertManagedExecutable(binary: "codex" | "claude"): Promise<ResolvedAiCliExecutable> {
    this.assertStableProcessTreeSupported();
    const inspected = this.managedIdentity;
    const located = await this.locateExecutable(this.entry, binary, this.packageRoot);
    const current = located ? await this.inspectManagedExecutable(this.entry, located) : null;
    if (!inspected || !current || !sameManagedRuntimeIdentity(inspected, current)) {
      throw new Error("The inspected managed CLI executable changed. Inspect it again before updating.");
    }
    return current.execution;
  }

  protected assertStableProcessTreeSupported(): void {
    if (this.platform === "win32") {
      throw new AiCliSetupError(
        "unsupportedPlatform",
        "CLI setup is unavailable on native Windows until Local Reader App can own and verify the complete CLI process tree.",
      );
    }
  }
}

class CodexAiCliSetupProvider extends DefaultAiCliProvider {
  readonly entry = "codexCli" as const;
  private readonly spawnConnection: typeof spawnCodexAppServer;
  private readonly loadCatalog: typeof loadCodexModelCatalog;
  private connection: CodexAppServerConnection | null = null;
  private connectionIdentity: string | null = null;
  private readonly plannedConnectionStops = new WeakSet<CodexAppServerConnection>();
  private readonly connectionTerminations = new Set<Promise<void>>();
  private terminationError: AiCliProcessTreeUnverifiedError | null = null;
  private shuttingDown = false;
  private shutdownPromise: Promise<void> | null = null;
  private loginId: string | null = null;
  private inspectedCliVersion: string | null = null;

  constructor(packageRoot: string, dependencies: AiCliDefaultProviderDependencies = {}) {
    super(packageRoot, dependencies);
    this.spawnConnection = dependencies.spawnCodexConnection ?? spawnCodexAppServer;
    this.loadCatalog = dependencies.loadCodexCatalog ?? loadCodexModelCatalog;
  }

  async inspect(signal: AbortSignal): Promise<AiCliProviderInspection> {
    const resolvedExecutable = await this.resolveExecutable("codex");
    if (!resolvedExecutable) return notInstalledInspection("codexCli", false);
    const currentExecution = await this.currentExecution(signal);
    const executable = currentExecution.executable;
    const cliVersion = currentExecution.version;
    this.inspectedCliVersion = cliVersion;
    try {
      await this.runPinned(executable, ["app-server", "--help"], signal, INSPECTION_TIMEOUT_MS);
    } catch (error) {
      if (isUnverifiedProcessTreeFailure(error) || signal.aborted) throw error;
      if (isCodexAppServerCapabilityFailure(error)) {
        return compatibilityUpdateInspection(cliVersion, this.managed, "Codex CLI must be updated before app-server authentication and model discovery can be used.");
      }
      throw error;
    }
    let connection: CodexAppServerConnection;
    try {
      connection = await this.ensureConnection(executable, signal);
    } catch (error) {
      if (isMissingCapability(error)) {
        return compatibilityUpdateInspection(cliVersion, this.managed, "Codex app-server setup is too old for authentication and model discovery.");
      }
      throw error;
    }

    let account: unknown;
    try {
      account = await this.withPinnedExecution(executable, () =>
        connection.client.request<unknown>("account/read", { refreshToken: true }, { signal, timeoutMs: INSPECTION_TIMEOUT_MS }),
      );
    } catch (error) {
      if (isMissingCapability(error)) {
        return compatibilityUpdateInspection(cliVersion, this.managed, "Codex CLI must be updated before ChatGPT authentication can be inspected.");
      }
      throw error;
    }
    const authenticated = readCodexAuthenticated(account);
    if (!authenticated) {
      await this.revalidatePinnedExecution(executable);
      return {
        installed: true,
        cliVersion,
        managed: this.managed,
        compatibility: this.managed ? "compatible" : "unmanaged",
        authenticated: false,
        message: "Codex CLI is installed. Sign in with ChatGPT to load the supported model catalog.",
      };
    }

    try {
      const catalog = await this.withPinnedExecution(executable, async () =>
        codexCatalogToAiCli(await this.loadCatalog(connection.client, {
          cliVersion,
          now: this.now,
          signal,
          requestTimeoutMs: INSPECTION_TIMEOUT_MS,
        })),
      );
      return {
        installed: true,
        cliVersion,
        managed: this.managed,
        compatibility: this.managed ? "compatible" : "unmanaged",
        authenticated: true,
        message: "Codex CLI authentication and model catalog are ready.",
        catalog,
      };
    } catch (error) {
      if (isMissingCapability(error) || (error instanceof CodexCatalogError && error.reason === "legacyShape")) {
        return compatibilityUpdateInspection(cliVersion, this.managed, "Codex CLI must be updated before its model catalog can be used.");
      }
      throw error;
    }
  }

  async startAuthentication(signal: AbortSignal, executable: ResolvedAiCliExecutable): Promise<AiCliAuthenticationLaunch> {
    const connection = await this.ensureConnection(executable, signal);
    if (this.loginId) await this.cancelAuthentication(signal);
    let raw: unknown;
    try {
      raw = await this.withPinnedExecution(executable, () =>
        connection.client.request<unknown>("account/login/start", { type: "chatgpt" }, { signal, timeoutMs: INSPECTION_TIMEOUT_MS }),
      );
    } catch (error) {
      if (isMissingCapability(error) && this.inspectedCliVersion) {
        throw new AiCliCompatibilityUpdateRequiredError(compatibilityUpdateInspection(
          this.inspectedCliVersion,
          this.managed,
          "Codex CLI must be updated before ChatGPT authentication can be started.",
        ));
      }
      throw error;
    }
    const launch = normalizeCodexAuthenticationLaunch(raw);
    this.loginId = launch.loginId;
    return {
      state: "waiting",
      verificationUrl: launch.verificationUrl,
      ...(launch.userCode ? { userCode: launch.userCode } : {}),
      message: launch.userCode
        ? "Open the verification URL and enter the displayed code."
        : "Complete ChatGPT sign-in in the opened verification page.",
    };
  }

  async cancelAuthentication(signal: AbortSignal): Promise<void> {
    const loginId = this.loginId;
    this.loginId = null;
    if (!loginId || !this.connection) return;
    await this.connection.client.request("account/login/cancel", { loginId }, { signal, timeoutMs: INSPECTION_TIMEOUT_MS });
  }

  async update(signal: AbortSignal): Promise<void> {
    await this.stopConnection();
    const executable = await this.assertManagedExecutable("codex");
    await this.run(executable, ["update"], signal, UPDATE_TIMEOUT_MS);
    this.executable = null;
    this.managedIdentity = null;
    this.unmanagedIdentity = null;
    this.managed = false;
    this.inspectedCliVersion = null;
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.loginId = null;
    this.shutdownPromise = this.stopConnection();
    return this.shutdownPromise;
  }

  private async ensureConnection(executable: ResolvedAiCliExecutable, signal: AbortSignal): Promise<CodexAppServerConnection> {
    this.assertStableProcessTreeSupported();
    if (this.terminationError) throw this.terminationError;
    if (this.shuttingDown || signal.aborted) throw providerAbortError();
    const pinnedExecution = await this.revalidatePinnedExecution(executable);
    const connectionIdentity = JSON.stringify({
      binary: pinnedExecution.binary,
      argvPrefix: pinnedExecution.argvPrefix,
      identityPath: pinnedExecution.identityPath,
      cliVersion: this.inspectedCliVersion,
      managedRuntimeIdentity: this.managedIdentity,
      unmanagedRuntimeIdentity: this.unmanagedIdentity,
    });
    if (this.connection && this.connectionIdentity !== connectionIdentity) {
      await this.stopConnection();
    }
    if (this.connection) return this.connection;
    const connection = this.spawnConnection({
      binary: pinnedExecution.binary,
      argvPrefix: pinnedExecution.argvPrefix,
      cwd: this.packageRoot,
      env: safeCliEnv(this.entry),
      signal,
      requestTimeoutMs: INSPECTION_TIMEOUT_MS,
    });
    this.attachConnectionProtocol(connection);
    try {
      await this.withPinnedExecution(pinnedExecution, () =>
        connection.client.request("initialize", {
          clientInfo: { name: "local-reader-app", title: "Local Reader App", version: "0.1.0" },
          capabilities: {},
        }, { signal, timeoutMs: INSPECTION_TIMEOUT_MS }),
      );
      connection.client.notify("initialized", {});
      this.connection = connection;
      this.connectionIdentity = connectionIdentity;
      this.observeConnectionTermination(connection);
      return connection;
    } catch (error) {
      try {
        await connection.shutdown();
      } catch (shutdownError) {
        throw this.retainTerminationError(
          "Codex app-server initialization failed and its process tree could not be stopped cleanly.",
          new AggregateError([error, shutdownError], "Codex app-server initialization and cleanup both failed."),
        );
      }
      throw error;
    }
  }

  private attachConnectionProtocol(connection: CodexAppServerConnection): void {
    connection.client.on("serverRequest", (request: JsonRpcServerRequest) => {
      connection.client.respondError(request.id, { code: -32601, message: "Client request is not supported by Local Reader App setup." });
    });
    connection.client.on("notification", (notification: JsonRpcNotification) => this.handleNotification(notification));
    connection.client.on("closed", () => {
      // Production connections stay retained until their termination promise
      // verifies the full process group. Older injected fakes have no lifecycle
      // promise and can be released immediately.
      if (!connection.termination && this.connection === connection) {
        const unexpected = !this.shuttingDown && !this.plannedConnectionStops.has(connection);
        this.connection = null;
        this.connectionIdentity = null;
        if (unexpected) {
          this.loginId = null;
          this.listener?.({
            type: "catalogInvalidated",
            message: "The Codex model service stopped. Inspect Codex CLI again before continuing.",
          });
        }
      }
    });
  }

  private observeConnectionTermination(connection: CodexAppServerConnection): void {
    // Older injected fakes may not expose the production lifecycle promise.
    // Production connections always do, and it settles only after the owned
    // process group has been reaped and verified.
    if (!connection.termination) return;
    let observed!: Promise<void>;
    observed = connection.termination
      .then(() => {
        if (!this.shuttingDown && !this.plannedConnectionStops.has(connection)) {
          this.loginId = null;
          this.listener?.({
            type: "catalogInvalidated",
            message: "The Codex model service stopped. Inspect Codex CLI again before continuing.",
          });
        }
      })
      .catch((error) => {
        this.retainTerminationError(
          "Codex app-server process cleanup could not be verified. Restart Local Reader App before continuing.",
          error,
        );
      })
      .finally(() => {
        if (this.connection === connection) {
          this.connection = null;
          this.connectionIdentity = null;
        }
        this.connectionTerminations.delete(observed);
      });
    this.connectionTerminations.add(observed);
    void observed.catch(() => undefined);
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === "account/login/completed") {
      const source = asRecordOrNull(notification.params);
      const notifiedLoginId = typeof source?.loginId === "string" ? source.loginId : undefined;
      if (!this.loginId || notifiedLoginId !== this.loginId) return;
      this.loginId = null;
      if (source?.success === false) {
        this.listener?.({ type: "authenticationFailed", message: "ChatGPT authentication did not complete." });
      } else {
        this.listener?.({ type: "authenticationSucceeded", message: "ChatGPT authentication completed." });
      }
      return;
    }
    if (notification.method === "account/updated") {
      const source = asRecordOrNull(notification.params);
      if (source?.authMode === "chatgpt") {
        this.loginId = null;
        this.listener?.({ type: "authenticationSucceeded", message: "ChatGPT authentication completed." });
      } else {
        this.loginId = null;
        this.listener?.({
          type: "authenticationInvalidated",
          message: "Codex ChatGPT authentication changed. Sign in again before using the model catalog.",
        });
      }
    }
  }

  private async stopConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.connectionIdentity = null;
    if (connection) {
      this.plannedConnectionStops.add(connection);
      try {
        await connection.shutdown();
      } catch (error) {
        this.retainTerminationError(
          "Codex app-server process cleanup could not be verified. Restart Local Reader App before continuing.",
          error,
        );
      }
    }
    while (this.connectionTerminations.size > 0) {
      await Promise.all([...this.connectionTerminations]);
    }
    if (this.terminationError) throw this.terminationError;
  }

  private retainTerminationError(message: string, cause: unknown): AiCliProcessTreeUnverifiedError {
    if (!this.terminationError) {
      this.terminationError = new AiCliProcessTreeUnverifiedError(message, cause);
      this.listener?.({
        type: "processTreeUnverified",
        error: this.terminationError,
        message,
      });
    }
    return this.terminationError;
  }
}

class ClaudeAiCliSetupProvider extends DefaultAiCliProvider {
  readonly entry = "claudeCli" as const;
  private readonly loadCatalog: (options: LoadClaudeAgentSdkCatalogOptions) => Promise<AICliModelCatalog>;
  private authenticationController: AbortController | null = null;
  private authenticationPromise: Promise<void> | null = null;
  private authenticationTerminationError: unknown = null;
  private readonly catalogControllers = new Set<AbortController>();

  constructor(packageRoot: string, dependencies: AiCliDefaultProviderDependencies = {}) {
    super(packageRoot, dependencies);
    this.loadCatalog = dependencies.loadClaudeCatalog ?? loadClaudeAgentSdkCatalog;
  }

  async inspect(signal: AbortSignal): Promise<AiCliProviderInspection> {
    const resolvedExecutable = await this.resolveExecutable("claude");
    if (!resolvedExecutable) return notInstalledInspection("claudeCli", true);
    const currentExecution = await this.currentExecution(signal);
    const executable = currentExecution.executable;
    const cliVersion = currentExecution.version;
    const help = await this.runPinned(executable, ["--help"], signal, INSPECTION_TIMEOUT_MS);
    if (!/(?:^|\s)--effort(?:\s|,|$)/mu.test(`${help.stdout}\n${help.stderr}`)) {
      return { ...compatibilityUpdateInspection(cliVersion, this.managed, "Claude Code CLI must be updated before model effort can be selected."), foundationOnly: true };
    }
    let authenticated: boolean;
    try {
      const status = await this.runPinned(executable, ["auth", "status", "--json"], signal, INSPECTION_TIMEOUT_MS);
      authenticated = parseClaudeAuthenticationStatus(status.stdout);
    } catch (error) {
      if (looksLikeMissingCommand(error)) {
        return { ...compatibilityUpdateInspection(cliVersion, this.managed, "Claude Code CLI must be updated before authentication can be inspected."), foundationOnly: true };
      }
      throw error;
    }
    if (!authenticated) {
      await this.revalidatePinnedExecution(executable);
      return {
        installed: true,
        cliVersion,
        managed: this.managed,
        compatibility: this.managed ? "compatible" : "unmanaged",
        authenticated: false,
        foundationOnly: true,
        message: "Claude Code CLI is installed. Sign in before loading the Agent SDK model catalog.",
      };
    }
    const catalogController = new AbortController();
    const abortCatalog = () => catalogController.abort();
    this.catalogControllers.add(catalogController);
    signal.addEventListener("abort", abortCatalog, { once: true });
    let catalog: AICliModelCatalog;
    try {
      if (signal.aborted) catalogController.abort();
      catalog = await this.withPinnedExecution(executable, (catalogExecution) =>
        this.loadCatalog({
          execution: catalogExecution,
          cwd: this.packageRoot,
          cliVersion,
          fetchedAt: this.now().toISOString(),
          abortController: catalogController,
          platform: this.platform,
        }),
      );
    } finally {
      signal.removeEventListener("abort", abortCatalog);
      this.catalogControllers.delete(catalogController);
      catalogController.abort();
    }
    return {
      installed: true,
      cliVersion,
      managed: this.managed,
      compatibility: this.managed ? "compatible" : "unmanaged",
      authenticated: true,
      foundationOnly: true,
      catalog,
      message: "Claude Code authentication and Agent SDK model catalog are ready.",
    };
  }

  async startAuthentication(signal: AbortSignal, executable: ResolvedAiCliExecutable): Promise<AiCliAuthenticationLaunch> {
    this.assertStableProcessTreeSupported();
    if (signal.aborted) throw providerAbortError();
    this.throwAuthenticationTerminationError();
    if (this.authenticationPromise) throw new Error("Claude Code authentication is already running.");
    const pinnedExecution = await this.revalidatePinnedExecution(executable);
    const controller = new AbortController();
    this.authenticationController = controller;
    const authentication = this.withPinnedExecution(pinnedExecution, (current) =>
      this.run(current, ["auth", "login"], controller.signal, AUTHENTICATION_TIMEOUT_MS),
    )
      .then(() => {
        if (!controller.signal.aborted) this.listener?.({ type: "authenticationSucceeded", message: "Claude Code authentication completed." });
      })
      .catch((error: unknown) => {
        if (isUnverifiedProcessTreeFailure(error)) {
          this.authenticationTerminationError = error;
          this.listener?.({
            type: "processTreeUnverified",
            error,
            message: "Claude Code authentication process cleanup could not be verified. Restart Local Reader App.",
          });
          return;
        }
        if (!controller.signal.aborted) this.listener?.({ type: "authenticationFailed", message: "Claude Code authentication failed." });
      })
      .finally(() => {
        if (this.authenticationController === controller) this.authenticationController = null;
        if (this.authenticationPromise === authentication) this.authenticationPromise = null;
      });
    this.authenticationPromise = authentication;
    return {
      state: "waiting",
      message: "Complete Claude Code sign-in in the browser opened by the CLI.",
    };
  }

  async cancelAuthentication(_signal: AbortSignal): Promise<void> {
    const controller = this.authenticationController;
    const authentication = this.authenticationPromise;
    controller?.abort();
    if (authentication) await authentication;
    this.throwAuthenticationTerminationError();
  }

  async update(signal: AbortSignal): Promise<void> {
    const executable = await this.assertManagedExecutable("claude");
    await this.run(executable, ["update"], signal, UPDATE_TIMEOUT_MS);
    this.executable = null;
    this.managedIdentity = null;
    this.unmanagedIdentity = null;
    this.managed = false;
  }

  async shutdown(): Promise<void> {
    for (const controller of this.catalogControllers) controller.abort();
    this.authenticationController?.abort();
    if (this.authenticationPromise) await this.authenticationPromise;
    this.throwAuthenticationTerminationError();
  }

  private throwAuthenticationTerminationError(): void {
    const error = this.authenticationTerminationError;
    if (error) throw error;
  }
}

export function createCodexAiCliSetupProvider(
  packageRoot: string,
  dependencies: AiCliDefaultProviderDependencies = {},
): AiCliSetupProvider {
  return new CodexAiCliSetupProvider(packageRoot, dependencies);
}

export function createClaudeAiCliSetupProvider(
  packageRoot: string,
  dependencies: AiCliDefaultProviderDependencies = {},
): AiCliSetupProvider {
  return new ClaudeAiCliSetupProvider(packageRoot, dependencies);
}

export function createDefaultAiCliSetupService(
  packageRoot: string,
  dependencies: AiCliDefaultProviderDependencies = {},
): AiCliSetupService {
  return new AiCliSetupService({
    providers: {
      codexCli: createCodexAiCliSetupProvider(packageRoot, dependencies),
      claudeCli: createClaudeAiCliSetupProvider(packageRoot, dependencies),
    },
    now: dependencies.now,
  });
}

export function codexCatalogToAiCli(catalog: CodexModelCatalog): AICliModelCatalog {
  return {
    entry: "codexCli",
    cliVersion: catalog.cliVersion,
    revision: catalog.revision,
    fetchedAt: catalog.fetchedAt,
    models: catalog.models.map((model) => {
      const fastTier = (model.serviceTiers || []).find((tier) => (
        tier.id === "fast"
        || (tier.id === "priority" && tier.name.trim().toLowerCase() === "fast")
      ));
      const supportsLegacyFast = (model.additionalSpeedTiers || []).includes("fast");
      const supportsFast = Boolean(fastTier || supportsLegacyFast);
      return {
        id: model.model,
        label: model.displayName,
        description: model.description || null,
        isDefault: model.isDefault,
        defaultEffort: model.defaultReasoningEffort,
        efforts: model.supportedReasoningEfforts.map((effort) => ({
          id: effort.reasoningEffort,
          label: effortLabel(effort.reasoningEffort),
          description: effort.description || null,
          isDefault: effort.reasoningEffort === model.defaultReasoningEffort,
        })),
        defaultSpeedMode: "standard",
        speedModes: [
          {
            id: "standard",
            label: "Standard",
            description: null,
            isDefault: true,
          },
          ...(supportsFast
            ? [{
                id: "fast" as const,
                label: "Fast",
                description: fastTier?.description || null,
                isDefault: false,
              }]
            : []),
        ],
      };
    }),
  };
}

export function parseClaudeAuthenticationStatus(stdout: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("Claude Code returned an invalid authentication status.");
  }
  const source = asRecordOrNull(value);
  if (!source) throw new Error("Claude Code returned an invalid authentication status.");
  if (typeof source.loggedIn === "boolean") return source.loggedIn;
  if (typeof source.authenticated === "boolean") return source.authenticated;
  throw new Error("Claude Code authentication status did not include a boolean login state.");
}

export async function locateAiCliExecutable(
  entry: AICliEntryKind,
  binary: "codex" | "claude",
  cwd: string,
): Promise<ResolvedAiCliExecutable | null> {
  const env = safeCliEnv(entry);
  if (process.platform === "win32") {
    try {
      const launch = await resolveAICommandLaunch(binary, [], { env, cwd });
      const identityCandidate = launch.args[0] && path.isAbsolute(launch.args[0]) ? launch.args[0] : launch.binary;
      return {
        binary: launch.binary,
        argvPrefix: [...launch.args],
        identityPath: await realpath(identityCandidate).catch(() => path.resolve(identityCandidate)),
      };
    } catch {
      return null;
    }
  }

  const candidates = path.isAbsolute(binary)
    ? [binary]
    : (env.PATH || "").split(path.delimiter).filter(Boolean).map((directory) => path.join(directory, binary));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      const identityPath = await realpath(candidate);
      return { binary: identityPath, argvPrefix: [], identityPath };
    } catch {
      // Continue to the next fixed PATH candidate without invoking a shell.
    }
  }
  return null;
}

const MAX_IDENTITY_FILE_BYTES = 512 * 1_024 * 1_024;
const MAX_MANIFEST_BYTES = 256 * 1_024;
const PACKAGE_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const MANAGED_CODEX_TARGETS: Readonly<Record<string, {
  dependencyName: string;
  versionSuffix: string;
  targetTriple: string;
  executableName: string;
  os: string;
  cpu: string;
}>> = {
  "darwin:arm64": { dependencyName: "codex-darwin-arm64", versionSuffix: "darwin-arm64", targetTriple: "aarch64-apple-darwin", executableName: "codex", os: "darwin", cpu: "arm64" },
  "darwin:x64": { dependencyName: "codex-darwin-x64", versionSuffix: "darwin-x64", targetTriple: "x86_64-apple-darwin", executableName: "codex", os: "darwin", cpu: "x64" },
  "linux:arm64": { dependencyName: "codex-linux-arm64", versionSuffix: "linux-arm64", targetTriple: "aarch64-unknown-linux-musl", executableName: "codex", os: "linux", cpu: "arm64" },
  "linux:x64": { dependencyName: "codex-linux-x64", versionSuffix: "linux-x64", targetTriple: "x86_64-unknown-linux-musl", executableName: "codex", os: "linux", cpu: "x64" },
  "win32:arm64": { dependencyName: "codex-win32-arm64", versionSuffix: "win32-arm64", targetTriple: "aarch64-pc-windows-msvc", executableName: "codex.exe", os: "win32", cpu: "arm64" },
  "win32:x64": { dependencyName: "codex-win32-x64", versionSuffix: "win32-x64", targetTriple: "x86_64-pc-windows-msvc", executableName: "codex.exe", os: "win32", cpu: "x64" },
};

type IdentitySnapshot = {
  file: AiCliFileIdentity;
  header: Buffer;
  content?: Buffer;
};

type PackageBinLayout = {
  root: string;
  manifest: AiCliFileIdentity;
  metadata: Record<string, unknown>;
};

export async function inspectManagedAiCliExecutable(
  entry: AICliEntryKind,
  executable: ResolvedAiCliExecutable,
): Promise<AiCliManagedRuntimeIdentity | null> {
  try {
    if (entry === "codexCli") return await inspectManagedCodexNpm(executable);
    return await inspectManagedClaudeNpm(executable) ?? await inspectManagedClaudeOfficialNative(executable);
  } catch {
    // Any malformed, incomplete, changing, or unsupported layout is unmanaged.
    return null;
  }
}

export async function inspectUnmanagedAiCliExecutable(
  entry: AICliEntryKind,
  executable: ResolvedAiCliExecutable,
): Promise<AiCliUnmanagedRuntimeIdentity> {
  if (executable.argvPrefix.length > 0 || !path.isAbsolute(executable.binary)) {
    throw new Error("Unmanaged CLI execution descriptors must resolve to one absolute launcher path.");
  }
  const launcherPath = await canonicalPath(executable.identityPath);
  const binaryPath = await canonicalPath(executable.binary);
  if (binaryPath !== launcherPath) {
    throw new Error("Unmanaged CLI launcher and identity paths must resolve to the same file.");
  }
  const launcher = await readIdentitySnapshot(launcherPath, { executable: true });
  if (isNativeExecutableHeader(launcher.header)) {
    return {
      entry,
      layout: "customNative",
      execution: { binary: launcher.file.path, argvPrefix: [], identityPath: launcher.file.path },
      members: [{ role: "launcher", file: launcher.file }],
    };
  }

  const interpreterPath = await resolveUnmanagedShebangInterpreter(launcher.header, safeCliEnv(entry));
  const interpreter = await readIdentitySnapshot(interpreterPath, { executable: true });
  if (!isNativeExecutableHeader(interpreter.header)) {
    throw new Error("Unmanaged CLI script interpreters must be native executables.");
  }
  return {
    entry,
    layout: "customScript",
    execution: {
      binary: interpreter.file.path,
      argvPrefix: [launcher.file.path],
      identityPath: launcher.file.path,
    },
    members: [
      { role: "launcher", file: launcher.file },
      { role: "interpreter", file: interpreter.file },
    ],
  };
}

export function sameManagedRuntimeIdentity(
  left: AiCliManagedRuntimeIdentity,
  right: AiCliManagedRuntimeIdentity,
): boolean {
  return left.entry === right.entry
    && left.layout === right.layout
    && left.execution.binary === right.execution.binary
    && left.execution.identityPath === right.execution.identityPath
    && left.execution.argvPrefix.length === right.execution.argvPrefix.length
    && left.execution.argvPrefix.every((value, index) => value === right.execution.argvPrefix[index])
    && left.members.length === right.members.length
    && left.members.every((member, index) => {
      const candidate = right.members[index];
      return candidate?.role === member.role && sameFileIdentity(member.file, candidate.file);
    });
}

export function sameUnmanagedRuntimeIdentity(
  left: AiCliUnmanagedRuntimeIdentity,
  right: AiCliUnmanagedRuntimeIdentity,
): boolean {
  return left.entry === right.entry
    && left.layout === right.layout
    && left.execution.binary === right.execution.binary
    && left.execution.identityPath === right.execution.identityPath
    && left.execution.argvPrefix.length === right.execution.argvPrefix.length
    && left.execution.argvPrefix.every((value, index) => value === right.execution.argvPrefix[index])
    && left.members.length === right.members.length
    && left.members.every((member, index) => {
      const candidate = right.members[index];
      return candidate?.role === member.role && sameFileIdentity(member.file, candidate.file);
    });
}

function sameExecutionDescriptor(left: ResolvedAiCliExecutable, right: ResolvedAiCliExecutable): boolean {
  return left.binary === right.binary
    && left.identityPath === right.identityPath
    && left.argvPrefix.length === right.argvPrefix.length
    && left.argvPrefix.every((value, index) => value === right.argvPrefix[index]);
}

async function inspectManagedCodexNpm(executable: ResolvedAiCliExecutable): Promise<AiCliManagedRuntimeIdentity | null> {
  const target = MANAGED_CODEX_TARGETS[`${process.platform}:${process.arch}`];
  if (!target) return null;
  const launcherPath = await canonicalPath(executable.identityPath);
  const packageLayout = await findPackageBinLayout(launcherPath, "@openai/codex", "codex");
  if (!packageLayout) return null;
  const version = packageVersion(packageLayout.metadata);
  if (!version) return null;
  if (packageLayout.metadata.type !== "module") return null;
  const optionalDependencies = recordValue(packageLayout.metadata.optionalDependencies);
  const expectedDependency = `npm:@openai/codex@${version}-${target.versionSuffix}`;
  if (optionalDependencies?.[`@openai/${target.dependencyName}`] !== expectedDependency) return null;

  const launcher = await readIdentitySnapshot(launcherPath, { executable: true });
  if (firstLine(launcher.header) !== "#!/usr/bin/env node") return null;
  const platformRoot = await findCodexPlatformPackageRoot(packageLayout.root, target.dependencyName);
  if (!platformRoot) return null;
  const platformManifest = await readJsonIdentity(path.join(platformRoot, "package.json"));
  if (platformManifest.metadata.name !== "@openai/codex"
    || platformManifest.metadata.version !== `${version}-${target.versionSuffix}`
    || !exactStringArray(platformManifest.metadata.os, [target.os])
    || !exactStringArray(platformManifest.metadata.cpu, [target.cpu])) return null;

  const vendorRoot = path.join(platformRoot, "vendor", target.targetTriple);
  const runtimeManifest = await readJsonIdentity(path.join(vendorRoot, "codex-package.json"));
  if (runtimeManifest.metadata.layoutVersion !== 1
    || runtimeManifest.metadata.version !== version
    || runtimeManifest.metadata.target !== target.targetTriple
    || runtimeManifest.metadata.variant !== "codex"
    || runtimeManifest.metadata.entrypoint !== `bin/${target.executableName}`) return null;
  const payload = await readIdentitySnapshot(path.join(vendorRoot, "bin", target.executableName), { executable: true });
  if (!isNativeExecutableHeader(payload.header)) return null;
  const nodePath = await resolvePathExecutable("node", safeCliEnv("codexCli"));
  const nodeInterpreter = await readIdentitySnapshot(nodePath, { executable: true });
  if (!isNativeExecutableHeader(nodeInterpreter.header)) return null;

  return {
    entry: "codexCli",
    layout: "codexNpm",
    execution: { binary: nodeInterpreter.file.path, argvPrefix: [launcher.file.path], identityPath: launcher.file.path },
    members: [
      { role: "launcher", file: launcher.file },
      { role: "packageManifest", file: packageLayout.manifest },
      { role: "platformPackageManifest", file: platformManifest.file },
      { role: "runtimeManifest", file: runtimeManifest.file },
      { role: "payload", file: payload.file },
      { role: "nodeInterpreter", file: nodeInterpreter.file },
    ],
  };
}

async function inspectManagedClaudeNpm(executable: ResolvedAiCliExecutable): Promise<AiCliManagedRuntimeIdentity | null> {
  const launcherPath = await canonicalPath(executable.identityPath);
  const packageLayout = await findPackageBinLayout(launcherPath, "@anthropic-ai/claude-code", "claude");
  if (!packageLayout || !packageVersion(packageLayout.metadata)) return null;
  const launcher = await readIdentitySnapshot(launcherPath, { executable: true });
  if (isNativeExecutableHeader(launcher.header)) {
    return {
      entry: "claudeCli",
      layout: "claudeNpmNative",
      execution: { binary: launcher.file.path, argvPrefix: [], identityPath: launcher.file.path },
      members: [
        { role: "launcher", file: launcher.file },
        { role: "packageManifest", file: packageLayout.manifest },
      ],
    };
  }
  if (firstLine(launcher.header) !== "#!/usr/bin/env node") return null;
  const nodePath = await resolvePathExecutable("node", safeCliEnv("claudeCli"));
  const nodeInterpreter = await readIdentitySnapshot(nodePath, { executable: true });
  if (!isNativeExecutableHeader(nodeInterpreter.header)) return null;
  return {
    entry: "claudeCli",
    layout: "claudeNpmNode",
    execution: { binary: nodeInterpreter.file.path, argvPrefix: [launcher.file.path], identityPath: launcher.file.path },
    members: [
      { role: "launcher", file: launcher.file },
      { role: "packageManifest", file: packageLayout.manifest },
      { role: "nodeInterpreter", file: nodeInterpreter.file },
    ],
  };
}

async function inspectManagedClaudeOfficialNative(executable: ResolvedAiCliExecutable): Promise<AiCliManagedRuntimeIdentity | null> {
  const home = process.env.HOME;
  if (!home || !path.isAbsolute(home)) return null;
  const versionsRoot = await canonicalPath(path.join(home, ".local", "share", "claude", "versions"));
  const launcherPath = await canonicalPath(executable.identityPath);
  const relative = path.relative(versionsRoot, launcherPath);
  const parts = relative.split(path.sep);
  const validShape = !relative.startsWith(`..${path.sep}`)
    && relative !== ".."
    && !path.isAbsolute(relative)
    && ((parts.length === 1 && PACKAGE_VERSION.test(parts[0] || ""))
      || (parts.length === 2 && PACKAGE_VERSION.test(parts[0] || "") && parts[1] === "claude"));
  if (!validShape) return null;
  const launcher = await readIdentitySnapshot(launcherPath, { executable: true });
  if (!isNativeExecutableHeader(launcher.header)) return null;
  return {
    entry: "claudeCli",
    layout: "claudeOfficialNative",
    execution: { binary: launcher.file.path, argvPrefix: [], identityPath: launcher.file.path },
    members: [{ role: "launcher", file: launcher.file }],
  };
}

async function findPackageBinLayout(
  launcherPath: string,
  expectedPackageName: string,
  binName: string,
): Promise<PackageBinLayout | null> {
  let directory = path.dirname(launcherPath);
  for (let depth = 0; depth < 8; depth += 1) {
    const manifestPath = path.join(directory, "package.json");
    const manifest = await readJsonIdentity(manifestPath).catch(() => null);
    if (manifest?.metadata.name === expectedPackageName) {
      const canonicalRoot = await canonicalPath(directory);
      if (manifest.file.path !== path.join(canonicalRoot, "package.json")) return null;
      const bin = recordValue(manifest.metadata.bin);
      const relativeBin = bin?.[binName];
      if (typeof relativeBin !== "string" || !safeRelativePackagePath(relativeBin)) return null;
      const lexicalTarget = path.resolve(canonicalRoot, relativeBin);
      if (!isWithinDirectory(canonicalRoot, lexicalTarget)) return null;
      const canonicalTarget = await canonicalPath(lexicalTarget).catch(() => null);
      if (canonicalTarget !== launcherPath) return null;
      return { root: canonicalRoot, manifest: manifest.file, metadata: manifest.metadata };
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

async function findCodexPlatformPackageRoot(packageRoot: string, dependencyName: string): Promise<string | null> {
  const candidates = [path.join(packageRoot, "node_modules", "@openai", dependencyName)];
  let current = packageRoot;
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(path.join(current, "node_modules", "@openai", dependencyName));
    if (path.basename(path.dirname(current)) === "@openai") candidates.push(path.join(path.dirname(current), dependencyName));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of new Set(candidates)) {
    const canonical = await canonicalPath(candidate).catch(() => null);
    if (canonical) return canonical;
  }
  return null;
}

async function readJsonIdentity(targetPath: string): Promise<{ file: AiCliFileIdentity; metadata: Record<string, unknown> }> {
  const snapshot = await readIdentitySnapshot(targetPath, { captureContent: true });
  if (!snapshot.content) throw new Error("Managed CLI manifest is empty.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(snapshot.content.toString("utf8"));
  } catch {
    throw new Error("Managed CLI manifest is invalid.");
  }
  const metadata = recordValue(parsed);
  if (!metadata) throw new Error("Managed CLI manifest must be an object.");
  return { file: snapshot.file, metadata };
}

async function readIdentitySnapshot(
  targetPath: string,
  options: { executable?: boolean; captureContent?: boolean } = {},
): Promise<IdentitySnapshot> {
  const canonical = await canonicalPath(targetPath);
  if (options.executable) await access(canonical, fsConstants.X_OK);
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(canonical, flags);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("CLI identity member is not a regular file.");
    if (before.size < 0n || before.size > BigInt(MAX_IDENTITY_FILE_BYTES)) throw new Error("CLI identity member exceeds the size limit.");
    if (options.captureContent && before.size > BigInt(MAX_MANIFEST_BYTES)) throw new Error("Managed CLI manifest exceeds the size limit.");
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(1_024 * 1_024);
    let header = Buffer.alloc(0);
    let offset = 0;
    const size = Number(before.size);
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      if (offset === 0) header = Buffer.from(chunk.subarray(0, 256));
      hash.update(chunk);
      if (options.captureContent) chunks.push(Buffer.from(chunk));
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (offset !== size
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs) {
      throw new Error("CLI identity member changed while it was inspected.");
    }
    return {
      file: {
        path: canonical,
        dev: before.dev.toString(),
        ino: before.ino.toString(),
        size,
        mtimeMs: Number(before.mtimeMs),
        sha256: hash.digest("hex"),
      },
      header,
      ...(options.captureContent ? { content: Buffer.concat(chunks) } : {}),
    };
  } finally {
    await handle.close();
  }
}

async function resolvePathExecutable(binary: string, env: NodeJS.ProcessEnv): Promise<string> {
  if (path.isAbsolute(binary)) return await canonicalPath(binary);
  for (const directory of (env.PATH || "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, binary);
    try {
      await access(candidate, fsConstants.X_OK);
      return await canonicalPath(candidate);
    } catch {
      // Continue through the fixed PATH candidates.
    }
  }
  throw new Error(`Managed CLI interpreter ${binary} was not found.`);
}

async function resolveUnmanagedShebangInterpreter(header: Buffer, env: NodeJS.ProcessEnv): Promise<string> {
  const declarationLine = firstLine(header);
  if (!declarationLine.startsWith("#!") || declarationLine.includes("\0")) {
    throw new Error("Unmanaged CLI executables must be native binaries or use a bounded shebang.");
  }
  const declaration = declarationLine.slice(2).trim();
  const envMatch = declaration.match(/^\/usr\/bin\/env ([A-Za-z0-9._+-]{1,64})$/u);
  if (envMatch) return await resolvePathExecutable(envMatch[1], env);
  if (!path.isAbsolute(declaration) || /\s/u.test(declaration)) {
    throw new Error("Unmanaged CLI script interpreters must use one absolute path or a bounded /usr/bin/env name.");
  }
  return await canonicalPath(declaration);
}

function packageVersion(metadata: Record<string, unknown>): string | null {
  return typeof metadata.version === "string" && PACKAGE_VERSION.test(metadata.version) ? metadata.version : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function exactStringArray(value: unknown, expected: string[]): boolean {
  return Array.isArray(value) && value.length === expected.length && value.every((entry, index) => entry === expected[index]);
}

function safeRelativePackagePath(value: string): boolean {
  return value.length > 0
    && value.length <= 512
    && !path.isAbsolute(value)
    && !value.includes("\0")
    && !value.split(/[\\/]/u).includes("..");
}

function isWithinDirectory(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function canonicalPath(value: string): Promise<string> {
  if (!path.isAbsolute(value) || value.includes("\0")) throw new Error("CLI identity paths must be absolute.");
  return await realpath(value);
}

function firstLine(header: Buffer): string {
  return header.toString("utf8").split(/\r?\n/u, 1)[0] || "";
}

function isNativeExecutableHeader(header: Buffer): boolean {
  if (process.platform === "win32") return header.length >= 2 && header[0] === 0x4d && header[1] === 0x5a;
  if (process.platform === "linux") return header.length >= 4 && header[0] === 0x7f && header[1] === 0x45 && header[2] === 0x4c && header[3] === 0x46;
  if (process.platform === "darwin" && header.length >= 4) {
    return ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(header.subarray(0, 4).toString("hex"));
  }
  return false;
}

function sameFileIdentity(left: AiCliFileIdentity, right: AiCliFileIdentity): boolean {
  return left.path === right.path
    && left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.sha256 === right.sha256;
}

function notInstalledInspection(entry: AICliEntryKind, foundationOnly: boolean): AiCliProviderInspection {
  return {
    installed: false,
    managed: false,
    compatibility: "unknown",
    authenticated: false,
    message: `${entry === "codexCli" ? "Codex" : "Claude Code"} CLI is not installed or is not on PATH.`,
    ...(foundationOnly ? { foundationOnly: true } : {}),
  };
}

function compatibilityUpdateInspection(cliVersion: string, managed: boolean, message: string): AiCliProviderInspection {
  return {
    installed: true,
    cliVersion,
    managed,
    compatibility: managed ? "updateRequired" : "unmanaged",
    authenticated: false,
    message: managed ? message : `${message} This executable is unmanaged and cannot be updated in the app.`,
    failureReason: "compatibilityUpdateRequired",
  };
}

function normalizeVersion(value: string, label: string): string {
  const version = value.trim().split(/\r?\n/u)[0]?.trim() || "";
  if (!version || version.length > 200 || /[\u0000-\u001f\u007f]/u.test(version)) {
    throw new Error(`${label} returned an invalid version.`);
  }
  return version;
}

function readCodexAuthenticated(value: unknown): boolean {
  const source = asRecordOrNull(value);
  const account = asRecordOrNull(source?.account);
  return account?.type === "chatgpt";
}

function normalizeCodexAuthenticationLaunch(value: unknown): { loginId: string; verificationUrl: string; userCode?: string } {
  const source = asRecordOrNull(value);
  const loginId = boundedProviderString(source?.loginId, "Codex login id", 256);
  const verificationUrlValue = source?.authUrl ?? source?.verificationUrl;
  const verificationUrl = boundedProviderString(verificationUrlValue, "Codex verification URL", 2_048);
  let parsed: URL;
  try {
    parsed = new URL(verificationUrl);
  } catch {
    throw new Error("Codex returned an invalid verification URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("Codex returned an unsupported verification URL.");
  const userCode = source?.userCode === undefined ? undefined : boundedProviderString(source.userCode, "Codex user code", 128);
  return { loginId, verificationUrl, ...(userCode ? { userCode } : {}) };
}

function boundedProviderString(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || !value || value.length > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function effortLabel(id: string): string {
  return id
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function asRecordOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isMissingCapability(error: unknown): boolean {
  return error instanceof JsonRpcRemoteError && error.code === -32601;
}

function isCodexAppServerCapabilityFailure(error: unknown): boolean {
  if (isMissingCapability(error) || looksLikeMissingCommand(error)) return true;
  return isHttpError(error)
    && error.status === 502
    && !isUnverifiedProcessTreeFailure(error)
    && Boolean(
      error.details
      && typeof error.details === "object"
      && (error.details as { cliFailureKind?: unknown }).cliFailureKind === "missingCapability",
    );
}

function looksLikeMissingCommand(error: unknown): boolean {
  if (
    isHttpError(error)
    && error.details
    && typeof error.details === "object"
    && (error.details as { cliFailureKind?: unknown }).cliFailureKind === "missingCapability"
  ) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /(?:unknown|unrecognized|invalid|no such)\s+(?:command|subcommand|option)\b/i.test(message);
}

function isUnverifiedProcessTreeFailure(error: unknown): boolean {
  if (!isHttpError(error) || !error.details || typeof error.details !== "object") return false;
  return (error.details as { processTreeUnverified?: unknown }).processTreeUnverified === true;
}

function providerAbortError(): Error {
  const error = new Error("The CLI provider operation was aborted.");
  error.name = "AbortError";
  return error;
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof AiCliSetupError) return error.message;
  if (error instanceof Error && error.name === "AbortError") return "The operation was canceled.";
  return "The CLI operation failed. Inspect the CLI and try again.";
}
