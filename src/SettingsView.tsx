import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, CheckCircle2, Settings as SettingsIcon, XCircle } from "lucide-react";
import {
  cancelAICliAuthentication,
  confirmAICliUpdate,
  fetchAIEntryReadiness,
  fetchRepositoryConfig,
  inspectAICliSetup,
  prepareAICliUpdate,
  previewRepositoryConfig,
  saveRepositoryConfig,
  startAICliAuthentication,
  validateRepositoryConfig,
} from "./api";
import {
  activeAIEntry,
  applyCliSetupSnapshot,
  applyCliSetupSnapshotAndBindSelection,
  aiModelBehavior,
  aiModelBehaviorCapability,
  aiConfigured,
  aiEntryCli,
  aiEntryProvider,
  aiEntrySettings,
  aiReady,
  derivedAIStatus,
  effectiveAIStatus,
  formatReaderFontScaleLabel,
  isCliEntryKind,
  isProviderEntryKind,
  normalizeAISettingsState,
  normalizeReaderFontScale,
  READER_FONT_SCALE_OPTIONS,
  updateAIEntry,
  updateAIEntryStatus,
  providerExecutionMode,
  updateAIModelBehavior,
  updateCliEntryReadiness,
  selectCliEffort,
  selectCliModel,
  selectCliSpeedMode,
  selectAIEntry,
  validCliModelSelection,
  type AISettingsState,
  type AIModelBehaviorCapability,
  type BasicSettings,
} from "./settingsState";
import type {
  AIConnectionStatus,
  AICliEntryKind,
  AICliModelSelection,
  AICliSetupSnapshot,
  AIEntryKind,
  AIEntrySettings,
  AIFormat,
  AIIntelligenceLevel,
  AIModelBehavior,
  AIProviderSettings,
  CliAIEntrySettings,
  RepositoryConfigEntryDraft,
  RepositoryConfigState,
  RepositoryConfigValidation,
} from "./types";

type SettingsCategory = "basic" | "repositories" | "aiChat";
type SaveState = "idle" | "dirty" | "saved" | "failed" | "pending";

type SettingsViewProps = {
  basicSettings: BasicSettings;
  aiSettings: AISettingsState;
  activeRepoId: string;
  activeRepoRevision: string;
  initialCategory?: SettingsCategory;
  basicSaveError: string;
  onBack: () => void;
  onBasicSettingsChange: (settings: BasicSettings) => void;
  onAISettingsChange: (settings: AISettingsState) => void;
  onRepositoriesChanged: () => Promise<void>;
};

const concealedInputType = "pass" + "word";

function normalizeExpandedRepoIndex(index: number | null, entries: RepositoryConfigEntryDraft[]): number | null {
  if (!entries.length) return null;
  if (index === null) return 0;
  return Math.min(Math.max(index, 0), entries.length - 1);
}

export function SettingsView({
  basicSettings,
  aiSettings,
  activeRepoId,
  activeRepoRevision,
  initialCategory = "basic",
  basicSaveError,
  onBack,
  onBasicSettingsChange,
  onAISettingsChange,
  onRepositoriesChanged,
}: SettingsViewProps) {
  const [category, setCategory] = useState<SettingsCategory>(initialCategory);
  const [basicDraft, setBasicDraft] = useState<BasicSettings>(basicSettings);
  const [aiDraft, setAiDraft] = useState<AISettingsState>(() => normalizeAISettingsState(aiSettings));
  const [repoState, setRepoState] = useState<RepositoryConfigState | null>(null);
  const [repoDraft, setRepoDraft] = useState<RepositoryConfigEntryDraft[]>([]);
  const [expandedRepoIndex, setExpandedRepoIndex] = useState<number | null>(null);
  const [repoValidation, setRepoValidation] = useState<RepositoryConfigValidation | null>(null);
  const [yamlPreview, setYamlPreview] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [repoSaveState, setRepoSaveState] = useState<SaveState>("idle");
  const [repoMessage, setRepoMessage] = useState("");
  const [testingEntry, setTestingEntry] = useState<AIEntryKind | null>(null);
  const aiDraftRef = useRef(aiDraft);
  const readinessGenerationRef = useRef(0);
  const activeRepoIdentityRef = useRef(`${activeRepoId}:${activeRepoRevision}`);

  useEffect(() => {
    setBasicDraft(basicSettings);
  }, [basicSettings]);

  useEffect(() => {
    const normalized = normalizeAISettingsState(aiSettings);
    aiDraftRef.current = normalized;
    setAiDraft(normalized);
  }, [aiSettings]);

  useEffect(() => {
    activeRepoIdentityRef.current = `${activeRepoId}:${activeRepoRevision}`;
    readinessGenerationRef.current += 1;
    setTestingEntry(null);
  }, [activeRepoId, activeRepoRevision]);

  useEffect(() => {
    setCategory(initialCategory);
  }, [initialCategory]);

  useEffect(() => {
    let canceled = false;
    async function load() {
      try {
        const nextState = await fetchRepositoryConfig();
        if (canceled) return;
        setRepoState(nextState);
        setRepoDraft(nextState.entries);
        setExpandedRepoIndex((current) => normalizeExpandedRepoIndex(current, nextState.entries));
        setRepoValidation(nextState.validation || null);
        setYamlPreview(nextState.yaml || "");
        setRepoSaveState("saved");
        setRepoMessage(nextState.parseError || "");
      } catch (error) {
        if (canceled) return;
        setRepoSaveState("failed");
        setRepoMessage(error instanceof Error ? error.message : String(error));
      }
    }
    void load();
    return () => {
      canceled = true;
    };
  }, []);

  const providerStatus = aiDraft.activeEntry ? effectiveAIStatus(aiDraft, aiDraft.activeEntry) : derivedAIStatus(null);
  const settingsTitle = category === "basic" ? "Basic Settings" : category === "repositories" ? "Repositories Settings" : "AI Chat Settings";
  const basicDirty = !sameJSON(basicDraft, basicSettings);
  const normalizedAISettings = normalizeAISettingsState(aiSettings);
  const aiDirty = !sameJSON(aiDraft, normalizedAISettings);
  const repoDirty = repoState ? !sameJSON(repoDraft, repoState.entries) : false;
  const globalStatus =
    category === "basic"
      ? basicSaveError ? "Save failed" : "Saved in this browser"
      : category === "repositories"
        ? saveStateLabel(repoSaveState)
        : "Browser run state";
  const globalMessage =
    category === "basic"
      ? basicSaveError || "Saved in this browser."
      : category === "repositories"
        ? repoMessage || "Repository config loaded."
        : aiDirty ? "AI settings changed in this browser run." : "AI settings are stored in this browser run only.";

  async function validateDraft() {
    setRepoSaveState("pending");
    setRepoMessage("Validating repository config...");
    try {
      const validation = await validateRepositoryConfig({ entries: repoDraft });
      setRepoValidation(validation);
      setRepoSaveState(validation.valid ? (repoDirty ? "dirty" : "saved") : "failed");
      setRepoMessage(validation.valid ? "Repository config is valid." : "Repository config needs changes.");
    } catch (error) {
      setRepoSaveState("failed");
      setRepoMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function refreshPreview() {
    setRepoSaveState("pending");
    setRepoMessage("Generating YAML preview...");
    try {
      const preview = await previewRepositoryConfig({ entries: repoDraft });
      setYamlPreview(preview.yaml);
      setRepoValidation(preview.validation);
      setPreviewOpen(true);
      setRepoSaveState(preview.validation.valid ? (repoDirty ? "dirty" : "saved") : "failed");
      setRepoMessage(preview.validation.valid ? "YAML preview is ready." : "YAML preview has validation errors.");
    } catch (error) {
      setRepoSaveState("failed");
      setRepoMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function saveRepositoryDraft() {
    setRepoSaveState("pending");
    setRepoMessage("Saving repository config...");
    try {
      const nextState = await saveRepositoryConfig({ entries: repoDraft, expectedConfigRevision: repoState?.configRevision });
      setRepoState(nextState);
      setRepoDraft(nextState.entries);
      setExpandedRepoIndex((current) => normalizeExpandedRepoIndex(current, nextState.entries));
      setRepoValidation(nextState.validation || null);
      setYamlPreview(nextState.yaml || "");
      setRepoSaveState("saved");
      setRepoMessage("Repository config saved.");
      await onRepositoriesChanged();
    } catch (error) {
      setRepoSaveState("failed");
      setRepoMessage(error instanceof Error ? error.message : String(error));
    }
  }

  function updateExpandedRepo(update: Partial<RepositoryConfigEntryDraft>) {
    if (expandedRepoIndex === null) return;
    setRepoDraft((current) => current.map((entry, index) => (index === expandedRepoIndex ? { ...entry, ...update } : entry)));
    setRepoSaveState("dirty");
    setRepoMessage("Unsaved repository config changes.");
  }

  function addRepository() {
    const nextEntry: RepositoryConfigEntryDraft = { id: "new-repo", label: "New repository", root: "", defaultPath: "README.md", excludes: [".git", "node_modules", "dist"], fetchRemote: false };
    setRepoDraft((current) => [...current, nextEntry]);
    setExpandedRepoIndex(repoDraft.length);
    setRepoSaveState("dirty");
    setRepoMessage("New repository draft added.");
  }

  function removeRepository(indexToRemove?: number) {
    const removeIndex = indexToRemove ?? expandedRepoIndex;
    if (removeIndex === null) return;
    const nextLength = Math.max(repoDraft.length - 1, 0);
    setRepoDraft((current) => current.filter((_, index) => index !== removeIndex));
    setExpandedRepoIndex((currentIndex) => {
      if (!nextLength) return null;
      if (currentIndex === null) return Math.min(removeIndex, nextLength - 1);
      if (removeIndex < currentIndex) return Math.max(0, currentIndex - 1);
      if (removeIndex === currentIndex) return Math.min(removeIndex, nextLength - 1);
      return Math.min(currentIndex, nextLength - 1);
    });
    setRepoSaveState("dirty");
    setRepoMessage("Repository entry removed from the draft list. The directory was not touched.");
  }

  async function testEntry(entry: AIEntryKind, settingsSnapshot?: AISettingsState) {
    const entryAtStart = entry;
    const repoIdentityAtStart = `${activeRepoId}:${activeRepoRevision}`;
    const requestGeneration = readinessGenerationRef.current + 1;
    readinessGenerationRef.current = requestGeneration;
    const settingsAtStart = settingsSnapshot ? normalizeAISettingsState(settingsSnapshot) : aiDraftRef.current;
    const providerFingerprint = isProviderEntryKind(entryAtStart) ? providerSettingsFingerprint(aiEntryProvider(settingsAtStart, entryAtStart)) : "";
    const selectionAtStart = isCliEntryKind(entryAtStart) ? validCliModelSelection(settingsAtStart, entryAtStart) : null;
    const selectionFingerprint = cliModelSelectionFingerprint(selectionAtStart);
    setTestingEntry(entry);
    try {
      const provider = isProviderEntryKind(entryAtStart) ? aiEntryProvider(settingsAtStart, entryAtStart) : undefined;
      const selection = selectionAtStart || undefined;
      const readiness = await fetchAIEntryReadiness(entryAtStart, provider, activeRepoId, activeRepoRevision, selection);
      if (readinessGenerationRef.current !== requestGeneration || activeRepoIdentityRef.current !== repoIdentityAtStart) return;
      commitAISettingsUpdate((current) => {
        if (isProviderEntryKind(entryAtStart) && providerSettingsFingerprint(aiEntryProvider(current, entryAtStart)) !== providerFingerprint) return current;
        if (isCliEntryKind(entryAtStart) && cliModelSelectionFingerprint(validCliModelSelection(current, entryAtStart)) !== selectionFingerprint) return current;
        return updateCliEntryReadiness(current, readiness);
      });
    } catch (error) {
      if (readinessGenerationRef.current !== requestGeneration || activeRepoIdentityRef.current !== repoIdentityAtStart) return;
      const failed: AIConnectionStatus = {
        state: "failed",
        code: "provider_http_error",
        severity: "error",
        message: "Readiness check failed.",
        nextAction: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      };
      commitAISettingsUpdate((current) => {
        if (isProviderEntryKind(entryAtStart) && providerSettingsFingerprint(aiEntryProvider(current, entryAtStart)) !== providerFingerprint) return current;
        if (isCliEntryKind(entryAtStart) && cliModelSelectionFingerprint(validCliModelSelection(current, entryAtStart)) !== selectionFingerprint) return current;
        return updateAIEntryStatus(current, entryAtStart, failed);
      });
    } finally {
      if (readinessGenerationRef.current === requestGeneration) {
        setTestingEntry((current) => (current === entryAtStart ? null : current));
      }
    }
  }

  function commitBasicSettings(settings: BasicSettings): BasicSettings {
    setBasicDraft(settings);
    onBasicSettingsChange(settings);
    return settings;
  }

  function commitAISettings(settings: AISettingsState): AISettingsState {
    const normalized = normalizeAISettingsState(settings);
    aiDraftRef.current = normalized;
    setAiDraft(normalized);
    onAISettingsChange(normalized);
    return normalized;
  }

  function commitAISettingsUpdate(updater: (settings: AISettingsState) => AISettingsState): AISettingsState {
    return commitAISettings(updater(aiDraftRef.current));
  }

  return (
    <main className="settings-shell" data-testid="settings-shell" data-color-mode={basicSettings.colorMode}>
      <aside className="settings-rail" aria-label="Settings navigation">
        <button type="button" className="settings-back-button" onClick={onBack}>
          <ArrowLeft aria-hidden="true" focusable="false" />
          <span>Back to viewer</span>
        </button>
        <div className="settings-heading">
          <span className="settings-mark" aria-hidden="true">
            <SettingsIcon />
          </span>
          <div>
            <p>Local Reader App</p>
            <h1>Settings</h1>
          </div>
        </div>
        <nav className="settings-category-nav" aria-label="Settings categories" role="tablist">
          {(["basic", "repositories", "aiChat"] as SettingsCategory[]).map((item) => (
            <button key={item} type="button" role="tab" aria-selected={category === item} className={category === item ? "active" : ""} onClick={() => setCategory(item)}>
              {item === "basic" ? "Basic" : item === "repositories" ? "Repositories" : "AI Chat"}
            </button>
          ))}
        </nav>
        <div className="settings-status-card">
          <span>Current category</span>
          <strong>{settingsTitle}</strong>
          <small>{categoryStatus(category, basicSaveError, basicDirty, repoSaveState, providerStatus, aiDirty)}</small>
          <span>Save state</span>
          <strong>{globalStatus}</strong>
          <small>{globalMessage}</small>
        </div>
      </aside>

      <section className="settings-main" aria-label={settingsTitle}>
        <header className="settings-header">
          <div>
            <p>Local Reader App Settings</p>
            <h2>{settingsTitle}</h2>
          </div>
          <div className="settings-header-actions">
            {category === "repositories" ? (
              <>
                <button type="button" className="secondary-button" onClick={() => void refreshPreview()}>
                  Preview YAML
                </button>
                <button type="button" className="primary-button" onClick={() => void saveRepositoryDraft()} disabled={!repoDirty || repoSaveState === "pending"}>
                  {repoSaveState === "pending" ? "Saving..." : "Save config"}
                </button>
              </>
            ) : null}
          </div>
        </header>

        {category === "basic" ? <BasicSettingsPanel settings={basicDraft} onChange={commitBasicSettings} /> : null}
        {category === "repositories" ? (
          <RepositoriesSettingsPanel
            repoState={repoState}
            repoDraft={repoDraft}
            expandedRepoIndex={expandedRepoIndex}
            validation={repoValidation}
            yamlPreview={yamlPreview}
            previewOpen={previewOpen}
            saveState={repoSaveState}
            message={repoMessage}
            onPreviewOpenChange={setPreviewOpen}
            onExpandedRepoChange={setExpandedRepoIndex}
            onUpdateExpandedRepo={updateExpandedRepo}
            onAddRepository={addRepository}
            onRemoveRepository={removeRepository}
            onValidate={() => void validateDraft()}
            onPreview={() => void refreshPreview()}
          />
        ) : null}
        {category === "aiChat" ? (
          <AIChatSettingsPanel
            settings={aiDraft}
            status={providerStatus}
            testingEntry={testingEntry}
            dirty={aiDirty}
            onChange={commitAISettings}
            onApplyCliSetup={(snapshot, bindSelection = false, preferredSelection = null) => commitAISettingsUpdate((current) => {
              if (!bindSelection) return applyCliSetupSnapshot(current, snapshot);
              const currentSelection = validCliModelSelection(current, snapshot.entry);
              return applyCliSetupSnapshotAndBindSelection(current, snapshot, currentSelection || preferredSelection);
            })}
            onTestEntry={testEntry}
          />
        ) : null}
      </section>
    </main>
  );
}

function BasicSettingsPanel({ settings, onChange }: { settings: BasicSettings; onChange: (settings: BasicSettings) => void }) {
  return (
    <section className="settings-page" aria-label="Basic settings">
      <SettingsCard title="Reader text scale" eyebrow="Font size" status={formatReaderFontScaleLabel(settings.readerFontScale)}>
        <SettingRow title="Adjust reader text density" description="Applies to markdown, text, code, and document reading surfaces in this browser.">
          <SegmentedControl
            label="Font size"
            value={String(settings.readerFontScale)}
            options={READER_FONT_SCALE_OPTIONS.map((scale): [string, string] => [String(scale), formatReaderFontScaleLabel(scale)])}
            onChange={(readerFontScale) => onChange({ ...settings, readerFontScale: normalizeReaderFontScale(readerFontScale) })}
          />
        </SettingRow>
      </SettingsCard>
      <SettingsCard title="Appearance" eyebrow="Color mode" status={settings.colorMode}>
        <SettingRow title="Choose the reader theme" description="Applies Light or Dark to the entire Local Reader App in this browser.">
          <SegmentedControl
            label="Color mode"
            value={settings.colorMode}
            options={[
              ["light", "Light"],
              ["dark", "Dark"],
            ]}
            onChange={(colorMode) => onChange({ ...settings, colorMode: colorMode as BasicSettings["colorMode"] })}
          />
        </SettingRow>
      </SettingsCard>
      <SettingsCard title="Workspace density" eyebrow="Reader layout" status={settings.layout}>
        <SettingRow title="Choose how much surrounding context stays visible" description="Compact widens navigation and side context, Comfortable balances panels, and Focused gives the reader more width.">
          <SegmentedControl
            label="Reader layout"
            value={settings.layout}
            options={[
              ["compact", "Compact"],
              ["comfortable", "Comfortable"],
              ["focused", "Focused"],
            ]}
            onChange={(layout) => onChange({ ...settings, layout: layout as BasicSettings["layout"] })}
          />
        </SettingRow>
      </SettingsCard>
    </section>
  );
}

function RepositoriesSettingsPanel({
  repoState,
  repoDraft,
  expandedRepoIndex,
  validation,
  yamlPreview,
  previewOpen,
  saveState,
  message,
  onPreviewOpenChange,
  onExpandedRepoChange,
  onUpdateExpandedRepo,
  onAddRepository,
  onRemoveRepository,
  onValidate,
  onPreview,
}: {
  repoState: RepositoryConfigState | null;
  repoDraft: RepositoryConfigEntryDraft[];
  expandedRepoIndex: number | null;
  validation: RepositoryConfigValidation | null;
  yamlPreview: string;
  previewOpen: boolean;
  saveState: SaveState;
  message: string;
  onPreviewOpenChange: (open: boolean) => void;
  onExpandedRepoChange: (index: number) => void;
  onUpdateExpandedRepo: (update: Partial<RepositoryConfigEntryDraft>) => void;
  onAddRepository: () => void;
  onRemoveRepository: (index?: number) => void;
  onValidate: () => void;
  onPreview: () => void;
}) {
  const checks = validation?.checks || [];
  const expandedEntryChecks = expandedRepoIndex === null ? [] : checks.filter((item) => item.id.startsWith(`entry:${expandedRepoIndex}:`));
  const configChecks = checks.filter((item) => !item.id.startsWith("entry:"));
  const validationIssues = checks.filter((item) => item.status !== "ready");
  const validationSummary = validation ? validation.valid ? "Ready" : `${validationIssues.length} issue${validationIssues.length === 1 ? "" : "s"}` : "Not validated";
  const statusMessageClass = repoState?.parseError || saveState === "failed" ? "error" : saveState === "pending" ? "warning" : saveState === "saved" ? "success" : "";
  const statusMessage = repoState?.parseError || message || "Repository config loaded.";
  return (
    <section className="settings-page repositories-page" aria-label="Repositories settings">
      <SettingsCard title="Repositories list" eyebrow="Registered Repositories" status={`${repoDraft.length} entries`}>
        <p className={`settings-message ${statusMessageClass}`}>{statusMessage}</p>
        <div className="repo-list" aria-label="Registered repositories">
          {repoDraft.map((repo, index) => {
            const expanded = index === expandedRepoIndex;
            const editorId = `repository-entry-${index}`;
            const editorLabel = `${repo.label || repo.id || "Repository"} repository entry`;
            return (
              <div key={index} className={`repo-list-row${expanded ? " active expanded" : ""}`}>
                <button
                  type="button"
                  className="repo-list-main"
                  aria-expanded={expanded}
                  aria-controls={expanded ? editorId : undefined}
                  onClick={() => onExpandedRepoChange(index)}
                >
                  <span className="repo-list-title">
                    <strong>{repo.label || "Untitled repository"}</strong>
                    <small>{repo.id || "missing-id"}</small>
                  </span>
                  <span className="repo-list-root">
                    <strong>Root</strong>
                    <small>{repo.root || "Missing root path"}</small>
                  </span>
                  <span className={`status-pill ${entryStatusClass(checks, index)}`}>{entryStatusLabel(checks, index)}</span>
                </button>
                {expanded ? (
                  <div id={editorId} className="repo-inline-editor" aria-label={editorLabel}>
                    <div className="repo-inline-editor-heading">
                      <div>
                        <span>Add / Edit Repository</span>
                        <h4>Repository entry</h4>
                      </div>
                      <span className="settings-badge">Editing {repo.id || "entry"}</span>
                    </div>
                    <div className="repo-form-grid">
                      <Field label="Repository ID" value={repo.id} onChange={(id) => onUpdateExpandedRepo({ id })} />
                      <Field label="Label" value={repo.label} onChange={(label) => onUpdateExpandedRepo({ label })} />
                      <Field label="Root absolute path" value={repo.root} onChange={(root) => onUpdateExpandedRepo({ root })} wide />
                      <details className="settings-details wide" aria-label="Advanced repository options">
                        <summary>Advanced repository options</summary>
                        <div className="repo-form-grid">
                          <Field label="Default path" value={repo.defaultPath} onChange={(defaultPath) => onUpdateExpandedRepo({ defaultPath })} />
                          <label className="settings-field wide">
                            <span>Excludes</span>
                            <textarea value={repo.excludes.join("\n")} rows={4} onChange={(event) => onUpdateExpandedRepo({ excludes: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} />
                          </label>
                          <div className="chip-list wide" aria-label="Exclude chips">
                            {repo.excludes.length ? repo.excludes.map((exclude) => <span key={exclude}>{exclude}</span>) : <span>No excludes configured</span>}
                          </div>
                          <label className="settings-toggle wide">
                            <input type="checkbox" checked={false} disabled />
                            <span>Remote Git fetch (disabled in the public build)</span>
                          </label>
                          {repo.fetchRemote ? <p className="settings-message warning wide">This config requests remote fetch, but the public execution policy will not run it.</p> : null}
                        </div>
                      </details>
                    </div>
                    <div className="repo-inline-actions">
                      <button type="button" className="danger-button" onClick={() => onRemoveRepository(index)}>
                        Remove from list
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="settings-action-row">
          <button type="button" className="secondary-button" onClick={onAddRepository}>
            Add repository
          </button>
        </div>
        <p className="settings-message">Remove from list only edits the config draft. Local Reader App does not delete repository directories.</p>
      </SettingsCard>

      <details className="settings-details" aria-label="Config details">
        <summary>Config details</summary>
        <div className="settings-summary-grid">
          <SummaryItem label="Config file" value={repoState?.configPath || "Loading..."} />
          <SummaryItem label="Source mode" value={repoState?.sourceMode === "env" ? "LOCAL_READER_APP_CONFIG" : "Default repositories.yaml"} />
          <SummaryItem label="Write access" value={repoState?.writable ? "Writable" : "Not writable"} />
          <SummaryItem label="Last validation" value={validation?.valid ? "Ready" : "Needs review"} />
        </div>
        {repoState?.parseError ? <p className="settings-message error">{repoState.parseError}</p> : null}
        <p className={`settings-message ${statusMessageClass}`}>{statusMessage}</p>
      </details>

      <details className="settings-details" aria-label="Validation details">
        <summary>Validation details</summary>
        <div className="setting-row inline-row">
          <div>
            <span>Validation status</span>
            <strong>{validationSummary}</strong>
            <small>{validationIssues[0]?.message || (validation?.valid ? "Repository config is valid." : "Run validation to see repository config checks.")}</small>
          </div>
          <button type="button" className="secondary-button" onClick={onValidate}>
            Validate config
          </button>
        </div>
        <div className="subsection-title">Repository entry checks</div>
        <div className="validation-list">
          {expandedEntryChecks.length ? expandedEntryChecks.map((item) => <ValidationRow key={item.id} item={item} />) : <p className="settings-message">Run validation to see entry checks.</p>}
        </div>
        <div className="subsection-title">Config checks</div>
        <div className="validation-list">
          {configChecks.length ? configChecks.map((item) => <ValidationRow key={item.id} item={item} />) : <p className="settings-message">Run validation to see config checks.</p>}
        </div>
      </details>

      <details className="settings-details" aria-label="YAML preview" open={previewOpen} onToggle={(event) => onPreviewOpenChange(event.currentTarget.open)}>
        <summary>YAML preview</summary>
        {yamlPreview ? (
          <pre className="yaml-preview" aria-label="Generated YAML preview">
            <code>{yamlPreview}</code>
          </pre>
        ) : (
          <p className="settings-message">Generate a YAML preview to inspect the saved shape before writing config.</p>
        )}
      </details>
    </section>
  );
}

function AIChatSettingsPanel({
  settings,
  status,
  testingEntry,
  dirty,
  onChange,
  onApplyCliSetup,
  onTestEntry,
}: {
  settings: AISettingsState;
  status: AIConnectionStatus;
  testingEntry: AIEntryKind | null;
  dirty: boolean;
  onChange: (settings: AISettingsState) => AISettingsState;
  onApplyCliSetup: (
    snapshot: AICliSetupSnapshot,
    bindSelection?: boolean,
    preferredSelection?: AICliModelSelection | null,
  ) => AISettingsState;
  onTestEntry: (entry: AIEntryKind, settingsSnapshot?: AISettingsState) => Promise<void>;
}) {
  const [setupAction, setSetupAction] = useState("");
  const [setupError, setSetupError] = useState("");
  const updatePreferredSelectionRef = useRef<Record<AICliEntryKind, AICliModelSelection | null>>({ codexCli: null, claudeCli: null });
  const activeEntrySettings = activeAIEntry(settings);
  const activeEntry = settings.activeEntry;
  const activeCliSnapshot = isCliEntryKind(activeEntry) ? settings.cliSetupByEntry[activeEntry] : null;
  const configured = aiConfigured(activeEntrySettings);
  const entries = ["codexCli", "claudeCli", "aiApi", "localAi"] as AIEntryKind[];
  const activeSetupTitle = isCliEntryKind(activeEntry) ? "CLI Readiness" : "Connection / Credentials";
  const behavior = activeEntry ? aiModelBehavior(settings, activeEntry) : { kind: "none" } as AIModelBehavior;
  const behaviorCapability = activeEntry ? aiModelBehaviorCapability(settings, activeEntry) : null;

  async function setActiveEntry(entry: AIEntryKind) {
    if (!isCliEntryKind(entry)) return;
    const selected = onChange(selectAIEntry(settings, entry));
    await runSetupAction(entry, "inspect", selected.cliModelSelectionByEntry[entry]);
  }

  function clearActiveEntry() {
    onChange(selectAIEntry(settings, null));
  }

  function updateEntry(entry: AIEntryKind, update: Partial<AIEntrySettings>) {
    onChange(updateAIEntry(settings, entry, update));
  }

  function updateBehavior(entry: AIEntryKind, nextBehavior: AIModelBehavior) {
    onChange(updateAIModelBehavior(settings, entry, nextBehavior));
  }

  async function runSetupAction(
    entry: AICliEntryKind,
    action: "inspect" | "signIn" | "cancel" | "prepareUpdate" | "confirmUpdate",
    preferredSelection = settings.cliModelSelectionByEntry[entry],
  ) {
    const actionKey = `${entry}:${action}`;
    setSetupAction(actionKey);
    setSetupError("");
    try {
      const current = settings.cliSetupByEntry[entry];
      if (action === "prepareUpdate") {
        updatePreferredSelectionRef.current[entry] = preferredSelection;
      }
      let snapshot: AICliSetupSnapshot;
      if (action === "inspect") snapshot = await inspectAICliSetup(entry);
      else if (action === "signIn") snapshot = await startAICliAuthentication(entry);
      else if (action === "cancel") snapshot = await cancelAICliAuthentication(entry);
      else if (action === "prepareUpdate") snapshot = await prepareAICliUpdate(entry);
      else {
        const nonce = current?.update.nonce || "";
        const updateKind = current?.update.kind || "compatibility";
        if (!nonce) throw new Error("The update confirmation expired. Prepare the managed CLI update again.");
        const confirmed = window.confirm(updateKind === "latest"
          ? `Run the managed CLI updater for ${entryLabel(entry)}? It will check for and apply a newer release if available, using only the fixed server-side update command.`
          : `Install the compatibility update for ${entryLabel(entry)}? Local Reader App will use only its fixed server-side update command.`);
        if (!confirmed) return;
        snapshot = await confirmAICliUpdate(entry, nonce);
      }
      const shouldBindAndTest = action === "inspect" || action === "confirmUpdate";
      const selectionToRebind = action === "confirmUpdate"
        ? updatePreferredSelectionRef.current[entry]
        : preferredSelection || updatePreferredSelectionRef.current[entry];
      const applied = onApplyCliSetup(snapshot, shouldBindAndTest, selectionToRebind);
      if (shouldBindAndTest) {
        updatePreferredSelectionRef.current[entry] = null;
        if (applied.activeEntry === entry && validCliModelSelection(applied, entry)) {
          await onTestEntry(entry, applied);
        }
      }
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error));
    } finally {
      setSetupAction("");
    }
  }

  return (
    <section className="settings-page ai-settings-page" aria-label="AI Chat settings">
      <SettingsCard title="AI Entry" eyebrow="Active entry" status={activeEntry ? entryLabel(activeEntry) : "No active AI Entry"}>
        <div className="active-entry-summary">
          <span>Active AI Entry</span>
          <strong>{activeEntry ? entryLabel(activeEntry) : "No active AI Entry"}</strong>
          <small>{activeEntry ? "This entry is selected for AI Chat. Readiness and connection details are shown below." : "Choose one entry before checking readiness or sending AI Chat."}</small>
          {dirty ? <small>AI Chat settings have unsaved changes.</small> : null}
        </div>
        <div className="entry-grid" aria-label="AI Entry choices">
          {entries.map((entry) => (
            <AIEntryCard
              key={entry}
              entry={entry}
              settings={aiEntrySettings(settings, entry)}
              status={effectiveAIStatus(settings, entry)}
              active={settings.activeEntry === entry}
              available={isCliEntryKind(entry)}
              onSetActive={() => void setActiveEntry(entry)}
              onClearActive={clearActiveEntry}
            />
          ))}
        </div>
      </SettingsCard>
      {activeEntry ? (
        <SettingsCard title={activeSetupTitle} eyebrow={entryLabel(activeEntry)} status={aiEntryStatusLabel(activeEntry, status)}>
          {activeEntry === "codexCli" ? (
            <AuthenticationEntryCard
              entry="codexCli"
              title={entryLabel("codexCli")}
              subtitle="Current repo execution boundary"
              note="Verifies the CLI runtime and Current repo-only execution boundary. Sign-in, compatibility, model, effort, and speed are managed and revalidated through Authentication and model below."
              configured={configured}
              lastCheckedAt={settings.lastCheckedAtByEntry.codexCli}
              status={effectiveAIStatus(settings, "codexCli")}
              labelKind="readiness"
              statusLabelText={cliStatusLabel(effectiveAIStatus(settings, "codexCli"))}
              showStatusMessages={false}
              detailsChildren={<CliReadinessDetails entry={aiEntryCli(settings, "codexCli")} />}
            >
              <CliAIForm
                entry={aiEntryCli(settings, "codexCli")}
                status={effectiveAIStatus(settings, "codexCli")}
                testing={testingEntry === "codexCli"}
                selectionReady={Boolean(validCliModelSelection(settings, "codexCli"))}
                onTest={() => onTestEntry("codexCli")}
              />
            </AuthenticationEntryCard>
          ) : null}
          {activeEntry === "claudeCli" ? (
            <AuthenticationEntryCard
              entry="claudeCli"
              title={entryLabel("claudeCli")}
              subtitle="Current repo execution boundary"
              note="Verifies the CLI runtime and Current repo-only execution boundary. Sign-in, compatibility, model, effort, and speed are managed and revalidated through Authentication and model below."
              configured={configured}
              lastCheckedAt={settings.lastCheckedAtByEntry.claudeCli}
              status={effectiveAIStatus(settings, "claudeCli")}
              labelKind="readiness"
              statusLabelText={cliStatusLabel(effectiveAIStatus(settings, "claudeCli"))}
              showStatusMessages={false}
              detailsChildren={<CliReadinessDetails entry={aiEntryCli(settings, "claudeCli")} />}
            >
              <CliAIForm
                entry={aiEntryCli(settings, "claudeCli")}
                status={effectiveAIStatus(settings, "claudeCli")}
                testing={testingEntry === "claudeCli"}
                selectionReady={Boolean(validCliModelSelection(settings, "claudeCli"))}
                onTest={() => onTestEntry("claudeCli")}
              />
            </AuthenticationEntryCard>
          ) : null}
          {activeEntry === "aiApi" ? (
            <AuthenticationEntryCard
              entry="aiApi"
              title="AI API"
              subtitle="Direct context or server-validated repo access"
              note="Context-only calls the configured HTTPS provider directly. Current repo write gives the model no shell or filesystem access: Local Reader App mediates bounded reads and applies only strict, validated multi-file text operations."
              configured={configured}
              lastCheckedAt={settings.lastCheckedAtByEntry.aiApi}
              status={effectiveAIStatus(settings, "aiApi")}
              labelKind="connection"
            >
              <AIAPIForm
                provider={aiEntryProvider(settings, "aiApi")}
                status={effectiveAIStatus(settings, "aiApi")}
                testing={testingEntry === "aiApi"}
                onUpdate={(update) => updateEntry("aiApi", update)}
                onClearCredential={() => updateEntry("aiApi", { credential: "" })}
                onTest={() => onTestEntry("aiApi")}
              />
            </AuthenticationEntryCard>
          ) : null}
          {activeEntry === "localAi" ? (
            <AuthenticationEntryCard
              entry="localAi"
              title="Local AI"
              subtitle="Direct context or server-validated local repo access"
              note="Context-only calls the loopback endpoint directly. Current repo write uses the same strict Local Reader App read/edit protocol without starting runtimes, loading models, or giving the model shell access."
              configured={configured}
              lastCheckedAt={settings.lastCheckedAtByEntry.localAi}
              status={effectiveAIStatus(settings, "localAi")}
              labelKind="connection"
            >
              <LocalAIForm
                provider={aiEntryProvider(settings, "localAi")}
                status={effectiveAIStatus(settings, "localAi")}
                testing={testingEntry === "localAi"}
                onUpdate={(update) => updateEntry("localAi", update)}
                onClearCredential={() => updateEntry("localAi", { credential: "" })}
                onTest={() => onTestEntry("localAi")}
              />
            </AuthenticationEntryCard>
          ) : null}
          {isProviderEntryKind(activeEntry) ? <p className="settings-message">Provider credentials stay in the current browser run and are never written to repository config or browser persistent storage.</p> : null}
        </SettingsCard>
      ) : null}
      {activeEntry && behaviorCapability ? (
        <SettingsCard
          title={isCliEntryKind(activeEntry) ? "Authentication and model" : "Model behavior"}
          eyebrow={entryLabel(activeEntry)}
          status={isCliEntryKind(activeEntry) ? cliSetupStatus(settings.cliSetupByEntry[activeEntry]) : modelBehaviorStatus(behavior)}
        >
          {isCliEntryKind(activeEntry) ? (
            <CliAuthenticationAndModel
              entry={activeEntry}
              settings={settings}
              pendingAction={setupAction.startsWith(`${activeEntry}:`) ? setupAction.split(":")[1] : ""}
              actionError={setupError}
              onInspect={() => void runSetupAction(activeEntry, "inspect")}
              onSignIn={() => void runSetupAction(activeEntry, "signIn")}
              onCancelSignIn={() => void runSetupAction(activeEntry, "cancel")}
              onPrepareUpdate={() => void runSetupAction(activeEntry, "prepareUpdate")}
              onConfirmUpdate={() => void runSetupAction(activeEntry, "confirmUpdate")}
              onModelChange={(model) => onChange(selectCliModel(settings, activeEntry, model))}
              onEffortChange={(effort) => onChange(selectCliEffort(settings, activeEntry, effort))}
              onSpeedModeChange={(speedMode) => onChange(selectCliSpeedMode(settings, activeEntry, speedMode))}
            />
          ) : (
            <ModelBehaviorSettings
              entry={activeEntry}
              entrySettings={aiEntrySettings(settings, activeEntry)}
              capability={behaviorCapability}
              behavior={behavior}
              onChange={(nextBehavior) => updateBehavior(activeEntry, nextBehavior)}
            />
          )}
        </SettingsCard>
      ) : null}
    </section>
  );
}

function CliAuthenticationAndModel({
  entry,
  settings,
  pendingAction,
  actionError,
  onInspect,
  onSignIn,
  onCancelSignIn,
  onPrepareUpdate,
  onConfirmUpdate,
  onModelChange,
  onEffortChange,
  onSpeedModeChange,
}: {
  entry: AICliEntryKind;
  settings: AISettingsState;
  pendingAction: string;
  actionError: string;
  onInspect: () => void;
  onSignIn: () => void;
  onCancelSignIn: () => void;
  onPrepareUpdate: () => void;
  onConfirmUpdate: () => void;
  onModelChange: (model: string) => void;
  onEffortChange: (effort: string) => void;
  onSpeedModeChange: (speedMode: string) => void;
}) {
  const snapshot = settings.cliSetupByEntry[entry];
  const selection = validCliModelSelection(settings, entry);
  const catalog = snapshot?.catalog;
  const selectedModel = catalog?.models.find((model) => model.id === selection?.model);
  const busy = Boolean(pendingAction);
  const authenticationWaiting = snapshot?.authentication.state === "waiting" || snapshot?.phase === "authenticating";
  const authenticationCanStart = snapshot?.phase === "loginRequired" || snapshot?.authentication.state === "failed";
  const updateConfirmationReady = snapshot?.update.state === "confirmationRequired" && Boolean(snapshot.update.nonce);
  const latestUpdateSupported = snapshot?.phase === "ready"
    && snapshot.compatibility === "compatible"
    && snapshot.managedUpdateSupported === true;
  const compatibilityUpdateAction = snapshot?.compatibility === "updateRequired"
    || (updateConfirmationReady && snapshot?.update.kind === "compatibility");
  const latestUpdate = !compatibilityUpdateAction;
  const modelSelectionEnabled = snapshot?.phase === "ready" && Boolean(catalog?.models.length) && !updateConfirmationReady;

  return (
    <div className="model-behavior-panel cli-auth-model-panel" aria-label={`${entryLabel(entry)} authentication and model settings`}>
      <div className="setting-row inline-row cli-setup-summary">
        <div>
          <span>CLI status</span>
          <strong>{cliSetupStatus(snapshot)}</strong>
          <small>{snapshot?.message || "Inspect the installed CLI to load authentication and model availability."}</small>
        </div>
        <button type="button" className="secondary-button" onClick={onInspect} disabled={busy}>
          {pendingAction === "inspect" ? "Checking..." : "Check again"}
        </button>
      </div>

      <div className="settings-summary-grid cli-setup-facts" aria-label={`${entryLabel(entry)} setup summary`}>
        <SummaryItem label="Version" value={snapshot?.cliVersion || "Not checked"} />
        <SummaryItem label="Authentication" value={cliAuthenticationLabel(snapshot)} />
        <SummaryItem label="Compatibility" value={cliCompatibilityLabel(snapshot)} />
        <SummaryItem label="Catalog" value={catalog ? `${catalog.models.length} model${catalog.models.length === 1 ? "" : "s"}` : "Not loaded"} />
      </div>

      {snapshot?.foundationOnly ? (
        <p className="settings-message warning">
          Claude Code support is foundation-only in this validation environment. No live Claude authentication or model request was used to verify this build.
        </p>
      ) : null}

      <div className="setting-row inline-row cli-auth-actions">
        <div>
          <span>Authentication</span>
          <strong>{cliAuthenticationLabel(snapshot)}</strong>
          <small>{snapshot?.authentication.message || "Authentication is owned by the installed CLI and is never stored in repository config."}</small>
        </div>
        {authenticationWaiting ? (
          <button type="button" className="secondary-button" onClick={onCancelSignIn} disabled={busy}>
            {pendingAction === "cancel" ? "Canceling..." : "Cancel sign-in"}
          </button>
        ) : authenticationCanStart ? (
          <button type="button" className="secondary-button" onClick={onSignIn} disabled={busy || !snapshot || snapshot.phase === "notInstalled"}>
            {pendingAction === "signIn" ? "Starting..." : "Sign in"}
          </button>
        ) : null}
      </div>

      {snapshot?.authentication.verificationUrl || snapshot?.authentication.userCode ? (
        <div className="cli-auth-challenge" aria-label={`${entryLabel(entry)} sign-in instructions`}>
          {snapshot.authentication.userCode ? (
            <div>
              <span>Verification code</span>
              <strong>{snapshot.authentication.userCode}</strong>
            </div>
          ) : null}
          {snapshot.authentication.verificationUrl ? (
            <a href={snapshot.authentication.verificationUrl} target="_blank" rel="noreferrer">
              Open sign-in page
            </a>
          ) : null}
        </div>
      ) : null}

      {snapshot?.compatibility === "updateRequired" || updateConfirmationReady || latestUpdateSupported ? (
        <div className="setting-row inline-row cli-update-actions">
          <div>
            <span>{latestUpdate ? "CLI release update" : "Compatibility update"}</span>
            <strong>{updateConfirmationReady
              ? "Confirmation required"
              : latestUpdate && snapshot?.update.state === "succeeded"
                ? "Updater completed"
                : latestUpdate
                  ? "Explicit action only"
                  : "Update required"}</strong>
            <small>{snapshot?.update.message || (latestUpdate
              ? "The CLI has no availability-only check. After confirmation, its fixed updater checks for and applies a newer release if one is available."
              : "Only a server-owned compatibility update command can run. Custom executables remain manual.")}</small>
          </div>
          <button
            type="button"
            className={updateConfirmationReady ? "primary-button" : "secondary-button"}
            onClick={updateConfirmationReady ? onConfirmUpdate : onPrepareUpdate}
            disabled={busy}
          >
            {pendingAction === "prepareUpdate"
              ? "Preparing..."
              : pendingAction === "confirmUpdate"
                ? "Updating..."
                : updateConfirmationReady
                  ? latestUpdate ? "Run managed updater" : "Install compatible update"
                  : latestUpdate ? "Check and apply latest" : "Prepare compatibility update"}
          </button>
        </div>
      ) : snapshot?.compatibility === "unmanaged" ? (
        <p className="settings-message warning">This executable is not managed by Local Reader App. Update it with its original package manager, then check again.</p>
      ) : null}

      <div className="cli-model-grid">
        <label className="settings-field">
          <span>Model</span>
          <select
            aria-label={`${entryLabel(entry)} model`}
            value={selection?.model || ""}
            disabled={!modelSelectionEnabled || busy}
            onChange={(event) => onModelChange(event.target.value)}
          >
            <option value="">Select a model</option>
            {(catalog?.models || []).map((model) => (
              <option key={model.id} value={model.id}>{model.label}</option>
            ))}
          </select>
          <small>{selectedModel?.description || "Models come from the authenticated CLI catalog. No fixed fallback is used."}</small>
        </label>
        <label className="settings-field">
          <span>Reasoning effort</span>
          <select
            aria-label={`${entryLabel(entry)} reasoning effort`}
            value={selection?.effort || ""}
            disabled={!selection || !selectedModel || busy}
            onChange={(event) => onEffortChange(event.target.value)}
          >
            <option value="">Select an effort</option>
            {(selectedModel?.efforts || []).map((effort) => (
              <option key={effort.id} value={effort.id}>{effort.label}</option>
            ))}
          </select>
          <small>{selectedModel ? "Only effort levels advertised for this model are enabled, including previously unknown levels." : "Select a model to see its supported effort levels."}</small>
        </label>
        <label className="settings-field">
          <span>Inference speed</span>
          <select
            aria-label={`${entryLabel(entry)} inference speed`}
            value={selection?.speedMode || ""}
            disabled={!selection || !selectedModel || busy}
            onChange={(event) => onSpeedModeChange(event.target.value)}
          >
            <option value="">Select a speed</option>
            {(selectedModel?.speedModes || []).map((speedMode) => (
              <option key={speedMode.id} value={speedMode.id}>{speedMode.label}</option>
            ))}
          </select>
          <small>{selectedModel?.speedModes.some((speedMode) => speedMode.id === "fast")
            ? "Standard uses the regular service tier. Fast is model-dependent and may consume usage at a higher rate."
            : "This model currently advertises Standard speed only."}</small>
        </label>
      </div>

      {!selection ? <p className="settings-message warning">Select a valid model, effort, and inference speed. If CLI Readiness is not already verified, run it before using AI Chat.</p> : null}
      {selection ? <p className="settings-message success">Selected for new requests: {selectedModel?.label || selection.model} / {selectedModel?.efforts.find((effort) => effort.id === selection.effort)?.label || selection.effort} / {selectedModel?.speedModes.find((speedMode) => speedMode.id === selection.speedMode)?.label || selection.speedMode}</p> : null}
      {actionError ? <p className="settings-message error" role="alert">{actionError}</p> : null}
    </div>
  );
}

function ModelBehaviorSettings({
  entry,
  entrySettings,
  capability,
  behavior,
  onChange,
}: {
  entry: AIEntryKind;
  entrySettings: AIEntrySettings;
  capability: AIModelBehaviorCapability;
  behavior: AIModelBehavior;
  onChange: (behavior: AIModelBehavior) => void;
}) {
  const model = "model" in entrySettings ? entrySettings.model || "No model selected" : entrySettings.binaryName;
  return (
    <div className="model-behavior-panel" aria-label="Model behavior settings">
      <div className="setting-row inline-row">
        <div>
          <span>Active model</span>
          <strong>{model}</strong>
          <small>{capability.description}</small>
        </div>
        <span className="status-pill active">{entryLabel(entry)}</span>
      </div>
      {capability.kind === "intelligence" && behavior.kind === "intelligence" ? (
        <SettingRow title={capability.label} description="Applies to new AI Chat requests from this browser session.">
          <SegmentedControl
            label={capability.label}
            value={behavior.level}
            options={capability.levels.map((level) => [level, intelligenceLabel(level)] as [string, string])}
            onChange={(level) => onChange({ kind: "intelligence", level: level as AIIntelligenceLevel })}
          />
        </SettingRow>
      ) : null}
      {capability.kind === "thinking" && behavior.kind === "thinking" ? (
        <label className="settings-toggle detailed">
          <input type="checkbox" checked={behavior.enabled} onChange={(event) => onChange({ kind: "thinking", enabled: event.target.checked })} />
          <span>Thinking mode</span>
          <small>Used only when the active endpoint supports Qwen-style thinking control.</small>
        </label>
      ) : null}
      {capability.kind === "none" ? <p className="settings-message">Local Reader App will use the active model default for this entry.</p> : null}
    </div>
  );
}

function AuthenticationEntryCard({
  entry,
  title,
  subtitle,
  note,
  configured,
  lastCheckedAt,
  status,
  children,
  labelKind = "connection",
  statusLabelText,
  showStatusMessages = true,
  detailsChildren,
}: {
  entry: AIEntryKind;
  title: string;
  subtitle: string;
  note: string;
  configured: boolean;
  lastCheckedAt: string;
  status: AIConnectionStatus;
  children: ReactNode;
  labelKind?: "connection" | "readiness";
  statusLabelText?: string;
  showStatusMessages?: boolean;
  detailsChildren?: ReactNode;
}) {
  const cliEntry = isCliEntryKind(entry);
  const checklistLabel = cliEntry ? "Readiness checklist" : "Readiness checklist";
  return (
    <article className="auth-entry-card active" aria-label={`${title} ${labelKind}`}>
      <div className="auth-card-heading">
        <span className="entry-icon" aria-hidden="true">
          {entryIcon(entry)}
        </span>
        <div>
          <span>{title}</span>
          <h4>{subtitle}</h4>
        </div>
        <span className={`status-pill ${statusClass(status) || "active"}`}>{statusLabelText || statusLabel(status)}</span>
      </div>
      <p className="auth-card-note">{note}</p>
      {children}
      {showStatusMessages ? <p className={`settings-message ${statusClass(status)}`}>{status.message}</p> : null}
      {showStatusMessages && status.nextAction ? <p className="settings-message">{status.nextAction}</p> : null}
      <details className="readiness-details" aria-label={`${title} readiness details`}>
        <summary>Details</summary>
        <div className="readiness-list" aria-label={checklistLabel}>
          {cliEntry ? (
            <>
              {detailsChildren}
              <ReadinessRow label="Last check" status={lastCheckedAt ? "ready" : "warning"} value={formatLastCheck(lastCheckedAt)} />
            </>
          ) : (
            <>
              <ReadinessRow label="Active entry" status="ready" value={title} />
              <ReadinessRow label="Connection fields" status={configured ? "ready" : "warning"} value={configured ? "Configured" : "Incomplete"} />
              <ReadinessRow label="Endpoint / model check" status={readinessRowStatus(status)} value={statusLabelText || statusLabel(status)} detail={status.message} />
              <ReadinessRow
                label="Provider access policy"
                status={readinessRowStatus(status)}
                value={status.state === "ready" ? "Ready" : "Not ready"}
                detail={status.state === "ready" ? "Local Reader App will enforce the access policy selected for this provider entry." : "Complete the endpoint, model, and access policy check before AI Chat is enabled."}
              />
              <ReadinessRow label="Next action" status={readinessRowStatus(status)} value={status.nextAction || "No action available"} />
              <ReadinessRow label="Last check" status={lastCheckedAt ? "ready" : "warning"} value={formatLastCheck(lastCheckedAt)} />
              {detailsChildren}
            </>
          )}
        </div>
      </details>
    </article>
  );
}

function AIAPIForm({
  provider,
  status,
  testing,
  onUpdate,
  onClearCredential,
  onTest,
}: {
  provider: AIProviderSettings;
  status: AIConnectionStatus;
  testing: boolean;
  onUpdate: (update: Partial<AIProviderSettings>) => void;
  onClearCredential: () => void;
  onTest: () => void;
}) {
  const needsEndpoint = provider.provider === "openaiCompatible" || provider.provider === "custom";
  return (
    <div className="provider-form-grid auth-form-grid">
      <label className="settings-field">
        <span>Provider</span>
        <select value={provider.provider} onChange={(event) => onUpdate({ ...providerDefaults(event.target.value), credential: provider.credential || "" })}>
          <option value="openai">OpenAI</option>
          <option value="anthropic">Anthropic</option>
          <option value="google">Google</option>
          <option value="openaiCompatible">OpenAI-compatible</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      <label className="settings-field">
        <span>API key</span>
        <input type={concealedInputType} value={provider.credential || ""} autoComplete="off" onChange={(event) => onUpdate({ credential: event.target.value })} />
      </label>
      <Field label="Model" value={provider.model} onChange={(model) => onUpdate({ model })} />
      <ProviderAccessModeControl provider={provider} onUpdate={onUpdate} />
      {provider.credential?.trim() ? (
        <div className="setting-row inline-row wide">
          <div>
            <span>Saved for this browser run</span>
            <strong>{credentialMask(provider)}</strong>
          </div>
          <button type="button" className="danger-button" onClick={onClearCredential}>
            Clear key
          </button>
        </div>
      ) : null}
      {needsEndpoint ? (
        <div className="endpoint-settings-panel wide">
          <div className="endpoint-settings-heading">
            <span>Endpoint settings</span>
            <small>Required for OpenAI-compatible and Custom providers.</small>
          </div>
          <Field label="Base URL" value={provider.baseUrl} onChange={(baseUrl) => onUpdate({ baseUrl })} wide />
          <label className="settings-field">
            <span>API format</span>
            <select value={provider.apiFormat} onChange={(event) => onUpdate({ apiFormat: event.target.value as AIFormat })}>
              <option value="openaiCompatible">OpenAI-compatible</option>
              <option value="anthropic">Anthropic</option>
              <option value="google">Google</option>
              <option value="custom">Custom</option>
            </select>
          </label>
        </div>
      ) : null}
      <div className="setting-row inline-row wide">
        <div>
          <span>Readiness</span>
          <strong>{statusLabel(status)}</strong>
          <small>{connectionHint(provider, status)}</small>
        </div>
        <button type="button" className={status.state === "ready" ? "success-button" : "secondary-button"} onClick={onTest} disabled={testing || !aiReady(provider)}>
          {status.state === "ready" ? <CheckCircle2 aria-hidden="true" focusable="false" /> : null}
          {testing ? "Checking..." : status.state === "ready" ? "Check again" : "Check readiness"}
        </button>
      </div>
    </div>
  );
}

function LocalAIForm({
  provider,
  status,
  testing,
  onUpdate,
  onClearCredential,
  onTest,
}: {
  provider: AIProviderSettings;
  status: AIConnectionStatus;
  testing: boolean;
  onUpdate: (update: Partial<AIProviderSettings>) => void;
  onClearCredential: () => void;
  onTest: () => void;
}) {
  return (
    <div className="provider-form-grid auth-form-grid">
      <label className="settings-field">
        <span>Runtime</span>
        <select value={provider.runtime} onChange={(event) => onUpdate({ ...localDefaults(event.target.value), credential: provider.credential || "" })}>
          <option value="ollama">Ollama</option>
          <option value="lmStudio">LM Studio</option>
          <option value="openaiLocal">OpenAI-compatible local server</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      <ProviderAccessModeControl provider={provider} onUpdate={onUpdate} />
      <Field label="Local endpoint" value={provider.baseUrl} onChange={(baseUrl) => onUpdate({ baseUrl })} wide />
      <Field label="Model" value={provider.model} onChange={(model) => onUpdate({ model })} />
      <label className="settings-field">
        <span>{`Optional ${localAccessName()}`}</span>
        <input type={concealedInputType} value={provider.credential || ""} autoComplete="off" onChange={(event) => onUpdate({ credential: event.target.value })} />
      </label>
      <label className="settings-field">
        <span>API format</span>
        <select value={provider.apiFormat} onChange={(event) => onUpdate({ apiFormat: event.target.value as AIFormat })}>
          <option value="openaiCompatible">OpenAI-compatible</option>
          <option value="custom">Custom</option>
        </select>
      </label>
      {provider.credential?.trim() ? (
        <div className="setting-row inline-row wide">
          <div>
            <span>{`Saved for this browser run`}</span>
            <strong>{credentialMask(provider)}</strong>
          </div>
          <button type="button" className="danger-button" onClick={onClearCredential}>
            {`Clear ${localAccessName()}`}
          </button>
        </div>
      ) : (
        <p className="settings-message wide">Leave the optional credential empty when the local runtime does not require one.</p>
      )}
      <div className="setting-row inline-row wide">
        <div>
          <span>Readiness</span>
          <strong>{statusLabel(status)}</strong>
          <small>{connectionHint(provider, status)}</small>
        </div>
        <button type="button" className={status.state === "ready" ? "success-button" : "secondary-button"} onClick={onTest} disabled={testing || !aiReady(provider)}>
          {status.state === "ready" ? <CheckCircle2 aria-hidden="true" focusable="false" /> : null}
          {testing ? "Checking..." : status.state === "ready" ? "Check again" : "Check readiness"}
        </button>
      </div>
    </div>
  );
}

function ProviderAccessModeControl({ provider, onUpdate }: { provider: AIProviderSettings; onUpdate: (update: Partial<AIProviderSettings>) => void }) {
  const mode = providerExecutionMode(provider);
  return (
    <div className="setting-row inline-row wide">
      <div>
        <span>Repository access</span>
        <strong>{mode === "repoWrite" ? "Current repo write" : "Context-only"}</strong>
        <small>
          {mode === "repoWrite"
            ? "The model returns a versioned JSON read/edit plan without filesystem access. Local Reader App validates and applies bounded UTF-8 text operations only inside the Current repo."
            : "The provider receives selected context but has no repository write tools."}
        </small>
      </div>
      <SegmentedControl
        label={`${provider.entry === "aiApi" ? "AI API" : "Local AI"} repository access`}
        value={mode}
        options={[["readOnly", "Context-only"], ["repoWrite", "Current repo write"]]}
        onChange={(value) => onUpdate({ executionMode: value === "repoWrite" ? "repoWrite" : "readOnly" })}
      />
    </div>
  );
}

function CliAIForm({ entry, status, testing, selectionReady, onTest }: { entry: CliAIEntrySettings; status: AIConnectionStatus; testing: boolean; selectionReady: boolean; onTest: () => void }) {
  return (
    <div className="cli-readiness-panel">
      <div className={`cli-readiness-action ${statusClass(status) || "neutral"}`}>
        <div>
          <span>Readiness</span>
          <strong>{cliStatusLabel(status)}</strong>
          <small>{selectionReady ? cliStatusMessage(status) : "Select a model and reasoning effort in Authentication and model before checking this boundary."}</small>
          <small>Last checked: {formatLastCheck(entry.lastCheckedAt || "")}</small>
        </div>
        <button type="button" className={status.state === "ready" ? "success-button" : "secondary-button"} onClick={onTest} disabled={testing || !selectionReady}>
          {status.state === "ready" ? <CheckCircle2 aria-hidden="true" focusable="false" /> : null}
          {testing ? "Checking..." : status.state === "ready" ? "Check again" : "Check readiness"}
        </button>
      </div>
    </div>
  );
}

function CliReadinessDetails({ entry }: { entry: CliAIEntrySettings }) {
  return (
    <>
      <ReadinessRow label="Binary" status={entry.binaryName ? "ready" : "warning"} value={entry.binaryName || "Unknown"} />
      <ReadinessRow label="Version" status={entry.version ? "ready" : "warning"} value={entry.version || "Not checked"} />
      <ReadinessRow label="Existing sign-in" status={entry.authState === "configured" ? "ready" : "warning"} value={cliAuthLabel(entry)} />
      <ReadinessRow label="Current repo-only boundary" status={entry.readOnlyWrapperState === "ready" ? "ready" : "warning"} value={cliWrapperLabel(entry)} />
      <ReadinessRow label="Execution mode" status={entry.executionMode === "repoWrite" ? "ready" : "warning"} value={entry.executionMode === "repoWrite" ? "Current repo write" : "Not confirmed"} />
    </>
  );
}

function AIEntryCard({
  entry,
  settings,
  status,
  active,
  available,
  onSetActive,
  onClearActive,
}: {
  entry: AIEntryKind;
  settings: AIEntrySettings;
  status: AIConnectionStatus;
  active: boolean;
  available: boolean;
  onSetActive: () => void;
  onClearActive: () => void;
}) {
  return (
    <article className={`entry-card${active ? " active" : ""}`} aria-label={`${entryLabel(entry)} entry`}>
      <div className="entry-card-header">
        <span className="entry-icon" aria-hidden="true">
          {entryIcon(entry)}
        </span>
        <div>
          <h4>{entryLabel(entry)}</h4>
          <p>{entryDescription(entry)}</p>
        </div>
      </div>
      <div className="entry-status-pills">
        <span className={active ? "ready" : ""}>{active ? "Active" : "Inactive"}</span>
        <span className={status.state === "ready" ? "ready" : status.state === "failed" ? "error" : ""}>{aiEntryStatusLabel(entry, status)}</span>
      </div>
      <button type="button" className="secondary-button" disabled={!available} onClick={active ? onClearActive : onSetActive}>
        {available ? active ? "Clear active entry" : "Set active" : "Coming soon"}
      </button>
    </article>
  );
}

function SettingsCard({ title, eyebrow, status, children }: { title: string; eyebrow: string; status: string; children: ReactNode }) {
  return (
    <article className="settings-card">
      <div className="settings-card-heading">
        <div>
          <span>{eyebrow}</span>
          <h3>{title}</h3>
        </div>
        <span className="settings-badge">{status}</span>
      </div>
      {children}
    </article>
  );
}

type SegmentedOption = [string, string] | { value: string; label: string; disabled?: boolean; title?: string };

function SegmentedControl({ label, value, options, onChange }: { label: string; value: string; options: SegmentedOption[]; onChange: (value: string) => void }) {
  return (
    <div className="settings-segmented" role="group" aria-label={label}>
      {options.map((option) => {
        const optionValue = Array.isArray(option) ? option[0] : option.value;
        const optionLabel = Array.isArray(option) ? option[1] : option.label;
        const disabled = Array.isArray(option) ? false : option.disabled === true;
        const title = Array.isArray(option) ? undefined : option.title;
        return (
          <button key={optionValue} type="button" className={value === optionValue ? "active" : ""} aria-pressed={value === optionValue} disabled={disabled} title={title} onClick={() => onChange(optionValue)}>
            {optionLabel}
            {disabled ? <small>Future</small> : null}
          </button>
        );
      })}
    </div>
  );
}

function SettingRow({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        <small>{description}</small>
      </div>
      <div>{children}</div>
    </div>
  );
}

function entryStatusLabel(checks: RepositoryConfigValidation["checks"], index: number): string {
  const entryChecks = checks.filter((item) => item.id.startsWith(`entry:${index}:`));
  if (!entryChecks.length) return "Not validated";
  return entryChecks.every((item) => item.status === "ready") ? "Ready" : "Needs review";
}

function entryStatusClass(checks: RepositoryConfigValidation["checks"], index: number): string {
  const entryChecks = checks.filter((item) => item.id.startsWith(`entry:${index}:`));
  if (!entryChecks.length) return "";
  return entryChecks.every((item) => item.status === "ready") ? "success" : "error";
}

function entryLabel(entry: AIEntryKind): string {
  if (entry === "localAi") return "Local AI";
  if (entry === "codexCli") return ["Co", "dex CLI"].join("");
  if (entry === "claudeCli") return "Claude Code CLI";
  return "AI API";
}

function entryIcon(entry: AIEntryKind): string {
  if (entry === "aiApi") return "API";
  if (entry === "localAi") return "L";
  if (entry === "codexCli") return "C";
  return "CC";
}

function entryDescription(entry: AIEntryKind): string {
  if (entry === "codexCli") return "Installed Codex CLI entry for the Current repo.";
  if (entry === "claudeCli") return "Installed Claude Code CLI entry for the Current repo.";
  if (entry === "aiApi") return "Remote AI provider entry.";
  return "Local AI runtime entry.";
}

function Field({ label, value, onChange, wide = false }: { label: string; value: string; onChange: (value: string) => void; wide?: boolean }) {
  return (
    <label className={`settings-field${wide ? " wide" : ""}`}>
      <span>{label}</span>
      <input value={value} autoComplete="off" onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function ReadinessRow({ label, status, value, detail = "" }: { label: string; status: "ready" | "warning" | "error"; value: string; detail?: string }) {
  return (
    <div className={`readiness-row ${status}`}>
      {status === "ready" ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}
      <div>
        <span>{label}</span>
        <strong>{value}</strong>
        {detail ? <small>{detail}</small> : null}
      </div>
    </div>
  );
}

function ValidationRow({ item }: { item: RepositoryConfigValidation["checks"][number] }) {
  const ready = item.status === "ready";
  return (
    <div className={`validation-item ${ready ? "ready" : "error"}`}>
      {ready ? <CheckCircle2 aria-hidden="true" /> : <XCircle aria-hidden="true" />}
      <div>
        <strong>{item.label}</strong>
        <small>{item.message}</small>
      </div>
    </div>
  );
}

function credentialMask(provider: AIProviderSettings): string {
  return provider.credential?.trim() ? "********" : "Not entered";
}

function connectionHint(provider: AIProviderSettings, status: AIConnectionStatus): string {
  if (status.state === "failed") return status.message;
  if (provider.entry === "aiApi") {
    if (!provider.credential?.trim()) return "Enter an API key.";
    if (!provider.model.trim()) return "Choose a model.";
    if ((provider.provider === "openaiCompatible" || provider.provider === "custom") && !provider.baseUrl.trim()) return "Add a Base URL in Endpoint settings.";
    return "Ready for a direct server-side endpoint and model check.";
  }
  if (!provider.baseUrl.trim()) return "Enter a loopback Local AI endpoint.";
  if (!provider.model.trim()) return "Choose a local model.";
  return "Ready for a direct loopback endpoint and model check.";
}

function cliAuthLabel(entry: CliAIEntrySettings): string {
  if (entry.authState === "configured") return "Configured";
  if (entry.authState === "notConfigured") return "Not configured";
  return "Unknown";
}

function cliWrapperLabel(entry: CliAIEntrySettings): string {
  if (entry.readOnlyWrapperState === "ready") return "Current repo write ready";
  if (entry.readOnlyWrapperState === "notReady") return "Not ready";
  return "Unknown";
}

function localAccessName(): string {
  return "to" + "ken";
}

function providerDefaults(provider: string): Partial<AIProviderSettings> {
  if (provider === "anthropic") return { provider: "anthropic", apiFormat: "anthropic", model: "claude-sonnet-4.5", baseUrl: "" };
  if (provider === "google") return { provider: "google", apiFormat: "google", model: "gemini-3.5-flash", baseUrl: "" };
  if (provider === "openaiCompatible") return { provider: "openaiCompatible", apiFormat: "openaiCompatible", model: "", baseUrl: "" };
  if (provider === "custom") return { provider: "custom", apiFormat: "custom", model: "", baseUrl: "" };
  return { provider: "openai", apiFormat: "openaiCompatible", model: "gpt-5.5", baseUrl: "" };
}

function providerSettingsFingerprint(provider: AIProviderSettings): string {
  return JSON.stringify({
    entry: provider.entry,
    provider: provider.provider || "",
    runtime: provider.runtime || "",
    model: provider.model,
    baseUrl: provider.baseUrl,
    apiFormat: provider.apiFormat,
    credential: provider.credential || "",
    executionMode: providerExecutionMode(provider),
  });
}

function cliModelSelectionFingerprint(selection: AICliModelSelection | null | undefined): string {
  return selection ? JSON.stringify([selection.model, selection.effort, selection.speedMode, selection.catalogRevision, selection.setupGeneration]) : "";
}

function localDefaults(runtime: string): Partial<AIProviderSettings> {
  if (runtime === "lmStudio") return { runtime: "lmStudio", baseUrl: "http://127.0.0.1:1234/v1", model: "" };
  if (runtime === "openaiLocal") return { runtime: "openaiLocal", baseUrl: "http://127.0.0.1:8000/v1", model: "" };
  if (runtime === "custom") return { runtime: "custom", baseUrl: "", model: "" };
  return { runtime: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "" };
}

function modelBehaviorStatus(behavior: AIModelBehavior): string {
  if (behavior.kind === "intelligence") return `Intelligence ${intelligenceLabel(behavior.level)}`;
  if (behavior.kind === "thinking") return behavior.enabled ? "Thinking on" : "Thinking off";
  return "Model default";
}

function cliSetupStatus(snapshot: AICliSetupSnapshot | null | undefined): string {
  if (!snapshot) return "Not inspected";
  if (snapshot.phase === "ready") return "Catalog ready";
  if (snapshot.phase === "notInstalled") return "Not installed";
  if (snapshot.phase === "updateRequired") return "Update required";
  if (snapshot.phase === "loginRequired") return "Sign-in required";
  if (snapshot.phase === "authenticating") return "Waiting for sign-in";
  if (snapshot.phase === "inspecting" || snapshot.phase === "loadingCatalog") return "Checking";
  if (snapshot.phase === "unavailable") return "Unavailable";
  if (snapshot.phase === "failed") return "Check failed";
  return "Not inspected";
}

function cliAuthenticationLabel(snapshot: AICliSetupSnapshot | null | undefined): string {
  if (!snapshot) return "Not checked";
  if (snapshot.authentication.state === "waiting") return "Waiting for sign-in";
  if (snapshot.authentication.state === "succeeded" || snapshot.phase === "ready") return "Signed in";
  if (snapshot.authentication.state === "failed") return "Sign-in failed";
  if (snapshot.phase === "loginRequired") return "Sign-in required";
  return "Not checked";
}

function cliCompatibilityLabel(snapshot: AICliSetupSnapshot | null | undefined): string {
  if (!snapshot || snapshot.compatibility === "unknown") return "Not checked";
  if (snapshot.compatibility === "compatible") return "Compatible";
  if (snapshot.compatibility === "updateRequired") return "Update required";
  return "Manual update only";
}

function intelligenceLabel(level: AIIntelligenceLevel): string {
  if (level === "xhigh") return "X High";
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function statusLabel(status: AIConnectionStatus): string {
  if (status.state === "notConfigured") return "Needs setup";
  if (status.state === "configured") return "Needs test";
  if (status.state === "ready") return "Connected";
  return "Needs attention";
}

function aiEntryStatusLabel(entry: AIEntryKind | null, status: AIConnectionStatus): string {
  return isCliEntryKind(entry) ? cliStatusLabel(status) : statusLabel(status);
}

function cliStatusLabel(status: AIConnectionStatus): string {
  if (status.state === "ready") return "Success";
  if (status.code === "cli_auth_missing") return "Needs sign-in";
  if (status.code === "wrapper_not_ready") return "Needs check";
  if (status.state === "failed") return "Check failed";
  return "Not checked";
}

function cliStatusMessage(status: AIConnectionStatus): string {
  if (status.state === "ready") return "Ready to use for AI Chat.";
  if (status.code === "cli_auth_missing") return "Complete persistent sign-in with the CLI outside Local Reader App, then check readiness again.";
  if (status.state === "failed" || status.code === "wrapper_not_ready") return status.nextAction || status.message;
  return "Check the installed CLI and existing sign-in state.";
}

function statusClass(status: AIConnectionStatus): string {
  if (status.severity === "success" || status.state === "ready") return "success";
  if (status.severity === "warning" || status.state === "configured") return "warning";
  if (status.severity === "error" || status.state === "failed") return "error";
  return "";
}

function readinessRowStatus(status: AIConnectionStatus): "ready" | "warning" | "error" {
  if (status.state === "ready") return "ready";
  if (status.state === "failed" && status.severity === "error") return "error";
  return "warning";
}

function formatLastCheck(value: string): string {
  if (!value) return "Not tested";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not tested";
  return date.toLocaleString();
}

function categoryStatus(category: SettingsCategory, basicError: string, basicDirty: boolean, repoSaveState: SaveState, providerStatus: AIConnectionStatus, aiDirty: boolean): string {
  if (category === "basic") return basicError ? "Basic save failed" : basicDirty ? "Unsaved browser-local changes" : "Browser-local settings";
  if (category === "repositories") return saveStateLabel(repoSaveState);
  return aiDirty ? `Unsaved / ${statusLabel(providerStatus)}` : statusLabel(providerStatus);
}

function saveStateLabel(state: SaveState): string {
  if (state === "dirty") return "Unsaved";
  if (state === "failed") return "Failed";
  if (state === "pending") return "Saving";
  if (state === "saved") return "Saved";
  return "Idle";
}

function sameJSON(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
