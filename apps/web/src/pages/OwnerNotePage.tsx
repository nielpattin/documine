import { useCallback, useEffect, useRef, useState } from "react";
import {
  apiRequest,
  requestRenderedHtmlPreview,
  type NoteAsset,
  type NotePayload,
  type ShareAccess,
  type Thread,
  type ThreadAnchor,
  uploadImage,
} from "../lib/api";
import { type CollabEditorHandle, type ShareParticipant } from "../lib/collab-editor";
import { CollabTextarea } from "../components/CollabTextarea";
import { PdfExportModal } from "../features/pdf/PdfExportModal";
import { copyRenderedPreviewToClipboard } from "../features/clipboard";
import { buildOwnerAgentModal } from "../features/agent-instructions";
import { AnchoredCommentCanvas } from "../features/comments/AnchoredCommentCanvas";
import { preparePreviewHtml } from "../features/prepare-preview-html";
import {
  usePreviewScrollSyncController,
  type PreviewMode,
  type ScrollMetrics,
} from "../hooks/usePreviewScrollSyncController";
import { NoteExplorer } from "./NotesListPage";
import { AgentSetupModal, ImageAssetsModal, NewCommentThreadModal, RenderedPreview } from "../components/shared-ui";
import {
  broadcastNotesListRefresh,
  getStoredEditorWrapEnabled,
  getStoredPreviewMode,
  hasScrolledToNewViewport,
  renderHistoryBadge,
  setStoredEditorWrapEnabled,
  setStoredPreviewMode,
  type EditorHistoryState,
  useDocumentTitle,
} from "./page-utils";
import { PreviewControls } from "../features/preview/PreviewControls";
import { useRenderedPdfPreview } from "../hooks/useRenderedPdfPreview";

export function OwnerNotePage({
  noteId,
  onBack,
  onOpenNote,
  onCreateNote,
  onLogout,
  onToggleTheme,
}: {
  noteId: string;
  onBack: () => void;
  onOpenNote: (noteId: string) => void;
  onCreateNote: () => Promise<void>;
  onLogout: () => Promise<void>;
  onToggleTheme: () => void;
}) {
  const [payload, setPayload] = useState<NotePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  useDocumentTitle(title || "Untitled");
  const [shareAccess, setShareAccess] = useState<ShareAccess>("none");
  const [markdown, setMarkdown] = useState("");
  const [renderedHtml, setRenderedHtml] = useState("");
  const [saveStatus, setSaveStatus] = useState("Saved");
  const [metaSaving, setMetaSaving] = useState(false);
  const [connected, setConnected] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [previewMode, setPreviewMode] = useState<PreviewMode>(() => getStoredPreviewMode());
  const [editorWrapEnabled, setEditorWrapEnabled] = useState(() => getStoredEditorWrapEnabled());
  const {
    scrollWithMarkdownEnabled,
    previewScrollRef,
    pdfPreviewFrameRef,
    pdfPreviewFrameNodeRef,
    handleEditorScrollChange,
    toggleScrollWithMarkdown,
    syncPreviewScroll,
  } = usePreviewScrollSyncController(previewMode);
  const renderedPdfPreview = useCallback(() => requestRenderedHtmlPreview(noteId, markdown), [markdown, noteId]);
  const {
    renderedPdfUrl,
    renderedPdfZoom,
    renderedPdfLoading,
    renderedPdfError,
    renderedPdfDirty,
    renderedPdfElapsedMs,
    renderedPdfLastDurationMs,
    renderedPdfZoomOut: handleRenderedPdfZoomOut,
    renderedPdfZoomIn: handleRenderedPdfZoomIn,
    renderedPdfZoomReset: handleRenderedPdfZoomReset,
    markRenderedPdfDirty,
  } = useRenderedPdfPreview({
    markdown,
    noteKey: noteId,
    previewMode,
    showPreview,
    renderPreview: renderedPdfPreview,
  });

  const [copyPreviewStatus, setCopyPreviewStatus] = useState("Copy");
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [agentApiKey, setAgentApiKey] = useState<string | null>(null);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showAssetsModal, setShowAssetsModal] = useState(false);
  const [shareParticipants, setShareParticipants] = useState<ShareParticipant[]>([]);
  const [assets, setAssets] = useState<NoteAsset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [showComments, setShowComments] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [pendingThreadAnchor, setPendingThreadAnchor] = useState<ThreadAnchor | null>(null);
  const editorHandleRef = useRef<CollabEditorHandle | null>(null);
  const [editorHistory, setEditorHistory] = useState<EditorHistoryState>({
    canUndo: false,
    canRedo: false,
    undoLabel: null,
    redoLabel: null,
  });
  const lastEditorScrollMetricsRef = useRef<ScrollMetrics | null>(null);

  const handleEditorScrollMetricsChange = useCallback(
    (metrics: ScrollMetrics) => {
      const previousMetrics = lastEditorScrollMetricsRef.current;
      lastEditorScrollMetricsRef.current = metrics;
      if (!hasScrolledToNewViewport(previousMetrics, metrics)) {
        return;
      }

      handleEditorScrollChange({
        metrics,
        anchor: scrollWithMarkdownEnabled ? (editorHandleRef.current?.getScrollAnchor() ?? null) : null,
      });
    },
    [handleEditorScrollChange, scrollWithMarkdownEnabled],
  );

  const handleToggleScrollWithMarkdown = useCallback(() => {
    const nextEnabled = !scrollWithMarkdownEnabled;
    toggleScrollWithMarkdown();
    if (nextEnabled && lastEditorScrollMetricsRef.current) {
      handleEditorScrollChange({
        metrics: lastEditorScrollMetricsRef.current,
        anchor: editorHandleRef.current?.getScrollAnchor() ?? null,
      });
    }
  }, [handleEditorScrollChange, scrollWithMarkdownEnabled, toggleScrollWithMarkdown]);

  const handlePreviewModeChange = useCallback((mode: PreviewMode) => {
    setPreviewMode(mode);
    setStoredPreviewMode(mode);
  }, []);

  const loadAssets = useCallback(async () => {
    setAssetsLoading(true);
    try {
      const response = await apiRequest<{ ok: true; assets: NoteAsset[] }>(`/api/notes/${noteId}/assets`);
      setAssets(response.assets);
    } finally {
      setAssetsLoading(false);
    }
  }, [noteId]);

  const loadNote = useCallback(
    async (options?: { background?: boolean }) => {
      if (!options?.background) {
        setLoading(true);
        setError("");
        setPayload(null);
        setTitle("");
        setShareAccess("none");
        setMarkdown("");
        setRenderedHtml("");
        setSaveStatus("Saved");
      }
      try {
        const nextPayload = await apiRequest<NotePayload>(`/api/notes/${noteId}`);
        setPayload(nextPayload);
        setTitle(nextPayload.note.title);
        setShareAccess(nextPayload.note.shareAccess);
        setMarkdown(nextPayload.note.markdown);
        setRenderedHtml(nextPayload.note.renderedHtml ? preparePreviewHtml(nextPayload.note.renderedHtml) : "");
        setSaveStatus("Saved");
        broadcastNotesListRefresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Failed to load note.");
      } finally {
        if (!options?.background) {
          setLoading(false);
        }
      }
    },
    [noteId],
  );

  useEffect(() => {
    void loadNote();
  }, [loadNote]);

  useEffect(() => {
    if (showAssetsModal) {
      void loadAssets();
    }
  }, [loadAssets, showAssetsModal]);

  useEffect(() => {
    if (!payload || !showPreview || previewMode !== "markdown") {
      return;
    }

    if (markdown === payload.note.markdown && payload.note.renderedHtml) {
      setRenderedHtml(preparePreviewHtml(payload.note.renderedHtml));
      return;
    }

    const renderDebounce = markdown.length > 50000 ? 600 : markdown.length > 20000 ? 400 : 200;
    const timer = window.setTimeout(async () => {
      try {
        const renderPayload = await apiRequest<{ ok: true; html: string }>("/api/render", {
          method: "POST",
          body: { markdown },
        });
        setRenderedHtml(preparePreviewHtml(renderPayload.html));
      } catch {
        // Keep last successful preview
      }
    }, renderDebounce);

    return () => window.clearTimeout(timer);
  }, [markdown, payload, previewMode, showPreview]);

  async function saveMeta(partial?: { title?: string; shareAccess?: ShareAccess }) {
    if (!payload) {
      return;
    }

    const nextTitle = partial?.title ?? title;
    const nextShareAccess = partial?.shareAccess ?? shareAccess;
    if (nextTitle === payload.note.title && nextShareAccess === payload.note.shareAccess) {
      return;
    }

    setMetaSaving(true);
    setSaveStatus("Saving");
    try {
      await apiRequest(`/api/notes/${noteId}`, {
        method: "PUT",
        body: { title: nextTitle, shareAccess: nextShareAccess },
      });
      setPayload((current) =>
        current
          ? {
              ...current,
              note: { ...current.note, title: nextTitle, shareAccess: nextShareAccess },
            }
          : current,
      );
      setSaveStatus("Saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to save note settings.");
      setSaveStatus("Error");
    } finally {
      setMetaSaving(false);
    }
  }

  async function createThread(anchor: ThreadAnchor, body: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/notes/${noteId}/threads`, {
      method: "POST",
      body: { anchor, quote: anchor.quote, body },
    });
    setPendingThreadAnchor(null);
    setPayload((current) => (current ? { ...current, threads: response.threads } : current));
  }

  async function replyToThread(threadId: string, parentMessageId: string, body: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(
      `/api/notes/${noteId}/threads/${threadId}/replies`,
      {
        method: "POST",
        body: { parentMessageId, body },
      },
    );
    setPayload((current) => (current ? { ...current, threads: response.threads } : current));
  }

  async function setThreadResolved(threadId: string, resolved: boolean) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/notes/${noteId}/threads/${threadId}`, {
      method: "PATCH",
      body: { resolved },
    });
    setPayload((current) => (current ? { ...current, threads: response.threads } : current));
  }

  async function deleteThread(threadId: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/notes/${noteId}/threads/${threadId}`, {
      method: "DELETE",
    });
    setPayload((current) => (current ? { ...current, threads: response.threads } : current));
  }

  async function editMessage(messageId: string, body: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/notes/${noteId}/messages/${messageId}`, {
      method: "PATCH",
      body: { body },
    });
    setPayload((current) => (current ? { ...current, threads: response.threads } : current));
  }

  async function deleteMessage(messageId: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/notes/${noteId}/messages/${messageId}`, {
      method: "DELETE",
    });
    setPayload((current) => (current ? { ...current, threads: response.threads } : current));
  }

  const shareUrl = payload ? `${window.location.origin}/s/${payload.note.shareId}` : "";

  async function copyShareUrl() {
    if (!shareUrl) {
      return;
    }

    await navigator.clipboard.writeText(shareUrl);
  }

  async function handleCopyRenderedPreview() {
    setCopyPreviewStatus("Copying...");
    try {
      await copyRenderedPreviewToClipboard(pdfPreviewFrameNodeRef.current);
      setCopyPreviewStatus("Copied!");
    } catch (cause) {
      setCopyPreviewStatus(cause instanceof Error ? cause.message : "Copy failed");
    } finally {
      window.setTimeout(() => setCopyPreviewStatus("Copy"), 2000);
    }
  }

  function requestCreateThread(anchor: ThreadAnchor) {
    setPendingThreadAnchor(anchor);
  }

  async function handleDeleteAsset(fileName: string) {
    const response = await apiRequest<{ ok: true; assets: NoteAsset[] }>(
      `/api/notes/${noteId}/assets/${encodeURIComponent(fileName)}`,
      {
        method: "DELETE",
      },
    );
    setAssets(response.assets);
  }

  function handleInsertAsset(markdownSnippet: string) {
    editorHandleRef.current?.insertText(markdownSnippet);
  }

  const noteReady = Boolean(payload) && !loading;
  const activeThreads = payload?.threads ?? [];

  if (error && !payload) {
    return (
      <div className="page-shell simple-page">
        <div className="simple-page-content">
          <p>{error}</p>
          <button type="button" onClick={onBack}>
            Back
          </button>
        </div>
      </div>
    );
  }

  const agentModalConfig = buildOwnerAgentModal(noteId);

  return (
    <div className="app-root" data-page="editor">
      <header className="topbar">
        <div className="topbar-left">
          <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onBack}>
            Back
          </button>
          <button
            type="button"
            className="documine-btn documine-btn--sm documine-btn--ghost"
            onClick={() => setExplorerOpen((current) => !current)}
          >
            {explorerOpen ? "Hide notes" : "Notes"}
          </button>
          <button
            type="button"
            className="documine-btn documine-btn--sm documine-btn--primary"
            onClick={() => void onCreateNote()}
          >
            New note
          </button>
          <input
            className="title-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void saveMeta({ title })}
            placeholder="Untitled"
          />
          <span className="status-text">{metaSaving ? "Saving..." : saveStatus}</span>
          {renderHistoryBadge(editorHistory)}
        </div>
        <div className="topbar-right">
          <div className="share-popover-wrap">
            <button
              type="button"
              className="documine-btn documine-btn--md documine-btn--ghost"
              onClick={() => setShowShare((current) => !current)}
            >
              Share
            </button>
            {showShare ? (
              <div className="share-popover">
                <div className="share-popover-row">
                  <select
                    value={shareAccess}
                    onChange={(event) => {
                      const nextValue = event.target.value as ShareAccess;
                      setShareAccess(nextValue);
                      void saveMeta({ shareAccess: nextValue });
                    }}
                  >
                    <option value="none">Not shared</option>
                    <option value="view">View only</option>
                    <option value="comment">View and comment</option>
                    <option value="edit">Edit and comment</option>
                  </select>
                  <button type="button" onClick={() => void copyShareUrl()} disabled={shareAccess === "none"}>
                    Copy link
                  </button>
                </div>
                <p className="meta-text">{shareUrl}</p>
              </div>
            ) : null}
          </div>
          <button
            type="button"
            className="documine-btn documine-btn--md documine-btn--ghost"
            onClick={() => setShowExportModal(true)}
          >
            Print
          </button>
          <button
            type="button"
            className="documine-btn documine-btn--md documine-btn--ghost"
            onClick={() => setShowAssetsModal(true)}
          >
            Images
          </button>
          <button
            type="button"
            className="documine-btn documine-btn--md documine-btn--ghost"
            onClick={() => setShowComments((current) => !current)}
          >
            {showComments ? "Hide comments" : "Show comments"}
          </button>
          <button
            type="button"
            className="documine-btn documine-btn--md documine-btn--ghost"
            onClick={() => setShowResolved((current) => !current)}
            disabled={!showComments}
          >
            {showResolved ? "Hide resolved" : "Show resolved"}
          </button>
          <div className="documine-segmented-control" role="group" aria-label="Edit history">
            <button
              type="button"
              className="documine-btn documine-btn--md documine-btn--ghost"
              onClick={() => editorHandleRef.current?.undo()}
              disabled={!editorHistory.canUndo}
              title="Undo (Ctrl+Z)"
            >
              Undo
            </button>
            <button
              type="button"
              className="documine-btn documine-btn--md documine-btn--ghost"
              onClick={() => editorHandleRef.current?.redo()}
              disabled={!editorHistory.canRedo}
              title="Redo (Ctrl+Y or Ctrl+Shift+Z)"
            >
              Redo
            </button>
          </div>
          <div className="documine-segmented-control" role="group" aria-label="Editor line wrapping">
            <button
              type="button"
              className={`documine-btn documine-btn--md ${editorWrapEnabled ? "documine-btn--primary" : "documine-btn--ghost"}`}
              onClick={() => {
                setEditorWrapEnabled(true);
                setStoredEditorWrapEnabled(true);
              }}
            >
              Wrap
            </button>
            <button
              type="button"
              className={`documine-btn documine-btn--md ${!editorWrapEnabled ? "documine-btn--primary" : "documine-btn--ghost"}`}
              onClick={() => {
                setEditorWrapEnabled(false);
                setStoredEditorWrapEnabled(false);
              }}
            >
              No wrap
            </button>
          </div>
          <button
            type="button"
            className={`documine-btn documine-btn--md ${scrollWithMarkdownEnabled ? "documine-btn--primary" : "documine-btn--ghost"}`}
            aria-pressed={scrollWithMarkdownEnabled}
            onClick={handleToggleScrollWithMarkdown}
          >
            {scrollWithMarkdownEnabled ? "Following markdown" : "Follow markdown"}
          </button>
          <button
            type="button"
            className="documine-btn documine-btn--md documine-btn--ghost"
            onClick={() => setShowAgentModal(true)}
          >
            Agent
          </button>
          <button
            type="button"
            id="previewFab"
            className="documine-btn documine-btn--md documine-btn--ghost"
            onClick={() => setShowPreview(true)}
          >
            Preview
          </button>
          <button
            type="button"
            className="documine-btn documine-btn--md documine-btn--ghost theme-toggle"
            onClick={onToggleTheme}
          >
            Theme
          </button>
          <button
            type="button"
            className="documine-btn documine-btn--md documine-btn--ghost"
            onClick={() => void onLogout()}
          >
            Logout
          </button>
          {shareParticipants.length ? (
            <div className="presence-avatars" aria-label="People currently in this share">
              {shareParticipants.map((participant) => (
                <div
                  key={participant.clientId}
                  className="presence-avatar"
                  title={`${participant.name} · ${participant.permissionLabel}`}
                  aria-label={`${participant.name}. ${participant.permissionLabel}`}
                >
                  {participant.name.trim().charAt(0).toUpperCase() || "?"}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </header>

      <div className={`workspace ${explorerOpen ? "workspace--with-explorer" : ""}`}>
        {explorerOpen ? (
          <NoteExplorer activeNoteId={noteId} onOpenNote={onOpenNote} onCreateNote={onCreateNote} />
        ) : null}
        <div className="editor-pane">
          {noteReady ? (
            <>
              {!connected ? <div className="editor-disconnected">Reconnecting...</div> : null}
              <CollabTextarea
                key={noteId}
                noteId={noteId}
                initialValue={markdown}
                wrapEnabled={editorWrapEnabled}
                onScrollMetricsChange={handleEditorScrollMetricsChange}
                onUploadImage={async (file) => {
                  const response = await uploadImage(file, { noteId });
                  if (showAssetsModal) {
                    void loadAssets();
                  }
                  return response;
                }}
                onEditorMount={(handle) => {
                  editorHandleRef.current = handle;
                }}
                onReady={(next) => {
                  setMarkdown(next.markdown);
                }}
                onTextChange={(nextMarkdown) => {
                  setMarkdown(nextMarkdown);
                  setSaveStatus("Live");
                }}
                onConnectionChange={setConnected}
                onThreadsUpdated={() => void loadNote({ background: true })}
                onParticipantsChange={setShareParticipants}
                onHistoryChange={setEditorHistory}
              />
            </>
          ) : (
            <div className="editor-loading-state" role="status" aria-live="polite">
              <div className="editor-loading-card">
                <div className="editor-loading-title">Opening note...</div>
                <div className="editor-loading-line" />
                <div className="editor-loading-line editor-loading-line--short" />
              </div>
            </div>
          )}
        </div>

        <section className={`preview-stage ${showPreview ? "preview-open" : ""}`}>
          <PreviewControls
            previewMode={previewMode}
            onPreviewModeChange={handlePreviewModeChange}
            renderedPdfLoading={renderedPdfLoading}
            renderedPdfDirty={renderedPdfDirty}
            renderedPdfElapsedMs={renderedPdfElapsedMs}
            renderedPdfLastDurationMs={renderedPdfLastDurationMs}
            renderedPdfZoom={renderedPdfZoom}
            onRenderedPdfZoomOut={handleRenderedPdfZoomOut}
            onRenderedPdfZoomReset={handleRenderedPdfZoomReset}
            onRenderedPdfZoomIn={handleRenderedPdfZoomIn}
            showCopyButton
            copyPreviewStatus={copyPreviewStatus}
            onCopyRenderedPreview={() => void handleCopyRenderedPreview()}
            onClosePreview={() => setShowPreview(false)}
          />
          {!noteReady ? (
            <div className="preview-loading-state">Loading preview...</div>
          ) : previewMode === "rendered-pdf" ? (
            <RenderedPreview
              url={renderedPdfUrl}
              zoom={renderedPdfZoom}
              loading={renderedPdfLoading}
              error={renderedPdfError}
              dirty={renderedPdfDirty}
              iframeRef={pdfPreviewFrameRef}
            />
          ) : (
            <AnchoredCommentCanvas
              renderedHtml={renderedHtml}
              previewScrollRef={previewScrollRef}
              syncPreviewScroll={syncPreviewScroll}
              threads={activeThreads}
              canCreateThread={showComments}
              commentsVisible={showComments}
              showResolved={showResolved}
              emptyMessage="No comment threads yet. Select text in the preview to add one."
              onRequestCreateThread={requestCreateThread}
              onReply={replyToThread}
              onResolve={setThreadResolved}
              onDeleteThread={deleteThread}
              onEditMessage={editMessage}
              onDeleteMessage={deleteMessage}
            />
          )}
        </section>
      </div>
      {pendingThreadAnchor ? (
        <NewCommentThreadModal
          anchor={pendingThreadAnchor}
          onSubmit={createThread}
          onClose={() => setPendingThreadAnchor(null)}
        />
      ) : null}
      {showExportModal ? (
        <PdfExportModal
          noteId={noteId}
          markdown={markdown}
          onClose={() => {
            setShowExportModal(false);
            markRenderedPdfDirty();
          }}
        />
      ) : null}
      {showAssetsModal ? (
        <ImageAssetsModal
          assets={assets}
          loading={assetsLoading}
          onInsert={handleInsertAsset}
          onDelete={handleDeleteAsset}
          onRefresh={loadAssets}
          onClose={() => setShowAssetsModal(false)}
        />
      ) : null}
      {showAgentModal ? (
        <AgentSetupModal
          config={agentModalConfig}
          initialApiKey={agentApiKey}
          onApiKeyGenerated={setAgentApiKey}
          onClose={() => setShowAgentModal(false)}
        />
      ) : null}
    </div>
  );
}
