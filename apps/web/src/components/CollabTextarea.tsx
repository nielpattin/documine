import { useEffect, useRef } from "react";
import { createCollabEditor, type CollabEditorHandle, type ShareParticipant } from "../lib/collab-editor";

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
  const onEditorMountRef = useRef(onEditorMount);

  useEffect(() => {
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
  }, [
    onConnectionChange,
    onHistoryChange,
    onParticipantsChange,
    onReady,
    onScrollMetricsChange,
    onTextChange,
    onThreadsUpdated,
    onUploadImage,
  ]);

  useEffect(() => {
    onEditorMountRef.current = onEditorMount;
    onEditorMount?.(editorRef.current);
  }, [onEditorMount]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    if (!editorRef.current) {
      textarea.value = initialValue;
    }
  }, [initialValue]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }

    textarea.value = initialValue;
    editorRef.current = createCollabEditor(textarea, {
      noteId,
      shareId,
      onReady: (payload: { markdown: string; title: string; shareId: string }) =>
        callbacksRef.current.onReady?.(payload),
      onTextChange: (nextMarkdown: string) => {
        callbacksRef.current.onTextChange(nextMarkdown);
        callbacksRef.current.onScrollMetricsChange?.({
          scrollTop: textarea.scrollTop,
          scrollHeight: textarea.scrollHeight,
          clientHeight: textarea.clientHeight,
        });
      },
      onConnectionChange: (connected: boolean) => callbacksRef.current.onConnectionChange(connected),
      onThreadsUpdated: () => callbacksRef.current.onThreadsUpdated?.(),
      onParticipantsChange: (participants: ShareParticipant[]) =>
        callbacksRef.current.onParticipantsChange?.(participants),
      onHistoryChange: (history: EditorHistoryState) => callbacksRef.current.onHistoryChange?.(history),
      onUploadImage: callbacksRef.current.onUploadImage
        ? (file: File) => callbacksRef.current.onUploadImage!(file)
        : undefined,
    });
    onEditorMountRef.current?.(editorRef.current);

    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
      onEditorMountRef.current?.(null);
    };
  }, [noteId, shareId, initialValue]);

  useEffect(() => {
    const textarea = textareaRef.current;
    const horizontalScroll = horizontalScrollRef.current;
    const spacer = horizontalScrollSpacerRef.current;
    if (!textarea || !horizontalScroll || !spacer) {
      return;
    }

    const emitScrollMetrics = () => {
      callbacksRef.current.onScrollMetricsChange?.({
        scrollTop: textarea.scrollTop,
        scrollHeight: textarea.scrollHeight,
        clientHeight: textarea.clientHeight,
      });
    };
    const syncMetrics = () => {
      spacer.style.width = `${Math.max(textarea.scrollWidth, textarea.clientWidth)}px`;
      horizontalScroll.scrollLeft = textarea.scrollLeft;
      emitScrollMetrics();
    };
    const syncFromTextarea = () => {
      horizontalScroll.scrollLeft = textarea.scrollLeft;
      syncMetrics();
    };
    const syncFromScrollbar = () => {
      textarea.scrollLeft = horizontalScroll.scrollLeft;
    };

    syncMetrics();
    textarea.addEventListener("scroll", syncFromTextarea);
    textarea.addEventListener("input", syncMetrics);
    horizontalScroll.addEventListener("scroll", syncFromScrollbar);

    const resizeObserver = new ResizeObserver(syncMetrics);
    resizeObserver.observe(textarea);

    return () => {
      textarea.removeEventListener("scroll", syncFromTextarea);
      textarea.removeEventListener("input", syncMetrics);
      horizontalScroll.removeEventListener("scroll", syncFromScrollbar);
      resizeObserver.disconnect();
    };
  }, [wrapEnabled, initialValue]);

  return (
    <div className={`editor-textarea-shell ${wrapEnabled ? "" : "editor-textarea-shell--nowrap"}`.trim()}>
      <textarea
        ref={textareaRef}
        className={`editor-textarea ${wrapEnabled ? "" : "editor-textarea--nowrap"}`.trim()}
        spellCheck={false}
        wrap={wrapEnabled ? "soft" : "off"}
      />
      <div ref={horizontalScrollRef} className="editor-horizontal-scroll" aria-hidden={wrapEnabled}>
        <div ref={horizontalScrollSpacerRef} className="editor-horizontal-scroll-spacer" />
      </div>
    </div>
  );
}
