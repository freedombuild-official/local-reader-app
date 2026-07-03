export type RepositoryConfig = {
  id: string;
  label: string;
  root: string;
  defaultPath?: string;
  excludes?: string[];
  fetchRemote?: boolean;
};

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

export type FileKind = "markdown" | "code" | "text" | "html" | "image" | "pdf" | "binary" | "unsupported";
export type FileViewerStatus = "displayable" | "unsupported" | "oversized" | "binary" | "metadata-only";
export type GitStatus = "new" | "changed" | "deleted";
export type DiffStatus = GitStatus | "binary";

export type GitStatusEntry = {
  path: string;
  status: GitStatus;
};

export type GitStatusResponse = {
  repoId: string;
  statuses: GitStatusEntry[];
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

export type FileResponse = {
  repoId: string;
  path: string;
  name: string;
  extension: string;
  kind: FileKind;
  content: string;
  lineCount: number;
  fileInfo: FileInformation;
  assetVersion?: string;
  gitDiff?: {
    status: DiffStatus;
    changedLines: number[];
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
  markdown?: {
    frontmatter: string;
    body: string;
    html: string;
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

export type HttpDeliverySessionStatus = {
  id: string;
  repoId: string;
  path: string;
  url: string;
  startedAt: string;
};

export type HttpDeliveryStatus = {
  state: "idle" | "running" | "error";
  sessions: HttpDeliverySessionStatus[];
  error?: string;
};
