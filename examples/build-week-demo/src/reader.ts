export type ReaderWorkspace = {
  mode: "local";
  writes: "disabled";
  visiblePanels: readonly ["tree", "reader", "outline"];
};

export type ReaderWorkspaceOptions = Pick<ReaderWorkspace, "mode" | "writes">;

export function createReaderWorkspace(
  options: ReaderWorkspaceOptions,
): ReaderWorkspace {
  return {
    ...options,
    visiblePanels: ["tree", "reader", "outline"],
  };
}
