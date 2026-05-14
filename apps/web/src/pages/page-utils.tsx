import { useEffect } from "react";
import type { ScrollMetrics } from "../hooks/usePreviewScrollSyncController";

export const RENDERED_PDF_ZOOM_MIN = 50;
export const RENDERED_PDF_ZOOM_MAX = 200;
export const RENDERED_PDF_ZOOM_STEP = 5;
export const RENDERED_PDF_ZOOM_DEFAULT = 80;

export type EditorHistoryState = {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
};

export function broadcastNotesListRefresh() {
  localStorage.setItem("documine_notes_list_refresh", String(Date.now()));
}

export function getStoredEditorWrapEnabled() {
  const value = window.localStorage.getItem("documine_editor_wrap");
  return value == null ? true : value !== "off";
}

export function setStoredEditorWrapEnabled(enabled: boolean) {
  window.localStorage.setItem("documine_editor_wrap", enabled ? "on" : "off");
}

export function getStoredPreviewMode() {
  const value = window.localStorage.getItem("documine_preview_mode");
  return value === "rendered-pdf" ? "rendered-pdf" : "markdown";
}

export function setStoredPreviewMode(mode: "markdown" | "rendered-pdf") {
  window.localStorage.setItem("documine_preview_mode", mode);
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
  }, [title]);
}

export function hasScrolledToNewViewport(previous: ScrollMetrics | null, next: ScrollMetrics) {
  return !previous || previous.scrollTop !== next.scrollTop;
}

export function summarizeHistoryStatus(history: EditorHistoryState): string {
  if (!history.canUndo && !history.canRedo) {
    return "No local edits yet";
  }

  const parts: string[] = [];
  if (history.canUndo) {
    parts.push(`Undo: ${history.undoLabel || "change"}`);
  }
  if (history.canRedo) {
    parts.push(`Redo: ${history.redoLabel || "change"}`);
  }
  return parts.join(" · ");
}

export function renderHistoryBadge(history: EditorHistoryState) {
  const summary = summarizeHistoryStatus(history);
  const isIdle = !history.canUndo && !history.canRedo;
  return (
    <span
      className={`history-pill ${isIdle ? "history-pill--idle" : "history-pill--active"}`}
      aria-live="polite"
      title={summary}
    >
      <span className="history-pill__dot" aria-hidden="true" />
      <span className="history-pill__label">{summary}</span>
    </span>
  );
}
