export type RepoListItem = {
  id: string;
  label: string;
  root: string;
  defaultPath: string;
  exists: boolean;
  revision: string;
};

export type TreeNode = {
  name: string;
  path: string;
  type: "directory" | "file";
  extension: string;
  gitStatus?: DiffStatus;
};

export type TreeSnapshot = Record<string, TreeNode[]>;

export type GitStatus = "new" | "changed" | "deleted";
export type DiffStatus = GitStatus | "binary";

export type FileResponse = {
  repoId: string;
  revision: string;
  path: string;
  name: string;
  extension: string;
  kind: "markdown" | "code" | "text" | "html" | "image" | "pdf" | "binary" | "unsupported";
  content: string;
  lineCount: number;
  fileInfo: FileInformation;
  assetVersion?: string;
  gitDiff?: {
    status: DiffStatus;
    changedLines: number[];
  };
  markdown?: {
    frontmatter: string;
    body: string;
    html: string;
  };
  image?: {
    mimeType: string;
    byteLength: number;
  };
  pdf?: {
    mimeType: string;
    byteLength: number;
  };
  docx?: {
    byteLength: number;
    source: "markdown-in-docx";
  };
};

export type FileInformation = {
  name: string;
  path: string;
  type: string;
  byteLength: number;
  characterCount: number;
  lineCount: number;
  createdAt: string | null;
  gitStatus?: GitStatus;
  mimeType?: string;
  viewerStatus: "displayable" | "deleted" | "binary" | "unsupported" | "oversized" | "metadata-only";
};

export type HttpDeliveryItemStatus = {
  id: string;
  repoId: string;
  path: string;
  url: string;
  startedAt: string;
};

export type HttpDeliveryStatus = {
  state: "idle" | "running" | "error";
  items: HttpDeliveryItemStatus[];
  error?: string;
};

export type RepoSyncStatus = {
  state: "disabled" | "synced" | "skipped" | "warning";
  message: string;
  fetched: boolean;
};

export type RepoOpenResponse = {
  repoId: string;
  revision: string;
  sync: RepoSyncStatus;
  tree: TreeSnapshot;
  treeTruncated: boolean;
  treeWarnings: string[];
};

export type RepositoryConfigSourceMode = "default" | "env";

export type RepositoryConfigEntryDraft = {
  id: string;
  label: string;
  root: string;
  defaultPath: string;
  excludes: string[];
  fetchRemote: boolean;
};

export type RepositoryConfigDraft = {
  entries: RepositoryConfigEntryDraft[];
  expectedConfigRevision?: string;
};

export type RepositoryConfigCheck = {
  id: string;
  label: string;
  status: "ready" | "error";
  message: string;
};

export type RepositoryConfigValidation = {
  valid: boolean;
  checks: RepositoryConfigCheck[];
};

export type RepositoryConfigState = {
  configPath: string;
  sourceMode: RepositoryConfigSourceMode;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  entries: RepositoryConfigEntryDraft[];
  configRevision: string;
  parseError?: string;
  validation?: RepositoryConfigValidation;
  yaml?: string;
};

export type RepositoryConfigPreview = {
  yaml: string;
  validation: RepositoryConfigValidation;
};

export type AIEntryKind = "aiApi" | "localAi" | "codexCli" | "claudeCli";
export type AIProviderEntryKind = "aiApi" | "localAi";
export type AICliEntryKind = "codexCli" | "claudeCli";
export type AIProviderName = "openai" | "anthropic" | "google" | "openaiCompatible" | "custom";
export type AIFormat = "openaiCompatible" | "anthropic" | "google" | "custom";
export type LocalAIRuntime = "ollama" | "lmStudio" | "openaiLocal" | "custom";
export type AICliAuthState = "unknown" | "configured" | "notConfigured";
export type AICliWrapperState = "unknown" | "ready" | "notReady";
export type AIExecutionMode = "unknown" | "readOnly" | "repoWrite";
export type AIProviderExecutionMode = Exclude<AIExecutionMode, "unknown">;

export type AIProviderSettings = {
  entry: AIProviderEntryKind;
  provider?: AIProviderName;
  runtime?: LocalAIRuntime;
  model: string;
  baseUrl: string;
  apiFormat: AIFormat;
  credential?: string;
  executionMode?: AIProviderExecutionMode;
};

export type CliAIEntrySettings = {
  entry: AICliEntryKind;
  binaryName: "codex" | "claude";
  version: string;
  authState: AICliAuthState;
  readOnlyWrapperState: AICliWrapperState;
  executionMode: AIExecutionMode;
  lastCheckedAt?: string;
  readinessMessage?: string;
};

export type AICliSetupPhase =
  | "idle"
  | "inspecting"
  | "notInstalled"
  | "updateRequired"
  | "loginRequired"
  | "authenticating"
  | "loadingCatalog"
  | "ready"
  | "unavailable"
  | "failed";

export type AICliEffortOption = {
  id: string;
  label: string;
  description: string | null;
  isDefault: boolean;
};

export type AICliSpeedMode = "standard" | "fast";

export type AICliSpeedModeOption = {
  id: AICliSpeedMode;
  label: string;
  description: string | null;
  isDefault: boolean;
};

export type AICliModelOption = {
  id: string;
  label: string;
  description: string | null;
  isDefault: boolean;
  defaultEffort: string;
  efforts: AICliEffortOption[];
  defaultSpeedMode: AICliSpeedMode;
  speedModes: AICliSpeedModeOption[];
};

export type AICliModelCatalog = {
  entry: AICliEntryKind;
  cliVersion: string;
  revision: string;
  fetchedAt: string;
  models: AICliModelOption[];
};

export type AICliModelSelection = {
  model: string;
  effort: string;
  speedMode: AICliSpeedMode;
  catalogRevision: string;
  setupGeneration: number;
};

export type AICliAuthenticationState = {
  state: "idle" | "waiting" | "succeeded" | "failed";
  verificationUrl?: string;
  userCode?: string;
  startedAt?: string;
  message?: string;
};

export type AICliUpdateState = {
  state: "idle" | "confirmationRequired" | "running" | "succeeded" | "failed";
  kind?: "compatibility" | "latest";
  nonce?: string;
  expiresAt?: string;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
};

export type AICliSetupSnapshot = {
  entry: AICliEntryKind;
  setupGeneration: number;
  phase: AICliSetupPhase;
  message: string;
  cliVersion?: string;
  checkedAt?: string;
  compatibility: "unknown" | "compatible" | "updateRequired" | "unmanaged";
  managedUpdateSupported?: boolean;
  authentication: AICliAuthenticationState;
  update: AICliUpdateState;
  catalog?: AICliModelCatalog;
  failureReason?: string;
  foundationOnly?: boolean;
};

export type AIEntrySettings = AIProviderSettings | CliAIEntrySettings;

export type AIReadinessCode =
  | "not_configured"
  | "needs_test"
  | "endpoint_unreachable"
  | "invalid_endpoint"
  | "model_missing"
  | "credential_required"
  | "provider_http_error"
  | "timeout_or_abort"
  | "cli_auth_missing"
  | "wrapper_not_ready"
  | "substrate_missing"
  | "workspace_not_ready"
  | "unsupported_provider"
  | "readiness_renewal_failed"
  | "authenticationInvalidated"
  | "success";

export type AIReadinessSeverity = "info" | "success" | "warning" | "error";

export type AIConnectionStatus = {
  state: "notConfigured" | "configured" | "ready" | "failed";
  code?: AIReadinessCode;
  severity?: AIReadinessSeverity;
  message: string;
  nextAction?: string;
  detail?: string;
  checkedAt: string;
};

export type AIChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AIIntelligenceLevel = "low" | "medium" | "high" | "xhigh";

export type AIModelBehavior =
  | { kind: "none" }
  | { kind: "intelligence"; level: AIIntelligenceLevel }
  | { kind: "thinking"; enabled: boolean };

export type AIChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  contentIncluded: boolean;
  content: string;
};

export type AIChatContextRole = "primary" | "rule";
export type AIChatPathKind = "file" | "directory";
export type AIChatContextSource = "tree-menu" | "manual" | "auto-root-rule" | "legacy";

export type AIChatContextPathRequest = {
  path: string;
  kind?: AIChatPathKind;
  source?: AIChatContextSource;
  includeContent?: boolean;
};

export type AIChatContextRequest = {
  repoId: string;
  expectedRevision: string;
  path?: string;
  includeContent?: boolean;
  primaryPaths?: AIChatContextPathRequest[];
  rulePaths?: AIChatContextPathRequest[];
};

export type AIChatContextItem = {
  repoId: string;
  role: AIChatContextRole;
  source: AIChatContextSource;
  path: string;
  name: string;
  kind: AIChatPathKind;
  fileKind?: FileResponse["kind"];
  viewerStatus: FileInformation["viewerStatus"] | "directory";
  lineCount: number;
  byteLength: number;
  contentIncluded: boolean;
  content: string;
};

export type AIChatContext = {
  repoId: string;
  revision: string;
  systemPromptVersion: string;
  primaryItems: AIChatContextItem[];
  ruleItems: AIChatContextItem[];
};

export type AIChatContextChip = {
  id: string;
  repoId: string;
  path: string;
  kind: AIChatPathKind;
  role: AIChatContextRole;
  source: AIChatContextSource;
  removable: boolean;
};

export type AIChatSessionState = {
  messages: AIChatMessage[];
  draft: string;
  pending: boolean;
  error: string;
  requestKey?: string;
  refreshingRepository?: boolean;
  repositoryRefreshError?: string;
  suppressRequestRetry?: boolean;
  lastRequest: string;
  attachments: AIChatAttachment[];
  contextChips: AIChatContextChip[];
  dismissedRulePathKeys: string[];
};

export type AIChatExecutionTarget =
  | { kind: "codexCli"; entry: "codexCli"; selection: AICliModelSelection; status?: AIConnectionStatus }
  | { kind: "claudeCli"; entry: "claudeCli"; selection: AICliModelSelection; status?: AIConnectionStatus }
  | { kind: "codexBackedProvider"; provider: AIProviderSettings; status?: AIConnectionStatus }
  | { kind: "codexBackedLocal"; provider: AIProviderSettings; status?: AIConnectionStatus };

export type AIChangedPath = {
  path: string;
  status: GitStatus;
};

export type AIChatRunSummary = {
  accessMode: "readOnly" | "repoWrite";
  entry: AIEntryKind;
  substrate: "codexCli" | "claudeCli" | "directProvider" | "serverEditProtocol";
  auditState: "verified" | "unverified";
  readPaths?: string[];
  changedPaths: AIChangedPath[];
  repairs: string[];
  warnings: string[];
};

export type AIChatFailureDetails = {
  code?: string;
  entry?: AIEntryKind;
  rollbackState?: string;
  run?: AIChatRunSummary;
  processTreeUnverified?: boolean;
};

export type AIEntryReadiness = {
  entry: AIEntryKind;
  settings: AIEntrySettings;
  status: AIConnectionStatus;
  ready: boolean;
  checks: Array<{
    id: string;
    label: string;
    status: "ready" | "error";
    message: string;
  }>;
};

export type CliAIEntryReadiness = AIEntryReadiness;

export type AIChatRequest = {
  target: AIChatExecutionTarget;
  messages: AIChatMessage[];
  context: AIChatContextRequest;
  attachments?: AIChatAttachment[];
  modelBehavior?: AIModelBehavior;
};

export type AIChatResponse = {
  message: AIChatMessage;
  context: AIChatContext;
  status: AIConnectionStatus;
  run: AIChatRunSummary;
};

export type AIChatStreamEvent =
  | { type: "meta"; runId: string; context: AIChatContext; status?: AIConnectionStatus }
  | { type: "delta"; content: string }
  | { type: "done"; message: AIChatMessage; context: AIChatContext; status: AIConnectionStatus; run: AIChatRunSummary }
  | { type: "error"; error: string; details?: AIChatFailureDetails };
