import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  apiRequest,
  buildWsUrl,
  formatDate,
  requestSharedRenderedHtmlPreview,
  type NotePayload,
  type Thread,
  type ThreadAnchor,
  uploadImage,
} from "../lib/api";
import { type CollabEditorHandle } from "../lib/collab-editor";
import { CollabTextarea } from "../components/CollabTextarea";
import { buildSharedAgentModal } from "../features/agent-instructions";
import { AnchoredCommentCanvas } from "../features/comments/AnchoredCommentCanvas";
import { preparePreviewHtml } from "../features/prepare-preview-html";
import {
  usePreviewScrollSyncController,
  type PreviewMode,
  type ScrollMetrics,
} from "../hooks/usePreviewScrollSyncController";
import {
  AgentSetupModal,
  CommentIdentityModal,
  LoadingPage,
  NewCommentThreadModal,
  RequiredShareIdentityPage,
  RenderedPreview,
} from "../components/shared-ui";
import {
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

export function SharedNotePage({ shareId, onToggleTheme }: { shareId: string; onToggleTheme: () => void }) {
  const [payload, setPayload] = useState<NotePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [identityName, setIdentityName] = useState("");
  const [identityRequired, setIdentityRequired] = useState(false);
  const [identitySaving, setIdentitySaving] = useState(false);
  const [identityError, setIdentityError] = useState("");
  useDocumentTitle(payload?.note.title || "Untitled");
  const [markdown, setMarkdown] = useState("");
  const [renderedHtml, setRenderedHtml] = useState("");
  const [connected, setConnected] = useState(false);
  const [editorWrapEnabled, setEditorWrapEnabled] = useState(() => getStoredEditorWrapEnabled());
  const [previewMode, setPreviewMode] = useState<PreviewMode>(() => getStoredPreviewMode());
  const showPreview = true;
  const {
    scrollWithMarkdownEnabled,
    previewScrollRef,
    pdfPreviewFrameRef,
    handleEditorScrollChange,
    toggleScrollWithMarkdown,
    syncPreviewScroll,
  } = usePreviewScrollSyncController(previewMode);
  const renderedPdfPreview = useCallback(
    () => requestSharedRenderedHtmlPreview(shareId, markdown),
    [markdown, shareId],
  );
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
  } = useRenderedPdfPreview({
    markdown,
    noteKey: shareId,
    previewMode,
    showPreview,
    renderPreview: renderedPdfPreview,
  });

  const [showAgentModal, setShowAgentModal] = useState(false);
  const [showComments, setShowComments] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [showIdentityModal, setShowIdentityModal] = useState(false);
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

  const loadSharedNote = useCallback(
    async (options?: { background?: boolean }) => {
      if (!options?.background) {
        setLoading(true);
        setError("");
        setPayload(null);
        setIdentityRequired(false);
        setIdentityError("");
        setIdentityName("");
        setMarkdown("");
        setRenderedHtml("");
      }
      try {
        const nextPayload = await apiRequest<NotePayload>(`/api/share/${shareId}`);
        setPayload(nextPayload);
        setIdentityRequired(false);
        setIdentityError("");
        setIdentityName(nextPayload.viewer.commenterName || "");
        setMarkdown(nextPayload.note.markdown);
        setRenderedHtml(nextPayload.note.renderedHtml ? preparePreviewHtml(nextPayload.note.renderedHtml) : "");
      } catch (cause) {
        if (cause instanceof ApiError && cause.status === 401) {
          setPayload(null);
          setIdentityRequired(true);
          setError("");
        } else {
          setError(cause instanceof Error ? cause.message : "Failed to load shared note.");
        }
      } finally {
        if (!options?.background) {
          setLoading(false);
        }
      }
    },
    [shareId],
  );

  useEffect(() => {
    void loadSharedNote();
  }, [loadSharedNote]);

  useEffect(() => {
    if (!payload || payload.note.shareAccess === "edit") {
      return;
    }

    const ws = new WebSocket(buildWsUrl(`/ws?shareId=${encodeURIComponent(shareId)}`));
    ws.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string };
        if (message.type === "updated" || message.type === "threads-updated") {
          void loadSharedNote({ background: true });
        }
      } catch {
        // ignore
      }
    });
    return () => ws.close();
  }, [loadSharedNote, payload, shareId]);

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
        const renderPayload = await apiRequest<{ ok: true; html: string }>(`/api/share/${shareId}/render`, {
          method: "POST",
          body: { markdown },
        });
        setRenderedHtml(preparePreviewHtml(renderPayload.html));
      } catch {
        // Keep last successful preview
      }
    }, renderDebounce);

    return () => window.clearTimeout(timer);
  }, [markdown, payload, previewMode, shareId, showPreview]);

  async function saveIdentity() {
    const response = await apiRequest<{ ok: true; viewer: NotePayload["viewer"] }>(`/api/share/${shareId}/identity`, {
      method: "POST",
      body: { name: identityName },
    });
    setPayload((current) => (current ? { ...current, viewer: response.viewer } : current));
    setIdentityName(response.viewer.commenterName || "");
    setShowIdentityModal(false);
  }

  async function submitRequiredIdentity() {
    setIdentitySaving(true);
    setIdentityError("");
    try {
      await saveIdentity();
      setIdentityRequired(false);
      await loadSharedNote();
    } catch (cause) {
      setIdentityError(cause instanceof Error ? cause.message : "Failed to save your name.");
    } finally {
      setIdentitySaving(false);
    }
  }

  async function createThread(anchor: ThreadAnchor, body: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/share/${shareId}/threads`, {
      method: "POST",
      body: {
        anchor,
        body,
        name: identityName,
      },
    });
    setPendingThreadAnchor(null);
    setPayload((current) => (current ? { ...current, threads: response.threads } : current));
  }

  async function replyToThread(threadId: string, parentMessageId: string, body: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(
      `/api/share/${shareId}/threads/${threadId}/replies`,
      {
        method: "POST",
        body: { parentMessageId, body, name: identityName },
      },
    );
    setPayload((current) => (current ? { ...current, threads: response.threads } : current));
  }

  async function setThreadResolved(threadId: string, resolved: boolean) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/share/${shareId}/threads/${threadId}`, {
      method: "PATCH",
      body: { resolved },
    });
    setPayload((current) => (current ? { ...current, threads: response.threads } : current));
  }

  async function deleteThread(threadId: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/share/${shareId}/threads/${threadId}`, {
      method: "DELETE",
    });
    setPayload((current) => (current ? { ...current, threads: response.threads } : current));
  }

  async function editMessage(messageId: string, body: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/share/${shareId}/messages/${messageId}`, {
      method: "PATCH",
      body: { body },
    });
    setPayload((current) => (current ? { ...current, threads: response.threads } : current));
  }

  async function deleteMessage(messageId: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/share/${shareId}/messages/${messageId}`, {
      method: "DELETE",
    });
    setPayload((current) => (current ? { ...current, threads: response.threads } : current));
  }

  function requestCreateThread(anchor: ThreadAnchor) {
    setPendingThreadAnchor(anchor);
    if (!payload?.viewer.hasCommenterIdentity) {
      setShowIdentityModal(true);
    }
  }

  if (loading) {
    return <LoadingPage message="Loading shared note" />;
  }

  if (identityRequired) {
    return (
      <RequiredShareIdentityPage
        name={identityName}
        saving={identitySaving}
        error={identityError}
        onNameChange={setIdentityName}
        onSubmit={submitRequiredIdentity}
        onToggleTheme={onToggleTheme}
      />
    );
  }

  if (error || !payload) {
    return (
      <div className="page-shell simple-page">
        <div className="simple-page-content">
          <p>{error || "Shared note not found."}</p>
        </div>
      </div>
    );
  }

  const canComment = payload.note.shareAccess === "comment" || payload.note.shareAccess === "edit";
  const isEditable = payload.note.shareAccess === "edit";
  const agentModalConfig = buildSharedAgentModal(shareId);

  return (
    <div className="app-root" data-page="public">
      <header className="topbar">
        <div className="topbar-left">
          <div className="topbar-title">{payload.note.title}</div>
          <span className="status-text">Updated {formatDate(payload.note.updatedAt)}</span>
          {isEditable ? renderHistoryBadge(editorHistory) : null}
        </div>
        <div className="topbar-right">
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
          {isEditable ? (
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
          ) : null}
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
          {isEditable ? (
            <button
              type="button"
              className={`documine-btn documine-btn--md ${scrollWithMarkdownEnabled ? "documine-btn--primary" : "documine-btn--ghost"}`}
              aria-pressed={scrollWithMarkdownEnabled}
              onClick={handleToggleScrollWithMarkdown}
            >
              {scrollWithMarkdownEnabled ? "Following markdown" : "Follow markdown"}
            </button>
          ) : null}
          <button
            type="button"
            className="documine-btn documine-btn--md documine-btn--ghost"
            onClick={() => setShowAgentModal(true)}
          >
            Agent
          </button>
          <button
            type="button"
            className="documine-btn documine-btn--md documine-btn--ghost theme-toggle"
            onClick={onToggleTheme}
          >
            Theme
          </button>
        </div>
      </header>

      {isEditable ? (
        <div className="workspace">
          <div className="editor-pane">
            {!connected ? <div className="editor-disconnected">Reconnecting...</div> : null}
            <CollabTextarea
              key={shareId}
              shareId={shareId}
              initialValue={markdown}
              wrapEnabled={editorWrapEnabled}
              onScrollMetricsChange={handleEditorScrollMetricsChange}
              onUploadImage={(file) => uploadImage(file, { shareId })}
              onEditorMount={(handle) => {
                editorHandleRef.current = handle;
              }}
              onReady={(next) => {
                setMarkdown(next.markdown);
              }}
              onTextChange={(nextMarkdown) => {
                setMarkdown(nextMarkdown);
              }}
              onConnectionChange={setConnected}
              onThreadsUpdated={() => void loadSharedNote({ background: true })}
              onHistoryChange={setEditorHistory}
            />
          </div>

          <section className="preview-stage preview-open">
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
              onClosePreview={() => undefined}
            />
            {previewMode === "rendered-pdf" ? (
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
                threads={payload.threads}
                canCreateThread={showComments && canComment}
                commentsVisible={showComments}
                showResolved={showResolved}
                emptyMessage={
                  canComment
                    ? "No comment threads yet. Select text in the preview to add one."
                    : "No comment threads yet."
                }
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
      ) : (
        <section className="preview-stage public">
          <AnchoredCommentCanvas
            renderedHtml={renderedHtml}
            previewScrollRef={previewScrollRef}
            syncPreviewScroll={syncPreviewScroll}
            threads={payload.threads}
            canCreateThread={showComments && canComment}
            commentsVisible={showComments}
            showResolved={showResolved}
            emptyMessage={
              canComment ? "No comment threads yet. Select text in the preview to add one." : "No comment threads yet."
            }
            onRequestCreateThread={requestCreateThread}
            onReply={replyToThread}
            onResolve={setThreadResolved}
            onDeleteThread={deleteThread}
            onEditMessage={editMessage}
            onDeleteMessage={deleteMessage}
          />
        </section>
      )}
      {showIdentityModal ? (
        <CommentIdentityModal
          name={identityName}
          onNameChange={setIdentityName}
          onSave={saveIdentity}
          onClose={() => {
            setShowIdentityModal(false);
            setPendingThreadAnchor(null);
          }}
        />
      ) : null}
      {pendingThreadAnchor && !showIdentityModal ? (
        <NewCommentThreadModal
          anchor={pendingThreadAnchor}
          onSubmit={createThread}
          onClose={() => setPendingThreadAnchor(null)}
        />
      ) : null}
      {showAgentModal ? <AgentSetupModal config={agentModalConfig} onClose={() => setShowAgentModal(false)} /> : null}
    </div>
  );
}
