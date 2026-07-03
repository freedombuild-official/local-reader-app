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

export type AIConnectionStatus = {
  state: "notConfigured" | "configured" | "ready" | "failed";
  message: string;
  checkedAt: string;
};

export type AIChatMessage = {
  role: "user" | "assistant";
  content: string;
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
};

export type AIChatResponse = {
  message: AIChatMessage;
  context: AIChatContext;
  status: AIConnectionStatus;
};
