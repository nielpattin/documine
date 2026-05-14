import { renderHistoryBadge, type EditorHistoryState } from "./page-utils";
import { type ShareParticipant } from "../lib/collab-editor";
import type { ShareAccess } from "../lib/api";

export function OwnerNoteTopbar({
  title,
  onTitleChange,
  onTitleBlur,
  metaSaving,
  saveStatus,
  editorHistory,
  explorerOpen,
  onToggleExplorer,
  onBack,
  onCreateNote,
  showShare,
  onToggleShowShare,
  shareAccess,
  onShareAccessChange,
  shareUrl,
  onOpenExportModal,
  onOpenAssetsModal,
  showComments,
  onToggleComments,
  showResolved,
  onToggleResolved,
  editorWrapEnabled,
  onWrap,
  onNoWrap,
  scrollWithMarkdownEnabled,
  onToggleScrollWithMarkdown,
  onOpenAgentModal,
  onShowPreview,
  onToggleTheme,
  onLogout,
  shareParticipants,
}: {
  title: string;
  onTitleChange: (value: string) => void;
  onTitleBlur: () => void;
  metaSaving: boolean;
  saveStatus: string;
  editorHistory: EditorHistoryState;
  explorerOpen: boolean;
  onToggleExplorer: () => void;
  onBack: () => void;
  onCreateNote: () => Promise<void>;
  showShare: boolean;
  onToggleShowShare: () => void;
  shareAccess: ShareAccess;
  onShareAccessChange: (value: ShareAccess) => void;
  shareUrl: string;
  onOpenExportModal: () => void;
  onOpenAssetsModal: () => void;
  showComments: boolean;
  onToggleComments: () => void;
  showResolved: boolean;
  onToggleResolved: () => void;
  editorWrapEnabled: boolean;
  onWrap: () => void;
  onNoWrap: () => void;
  scrollWithMarkdownEnabled: boolean;
  onToggleScrollWithMarkdown: () => void;
  onOpenAgentModal: () => void;
  onShowPreview: () => void;
  onToggleTheme: () => void;
  onLogout: () => void;
  shareParticipants: ShareParticipant[];
}) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onBack}>
          Back
        </button>
        <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onToggleExplorer}>
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
          onChange={(event) => onTitleChange(event.target.value)}
          onBlur={onTitleBlur}
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
            onClick={onToggleShowShare}
          >
            Share
          </button>
          {showShare ? (
            <div className="share-popover">
              <div className="share-popover-row">
                <select
                  value={shareAccess}
                  onChange={(event) => onShareAccessChange(event.target.value as ShareAccess)}
                >
                  <option value="none">Not shared</option>
                  <option value="view">View only</option>
                  <option value="comment">View and comment</option>
                  <option value="edit">Edit and comment</option>
                </select>
                <button
                  type="button"
                  onClick={() => void navigator.clipboard.writeText(shareUrl)}
                  disabled={shareAccess === "none"}
                >
                  Copy link
                </button>
              </div>
              <p className="meta-text">{shareUrl}</p>
            </div>
          ) : null}
        </div>
        <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={onOpenExportModal}>
          Print
        </button>
        <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={onOpenAssetsModal}>
          Images
        </button>
        <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={onToggleComments}>
          {showComments ? "Hide comments" : "Show comments"}
        </button>
        <button
          type="button"
          className="documine-btn documine-btn--md documine-btn--ghost"
          onClick={onToggleResolved}
          disabled={!showComments}
        >
          {showResolved ? "Hide resolved" : "Show resolved"}
        </button>
        <div className="documine-segmented-control" role="group" aria-label="Edit history">
          <button
            type="button"
            className="documine-btn documine-btn--md documine-btn--ghost"
            onClick={() => void 0}
            disabled={!editorHistory.canUndo}
            title="Undo (Ctrl+Z)"
          >
            Undo
          </button>
          <button
            type="button"
            className="documine-btn documine-btn--md documine-btn--ghost"
            onClick={() => void 0}
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
            onClick={onWrap}
          >
            Wrap
          </button>
          <button
            type="button"
            className={`documine-btn documine-btn--md ${!editorWrapEnabled ? "documine-btn--primary" : "documine-btn--ghost"}`}
            onClick={onNoWrap}
          >
            No wrap
          </button>
        </div>
        <button
          type="button"
          className={`documine-btn documine-btn--md ${scrollWithMarkdownEnabled ? "documine-btn--primary" : "documine-btn--ghost"}`}
          aria-pressed={scrollWithMarkdownEnabled}
          onClick={onToggleScrollWithMarkdown}
        >
          {scrollWithMarkdownEnabled ? "Following markdown" : "Follow markdown"}
        </button>
        <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={onOpenAgentModal}>
          Agent
        </button>
        <button
          type="button"
          id="previewFab"
          className="documine-btn documine-btn--md documine-btn--ghost"
          onClick={onShowPreview}
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
        <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={onLogout}>
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
  );
}
