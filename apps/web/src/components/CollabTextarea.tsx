import { useCallback, useRef } from "react";
import { createCollabEditor, type CollabEditorHandle, type ShareParticipant } from "../lib/collab-editor";
import { useMountEffect } from "../hooks/useMountEffect";

export type EditorHistoryState = {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
};

export type CollabTextareaProps = {
  noteId?: string;
  shareId?: string;
  initialValue: string;
  wrapEnabled: boolean;
  onReady?: (payload: { markdown: string; title: string; shareId: string }) => void;
  onTextChange: (markdown: string) => void;
  onConnectionChange: (connected: boolean) => void;
  onThreadsUpdated?: () => void;
  onParticipantsChange?: (participants: ShareParticipant[]) => void;
  onHistoryChange?: (history: EditorHistoryState) => void;
  onScrollMetricsChange?: (metrics: { scrollTop: number; scrollHeight: number; clientHeight: number }) => void;
  onUploadImage?: (file: File) => Promise<{ ok: true; asset: { url: string; markdown: string } }>;
  onEditorMount?: (handle: CollabEditorHandle | null) => void;
};

export function CollabTextarea({
  noteId,
  shareId,
  initialValue,
  wrapEnabled,
  onReady,
  onTextChange,
  onConnectionChange,
  onThreadsUpdated,
  onParticipantsChange,
  onHistoryChange,
  onScrollMetricsChange,
  onUploadImage,
  onEditorMount,
}: CollabTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const horizontalScrollRef = useRef<HTMLDivElement | null>(null);
  const horizontalScrollSpacerRef = useRef<HTMLDivElement | null>(null);
  const editorRef = useRef<CollabEditorHandle | null>(null);

  // Store latest callbacks in ref for external system (collab editor) to use
  // This avoids stale closures without recreating the editor
  const callbacksRef = useRef({
    onReady,
    onTextChange,
    onConnectionChange,
    onThreadsUpdated,
    onParticipantsChange,
    onHistoryChange,
    onScrollMetricsChange,
    onUploadImage,
  });
  callbacksRef.current = {
    onReady,
    onTextChange,
    onConnectionChange,
    onThreadsUpdated,
    onParticipantsChange,
    onHistoryChange,
    onScrollMetricsChange,
    onUploadImage,
  };

  const onEditorMountRef = useRef(onEditorMount);
  onEditorMountRef.current = onEditorMount;

  // Editor creation: mount-time external system setup
  useMountEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.value = initialValue;
    editorRef.current = createCollabEditor(textarea, {
      noteId,
      shareId,
      onReady: (payload) => callbacksRef.current.onReady?.(payload),
      onTextChange: (nextMarkdown) => {
        callbacksRef.current.onTextChange(nextMarkdown);
        callbacksRef.current.onScrollMetricsChange?.({
          scrollTop: textarea.scrollTop,
          scrollHeight: textarea.scrollHeight,
          clientHeight: textarea.clientHeight,
        });
      },
      onConnectionChange: (connected) => callbacksRef.current.onConnectionChange(connected),
      onThreadsUpdated: () => callbacksRef.current.onThreadsUpdated?.(),
      onParticipantsChange: (participants) => callbacksRef.current.onParticipantsChange?.(participants),
      onHistoryChange: (history) => callbacksRef.current.onHistoryChange?.(history),
      onUploadImage: callbacksRef.current.onUploadImage
        ? (file) => callbacksRef.current.onUploadImage!(file)
        : undefined,
    });
    onEditorMountRef.current?.(editorRef.current);

    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
      onEditorMountRef.current?.(null);
    };
  });

  // Horizontal scroll sync: DOM side effect via callback ref (React 19+ cleanup)
  const horizontalScrollCallbackRef = useCallback((node: HTMLDivElement | null) => {
    horizontalScrollRef.current = node;
    if (!node) return;

    const textarea = textareaRef.current;
    const spacer = horizontalScrollSpacerRef.current;
    if (!textarea || !spacer) return;

    const emitScrollMetrics = () => {
      callbacksRef.current.onScrollMetricsChange?.({
        scrollTop: textarea.scrollTop,
        scrollHeight: textarea.scrollHeight,
        clientHeight: textarea.clientHeight,
      });
    };
    const syncMetrics = () => {
      spacer.style.width = `${Math.max(textarea.scrollWidth, textarea.clientWidth)}px`;
      node.scrollLeft = textarea.scrollLeft;
      emitScrollMetrics();
    };
    const syncFromTextarea = () => {
      node.scrollLeft = textarea.scrollLeft;
      syncMetrics();
    };
    const syncFromScrollbar = () => {
      textarea.scrollLeft = node.scrollLeft;
    };

    syncMetrics();
    textarea.addEventListener("scroll", syncFromTextarea);
    textarea.addEventListener("input", syncMetrics);
    node.addEventListener("scroll", syncFromScrollbar);

    const resizeObserver = new ResizeObserver(syncMetrics);
    resizeObserver.observe(textarea);

    return () => {
      textarea.removeEventListener("scroll", syncFromTextarea);
      textarea.removeEventListener("input", syncMetrics);
      node.removeEventListener("scroll", syncFromScrollbar);
      resizeObserver.disconnect();
    };
  }, []);

  const horizontalScrollSpacerCallbackRef = useCallback((node: HTMLDivElement | null) => {
    horizontalScrollSpacerRef.current = node;
  }, []);

  return (
    <div className={`editor-textarea-shell ${wrapEnabled ? "" : "editor-textarea-shell--nowrap"}`.trim()}>
      <textarea
        ref={textareaRef}
        className={`editor-textarea ${wrapEnabled ? "" : "editor-textarea--nowrap"}`.trim()}
        spellCheck={false}
        wrap={wrapEnabled ? "soft" : "off"}
      />
      <div ref={horizontalScrollCallbackRef} className="editor-horizontal-scroll" aria-hidden={wrapEnabled}>
        <div ref={horizontalScrollSpacerCallbackRef} className="editor-horizontal-scroll-spacer" />
      </div>
    </div>
  );
}
