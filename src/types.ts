export type RepoListItem = {
  id: string;
  label: string;
  root: string;
  defaultPath: string;
  exists: boolean;
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
  sync: RepoSyncStatus;
  tree: TreeSnapshot;
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

export type AIProviderSettings = {
  entry: AIProviderEntryKind;
  provider?: AIProviderName;
  runtime?: LocalAIRuntime;
  model: string;
  baseUrl: string;
  apiFormat: AIFormat;
  credential?: string;
};

export type CliAIEntrySettings = {
  entry: AICliEntryKind;
  binaryName: "codex" | "claude";
  version: string;
  authState: AICliAuthState;
  readOnlyWrapperState: AICliWrapperState;
  executionMode: "unknown" | "readOnly";
  lastCheckedAt?: string;
  readinessMessage?: string;
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

export type AIChatSessionState = {
  messages: AIChatMessage[];
  draft: string;
  pending: boolean;
  error: string;
  lastRequest: string;
  attachments: AIChatAttachment[];
};

export type AIChatContextRequest = {
  repoId: string;
  path: string;
  includeContent?: boolean;
};

export type AIChatContext = {
  repoId: string;
  path: string;
  fileName: string;
  fileKind: FileResponse["kind"];
  viewerStatus: FileInformation["viewerStatus"];
  lineCount: number;
  byteLength: number;
  contentIncluded: boolean;
  content: string;
};

export type AIChatExecutionTarget = { kind: "provider"; provider: AIProviderSettings } | { kind: "cli"; entry: AICliEntryKind };

export type CliAIEntryReadiness = {
  entry: AICliEntryKind;
  settings: CliAIEntrySettings;
  status: AIConnectionStatus;
  ready: boolean;
  checks: Array<{
    id: string;
    label: string;
    status: "ready" | "error";
    message: string;
  }>;
};

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
};

export type AIChatStreamEvent =
  | { type: "meta"; context: AIChatContext; status?: AIConnectionStatus }
  | { type: "delta"; content: string }
  | { type: "done"; message: AIChatMessage; context: AIChatContext; status: AIConnectionStatus }
  | { type: "error"; error: string };
