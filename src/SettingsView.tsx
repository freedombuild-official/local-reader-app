import { useEffect, useState, type ReactNode } from "react";
import { ArrowLeft, CheckCircle2, Settings as SettingsIcon, XCircle } from "lucide-react";
import { fetchAIEntryReadiness, fetchRepositoryConfig, previewRepositoryConfig, saveRepositoryConfig, testAIProviderConnection, validateRepositoryConfig } from "./api";
import {
  activeAIEntry,
  aiConfigured,
  aiEntryCli,
  aiEntryProvider,
  aiEntrySettings,
  aiReady,
  aiVerifiedReady,
  defaultAISettings,
  derivedAIStatus,
  effectiveAIStatus,
  formatReaderFontScaleLabel,
  isProviderEntryKind,
  normalizeAISettingsState,
  normalizeReaderFontScale,
  READER_FONT_SCALE_OPTIONS,
  updateAIEntry,
  updateAIEntryStatus,
  updateCliEntryReadiness,
  type AISettingsState,
  type BasicSettings,
} from "./settingsState";
import type {
  AIConnectionStatus,
  AICliEntryKind,
  AIEntryKind,
  AIEntrySettings,
  AIFormat,
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
  basicSaveError: string;
  onBack: () => void;
  onBasicSettingsChange: (settings: BasicSettings) => void;
  onAISettingsChange: (settings: AISettingsState) => void;
  onRepositoriesChanged: () => Promise<void>;
};

const concealedInputType = "pass" + "word";

export function SettingsView({
  basicSettings,
  aiSettings,
  basicSaveError,
  onBack,
  onBasicSettingsChange,
  onAISettingsChange,
  onRepositoriesChanged,
}: SettingsViewProps) {
  const [category, setCategory] = useState<SettingsCategory>("basic");
  const [basicDraft, setBasicDraft] = useState<BasicSettings>(basicSettings);
  const [aiDraft, setAiDraft] = useState<AISettingsState>(() => normalizeAISettingsState(aiSettings));
  const [repoState, setRepoState] = useState<RepositoryConfigState | null>(null);
  const [repoDraft, setRepoDraft] = useState<RepositoryConfigEntryDraft[]>([]);
  const [selectedRepoIndex, setSelectedRepoIndex] = useState(0);
  const [repoValidation, setRepoValidation] = useState<RepositoryConfigValidation | null>(null);
  const [yamlPreview, setYamlPreview] = useState("");
  const [previewOpen, setPreviewOpen] = useState(false);
  const [repoSaveState, setRepoSaveState] = useState<SaveState>("idle");
  const [repoMessage, setRepoMessage] = useState("");
  const [testingEntry, setTestingEntry] = useState<AIEntryKind | null>(null);

  useEffect(() => {
    setBasicDraft(basicSettings);
  }, [basicSettings]);

  useEffect(() => {
    setAiDraft(normalizeAISettingsState(aiSettings));
  }, [aiSettings]);

  useEffect(() => {
    let canceled = false;
    async function load() {
      try {
        const nextState = await fetchRepositoryConfig();
        if (canceled) return;
        setRepoState(nextState);
        setRepoDraft(nextState.entries);
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

  const selectedRepo = repoDraft[selectedRepoIndex] || null;
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
      const nextState = await saveRepositoryConfig({ entries: repoDraft });
      setRepoState(nextState);
      setRepoDraft(nextState.entries);
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

  function updateSelectedRepo(update: Partial<RepositoryConfigEntryDraft>) {
    setRepoDraft((current) => current.map((entry, index) => (index === selectedRepoIndex ? { ...entry, ...update } : entry)));
    setRepoSaveState("dirty");
    setRepoMessage("Unsaved repository config changes.");
  }

  function addRepository() {
    const nextEntry: RepositoryConfigEntryDraft = { id: "new-repo", label: "New repository", root: "", defaultPath: "README.md", excludes: [".git", "node_modules", "dist"], fetchRemote: false };
    setRepoDraft((current) => [...current, nextEntry]);
    setSelectedRepoIndex(repoDraft.length);
    setRepoSaveState("dirty");
    setRepoMessage("New repository draft added.");
  }

  function removeRepository(indexToRemove = selectedRepoIndex) {
    setRepoDraft((current) => current.filter((_, index) => index !== indexToRemove));
    setSelectedRepoIndex((current) => {
      if (indexToRemove < current) return Math.max(0, current - 1);
      if (indexToRemove === current) return 0;
      return current;
    });
    setRepoSaveState("dirty");
    setRepoMessage("Repository entry removed from the draft list. The directory was not touched.");
  }

  async function testEntry(entry: AIEntryKind) {
    setTestingEntry(entry);
    try {
      if (isProviderEntryKind(entry)) {
        const provider = aiEntryProvider(aiDraft, entry);
        const status = await testAIProviderConnection(provider);
        commitAISettings(updateAIEntryStatus(aiDraft, entry, status));
      } else {
        const readiness = await fetchAIEntryReadiness(entry);
        commitAISettings(updateCliEntryReadiness(aiDraft, readiness));
      }
    } catch (error) {
      const failed: AIConnectionStatus = {
        state: "failed",
        code: "provider_http_error",
        severity: "error",
        message: "Readiness check failed.",
        nextAction: error instanceof Error ? error.message : String(error),
        checkedAt: new Date().toISOString(),
      };
      commitAISettings(updateAIEntryStatus(aiDraft, entry, failed));
    } finally {
      setTestingEntry(null);
    }
  }

  function commitBasicSettings(settings: BasicSettings): BasicSettings {
    setBasicDraft(settings);
    onBasicSettingsChange(settings);
    return settings;
  }

  function commitAISettings(settings: AISettingsState): AISettingsState {
    const normalized = normalizeAISettingsState(settings);
    setAiDraft(normalized);
    onAISettingsChange(normalized);
    return normalized;
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
            selectedRepo={selectedRepo}
            selectedRepoIndex={selectedRepoIndex}
            validation={repoValidation}
            yamlPreview={yamlPreview}
            previewOpen={previewOpen}
            saveState={repoSaveState}
            message={repoMessage}
            onPreviewOpenChange={setPreviewOpen}
            onSelectedRepoChange={setSelectedRepoIndex}
            onUpdateSelectedRepo={updateSelectedRepo}
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
            onTestEntry={(entry) => void testEntry(entry)}
            onTestActive={() => {
              if (aiDraft.activeEntry) void testEntry(aiDraft.activeEntry);
            }}
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
  selectedRepo,
  selectedRepoIndex,
  validation,
  yamlPreview,
  previewOpen,
  saveState,
  message,
  onPreviewOpenChange,
  onSelectedRepoChange,
  onUpdateSelectedRepo,
  onAddRepository,
  onRemoveRepository,
  onValidate,
  onPreview,
}: {
  repoState: RepositoryConfigState | null;
  repoDraft: RepositoryConfigEntryDraft[];
  selectedRepo: RepositoryConfigEntryDraft | null;
  selectedRepoIndex: number;
  validation: RepositoryConfigValidation | null;
  yamlPreview: string;
  previewOpen: boolean;
  saveState: SaveState;
  message: string;
  onPreviewOpenChange: (open: boolean) => void;
  onSelectedRepoChange: (index: number) => void;
  onUpdateSelectedRepo: (update: Partial<RepositoryConfigEntryDraft>) => void;
  onAddRepository: () => void;
  onRemoveRepository: (index?: number) => void;
  onValidate: () => void;
  onPreview: () => void;
}) {
  const checks = validation?.checks || [];
  const selectedEntryChecks = selectedRepo ? checks.filter((item) => item.id.startsWith(`entry:${selectedRepoIndex}:`)) : [];
  const configChecks = checks.filter((item) => !item.id.startsWith("entry:"));
  const configStatus = repoState?.parseError ? "Parse error" : saveStateLabel(saveState);
  return (
    <section className="settings-page repositories-page" aria-label="Repositories settings">
      <SettingsCard title="Repository config" eyebrow="Config Source" status={configStatus}>
        <div className="settings-summary-grid">
          <SummaryItem label="Config file" value={repoState?.configPath || "Loading..."} />
          <SummaryItem label="Source mode" value={repoState?.sourceMode === "env" ? "READER_WIKI_CONFIG" : "Default repositories.yaml"} />
          <SummaryItem label="Write access" value={repoState?.writable ? "Writable" : "Not writable"} />
          <SummaryItem label="Last validation" value={validation?.valid ? "Ready" : "Needs review"} />
        </div>
        {repoState?.parseError ? <p className="settings-message error">{repoState.parseError}</p> : null}
        <div className="settings-action-row">
          <button type="button" className="secondary-button" onClick={onValidate}>
            Validate config
          </button>
          <button type="button" className="secondary-button" onClick={onPreview}>
            Preview YAML
          </button>
        </div>
        <p className={`settings-message ${saveState === "failed" ? "error" : ""}`}>{message || "Repository config loaded."}</p>
        {previewOpen ? (
          <pre className="yaml-preview" aria-label="Generated YAML preview">
            <code>{yamlPreview}</code>
          </pre>
        ) : null}
        {yamlPreview ? (
          <button type="button" className="text-button" onClick={() => onPreviewOpenChange(!previewOpen)}>
            {previewOpen ? "Hide YAML preview" : "Show last YAML preview"}
          </button>
        ) : null}
      </SettingsCard>

      <SettingsCard title="Repositories list" eyebrow="Registered Repositories" status={`${repoDraft.length} entries`}>
        <div className="repo-list" aria-label="Registered repositories">
          {repoDraft.map((repo, index) => (
            <div key={`${repo.id}-${index}`} className={`repo-list-row${index === selectedRepoIndex ? " active" : ""}`}>
              <button type="button" className="repo-list-main" onClick={() => onSelectedRepoChange(index)}>
                <span>
                  <strong>{repo.label || "Untitled repository"}</strong>
                  <small>{repo.id || "missing-id"}</small>
                </span>
                <span>
                  <strong>Root</strong>
                  <small>{repo.root || "Missing root path"}</small>
                </span>
                <span>
                  <strong>Default path</strong>
                  <small>{repo.defaultPath || "No default path"}</small>
                </span>
                <span>
                  <strong>Status</strong>
                  <small>{entryStatusLabel(checks, index)}</small>
                </span>
                <span>
                  <strong>Fetch remote</strong>
                  <small>{repo.fetchRemote ? "Fetch-only enabled" : "Fetch off"}</small>
                </span>
              </button>
              <div className="repo-row-actions">
                <button type="button" className="secondary-button" onClick={() => onSelectedRepoChange(index)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => {
                    onSelectedRepoChange(index);
                    onValidate();
                  }}
                >
                  Validate
                </button>
                <button type="button" className="danger-button" onClick={() => onRemoveRepository(index)}>
                  Remove from list
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="settings-action-row">
          <button type="button" className="secondary-button" onClick={onAddRepository}>
            Add repository
          </button>
          <button type="button" className="danger-button" onClick={() => onRemoveRepository()} disabled={!selectedRepo}>
            Remove from list
          </button>
        </div>
        <p className="settings-message">Remove from list only edits the config draft. Reader-Wiki does not delete repository directories.</p>
      </SettingsCard>

      <SettingsCard title="Repository entry" eyebrow="Add / Edit Repository" status={selectedRepo ? `Editing ${selectedRepo.id || "entry"}` : "No entry"}>
        {selectedRepo ? (
          <div className="repo-form-grid">
            <Field label="Repository ID" value={selectedRepo.id} onChange={(id) => onUpdateSelectedRepo({ id })} />
            <Field label="Label" value={selectedRepo.label} onChange={(label) => onUpdateSelectedRepo({ label })} />
            <Field label="Root absolute path" value={selectedRepo.root} onChange={(root) => onUpdateSelectedRepo({ root })} wide />
            <Field label="Default path" value={selectedRepo.defaultPath} onChange={(defaultPath) => onUpdateSelectedRepo({ defaultPath })} />
            <label className="settings-field wide">
              <span>Excludes</span>
              <textarea value={selectedRepo.excludes.join("\n")} rows={4} onChange={(event) => onUpdateSelectedRepo({ excludes: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} />
            </label>
            <div className="chip-list wide" aria-label="Exclude chips">
              {selectedRepo.excludes.length ? selectedRepo.excludes.map((exclude) => <span key={exclude}>{exclude}</span>) : <span>No excludes configured</span>}
            </div>
            <label className="settings-toggle wide">
              <input type="checkbox" checked={selectedRepo.fetchRemote} onChange={(event) => onUpdateSelectedRepo({ fetchRemote: event.target.checked })} />
              <span>Fetch-only Git sync</span>
            </label>
            <div className="settings-action-row wide">
              <button type="button" className="secondary-button" onClick={onValidate}>
                Validate entry
              </button>
            </div>
          </div>
        ) : (
          <p className="settings-message">Add a repository entry to start editing.</p>
        )}
        {selectedRepo?.fetchRemote ? <p className="settings-message warning">Fetch-only means no pull, checkout, merge, reset, or working tree changes.</p> : null}
      </SettingsCard>

      <SettingsCard title="Repository entry checks" eyebrow="Validation" status={selectedEntryChecks.length && selectedEntryChecks.every((item) => item.status === "ready") ? "Ready" : "Needs review"}>
        <div className="validation-list">
          {selectedEntryChecks.length ? selectedEntryChecks.map((item) => <ValidationRow key={item.id} item={item} />) : <p className="settings-message">Run validation to see entry checks.</p>}
        </div>
      </SettingsCard>

      <SettingsCard title="Config checks" eyebrow="Validation" status={validation?.valid ? "Ready" : "Needs review"}>
        <div className="validation-list">
          {configChecks.length ? configChecks.map((item) => <ValidationRow key={item.id} item={item} />) : <p className="settings-message">Run validation to see config checks.</p>}
        </div>
      </SettingsCard>
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
  onTestActive,
}: {
  settings: AISettingsState;
  status: AIConnectionStatus;
  testingEntry: AIEntryKind | null;
  repositories: RepositoryConfigEntryDraft[];
  dirty: boolean;
  onChange: (settings: AISettingsState) => void;
  onTestEntry: (entry: AIEntryKind) => void;
  onTestActive: () => void;
}) {
  const activeEntrySettings = activeAIEntry(settings);
  const activeEntry = settings.activeEntry;
  const ready = aiVerifiedReady(settings, activeEntry);
  const configured = aiConfigured(activeEntrySettings);
  const entries = ["codexCli", "claudeCli", "aiApi", "localAi"] as AIEntryKind[];

  function setActiveEntry(entry: AIEntryKind) {
    onChange({ ...settings, activeEntry: entry });
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

  return (
    <section className="settings-page ai-settings-page" aria-label="AI Chat settings">
      <SettingsCard title="AI Entry" eyebrow="Active entry" status={activeEntry ? entryLabel(activeEntry) : "No active AI Entry"}>
        <div className="active-entry-summary">
          <span>Active AI Entry</span>
          <strong>{activeEntry ? entryLabel(activeEntry) : "No active AI Entry"}</strong>
          <small>{activeEntry ? status.nextAction || "Only this entry is used for AI Chat." : "Choose one entry before checking readiness or sending AI Chat."}</small>
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
      <SettingsCard title="Connection / Credentials" eyebrow="Readiness" status={statusLabel(status)}>
        {!activeEntry ? (
          <p className="settings-message">Select an AI Entry to edit connection details and run readiness checks.</p>
        ) : null}
        {activeEntry === "codexCli" ? (
          <AuthenticationEntryCard
            entry="codexCli"
            title={entryLabel("codexCli")}
            subtitle="Existing CLI auth / read-only wrapper"
            note="Uses installed CLI authentication and fixed read-only invocation. No login, logout, browser launch, or repository writes are started here."
            active
            status={effectiveAIStatus(settings, "codexCli")}
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
            subtitle="Existing CLI auth / tool-restricted print mode"
            note="Uses installed CLI authentication and a non-persistent print invocation with tools disabled."
            active
            status={effectiveAIStatus(settings, "claudeCli")}
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
            subtitle="Provider / model / credential"
            note="Cloud and compatible providers require a model, endpoint where applicable, and a credential kept in this browser run only."
            active
            status={effectiveAIStatus(settings, "aiApi")}
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
            subtitle="Local runtime / endpoint / model"
            note="Use a localhost OpenAI-compatible endpoint. Reader-Wiki does not start runtimes, load models, or run local AI CLIs."
            active
            status={effectiveAIStatus(settings, "localAi")}
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
        <p className="settings-message">Provider credentials stay in the current browser run and are never written to repository config or browser storage.</p>
      </SettingsCard>
      <SettingsCard title="Access policy" eyebrow="AI Chat" status="Read-only context">
        <div className="policy-grid">
          <div className="policy-item ready">
            <strong>Read context</strong>
            <small>AI Chat can receive the active repository file as guarded read-only context.</small>
          </div>
          <div className="policy-item">
            <strong>No write path</strong>
            <small>AI Chat cannot edit files, apply patches, mutate repositories, or delete content.</small>
          </div>
          <div className="policy-item">
            <strong>No runtime orchestration</strong>
            <small>Reader-Wiki does not start Local AI servers, load models, download models, or run local AI CLIs.</small>
          </div>
        </div>
        <div className="subsection-title">Repository Access</div>
        <RepositoryAccessList repositories={repositories} />
      </SettingsCard>
      <SettingsCard title="Readiness diagnostics" eyebrow="Diagnostics" status={statusLabel(status)}>
        <div className={`diagnostic-test-row ${statusClass(status)}`}>
          <div>
            <span>Test active entry</span>
            <strong>{activeEntry ? `${entryLabel(activeEntry)} readiness` : "No active AI Entry"}</strong>
            <small>{activeEntry ? status.message : "Select an AI Entry before running diagnostics."}</small>
            {activeEntry && status.nextAction ? <small>{status.nextAction}</small> : null}
          </div>
          <button type="button" className={ready ? "success-button" : "secondary-button"} onClick={onTestActive} disabled={!activeEntry || testingEntry !== null}>
            {ready ? <CheckCircle2 aria-hidden="true" focusable="false" /> : null}
            {testingEntry && testingEntry === activeEntry ? "Testing..." : ready ? "Test again" : "Test active entry"}
          </button>
        </div>
        <div className="readiness-list" aria-label="Readiness checklist">
          <ReadinessRow label="Active entry" status={activeEntry ? "ready" : "warning"} value={activeEntry ? entryLabel(activeEntry) : "Select an entry"} />
          <ReadinessRow label="Connection fields" status={configured ? "ready" : "warning"} value={configured ? "Configured" : "Incomplete"} />
          <ReadinessRow label="Connection check" status={readinessRowStatus(status)} value={statusLabel(status)} detail={status.message} />
          <ReadinessRow label="Next action" status={readinessRowStatus(status)} value={status.nextAction || "No action available"} />
          <ReadinessRow label="Last check" status={settings.activeEntry && settings.lastCheckedAtByEntry[settings.activeEntry] ? "ready" : "warning"} value={activeEntry ? formatLastCheck(settings.lastCheckedAtByEntry[activeEntry]) : "Not tested"} />
        </div>
      </SettingsCard>
    </section>
  );
}

function AuthenticationEntryCard({
  entry,
  title,
  subtitle,
  note,
  active,
  status,
  children,
}: {
  entry: AIEntryKind;
  title: string;
  subtitle: string;
  note: string;
  active: boolean;
  status: AIConnectionStatus;
  children: ReactNode;
}) {
  return (
    <article className={`auth-entry-card${active ? " active" : ""}`} aria-label={`${title} connection`}>
      <div className="auth-card-heading">
        <span className="entry-icon" aria-hidden="true">
          {entryIcon(entry)}
        </span>
        <div>
          <span>{title}</span>
          <h4>{subtitle}</h4>
        </div>
        <span className={`status-pill ${active ? "active" : "inactive"}`}>{active ? "Active" : "Inactive"}</span>
      </div>
      <p className="auth-card-note">{note}</p>
      {children}
      <p className={`settings-message ${statusClass(status)}`}>{status.message}</p>
      {status.nextAction ? <p className="settings-message">{status.nextAction}</p> : null}
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
          <span>Connection status</span>
          <strong>{statusLabel(status)}</strong>
          <small>{connectionHint(provider, status)}</small>
        </div>
        <button type="button" className={status.state === "ready" ? "success-button" : "secondary-button"} onClick={onTest} disabled={testing || !aiReady(provider)}>
          {status.state === "ready" ? <CheckCircle2 aria-hidden="true" focusable="false" /> : null}
          {testing ? "Testing..." : status.state === "ready" ? "Test again" : "Test connection"}
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
          <span>Connection status</span>
          <strong>{statusLabel(status)}</strong>
          <small>{connectionHint(provider, status)}</small>
        </div>
        <button type="button" className={status.state === "ready" ? "success-button" : "secondary-button"} onClick={onTest} disabled={testing || !aiReady(provider)}>
          {status.state === "ready" ? <CheckCircle2 aria-hidden="true" focusable="false" /> : null}
          {testing ? "Testing..." : status.state === "ready" ? "Test again" : "Test connection"}
        </button>
      </div>
    </div>
  );
}

function CliAIForm({ entry, status, testing, onTest }: { entry: CliAIEntrySettings; status: AIConnectionStatus; testing: boolean; onTest: () => void }) {
  return (
    <div className="provider-form-grid auth-form-grid">
      <SummaryItem label="Binary" value={entry.binaryName} />
      <SummaryItem label="Version" value={entry.version || "Not checked"} />
      <SummaryItem label="Existing auth" value={cliAuthLabel(entry)} />
      <SummaryItem label="Wrapper" value={cliWrapperLabel(entry)} />
      <SummaryItem label="Execution mode" value={entry.executionMode === "readOnly" ? "Read only" : "Not confirmed"} />
      <div className="setting-row inline-row wide">
        <div>
          <span>Readiness</span>
          <strong>{statusLabel(status)}</strong>
          <small>{status.nextAction || status.message}</small>
        </div>
        <button type="button" className={status.state === "ready" ? "success-button" : "secondary-button"} onClick={onTest} disabled={testing}>
          {status.state === "ready" ? <CheckCircle2 aria-hidden="true" focusable="false" /> : null}
          {testing ? "Checking..." : status.state === "ready" ? "Check again" : "Check readiness"}
        </button>
      </div>
    </div>
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
        <span className={status.state === "ready" ? "ready" : status.state === "failed" ? "error" : ""}>{statusLabel(status)}</span>
      </div>
      {active ? <p className="settings-message">{status.nextAction || status.message}</p> : null}
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
  if (entry === "codexCli") return "Installed CLI with read-only non-interactive execution.";
  if (entry === "claudeCli") return "Installed CLI with tool-restricted print execution.";
  if (entry === "aiApi") return "Remote API provider configured below.";
  return "Local OpenAI-compatible runtime endpoint.";
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
  if (!repositories.length) return <p className="settings-message">No registered repositories are available for read-only context.</p>;
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
    return "Ready to test this provider.";
  }
  if (!provider.baseUrl.trim()) return "Enter a local endpoint.";
  if (!provider.model.trim()) return "Choose a local model.";
  return "Ready to test this local runtime.";
}

function cliAuthLabel(entry: CliAIEntrySettings): string {
  if (entry.authState === "configured") return "Configured";
  if (entry.authState === "notConfigured") return "Not configured";
  return "Unknown";
}

function cliWrapperLabel(entry: CliAIEntrySettings): string {
  if (entry.readOnlyWrapperState === "ready") return "Read-only ready";
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

function localDefaults(runtime: string): Partial<AIProviderSettings> {
  if (runtime === "lmStudio") return { runtime: "lmStudio", baseUrl: "http://127.0.0.1:1234/v1", model: "" };
  if (runtime === "openaiLocal") return { runtime: "openaiLocal", baseUrl: "http://127.0.0.1:8000/v1", model: "" };
  if (runtime === "custom") return { runtime: "custom", baseUrl: "", model: "" };
  return { runtime: "ollama", baseUrl: "http://127.0.0.1:11434/v1", model: "" };
}

function statusLabel(status: AIConnectionStatus): string {
  if (status.state === "notConfigured") return "Needs setup";
  if (status.state === "configured") return "Needs test";
  if (status.state === "ready") return "Connected";
  return "Needs attention";
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
