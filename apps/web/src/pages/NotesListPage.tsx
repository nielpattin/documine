import { useCallback, useEffect, useState } from "react";
import { apiRequest, exportNotes, formatDate, importNotes, type ApiKey, type NoteSummary } from "../lib/api";

function broadcastNotesListRefresh() {
  localStorage.setItem("documine_notes_list_refresh", String(Date.now()));
}

function useNotesListRefreshSignal(onRefresh: () => void) {
  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key === "documine_notes_list_refresh") {
        onRefresh();
      }
    }
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [onRefresh]);
}

export function NotesListPage({
  onOpenNote,
  onLogout,
  onToggleTheme,
}: {
  onOpenNote: (noteId: string) => void;
  onLogout: () => Promise<void>;
  onToggleTheme: () => void;
}) {
  const [search, setSearch] = useState("");
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);
  const [selectedNoteIds, setSelectedNoteIds] = useState<Set<string>>(() => new Set());
  const [transferStatus, setTransferStatus] = useState("");
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const selectedCount = selectedNoteIds.size;

  const loadNotes = useCallback(async (query: string) => {
    setLoading(true);
    setError("");
    try {
      const payload = await apiRequest<{ ok: true; notes: NoteSummary[] }>(`/api/notes?q=${encodeURIComponent(query)}`);
      setNotes(payload.notes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load notes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useNotesListRefreshSignal(() => {
    void loadNotes(search);
  });

  const loadKeys = useCallback(async () => {
    setKeysLoading(true);
    try {
      const payload = await apiRequest<{ ok: true; keys: ApiKey[] }>("/api/keys");
      setApiKeys(payload.keys);
    } finally {
      setKeysLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadNotes(search);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [loadNotes, search]);

  useEffect(() => {
    if (showSettings) {
      void loadKeys();
    }
  }, [loadKeys, showSettings]);

  async function handleCreateNote() {
    const payload = await apiRequest<{ ok: true; note: NoteSummary }>("/api/notes", { method: "POST" });
    onOpenNote(payload.note.id);
  }

  async function handleDeleteNote(noteId: string) {
    if (!window.confirm("Delete this note?")) {
      return;
    }

    await apiRequest(`/api/notes/${noteId}`, { method: "DELETE" });
    setSelectedNoteIds((current) => {
      const next = new Set(current);
      next.delete(noteId);
      return next;
    });
    await loadNotes(search);
  }

  function toggleSelectedNote(noteId: string) {
    setSelectedNoteIds((current) => {
      const next = new Set(current);
      if (next.has(noteId)) {
        next.delete(noteId);
      } else {
        next.add(noteId);
      }
      return next;
    });
  }

  function downloadBlob(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  async function handleExport(scope: "all" | "selected") {
    if (scope === "selected" && selectedNoteIds.size === 0) {
      setTransferStatus("Select at least one note to export.");
      return;
    }
    setExporting(true);
    setTransferStatus("Exporting...");
    try {
      const result = await exportNotes(scope, Array.from(selectedNoteIds));
      downloadBlob(result.blob, result.fileName);
      setTransferStatus("");
    } catch (cause) {
      setTransferStatus(cause instanceof Error ? cause.message : "Could not export notes. Try again.");
    } finally {
      setExporting(false);
    }
  }

  async function handleImport(file: File | null) {
    if (!file) {
      return;
    }
    setImporting(true);
    setTransferStatus("Importing...");
    try {
      const result = await importNotes(file);
      const issueText =
        result.skipped.length || result.warnings.length
          ? `, skipped ${result.skipped.length}, with ${result.warnings.length} warnings`
          : "";
      setTransferStatus(`Imported ${result.imported.length} notes${issueText}.`);
      broadcastNotesListRefresh();
      await loadNotes(search);
    } catch (cause) {
      setTransferStatus(cause instanceof Error ? cause.message : "This file is not a valid Documine notes export.");
    } finally {
      setImporting(false);
    }
  }

  async function handleCreateKey() {
    const label = window.prompt("Label for this API key:")?.trim();
    if (!label) {
      return;
    }

    const payload = await apiRequest<{ ok: true; id: string; key: string }>("/api/keys", {
      method: "POST",
      body: { label },
    });
    await loadKeys();
    await navigator.clipboard.writeText(payload.key).catch(() => undefined);
    window.alert(`New API key copied to your clipboard.\n\n${payload.key}`);
  }

  async function handleDeleteKey(keyId: string) {
    if (!window.confirm("Delete this API key?")) {
      return;
    }

    await apiRequest(`/api/keys/${keyId}`, { method: "DELETE" });
    await loadKeys();
  }

  return (
    <div className="app-root">
      <header className="topbar">
        <div className="topbar-left">
          <div className="topbar-title">notes</div>
        </div>
        <div className="topbar-right">
          <label className="documine-btn documine-btn--md documine-btn--ghost import-button">
            {importing ? "Importing..." : "Import"}
            <input
              type="file"
              accept=".zip,application/zip"
              hidden
              disabled={importing}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0] || null;
                event.currentTarget.value = "";
                void handleImport(file);
              }}
            />
          </label>
          <button
            type="button"
            className="documine-btn documine-btn--md documine-btn--ghost"
            disabled={exporting}
            onClick={() => void handleExport("all")}
          >
            Export all
          </button>
          <button
            type="button"
            className="documine-btn documine-btn--md documine-btn--primary"
            onClick={() => void handleCreateNote()}
          >
            New note
          </button>
          <button
            type="button"
            className="documine-btn documine-btn--md documine-btn--ghost"
            onClick={() => setShowSettings(true)}
          >
            Settings
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
        </div>
      </header>

      <main className="list-page">
        <div className="list-search-wrap">
          <input
            className="list-search"
            type="text"
            placeholder="Search notes"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>

        {transferStatus ? <p className="empty-state">{transferStatus}</p> : null}

        {selectedCount > 0 ? (
          <div className="selection-toolbar">
            <span>{selectedCount} selected</span>
            <button
              type="button"
              className="documine-btn documine-btn--sm documine-btn--primary"
              disabled={exporting}
              onClick={() => void handleExport("selected")}
            >
              {exporting ? "Exporting..." : "Export selected"}
            </button>
            <button
              type="button"
              className="documine-btn documine-btn--sm documine-btn--ghost"
              onClick={() => setSelectedNoteIds(new Set())}
            >
              Clear selection
            </button>
          </div>
        ) : null}

        {error ? <p className="empty-state">{error}</p> : null}

        {loading ? <p className="empty-state">Loading notes...</p> : null}

        {!loading && notes.length === 0 ? (
          <div className="empty-state-create">
            <p className="empty-state-text">No notes yet.</p>
            <button type="button" className="primary" onClick={() => void handleCreateNote()}>
              Create your first note
            </button>
          </div>
        ) : null}

        <div className="note-list">
          {notes.map((note) => (
            <div key={note.id} className="note-row" onClick={() => onOpenNote(note.id)}>
              <label className="note-row-select" onClick={(event) => event.stopPropagation()}>
                <input
                  type="checkbox"
                  checked={selectedNoteIds.has(note.id)}
                  onChange={() => toggleSelectedNote(note.id)}
                  aria-label={`Select ${note.title}`}
                />
              </label>
              <div className="note-row-content">
                <div className="note-row-title">
                  {note.title}
                  {note.isImportedUnread ? <span className="imported-badge">Imported</span> : null}
                </div>
                <div className="note-row-snippet">{note.snippet || "Empty note"}</div>
                <div className="note-row-meta">{formatDate(note.updatedAt)}</div>
              </div>
              <div>
                <button
                  type="button"
                  className="documine-btn documine-btn--sm documine-btn--danger"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDeleteNote(note.id);
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </main>

      {showSettings ? (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal settings-modal" onClick={(event) => event.stopPropagation()}>
            <div className="settings-header">
              <h2 className="settings-title">Settings</h2>
              <button
                type="button"
                className="documine-btn documine-btn--sm documine-btn--ghost"
                onClick={() => setShowSettings(false)}
              >
                Close
              </button>
            </div>
            <div className="settings-section-header">
              <h3 className="settings-section-title">API Keys</h3>
              <button
                type="button"
                className="documine-btn documine-btn--sm documine-btn--ghost"
                onClick={() => void handleCreateKey()}
              >
                New key
              </button>
            </div>
            {keysLoading ? <p className="api-keys-empty">Loading...</p> : null}
            {!keysLoading && apiKeys.length === 0 ? <p className="api-keys-empty">No API keys yet.</p> : null}
            {apiKeys.map((key) => (
              <div key={key.id} className="api-key-row">
                <div className="api-key-info">
                  <span className="api-key-label">{key.label}</span>
                  <span className="api-key-meta">{formatDate(key.createdAt)}</span>
                </div>
                <button
                  type="button"
                  className="documine-btn documine-btn--sm documine-btn--danger"
                  onClick={() => void handleDeleteKey(key.id)}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function useNoteExplorerNotes() {
  const [search, setSearch] = useState("");
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadNotes = useCallback(async (query: string) => {
    setLoading(true);
    setError("");
    try {
      const payload = await apiRequest<{ ok: true; notes: NoteSummary[] }>(`/api/notes?q=${encodeURIComponent(query)}`);
      setNotes(payload.notes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Failed to load notes.");
    } finally {
      setLoading(false);
    }
  }, []);

  useNotesListRefreshSignal(() => {
    void loadNotes(search);
  });

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadNotes(search);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [loadNotes, search]);

  return { search, setSearch, notes, loading, error };
}

export function NoteExplorer({
  activeNoteId,
  onOpenNote,
  onCreateNote,
}: {
  activeNoteId: string;
  onOpenNote: (noteId: string) => void;
  onCreateNote: () => Promise<void>;
}) {
  const { search, setSearch, notes, loading, error } = useNoteExplorerNotes();

  return (
    <aside className="note-explorer" aria-label="Notes explorer">
      <div className="note-explorer-header">
        <div className="note-explorer-title">Notes</div>
        <button
          type="button"
          className="documine-btn documine-btn--sm documine-btn--primary"
          onClick={() => void onCreateNote()}
        >
          New note
        </button>
      </div>
      <input
        className="note-explorer-search"
        type="text"
        placeholder="Search notes"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="note-explorer-list">
        {loading ? <p className="note-explorer-status">Loading notes...</p> : null}
        {error ? <p className="note-explorer-status">{error}</p> : null}
        {!loading && notes.length === 0 ? <p className="note-explorer-status">No notes found.</p> : null}
        {notes.map((note) => (
          <button
            key={note.id}
            type="button"
            className={`note-explorer-row ${note.id === activeNoteId ? "active" : ""}`}
            aria-current={note.id === activeNoteId ? "page" : undefined}
            onClick={() => onOpenNote(note.id)}
          >
            <span className="note-explorer-row-title">{note.title}</span>
            <span className="note-explorer-row-snippet">{note.snippet || "Empty note"}</span>
            <span className="note-explorer-row-meta">{formatDate(note.updatedAt)}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}
