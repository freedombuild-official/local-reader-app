import { useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import MarkdownIt from "markdown-it";
import { Send, Square, RotateCcw } from "lucide-react";
import { sendAIChatMessage } from "./api";
import { activeAIChatTarget, activeAIEntry, aiReady, derivedAIStatus, effectiveAIStatus, type AISettingsState } from "./settingsState";
import type { AIChatMessage, AIChatResponse, FileResponse } from "./types";
import { injectMarkdownCodeToolbarButtons, installCodeBlockRule } from "../shared/markdownCodeBlocks";
import { installTableScrollRule } from "../shared/markdownTableScroll";

type AIChatPanelProps = {
  aiSettings: AISettingsState;
  activeRepoId: string;
  activeFile: FileResponse | null;
  onOpenSettings: () => void;
  onMarkdownClick: (event: ReactMouseEvent<HTMLElement>) => void;
};

const aiMarkdown = new MarkdownIt({ html: false, linkify: true });
installTableScrollRule(aiMarkdown);
installCodeBlockRule(aiMarkdown);

export function AIChatPanel({ aiSettings, activeRepoId, activeFile, onOpenSettings, onMarkdownClick }: AIChatPanelProps) {
  const [messages, setMessages] = useState<AIChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [lastRequest, setLastRequest] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const activeEntry = activeAIEntry(aiSettings);
  const target = activeAIChatTarget(aiSettings);
  const status = activeEntry ? effectiveAIStatus(aiSettings, activeEntry.entry) : derivedAIStatus(null);
  const ready = Boolean(target && aiReady(activeEntry));
  const statusMessage = status.message;
  const canSend = Boolean(ready && activeRepoId && activeFile?.path && draft.trim() && !pending);
  const contextLabel = activeFile ? `${activeFile.path} (${activeFile.kind})` : "No active file";

  async function sendMessage(content: string) {
    if (!target || !ready) {
      setError(statusMessage || "Select and configure an AI Entry in Settings before sending a message.");
      return;
    }
    if (!activeRepoId || !activeFile?.path) {
      setError("Open a repository file before sending a message.");
      return;
    }
    const userMessage: AIChatMessage = { role: "user", content };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setDraft("");
    setPending(true);
    setError("");
    setLastRequest(content);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response: AIChatResponse = await sendAIChatMessage(
        {
          target,
          messages: nextMessages,
          context: { repoId: activeRepoId, path: activeFile.path, includeContent: true },
        },
        controller.signal,
      );
      setMessages((current) => [...current, response.message]);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : String(nextError));
    } finally {
      setPending(false);
      abortRef.current = null;
    }
  }

  function cancelRequest() {
    abortRef.current?.abort();
    setPending(false);
  }

  const renderedMessages = useMemo(
    () =>
      messages.map((message, index) => ({
        ...message,
        id: `${message.role}-${index}`,
        html: renderAIMessage(message.content),
      })),
    [messages],
  );

  return (
    <section className="ai-chat-panel" aria-label="AI Chat">
      <div className="ai-chat-context">
        <span>Read-only context</span>
        <strong>{contextLabel}</strong>
      </div>
      {!ready ? (
        <div className="ai-chat-empty">
          <p>AI Chat needs an active AI Entry before it can answer from the active file context.</p>
          <p>{statusMessage}</p>
          <button type="button" className="secondary-button" onClick={onOpenSettings}>
            Open AI Chat Settings
          </button>
        </div>
      ) : null}
      <div className="ai-chat-messages" aria-live="polite">
        {renderedMessages.length ? (
          renderedMessages.map((message) => (
            <article key={message.id} className={`ai-message ${message.role}`}>
              <span>{message.role === "user" ? "You" : "AI"}</span>
              <div className="markdown-body ai-message-body" onClick={onMarkdownClick} dangerouslySetInnerHTML={{ __html: message.html }} />
            </article>
          ))
        ) : (
          <p className="ai-chat-placeholder">Ask about the active file. Reader-Wiki sends read-only context only.</p>
        )}
      </div>
      {error ? (
        <div className="ai-chat-error">
          <span>{error}</span>
          {lastRequest ? (
            <button type="button" className="icon-button" aria-label="Retry AI Chat request" title="Retry AI Chat request" onClick={() => void sendMessage(lastRequest)}>
              <RotateCcw aria-hidden="true" focusable="false" />
            </button>
          ) : null}
        </div>
      ) : null}
      <form
        className="ai-chat-composer"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) void sendMessage(draft.trim());
        }}
      >
        <textarea aria-label="AI Chat message" value={draft} rows={3} onChange={(event) => setDraft(event.target.value)} placeholder="Ask about the active file..." />
        {pending ? (
          <button type="button" className="icon-button" aria-label="Cancel AI Chat request" title="Cancel AI Chat request" onClick={cancelRequest}>
            <Square aria-hidden="true" focusable="false" />
          </button>
        ) : (
          <button type="submit" className="icon-button" aria-label="Send AI Chat message" title="Send AI Chat message" disabled={!canSend}>
            <Send aria-hidden="true" focusable="false" />
          </button>
        )}
      </form>
    </section>
  );
}

function renderAIMessage(content: string): string {
  return injectMarkdownCodeToolbarButtons(aiMarkdown.render(content));
}
