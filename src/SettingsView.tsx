import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, CheckCircle2, Settings as SettingsIcon, XCircle } from "lucide-react";
import { fetchAIEntryReadiness, fetchRepositoryConfig, previewRepositoryConfig, saveRepositoryConfig, validateRepositoryConfig } from "./api";
import {
  activeAIEntry,
  aiModelBehavior,
  aiModelBehaviorCapability,
  aiConfigured,
  aiEntryCli,
  aiEntryProvider,
  aiEntrySettings,
  aiReady,
  defaultAISettings,
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
  updateAIModelBehavior,
  updateCliEntryReadiness,
  type AISettingsState,
  type AIModelBehaviorCapability,
  type BasicSettings,
} from "./settingsState";
import type {
  AIConnectionStatus,
  AICliEntryKind,
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
    setTestingEntry(entry);
    try {
      const provider = isProviderEntryKind(entryAtStart) ? aiEntryProvider(settingsAtStart, entryAtStart) : undefined;
      const readiness = await fetchAIEntryReadiness(entryAtStart, provider, activeRepoId, activeRepoRevision);
      if (readinessGenerationRef.current !== requestGeneration || activeRepoIdentityRef.current !== repoIdentityAtStart) return;
      commitAISettingsUpdate((current) => {
        if (isProviderEntryKind(entryAtStart) && providerSettingsFingerprint(aiEntryProvider(current, entryAtStart)) !== providerFingerprint) return current;
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
            <p>Reader-Wiki</p>
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
            <p>Reader-Wiki Settings</p>
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
            repositories={repoDraft}
            dirty={aiDirty}
            onChange={commitAISettings}
            onTestEntry={(entry, settingsSnapshot) => void testEntry(entry, settingsSnapshot)}
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
        <SettingRow title="Choose the reader theme" description="Applies Light or Dark to the full Reader-Wiki app in this browser.">
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
        <p className="settings-message">Remove from list only edits the config draft. Reader-Wiki does not delete repository directories.</p>
      </SettingsCard>

      <details className="settings-details" aria-label="Config details">
        <summary>Config details</summary>
        <div className="settings-summary-grid">
          <SummaryItem label="Config file" value={repoState?.configPath || "Loading..."} />
          <SummaryItem label="Source mode" value={repoState?.sourceMode === "env" ? "READER_WIKI_CONFIG" : "Default repositories.yaml"} />
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
  repositories,
  dirty,
  onChange,
  onTestEntry,
}: {
  settings: AISettingsState;
  status: AIConnectionStatus;
  testingEntry: AIEntryKind | null;
  repositories: RepositoryConfigEntryDraft[];
  dirty: boolean;
  onChange: (settings: AISettingsState) => void;
  onTestEntry: (entry: AIEntryKind, settingsSnapshot?: AISettingsState) => void;
}) {
  const activeEntrySettings = activeAIEntry(settings);
  const activeEntry = settings.activeEntry;
  const configured = aiConfigured(activeEntrySettings);
  const entries = ["codexCli", "claudeCli", "aiApi", "localAi"] as AIEntryKind[];
  const activeSetupTitle = isCliEntryKind(activeEntry) ? "CLI Readiness" : "Connection / Credentials";
  const behavior = activeEntry ? aiModelBehavior(settings, activeEntry) : { kind: "none" } as AIModelBehavior;
  const behaviorCapability = activeEntry ? aiModelBehaviorCapability(settings, activeEntry) : null;

  function setActiveEntry(entry: AIEntryKind) {
    const nextSettings = { ...settings, activeEntry: entry };
    onChange(nextSettings);
    onTestEntry(entry, nextSettings);
  }

  function clearActiveEntry() {
    onChange({ ...settings, activeEntry: null });
  }

  function updateEntry(entry: AIEntryKind, update: Partial<AIEntrySettings>) {
    onChange(updateAIEntry(settings, entry, update));
  }

  function clearEntry(entry: AIEntryKind) {
    onChange(updateAIEntry(settings, entry, defaultAISettings.entries[entry]));
  }

  function updateBehavior(entry: AIEntryKind, nextBehavior: AIModelBehavior) {
    onChange(updateAIModelBehavior(settings, entry, nextBehavior));
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
              onSetActive={() => setActiveEntry(entry)}
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
              subtitle="Existing CLI readiness"
              note="Checks installed CLI sign-in and the Current repo write wrapper. No login, browser launch, or Git remote operation is started here."
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
                onTest={() => onTestEntry("codexCli")}
              />
            </AuthenticationEntryCard>
          ) : null}
          {activeEntry === "claudeCli" ? (
            <AuthenticationEntryCard
              entry="claudeCli"
              title={entryLabel("claudeCli")}
              subtitle="Existing CLI readiness"
              note="Checks installed CLI sign-in and the tool-restricted Current repo write wrapper. No login, browser auth, or credential handling is started here."
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
                onTest={() => onTestEntry("claudeCli")}
              />
            </AuthenticationEntryCard>
          ) : null}
          {activeEntry === "aiApi" ? (
            <AuthenticationEntryCard
              entry="aiApi"
              title="AI API"
              subtitle="Direct context-only provider / model / credential"
              note="Reader-Wiki checks the HTTPS endpoint and model directly. Credentials stay in this browser run and are sent only with provider requests."
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
              subtitle="Direct context-only local runtime / model"
              note="Use a loopback Ollama or LM Studio endpoint directly. Reader-Wiki does not start runtimes, load models, or launch auth flows."
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
        <SettingsCard title="Model behavior" eyebrow={entryLabel(activeEntry)} status={modelBehaviorStatus(behavior)}>
          <ModelBehaviorSettings
            entry={activeEntry}
            entrySettings={aiEntrySettings(settings, activeEntry)}
            capability={behaviorCapability}
            behavior={behavior}
            onChange={(nextBehavior) => updateBehavior(activeEntry, nextBehavior)}
          />
        </SettingsCard>
      ) : null}
      <SettingsCard title="Access policy" eyebrow="AI Chat" status="Context-only or Current repo write">
        <div className="policy-grid">
          <div className="policy-item ready">
            <strong>Read selected context</strong>
            <small>AI Chat receives selected files, directories, attachments, and repository rule context with repository-relative paths.</small>
          </div>
          <div className="policy-item">
            <strong>CLI Current repo write</strong>
            <small>Codex CLI and Claude Code CLI may edit only the Current repo selected for this AI Chat run. Review changes and keep backups; CLI use and edit results are your responsibility.</small>
          </div>
          <div className="policy-item">
            <strong>Guarded execution</strong>
            <small>No Git commit, push, pull, fetch, checkout, merge, reset, auth flow, model download, plugin run, or app terminal UI is started.</small>
          </div>
        </div>
        <div className="subsection-title">Repository Access</div>
        <RepositoryAccessList repositories={repositories} />
      </SettingsCard>
    </section>
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
      {capability.kind === "none" ? <p className="settings-message">Reader-Wiki will use the active model default for this entry.</p> : null}
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
                label="Context-only execution"
                status={readinessRowStatus(status)}
                value={status.state === "ready" ? "Ready" : "Not ready"}
                detail={status.state === "ready" ? "Reader-Wiki will send selected context without repository write tools." : "Complete the endpoint and model check before context-only AI Chat is enabled."}
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

function CliAIForm({ entry, status, testing, onTest }: { entry: CliAIEntrySettings; status: AIConnectionStatus; testing: boolean; onTest: () => void }) {
  return (
    <div className="cli-readiness-panel">
      <div className={`cli-readiness-action ${statusClass(status) || "neutral"}`}>
        <div>
          <span>Readiness</span>
          <strong>{cliStatusLabel(status)}</strong>
          <small>{cliStatusMessage(status)}</small>
          <small>Last checked: {formatLastCheck(entry.lastCheckedAt || "")}</small>
        </div>
        <button type="button" className={status.state === "ready" ? "success-button" : "secondary-button"} onClick={onTest} disabled={testing}>
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
      <ReadinessRow label="Current repo write wrapper" status={entry.readOnlyWrapperState === "ready" ? "ready" : "warning"} value={cliWrapperLabel(entry)} />
      <ReadinessRow label="Execution mode" status={entry.executionMode === "repoWrite" ? "ready" : "warning"} value={entry.executionMode === "repoWrite" ? "Current repo write" : "Not confirmed"} />
    </>
  );
}

function AIEntryCard({
  entry,
  settings,
  status,
  active,
  onSetActive,
  onClearActive,
}: {
  entry: AIEntryKind;
  settings: AIEntrySettings;
  status: AIConnectionStatus;
  active: boolean;
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
      <button type="button" className="secondary-button" onClick={active ? onClearActive : onSetActive}>
        {active ? "Clear active entry" : "Set active"}
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
  if (entry === "codexCli") return "Installed CLI with guarded Current repo write execution.";
  if (entry === "claudeCli") return "Installed CLI with tool-restricted Current repo write execution.";
  if (entry === "aiApi") return "Remote HTTPS provider with selected context only.";
  return "Loopback Ollama or LM Studio runtime with selected context only.";
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

function RepositoryAccessList({ repositories }: { repositories: RepositoryConfigEntryDraft[] }) {
  if (!repositories.length) return <p className="settings-message">No registered repositories are available for AI Chat access.</p>;
  return (
    <div className="repo-access-list" aria-label="Repository Access list">
      {repositories.map((repo) => (
        <div key={repo.id || repo.label} className="repo-access-row">
          <div>
            <span>{repo.label || repo.id || "Untitled repository"}</span>
            <small>{repo.defaultPath ? `Default context path: ${repo.defaultPath}` : "No default context path"}</small>
          </div>
          <strong>Available</strong>
        </div>
      ))}
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
  if (provider.runtime !== "ollama" && provider.runtime !== "lmStudio") return "Choose Ollama or LM Studio for Local AI.";
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
  });
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
  if (status.state === "failed" || status.code === "wrapper_not_ready") return "Check failed";
  return "Not checked";
}

function cliStatusMessage(status: AIConnectionStatus): string {
  if (status.state === "ready") return "Ready to use for AI Chat.";
  if (status.code === "cli_auth_missing") return "Complete persistent sign-in with the CLI outside Reader-Wiki, then check readiness again.";
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
