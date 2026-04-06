import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import {
  apiRequest,
  buildWsUrl,
  deleteNotePdf,
  formatDate,
  getApiHttpOrigin,
  listNotePdfExports,
  saveNotePdf,
  type ApiKey,
  type NoteAsset,
  type NotePayload,
  type NotePdfExport,
  type NoteSummary,
  type PdfExportCodeWrapMode,
  type PdfExportHeaderMode,
  type PdfExportImageAlignment,
  type PdfExportSettings,
  type PdfExportSettingsPayload,
  type ShareAccess,
  type Thread,
  type ThreadAnchor,
  type ThreadMessage,
  type ViewerPayload,
  uploadImage,
} from './lib/api';
import { createCollabEditor, type CollabEditorHandle } from './lib/collab-editor';

const FALLBACK_OWNER_TOKEN_KEY = 'documine_owner_token';

type Route =
  | { kind: 'login' }
  | { kind: 'list' }
  | { kind: 'note'; noteId: string }
  | { kind: 'share'; shareId: string };

type CollabTextareaProps = {
  noteId?: string;
  shareId?: string;
  initialValue: string;
  onReady?: (payload: { markdown: string; title: string; shareId: string }) => void;
  onTextChange: (markdown: string) => void;
  onConnectionChange: (connected: boolean) => void;
  onThreadsUpdated?: () => void;
  onUploadImage?: (file: File) => Promise<{ ok: true; asset: { url: string; markdown: string } }>;
  onEditorMount?: (handle: CollabEditorHandle | null) => void;
};

type AgentModalConfig = {
  title: string;
  hint: string;
  requiresApiKey?: boolean;
  buildInstructions: (apiKey: string | null) => string;
};

function buildOwnerAgentModal(noteId: string): AgentModalConfig {
  const apiBaseUrl = getApiHttpOrigin();
  return {
    title: 'Agent setup',
    hint: 'Generate an owner API key below. It is only shown once. Then copy the fully connected instructions.',
    requiresApiKey: true,
    buildInstructions: (apiKey) => [
      '# Install the CLI globally',
      'pnpm add -g documine',
      '',
      '# Register this Documine instance using the generated owner API key',
      `documine register my-documine ${apiBaseUrl} ${apiKey || '<generate-api-key-first>'}`,
      '',
      '# Read this note',
      `documine my-documine read ${noteId}`,
      '',
      '# Edit this note',
      `documine my-documine edit ${noteId} '[{"oldText":"...","newText":"..."}]'`,
      '',
      '# Comment on quoted text',
      `documine my-documine comment ${noteId} "quoted text" "comment body"`,
      '',
      '# Reply to a specific message',
      `documine my-documine reply ${noteId} <thread-id> <message-id> "reply"`,
      '',
      '# Resolve or reopen a thread',
      `documine my-documine resolve ${noteId} <thread-id>`,
      `documine my-documine reopen ${noteId} <thread-id>`,
      '',
      '# Edit or delete comments',
      `documine my-documine edit-comment ${noteId} <message-id> "new body"`,
      `documine my-documine delete-comment ${noteId} <message-id>`,
      `documine my-documine delete-thread ${noteId} <thread-id>`,
      '',
      '# Full command reference',
      'documine --help',
    ].join('\n'),
  };
}

function buildSharedAgentModal(shareId: string): AgentModalConfig {
  const apiBaseUrl = getApiHttpOrigin();
  const shareUrl = `${apiBaseUrl}/s/${shareId}`;
  return {
    title: 'Agent setup',
    hint: 'This shared note does not need an API key. Copy these instructions directly.',
    buildInstructions: () => [
      '# Install the CLI globally',
      'pnpm add -g documine',
      '',
      '# Register the shared note',
      `documine register shared-note ${shareUrl}`,
      '',
      '# Read the note',
      'documine shared-note read',
      '',
      '# Edit the note if edit access is enabled',
      'documine shared-note edit \'' + '[{"oldText":"...","newText":"..."}]' + '\'',
      '',
      '# Comment and reply as an agent',
      'documine shared-note comment "quoted text" "comment body" --name="My Agent"',
      'documine shared-note reply <thread-id> <message-id> "reply" --name="My Agent"',
      '',
      '# Full command reference',
      'documine --help',
    ].join('\n'),
  };
}

function preparePreviewHtml(html: string) {
  if (!html || typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    return html;
  }

  const document = new DOMParser().parseFromString(html, 'text/html');
  const images = Array.from(document.querySelectorAll('img'));
  for (const image of images) {
    let sibling: ChildNode | null = image.nextSibling;
    while (sibling && sibling.nodeType === Node.TEXT_NODE) {
      const text = sibling.textContent || '';
      const match = text.match(/^\s*\{([^{}]+)\}(.*)$/s);
      if (!match) {
        break;
      }
      const hint = match[1]?.trim();
      if (hint && !image.getAttribute('title')) {
        image.setAttribute('title', hint);
      }
      const rest = match[2] || '';
      if (rest.trim()) {
        sibling.textContent = rest;
        break;
      }
      const nextSibling = sibling.nextSibling;
      sibling.parentNode?.removeChild(sibling);
      sibling = nextSibling;
    }
  }

  return document.body.innerHTML;
}

function AgentSetupModal({ config, onClose }: { config: AgentModalConfig; onClose: () => void }) {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const instructions = config.buildInstructions(apiKey);

  async function generateApiKey() {
    setIsGenerating(true);
    try {
      const payload = await apiRequest<{ ok: true; id: string; key: string }>(`/api/keys`, {
        method: 'POST',
        body: { label: 'agent-cli' },
      });
      setApiKey(payload.key);
    } finally {
      setIsGenerating(false);
    }
  }

  async function copyInstructions() {
    await navigator.clipboard.writeText(instructions);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal agent-modal" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <h2 className="settings-title">{config.title}</h2>
          <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <p className="agent-hint">{config.hint}</p>
        {config.requiresApiKey ? (
          <>
            <div className="modal-actions" style={{ marginBottom: '0.75rem' }}>
              <button type="button" className="documine-btn documine-btn--md documine-btn--primary" onClick={() => void generateApiKey()} disabled={isGenerating}>
                {isGenerating ? 'Generating...' : apiKey ? 'Generate another API key' : 'Generate API key'}
              </button>
            </div>
            {apiKey ? <pre className="agent-instructions"><code>{apiKey}</code></pre> : null}
          </>
        ) : null}
        <pre className="agent-instructions"><code>{instructions}</code></pre>
        <button type="button" className="documine-btn documine-btn--md documine-btn--primary" onClick={() => void copyInstructions()} disabled={Boolean(config.requiresApiKey && !apiKey)}>
          Copy to clipboard
        </button>
      </div>
    </div>
  );
}

function parseRoute(pathname: string): Route {
  if (pathname === '/login') {
    return { kind: 'login' };
  }

  const noteMatch = pathname.match(/^\/notes\/([^/]+)$/);
  if (noteMatch) {
    return { kind: 'note', noteId: decodeURIComponent(noteMatch[1]) };
  }

  const shareMatch = pathname.match(/^\/s\/([^/]+)$/);
  if (shareMatch) {
    return { kind: 'share', shareId: decodeURIComponent(shareMatch[1]) };
  }

  return { kind: 'list' };
}

function getStoredTheme() {
  return window.localStorage.getItem('md_theme') || 'dark';
}

function applyTheme(theme: string) {
  document.documentElement.setAttribute('data-theme', theme);
  window.localStorage.setItem('md_theme', theme);
}

function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [viewerPayload, setViewerPayload] = useState<ViewerPayload | null>(null);
  const [viewerLoading, setViewerLoading] = useState(true);
  const [theme, setTheme] = useState(() => getStoredTheme());

  const navigate = useCallback((nextPath: string, replace = false) => {
    if (replace) {
      window.history.replaceState({}, '', nextPath);
    } else {
      window.history.pushState({}, '', nextPath);
    }
    setRoute(parseRoute(window.location.pathname));
  }, []);

  const refreshViewer = useCallback(async () => {
    setViewerLoading(true);
    try {
      const payload = await apiRequest<ViewerPayload>('/api/viewer');
      setViewerPayload(payload);
    } finally {
      setViewerLoading(false);
    }
  }, []);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    void refreshViewer();
  }, [refreshViewer]);

  useEffect(() => {
    const handlePopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  useEffect(() => {
    if (route.kind === 'login' || route.kind === 'share' || viewerLoading) {
      return;
    }

    if (viewerPayload && !viewerPayload.ownerAuthenticated) {
      navigate('/login', true);
    }
  }, [navigate, route.kind, viewerLoading, viewerPayload]);

  const ownerTokenKey = viewerPayload?.ownerLocalStorageTokenKey || FALLBACK_OWNER_TOKEN_KEY;

  const handleLogout = useCallback(async () => {
    await apiRequest('/api/auth/logout', { method: 'POST' });
    window.localStorage.removeItem(ownerTokenKey);
    await refreshViewer();
    navigate('/login', true);
  }, [navigate, ownerTokenKey, refreshViewer]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  if (route.kind === 'login') {
    return (
      <LoginPage
        ownerTokenKey={ownerTokenKey}
        viewerPayload={viewerPayload}
        viewerLoading={viewerLoading}
        onAuthenticated={async () => {
          await refreshViewer();
          navigate('/', true);
        }}
        onToggleTheme={toggleTheme}
      />
    );
  }

  if (route.kind === 'share') {
    return <SharedNotePage shareId={route.shareId} onToggleTheme={toggleTheme} />;
  }

  if (viewerLoading || !viewerPayload) {
    return <LoadingPage message="Loading" />;
  }

  if (!viewerPayload.ownerAuthenticated) {
    return <LoadingPage message="Redirecting" />;
  }

  if (route.kind === 'note') {
    return (
      <OwnerNotePage
        noteId={route.noteId}
        onBack={() => navigate('/')}
        onLogout={handleLogout}
        onToggleTheme={toggleTheme}
      />
    );
  }

  return <NotesListPage onOpenNote={(noteId) => navigate(`/notes/${noteId}`)} onLogout={handleLogout} onToggleTheme={toggleTheme} />;
}

function LoadingPage({ message }: { message: string }) {
  return (
    <div className="page-shell simple-page">
      <div className="simple-page-content">
        <p>{message}...</p>
      </div>
    </div>
  );
}

function LoginPage({
  ownerTokenKey,
  viewerPayload,
  viewerLoading,
  onAuthenticated,
  onToggleTheme,
}: {
  ownerTokenKey: string;
  viewerPayload: ViewerPayload | null;
  viewerLoading: boolean;
  onAuthenticated: () => Promise<void>;
  onToggleTheme: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const mode = viewerPayload?.authConfigured ? 'login' : 'setup';

  useEffect(() => {
    async function restoreOwnerSession() {
      const token = window.localStorage.getItem(ownerTokenKey);
      if (!token) {
        return;
      }

      try {
        await apiRequest('/api/auth/token', { method: 'POST', body: { token } });
        await onAuthenticated();
      } catch {
        window.localStorage.removeItem(ownerTokenKey);
      }
    }

    if (!viewerLoading) {
      void restoreOwnerSession();
    }
  }, [onAuthenticated, ownerTokenKey, viewerLoading]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    try {
      const endpoint = mode === 'setup' ? '/api/auth/setup' : '/api/auth/login';
      const payload = await apiRequest<{ token: string }>(endpoint, {
        method: 'POST',
        body: mode === 'setup' ? { password, confirmPassword } : { password },
      });
      window.localStorage.setItem(ownerTokenKey, payload.token);
      await apiRequest('/api/auth/token', { method: 'POST', body: { token: payload.token } });
      await onAuthenticated();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Request failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="page-shell auth-shell">
      <button type="button" className="documine-btn-icon documine-btn-icon--md auth-theme-toggle theme-toggle" onClick={onToggleTheme}>
        {document.documentElement.getAttribute('data-theme') === 'dark' ? '☀' : '☾'}
      </button>
      <div className="auth-layout">
        <h1>{mode === 'setup' ? 'Set owner password' : 'Sign in'}</h1>
        <p className="auth-hint">
          {mode === 'setup'
            ? 'This password protects the owner workspace and API key management.'
            : 'Use the owner password for this Documine instance.'}
        </p>
        <div className={`auth-error ${error ? '' : 'hidden'}`}>{error}</div>
        <form className="auth-form" onSubmit={handleSubmit}>
          <input
            type="password"
            placeholder="Password"
            autoComplete={mode === 'setup' ? 'new-password' : 'current-password'}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
          {mode === 'setup' ? (
            <input
              type="password"
              placeholder="Confirm password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
            />
          ) : null}
          <div className="auth-actions">
            <button type="submit" className="primary" disabled={submitting}>
              {submitting ? 'Working...' : mode === 'setup' ? 'Save password' : 'Sign in'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function NotesListPage({
  onOpenNote,
  onLogout,
  onToggleTheme,
}: {
  onOpenNote: (noteId: string) => void;
  onLogout: () => Promise<void>;
  onToggleTheme: () => void;
}) {
  const [search, setSearch] = useState('');
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [apiKeys, setApiKeys] = useState<ApiKey[]>([]);
  const [keysLoading, setKeysLoading] = useState(false);

  const loadNotes = useCallback(async (query: string) => {
    setLoading(true);
    setError('');
    try {
      const payload = await apiRequest<{ ok: true; notes: NoteSummary[] }>(`/api/notes?q=${encodeURIComponent(query)}`);
      setNotes(payload.notes);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load notes.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadKeys = useCallback(async () => {
    setKeysLoading(true);
    try {
      const payload = await apiRequest<{ ok: true; keys: ApiKey[] }>('/api/keys');
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
    const payload = await apiRequest<{ ok: true; note: NoteSummary }>('/api/notes', { method: 'POST' });
    onOpenNote(payload.note.id);
  }

  async function handleDeleteNote(noteId: string) {
    if (!window.confirm('Delete this note?')) {
      return;
    }

    await apiRequest(`/api/notes/${noteId}`, { method: 'DELETE' });
    await loadNotes(search);
  }

  async function handleCreateKey() {
    const label = window.prompt('Label for this API key:')?.trim();
    if (!label) {
      return;
    }

    const payload = await apiRequest<{ ok: true; id: string; key: string }>('/api/keys', {
      method: 'POST',
      body: { label },
    });
    await loadKeys();
    await navigator.clipboard.writeText(payload.key).catch(() => undefined);
    window.alert(`New API key copied to your clipboard.\n\n${payload.key}`);
  }

  async function handleDeleteKey(keyId: string) {
    if (!window.confirm('Delete this API key?')) {
      return;
    }

    await apiRequest(`/api/keys/${keyId}`, { method: 'DELETE' });
    await loadKeys();
  }

  return (
    <div className="app-root">
      <header className="topbar">
        <div className="topbar-left">
          <div className="topbar-title">notes</div>
        </div>
        <div className="topbar-right">
          <button type="button" className="documine-btn documine-btn--md documine-btn--primary" onClick={() => void handleCreateNote()}>
            New note
          </button>
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowSettings(true)}>
            Settings
          </button>
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost theme-toggle" onClick={onToggleTheme}>
            Theme
          </button>
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => void onLogout()}>
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
              <div className="note-row-content">
                <div className="note-row-title">{note.title}</div>
                <div className="note-row-snippet">{note.snippet || 'Empty note'}</div>
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
              <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => setShowSettings(false)}>
                Close
              </button>
            </div>
            <div className="settings-section-header">
              <h3 className="settings-section-title">API Keys</h3>
              <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => void handleCreateKey()}>
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
                <button type="button" className="documine-btn documine-btn--sm documine-btn--danger" onClick={() => void handleDeleteKey(key.id)}>
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

function OwnerNotePage({
  noteId,
  onBack,
  onLogout,
  onToggleTheme,
}: {
  noteId: string;
  onBack: () => void;
  onLogout: () => Promise<void>;
  onToggleTheme: () => void;
}) {
  const [payload, setPayload] = useState<NotePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [shareAccess, setShareAccess] = useState<ShareAccess>('none');
  const [markdown, setMarkdown] = useState('');
  const [renderedHtml, setRenderedHtml] = useState('');
  const [saveStatus, setSaveStatus] = useState('Saved');
  const [metaSaving, setMetaSaving] = useState(false);
  const [connected, setConnected] = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showAssetsModal, setShowAssetsModal] = useState(false);
  const [assets, setAssets] = useState<NoteAsset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [showComments, setShowComments] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [pendingThreadAnchor, setPendingThreadAnchor] = useState<ThreadAnchor | null>(null);
  const editorHandleRef = useRef<CollabEditorHandle | null>(null);

  const loadAssets = useCallback(async () => {
    setAssetsLoading(true);
    try {
      const response = await apiRequest<{ ok: true; assets: NoteAsset[] }>(`/api/notes/${noteId}/assets`);
      setAssets(response.assets);
    } finally {
      setAssetsLoading(false);
    }
  }, [noteId]);

  const loadNote = useCallback(async (options?: { background?: boolean }) => {
    if (!options?.background) {
      setLoading(true);
      setError('');
    }
    try {
      const nextPayload = await apiRequest<NotePayload>(`/api/notes/${noteId}`);
      setPayload(nextPayload);
      setTitle(nextPayload.note.title);
      setShareAccess(nextPayload.note.shareAccess);
      setMarkdown(nextPayload.note.markdown);
      setRenderedHtml(preparePreviewHtml(nextPayload.note.renderedHtml));
      setSaveStatus('Saved');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load note.');
    } finally {
      if (!options?.background) {
        setLoading(false);
      }
    }
  }, [noteId]);

  useEffect(() => {
    void loadNote();
  }, [loadNote]);

  useEffect(() => {
    if (showAssetsModal) {
      void loadAssets();
    }
  }, [loadAssets, showAssetsModal]);

  useEffect(() => {
    if (!payload) {
      return;
    }

    if (markdown === payload.note.markdown) {
      setRenderedHtml(preparePreviewHtml(payload.note.renderedHtml));
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const renderPayload = await apiRequest<{ ok: true; html: string }>('/api/render', {
          method: 'POST',
          body: { markdown },
        });
        setRenderedHtml(preparePreviewHtml(renderPayload.html));
      } catch {
        // Keep last successful preview
      }
    }, 200);

    return () => window.clearTimeout(timer);
  }, [markdown, payload]);

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
    setSaveStatus('Saving');
    try {
      await apiRequest(`/api/notes/${noteId}`, {
        method: 'PUT',
        body: { title: nextTitle, shareAccess: nextShareAccess },
      });
      setPayload((current) => current ? {
        ...current,
        note: { ...current.note, title: nextTitle, shareAccess: nextShareAccess },
      } : current);
      setSaveStatus('Saved');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to save note settings.');
      setSaveStatus('Error');
    } finally {
      setMetaSaving(false);
    }
  }

  async function createThread(anchor: ThreadAnchor, body: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/notes/${noteId}/threads`, {
      method: 'POST',
      body: { anchor, quote: anchor.quote, body },
    });
    setPendingThreadAnchor(null);
    setPayload((current) => current ? { ...current, threads: response.threads } : current);
  }

  async function replyToThread(threadId: string, parentMessageId: string, body: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/notes/${noteId}/threads/${threadId}/replies`, {
      method: 'POST',
      body: { parentMessageId, body },
    });
    setPayload((current) => current ? { ...current, threads: response.threads } : current);
  }

  async function setThreadResolved(threadId: string, resolved: boolean) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/notes/${noteId}/threads/${threadId}`, {
      method: 'PATCH',
      body: { resolved },
    });
    setPayload((current) => current ? { ...current, threads: response.threads } : current);
  }

  async function deleteThread(threadId: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/notes/${noteId}/threads/${threadId}`, { method: 'DELETE' });
    setPayload((current) => current ? { ...current, threads: response.threads } : current);
  }

  async function editMessage(messageId: string, body: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/notes/${noteId}/messages/${messageId}`, {
      method: 'PATCH',
      body: { body },
    });
    setPayload((current) => current ? { ...current, threads: response.threads } : current);
  }

  async function deleteMessage(messageId: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/notes/${noteId}/messages/${messageId}`, { method: 'DELETE' });
    setPayload((current) => current ? { ...current, threads: response.threads } : current);
  }

  const shareUrl = payload ? `${window.location.origin}/s/${payload.note.shareId}` : '';

  async function copyShareUrl() {
    if (!shareUrl) {
      return;
    }

    await navigator.clipboard.writeText(shareUrl);
  }

  function requestCreateThread(anchor: ThreadAnchor) {
    setPendingThreadAnchor(anchor);
  }

  async function handleDeleteAsset(fileName: string) {
    const response = await apiRequest<{ ok: true; assets: NoteAsset[] }>(`/api/notes/${noteId}/assets/${encodeURIComponent(fileName)}`, {
      method: 'DELETE',
    });
    setAssets(response.assets);
  }

  function handleInsertAsset(markdownSnippet: string) {
    editorHandleRef.current?.insertText(markdownSnippet);
  }

  if (loading) {
    return <LoadingPage message="Loading note" />;
  }

  if (error && !payload) {
    return (
      <div className="page-shell simple-page">
        <div className="simple-page-content">
          <p>{error}</p>
          <button type="button" onClick={onBack}>Back</button>
        </div>
      </div>
    );
  }

  if (!payload) {
    return null;
  }

  const agentModalConfig = buildOwnerAgentModal(noteId);

  return (
    <div className="app-root">
      <header className="topbar">
        <div className="topbar-left">
          <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onBack}>
            Back
          </button>
          <input
            className="title-input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onBlur={() => void saveMeta({ title })}
            placeholder="Untitled"
          />
          <span className="status-text">{metaSaving ? 'Saving...' : saveStatus}</span>
        </div>
        <div className="topbar-right">
          <div className="share-popover-wrap">
            <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowShare((current) => !current)}>
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
                  <button type="button" onClick={() => void copyShareUrl()} disabled={shareAccess === 'none'}>
                    Copy link
                  </button>
                </div>
                <p className="meta-text">{shareUrl}</p>
              </div>
            ) : null}
          </div>
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowExportModal(true)}>
            Print
          </button>
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowExportModal(true)}>
            Exports
          </button>
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowAssetsModal(true)}>
            Images
          </button>
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowComments((current) => !current)}>
            {showComments ? 'Hide comments' : 'Show comments'}
          </button>
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowResolved((current) => !current)} disabled={!showComments}>
            {showResolved ? 'Hide resolved' : 'Show resolved'}
          </button>
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowAgentModal(true)}>
            Agent
          </button>
          <button type="button" id="previewFab" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowPreview(true)}>
            Preview
          </button>
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost theme-toggle" onClick={onToggleTheme}>
            Theme
          </button>
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => void onLogout()}>
            Logout
          </button>
        </div>
      </header>

      <div className="workspace">
        <div className="editor-pane">
          {!connected ? <div className="editor-disconnected">Reconnecting...</div> : null}
          <CollabTextarea
            noteId={noteId}
            initialValue={markdown}
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
              setSaveStatus('Live');
            }}
            onConnectionChange={setConnected}
            onThreadsUpdated={() => void loadNote({ background: true })}
          />
        </div>

        <section className={`preview-stage ${showPreview ? 'preview-open' : ''}`}>
          <div className="preview-controls">
            <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost preview-close-btn" onClick={() => setShowPreview(false)}>
              Close
            </button>
          </div>
          <AnchoredCommentCanvas
            renderedHtml={renderedHtml}
            threads={payload.threads}
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
        </section>
      </div>
      {pendingThreadAnchor ? (
        <NewCommentThreadModal
          anchor={pendingThreadAnchor}
          onSubmit={createThread}
          onClose={() => setPendingThreadAnchor(null)}
        />
      ) : null}
      {showExportModal ? <PdfExportModal noteId={noteId} onClose={() => setShowExportModal(false)} /> : null}
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
      {showAgentModal ? <AgentSetupModal config={agentModalConfig} onClose={() => setShowAgentModal(false)} /> : null}
    </div>
  );
}

function SharedNotePage({ shareId, onToggleTheme }: { shareId: string; onToggleTheme: () => void }) {
  const [payload, setPayload] = useState<NotePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [identityName, setIdentityName] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [renderedHtml, setRenderedHtml] = useState('');
  const [connected, setConnected] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [showComments, setShowComments] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [pendingThreadAnchor, setPendingThreadAnchor] = useState<ThreadAnchor | null>(null);

  const loadSharedNote = useCallback(async (options?: { background?: boolean }) => {
    if (!options?.background) {
      setLoading(true);
      setError('');
    }
    try {
      const nextPayload = await apiRequest<NotePayload>(`/api/share/${shareId}`);
      setPayload(nextPayload);
      setIdentityName(nextPayload.viewer.commenterName || '');
      setMarkdown(nextPayload.note.markdown);
      setRenderedHtml(preparePreviewHtml(nextPayload.note.renderedHtml));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load shared note.');
    } finally {
      if (!options?.background) {
        setLoading(false);
      }
    }
  }, [shareId]);

  useEffect(() => {
    void loadSharedNote();
  }, [loadSharedNote]);

  useEffect(() => {
    if (!payload || payload.note.shareAccess === 'edit') {
      return;
    }

    const ws = new WebSocket(buildWsUrl(`/ws?shareId=${encodeURIComponent(shareId)}`));
    ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data)) as { type?: string };
        if (message.type === 'updated' || message.type === 'threads-updated') {
          void loadSharedNote({ background: true });
        }
      } catch {
        // ignore
      }
    });
    return () => ws.close();
  }, [loadSharedNote, payload, shareId]);

  useEffect(() => {
    if (!payload) {
      return;
    }

    if (markdown === payload.note.markdown) {
      setRenderedHtml(preparePreviewHtml(payload.note.renderedHtml));
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const renderPayload = await apiRequest<{ ok: true; html: string }>(`/api/share/${shareId}/render`, {
          method: 'POST',
          body: { markdown },
        });
        setRenderedHtml(preparePreviewHtml(renderPayload.html));
      } catch {
        // Keep last successful preview
      }
    }, 200);

    return () => window.clearTimeout(timer);
  }, [markdown, payload, shareId]);

  async function setIdentity() {
    const response = await apiRequest<{ ok: true; viewer: NotePayload['viewer'] }>(`/api/share/${shareId}/identity`, {
      method: 'POST',
      body: { name: identityName },
    });
    setPayload((current) => current ? { ...current, viewer: response.viewer } : current);
    setIdentityName(response.viewer.commenterName || '');
    setShowIdentityModal(false);
  }

  async function createThread(anchor: ThreadAnchor, body: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/share/${shareId}/threads`, {
      method: 'POST',
      body: {
        anchor,
        body,
        name: identityName,
      },
    });
    setPendingThreadAnchor(null);
    setPayload((current) => current ? { ...current, threads: response.threads } : current);
  }

  async function replyToThread(threadId: string, parentMessageId: string, body: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/share/${shareId}/threads/${threadId}/replies`, {
      method: 'POST',
      body: { parentMessageId, body, name: identityName },
    });
    setPayload((current) => current ? { ...current, threads: response.threads } : current);
  }

  async function setThreadResolved(threadId: string, resolved: boolean) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/share/${shareId}/threads/${threadId}`, {
      method: 'PATCH',
      body: { resolved },
    });
    setPayload((current) => current ? { ...current, threads: response.threads } : current);
  }

  async function deleteThread(threadId: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/share/${shareId}/threads/${threadId}`, { method: 'DELETE' });
    setPayload((current) => current ? { ...current, threads: response.threads } : current);
  }

  async function editMessage(messageId: string, body: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/share/${shareId}/messages/${messageId}`, {
      method: 'PATCH',
      body: { body },
    });
    setPayload((current) => current ? { ...current, threads: response.threads } : current);
  }

  async function deleteMessage(messageId: string) {
    const response = await apiRequest<{ ok: true; threads: Thread[] }>(`/api/share/${shareId}/messages/${messageId}`, { method: 'DELETE' });
    setPayload((current) => current ? { ...current, threads: response.threads } : current);
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

  if (error || !payload) {
    return (
      <div className="page-shell simple-page">
        <div className="simple-page-content">
          <p>{error || 'Shared note not found.'}</p>
        </div>
      </div>
    );
  }

  const canComment = payload.note.shareAccess === 'comment' || payload.note.shareAccess === 'edit';
  const isEditable = payload.note.shareAccess === 'edit';
  const agentModalConfig = buildSharedAgentModal(shareId);

  return (
    <div className="app-root">
      <header className="topbar">
        <div className="topbar-left">
          <div className="topbar-title">{payload.note.title}</div>
          <span className="status-text">Updated {formatDate(payload.note.updatedAt)}</span>
        </div>
        <div className="topbar-right">
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowComments((current) => !current)}>
            {showComments ? 'Hide comments' : 'Show comments'}
          </button>
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowResolved((current) => !current)} disabled={!showComments}>
            {showResolved ? 'Hide resolved' : 'Show resolved'}
          </button>
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowAgentModal(true)}>
            Agent
          </button>
          {isEditable ? (
            <button type="button" id="previewFab" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowPreview(true)}>
              Preview
            </button>
          ) : null}
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost theme-toggle" onClick={onToggleTheme}>
            Theme
          </button>
        </div>
      </header>

      {isEditable ? (
        <div className="workspace">
          <div className="editor-pane">
            {!connected ? <div className="editor-disconnected">Reconnecting...</div> : null}
            <CollabTextarea
              shareId={shareId}
              initialValue={markdown}
              onUploadImage={(file) => uploadImage(file, { shareId })}
              onReady={(next) => {
                setMarkdown(next.markdown);
              }}
              onTextChange={(nextMarkdown) => {
                setMarkdown(nextMarkdown);
              }}
              onConnectionChange={setConnected}
              onThreadsUpdated={() => void loadSharedNote({ background: true })}
            />
          </div>

          <section className={`preview-stage ${showPreview ? 'preview-open' : ''}`}>
            <div className="preview-controls">
              <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost preview-close-btn" onClick={() => setShowPreview(false)}>
                Close
              </button>
            </div>
            <AnchoredCommentCanvas
              renderedHtml={renderedHtml}
              threads={payload.threads}
              canCreateThread={showComments && canComment}
              commentsVisible={showComments}
              showResolved={showResolved}
              emptyMessage={canComment ? 'No comment threads yet. Select text in the preview to add one.' : 'No comment threads yet.'}
              onRequestCreateThread={requestCreateThread}
              onReply={replyToThread}
              onResolve={setThreadResolved}
              onDeleteThread={deleteThread}
              onEditMessage={editMessage}
              onDeleteMessage={deleteMessage}
            />
          </section>
        </div>
      ) : (
        <section className="preview-stage public">
          <AnchoredCommentCanvas
            renderedHtml={renderedHtml}
            threads={payload.threads}
            canCreateThread={showComments && canComment}
            commentsVisible={showComments}
            showResolved={showResolved}
            emptyMessage={canComment ? 'No comment threads yet. Select text in the preview to add one.' : 'No comment threads yet.'}
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
          onSave={setIdentity}
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

function CollabTextarea({
  noteId,
  shareId,
  initialValue,
  onReady,
  onTextChange,
  onConnectionChange,
  onThreadsUpdated,
  onUploadImage,
  onEditorMount,
}: CollabTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editorRef = useRef<CollabEditorHandle | null>(null);
  const callbacksRef = useRef({ onReady, onTextChange, onConnectionChange, onThreadsUpdated, onUploadImage });
  const onEditorMountRef = useRef(onEditorMount);

  useEffect(() => {
    callbacksRef.current = { onReady, onTextChange, onConnectionChange, onThreadsUpdated, onUploadImage };
  }, [onConnectionChange, onReady, onTextChange, onThreadsUpdated, onUploadImage]);

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
      onReady: (payload: { markdown: string; title: string; shareId: string }) => callbacksRef.current.onReady?.(payload),
      onTextChange: (nextMarkdown: string) => callbacksRef.current.onTextChange(nextMarkdown),
      onConnectionChange: (connected: boolean) => callbacksRef.current.onConnectionChange(connected),
      onThreadsUpdated: () => callbacksRef.current.onThreadsUpdated?.(),
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
  }, [noteId, shareId]);

  return <textarea ref={textareaRef} className="editor-textarea" spellCheck={false} />;
}

function ImageAssetsModal({
  assets,
  loading,
  onInsert,
  onDelete,
  onRefresh,
  onClose,
}: {
  assets: NoteAsset[];
  loading: boolean;
  onInsert: (markdown: string) => void;
  onDelete: (fileName: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [confirmDeleteFile, setConfirmDeleteFile] = useState<string | null>(null);
  const [deletingFile, setDeletingFile] = useState<string | null>(null);

  async function handleConfirmDelete(fileName: string) {
    setDeletingFile(fileName);
    try {
      await onDelete(fileName);
      setConfirmDeleteFile((current) => (current === fileName ? null : current));
    } finally {
      setDeletingFile((current) => (current === fileName ? null : current));
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal image-assets-modal" onClick={(event) => event.stopPropagation()}>
        <div className="settings-header">
          <h2 className="settings-title">Images</h2>
          <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onClose}>
            Close
          </button>
        </div>
        <div className="settings-section-header">
          <h3 className="settings-section-title">Current note assets</h3>
          <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => void onRefresh()}>
            Refresh
          </button>
        </div>
        <p className="api-keys-empty">Used images are currently referenced in the note. Remove them from the markdown before deleting them.</p>
        {loading ? <p className="api-keys-empty">Loading...</p> : null}
        {!loading && assets.length === 0 ? <p className="api-keys-empty">No uploaded images yet.</p> : null}
        <div className="image-asset-list">
          {assets.map((asset) => (
            <div key={asset.fileName} className="image-asset-row">
              <img src={asset.url} alt={asset.fileName} className="image-asset-preview" />
              <div className="image-asset-info">
                <div className="image-asset-title-row">
                  <strong className="api-key-label">{asset.fileName}</strong>
                  <span className={`image-asset-badge ${asset.inUse ? 'used' : 'unused'}`}>{asset.inUse ? 'In use' : 'Unused'}</span>
                </div>
                <div className="api-key-meta">{Math.max(1, Math.round(asset.size / 1024))} KB • {formatDate(asset.updatedAt)}</div>
                <code className="image-asset-markdown">{asset.markdown}</code>
                <div className="modal-actions">
                  <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => onInsert(asset.markdown)}>
                    Insert into note
                  </button>
                  {confirmDeleteFile === asset.fileName ? (
                    <div className="image-asset-confirm-delete">
                      <button
                        type="button"
                        className="documine-btn documine-btn--sm documine-btn--ghost"
                        onClick={() => setConfirmDeleteFile(null)}
                        disabled={deletingFile === asset.fileName}
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        className="documine-btn documine-btn--sm documine-btn--danger"
                        onClick={() => void handleConfirmDelete(asset.fileName)}
                        disabled={deletingFile === asset.fileName}
                      >
                        {deletingFile === asset.fileName ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="documine-btn documine-btn--sm documine-btn--danger"
                      onClick={() => setConfirmDeleteFile(asset.fileName)}
                      disabled={asset.inUse}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function PdfExportModal({ noteId, onClose }: { noteId: string; onClose: () => void }) {
  const [payload, setPayload] = useState<PdfExportSettingsPayload | null>(null);
  const [settings, setSettings] = useState<PdfExportSettings | null>(null);
  const [exportsList, setExportsList] = useState<NotePdfExport[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState('');
  const [confirmDeleteExport, setConfirmDeleteExport] = useState<string | null>(null);
  const [deletingExport, setDeletingExport] = useState<string | null>(null);
  const apiOrigin = getApiHttpOrigin();

  const loadExports = useCallback(async () => {
    const response = await listNotePdfExports(noteId);
    setExportsList(response.exports);
  }, [noteId]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      try {
        const [nextPayload, nextExports] = await Promise.all([
          apiRequest<PdfExportSettingsPayload>('/api/export/settings'),
          listNotePdfExports(noteId),
        ]);
        if (cancelled) {
          return;
        }
        setPayload(nextPayload);
        setSettings(nextPayload.settings);
        setExportsList(nextExports.exports);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : 'Failed to load PDF export settings.');
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [noteId]);

  function updateSettings(patch: Partial<PdfExportSettings>) {
    setSettings((current) => current ? { ...current, ...patch } : current);
  }

  function updateMargins(side: 'top' | 'right' | 'bottom' | 'left', value: number) {
    setSettings((current) => current ? {
      ...current,
      marginsCm: { ...current.marginsCm, [side]: value },
    } : current);
  }

  async function handleSaveDefaults() {
    if (!settings) {
      return;
    }
    setSaving(true);
    setError('');
    try {
      const nextPayload = await apiRequest<PdfExportSettingsPayload>('/api/export/settings', {
        method: 'PUT',
        body: { settings },
      });
      setPayload(nextPayload);
      setSettings(nextPayload.settings);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to save defaults.');
    } finally {
      setSaving(false);
    }
  }

  async function handleExport() {
    if (!settings) {
      return;
    }
    setExporting(true);
    setError('');
    try {
      const response = await saveNotePdf(noteId, settings);
      setExportsList(response.exports);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to export PDF.');
    } finally {
      setExporting(false);
    }
  }

  function openExport(item: NotePdfExport) {
    window.open(`${apiOrigin}${item.url}`, '_blank', 'noopener,noreferrer');
  }

  function downloadExport(item: NotePdfExport) {
    const anchor = document.createElement('a');
    anchor.href = `${apiOrigin}${item.downloadUrl}`;
    anchor.target = '_blank';
    anchor.rel = 'noopener';
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  function openDebug(item: NotePdfExport) {
    window.open(`${apiOrigin}${item.debugHtmlUrl}`, '_blank', 'noopener,noreferrer');
  }

  async function handleDeleteExport(item: NotePdfExport) {
    setDeletingExport(item.fileName);
    setError('');
    try {
      const response = await deleteNotePdf(noteId, item.fileName);
      setExportsList(response.exports);
      setConfirmDeleteExport((current) => (current === item.fileName ? null : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to delete export PDF.');
    } finally {
      setDeletingExport((current) => (current === item.fileName ? null : current));
    }
  }

  function formatFileSize(bytes: number) {
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (loading) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal pdf-export-modal" onClick={(event) => event.stopPropagation()}>
          <div className="pdf-export-header">
            <div className="pdf-export-header-left">
              <h2 className="pdf-export-title">Print to PDF</h2>
            </div>
            <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onClose}>Close</button>
          </div>
          <div className="pdf-export-content">
            <p className="pdf-export-loading">Loading export settings...</p>
          </div>
        </div>
      </div>
    );
  }

  if (!payload || !settings) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal pdf-export-modal" onClick={(event) => event.stopPropagation()}>
          <div className="pdf-export-header">
            <div className="pdf-export-header-left">
              <h2 className="pdf-export-title">Print to PDF</h2>
            </div>
            <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onClose}>Close</button>
          </div>
          <div className="pdf-export-content">
            <div className="inline-error">{error || 'Export settings unavailable.'}</div>
          </div>
        </div>
      </div>
    );
  }

  const engineUnavailable = !payload.capabilities.pandoc;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal pdf-export-modal" onClick={(event) => event.stopPropagation()}>
        <div className="pdf-export-header">
          <div className="pdf-export-header-left">
            <h2 className="pdf-export-title">Print to PDF</h2>
            <p className="pdf-export-subtitle">Exports are saved in the background with incremented file names and debug artifacts.</p>
          </div>
          <div className="pdf-export-actions">
            <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => setSettings(payload.settings)} disabled={saving || exporting}>
              Reset
            </button>
            <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => void handleSaveDefaults()} disabled={saving || exporting}>
              {saving ? 'Saving...' : 'Save'}
            </button>
            <button type="button" className="documine-btn documine-btn--sm documine-btn--primary" onClick={() => void handleExport()} disabled={engineUnavailable || exporting || saving}>
              {exporting ? 'Saving PDF...' : 'Save PDF'}
            </button>
            <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onClose}>Close</button>
          </div>
        </div>

        <div className="pdf-export-content">
          {!payload.capabilities.pandoc ? (
            <div className="inline-error">Pandoc is not available on this server. Install it locally or in Docker to enable PDF export.</div>
          ) : null}
          {error ? <div className="inline-error">{error}</div> : null}

          <section className="pdf-export-section">
            <div className="pdf-export-section-header-row">
              <h3 className="pdf-export-section-title">Recent exports</h3>
              <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => void loadExports()} disabled={exporting || saving}>
                Refresh
              </button>
            </div>
            {exportsList.length === 0 ? (
              <p className="pdf-export-loading">No PDFs saved yet.</p>
            ) : (
              <div className="pdf-export-history-list">
                {exportsList.map((item) => (
                  <div key={item.fileName} className="pdf-export-history-row">
                    <div className="pdf-export-history-info">
                      <div className="pdf-export-history-title">{item.fileName}</div>
                      <div className="pdf-export-history-meta">{formatDate(item.createdAt)} · {formatFileSize(item.size)}</div>
                    </div>
                    <div className="pdf-export-history-actions">
                      <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => openExport(item)}>Open</button>
                      <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => downloadExport(item)}>Download</button>
                      <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => openDebug(item)}>Debug HTML</button>
                      {confirmDeleteExport === item.fileName ? (
                        <div className="image-asset-confirm-delete">
                          <button
                            type="button"
                            className="documine-btn documine-btn--sm documine-btn--ghost"
                            onClick={() => setConfirmDeleteExport(null)}
                            disabled={deletingExport === item.fileName}
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            className="documine-btn documine-btn--sm documine-btn--danger"
                            onClick={() => void handleDeleteExport(item)}
                            disabled={deletingExport === item.fileName}
                          >
                            {deletingExport === item.fileName ? 'Deleting...' : 'Delete'}
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          className="documine-btn documine-btn--sm documine-btn--danger"
                          onClick={() => setConfirmDeleteExport(item.fileName)}
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="pdf-export-section">
            <h3 className="pdf-export-section-title">Page setup</h3>
            <div className="pdf-export-grid">
              <label className="pdf-export-field">
                <span>Paper size</span>
                <select value={settings.pageSize} onChange={(event) => updateSettings({ pageSize: event.target.value as PdfExportSettings['pageSize'] })}>
                  {payload.capabilities.pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}
                </select>
              </label>
              <label className="pdf-export-field">
                <span>Orientation</span>
                <select value={settings.orientation} onChange={(event) => updateSettings({ orientation: event.target.value as PdfExportSettings['orientation'] })}>
                  <option value="portrait">Portrait</option>
                  <option value="landscape">Landscape</option>
                </select>
              </label>
            </div>
            <div className="pdf-export-margins">
              <span className="pdf-export-field-label">Margins (cm)</span>
              <div className="pdf-export-margins-grid">
                <label><span>Top</span><input type="number" min={0.5} max={5} step={0.1} value={settings.marginsCm.top} onChange={(event) => updateMargins('top', Number(event.target.value) || settings.marginsCm.top)} /></label>
                <label><span>Right</span><input type="number" min={0.5} max={5} step={0.1} value={settings.marginsCm.right} onChange={(event) => updateMargins('right', Number(event.target.value) || settings.marginsCm.right)} /></label>
                <label><span>Bottom</span><input type="number" min={0.5} max={5} step={0.1} value={settings.marginsCm.bottom} onChange={(event) => updateMargins('bottom', Number(event.target.value) || settings.marginsCm.bottom)} /></label>
                <label><span>Left</span><input type="number" min={0.5} max={5} step={0.1} value={settings.marginsCm.left} onChange={(event) => updateMargins('left', Number(event.target.value) || settings.marginsCm.left)} /></label>
              </div>
            </div>
          </section>

          <section className="pdf-export-section">
            <h3 className="pdf-export-section-title">Typography</h3>
            <div className="pdf-export-grid">
              <label className="pdf-export-field">
                <span>Font family</span>
                <select value={settings.fontFamily} onChange={(event) => updateSettings({ fontFamily: event.target.value as PdfExportSettings['fontFamily'] })}>
                  {payload.capabilities.fontFamilies.map((family) => <option key={family} value={family}>{family}</option>)}
                </select>
              </label>
              <label className="pdf-export-field">
                <span>Style preset</span>
                <select value={settings.stylePreset} onChange={(event) => updateSettings({ stylePreset: event.target.value as PdfExportSettings['stylePreset'] })}>
                  {payload.capabilities.styles.map((style) => <option key={style} value={style}>{style}</option>)}
                </select>
              </label>
              <label className="pdf-export-field">
                <span>Font size (pt)</span>
                <input type="number" min={9} max={18} step={0.5} value={settings.fontSizePt} onChange={(event) => updateSettings({ fontSizePt: Number(event.target.value) || settings.fontSizePt })} />
              </label>
              <label className="pdf-export-field">
                <span>Line height</span>
                <input type="number" min={1.1} max={2} step={0.05} value={settings.lineHeight} onChange={(event) => updateSettings({ lineHeight: Number(event.target.value) || settings.lineHeight })} />
              </label>
            </div>
            <div className="pdf-export-toggles">
              <label className="pdf-export-checkbox"><input type="checkbox" checked={settings.justifyText} onChange={(event) => updateSettings({ justifyText: event.target.checked })} /> Justify paragraphs</label>
            </div>
          </section>

          <section className="pdf-export-section">
            <h3 className="pdf-export-section-title">Content</h3>
            <div className="pdf-export-grid">
              <label className="pdf-export-field">
                <span>Header</span>
                <select value={settings.headerMode} onChange={(event) => updateSettings({ headerMode: event.target.value as PdfExportHeaderMode })}>
                  {payload.capabilities.headerModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
                </select>
              </label>
              <label className="pdf-export-field">
                <span>Engine</span>
                <select value={settings.engine} onChange={(event) => updateSettings({ engine: event.target.value as PdfExportSettings['engine'] })}>
                  <option value="auto">Auto</option>
                  {payload.capabilities.availableEngines.filter((engine) => engine !== 'auto').map((engine) => (
                    <option key={engine} value={engine}>{engine}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="pdf-export-toggles">
              <label className="pdf-export-checkbox"><input type="checkbox" checked={settings.toc} onChange={(event) => updateSettings({ toc: event.target.checked })} /> Include table of contents</label>
              <label className="pdf-export-checkbox"><input type="checkbox" checked={settings.includeTitle} onChange={(event) => updateSettings({ includeTitle: event.target.checked })} /> Include note title</label>
              <label className="pdf-export-checkbox"><input type="checkbox" checked={settings.includeDate} onChange={(event) => updateSettings({ includeDate: event.target.checked })} /> Include export date</label>
            </div>
          </section>

          <section className="pdf-export-section">
            <h3 className="pdf-export-section-title">Images</h3>
            <div className="pdf-export-grid">
              <label className="pdf-export-field">
                <span>Max width %</span>
                <input type="number" min={30} max={100} step={5} value={settings.imageMaxWidthPercent} onChange={(event) => updateSettings({ imageMaxWidthPercent: Number(event.target.value) || settings.imageMaxWidthPercent })} />
              </label>
              <label className="pdf-export-field">
                <span>Alignment</span>
                <select value={settings.imageAlign} onChange={(event) => updateSettings({ imageAlign: event.target.value as PdfExportImageAlignment })}>
                  {payload.capabilities.imageAlignments.map((alignment) => <option key={alignment} value={alignment}>{alignment}</option>)}
                </select>
              </label>
            </div>
            <p className="pdf-export-hint-text">
              Per-image overrides: <code>{'![alt](image.png){width="4in" height="3in"}'}</code>
            </p>
          </section>

          <section className="pdf-export-section">
            <h3 className="pdf-export-section-title">Code blocks</h3>
            <label className="pdf-export-field">
              <span>Line wrapping</span>
              <select value={settings.codeWrap} onChange={(event) => updateSettings({ codeWrap: event.target.value as PdfExportCodeWrapMode })}>
                {payload.capabilities.codeWrapModes.map((mode) => <option key={mode} value={mode}>{mode}</option>)}
              </select>
            </label>
          </section>

          <div className="pdf-export-footer">
            Engines: {payload.capabilities.availableEngines.join(', ')} · Defaults saved to instance data
          </div>
        </div>
      </div>
    </div>
  );
}

function CommentIdentityModal({
  name,
  onNameChange,
  onSave,
  onClose,
}: {
  name: string;
  onNameChange: (name: string) => void;
  onSave: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSave() {
    if (!name.trim()) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      await onSave();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to save your name.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal compact" onClick={(event) => event.stopPropagation()}>
        <h2>Comment identity</h2>
        <p>Set a name before creating comments on this shared note.</p>
        <div className="field">
          <input value={name} onChange={(event) => onNameChange(event.target.value)} placeholder="Your name" />
        </div>
        {error ? <div className="inline-error">{error}</div> : null}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void handleSave()} disabled={busy || !name.trim()}>
            {busy ? 'Saving...' : 'Save name'}
          </button>
        </div>
      </div>
    </div>
  );
}

function NewCommentThreadModal({
  anchor,
  onSubmit,
  onClose,
}: {
  anchor: ThreadAnchor;
  onSubmit: (anchor: ThreadAnchor, body: string) => Promise<void>;
  onClose: () => void;
}) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit() {
    if (!body.trim()) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      await onSubmit(anchor, body);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to add comment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal compact" onClick={(event) => event.stopPropagation()}>
        <h2>New comment thread</h2>
        <p>Comment on the selected text.</p>
        <pre className="agent-instructions"><code>{anchor.quote}</code></pre>
        <div className="field">
          <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Comment" />
        </div>
        {error ? <div className="inline-error">{error}</div> : null}
        <div className="modal-actions">
          <button type="button" className="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={() => void handleSubmit()} disabled={busy || !body.trim()}>
            {busy ? 'Saving...' : 'Add comment'}
          </button>
        </div>
      </div>
    </div>
  );
}

function usePreviewCommentSelection({
  rootRef,
  bubbleRef,
  fabRef,
  enabled,
}: {
  rootRef: RefObject<HTMLElement | null>;
  bubbleRef: RefObject<HTMLButtonElement | null>;
  fabRef: RefObject<HTMLButtonElement | null>;
  enabled: boolean;
}) {
  const anchorRef = useRef<ThreadAnchor | null>(null);
  const rafIdRef = useRef<number | null>(null);
  const pendingRef = useRef(false);
  const pointerDownRef = useRef(false);

  useEffect(() => {
    function hideControls() {
      anchorRef.current = null;
      if (bubbleRef.current) {
        bubbleRef.current.style.display = 'none';
      }
      if (fabRef.current) {
        fabRef.current.style.display = 'none';
      }
    }

    if (!enabled) {
      hideControls();
      return;
    }

    function updateSelection() {
      pendingRef.current = false;
      if (pointerDownRef.current) {
        return;
      }

      const root = rootRef.current;
      const currentSelection = window.getSelection();
      if (!root || !currentSelection || currentSelection.rangeCount === 0 || currentSelection.isCollapsed) {
        hideControls();
        return;
      }

      const range = currentSelection.getRangeAt(0);
      if (!root.contains(range.commonAncestorContainer)) {
        hideControls();
        return;
      }

      const anchor = buildAnchorFromSelection(root, range);
      if (!anchor) {
        hideControls();
        return;
      }

      const rect = range.getBoundingClientRect();
      const useFab = window.matchMedia('(hover: none), (pointer: coarse)').matches;
      anchorRef.current = anchor;

      if (bubbleRef.current) {
        if (useFab) {
          bubbleRef.current.style.display = 'none';
        } else {
          bubbleRef.current.style.left = `${Math.max(16, rect.left)}px`;
          bubbleRef.current.style.top = `${rect.bottom + 6}px`;
          bubbleRef.current.style.display = 'inline-flex';
        }
      }

      if (fabRef.current) {
        fabRef.current.style.display = useFab ? 'inline-flex' : 'none';
      }
    }

    function scheduleUpdate() {
      if (pendingRef.current) {
        return;
      }
      pendingRef.current = true;
      rafIdRef.current = requestAnimationFrame(updateSelection);
    }

    function handlePointerDown(event: PointerEvent) {
      const root = rootRef.current;
      if (!root || !root.contains(event.target as Node)) {
        return;
      }
      pointerDownRef.current = true;
      hideControls();
    }

    function handlePointerUp() {
      if (!pointerDownRef.current) {
        return;
      }
      pointerDownRef.current = false;
      scheduleUpdate();
    }

    document.addEventListener('selectionchange', scheduleUpdate);
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('keyup', scheduleUpdate);

    return () => {
      hideControls();
      document.removeEventListener('selectionchange', scheduleUpdate);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('keyup', scheduleUpdate);
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [enabled, rootRef, bubbleRef, fabRef]);

  function getAnchor() {
    return anchorRef.current;
  }

  function clearSelection() {
    anchorRef.current = null;
    if (bubbleRef.current) {
      bubbleRef.current.style.display = 'none';
    }
    if (fabRef.current) {
      fabRef.current.style.display = 'none';
    }
    window.getSelection()?.removeAllRanges();
  }

  return { getAnchor, clearSelection };
}

function buildAnchorFromSelection(root: HTMLElement, range: Range): ThreadAnchor | null {
  const mapping = collectTextNodes(root);
  const start = resolveOffset(root, mapping, range.startContainer, range.startOffset);
  const end = resolveOffset(root, mapping, range.endContainer, range.endOffset);
  if (start === null || end === null || end <= start) {
    return null;
  }

  const quote = mapping.fullText.slice(start, end);
  if (!quote.trim()) {
    return null;
  }

  return {
    quote,
    prefix: mapping.fullText.slice(Math.max(0, start - 40), start),
    suffix: mapping.fullText.slice(end, Math.min(mapping.fullText.length, end + 40)),
    start,
    end,
  };
}

function collectTextNodes(root: HTMLElement) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const segments: Array<{ node: Text; start: number; end: number }> = [];
  let fullText = '';
  let offset = 0;
  let node = walker.nextNode();
  while (node) {
    const textNode = node as Text;
    const value = textNode.nodeValue || '';
    segments.push({ node: textNode, start: offset, end: offset + value.length });
    fullText += value;
    offset += value.length;
    node = walker.nextNode();
  }

  return { fullText, segments };
}

function resolveOffset(
  root: HTMLElement,
  mapping: ReturnType<typeof collectTextNodes>,
  container: Node,
  localOffset: number,
) {
  if (container.nodeType === Node.TEXT_NODE) {
    const segment = mapping.segments.find((item) => item.node === container);
    return segment ? segment.start + localOffset : null;
  }

  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(container, localOffset);
  return range.toString().length;
}

type HighlightRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

type PositionedThread = {
  thread: Thread;
  highlightRects: HighlightRect[];
};

function offsetsToRange(mapping: ReturnType<typeof collectTextNodes>, start: number, end: number) {
  const startSegment = mapping.segments.find((segment) => start >= segment.start && start <= segment.end);
  const endSegment = mapping.segments.find((segment) => end >= segment.start && end <= segment.end);
  if (!startSegment || !endSegment) {
    return null;
  }

  const range = document.createRange();
  range.setStart(startSegment.node, start - startSegment.start);
  range.setEnd(endSegment.node, end - endSegment.start);
  return range;
}

function locateAnchor(anchor: ThreadAnchor, root: HTMLElement) {
  const mapping = collectTextNodes(root);
  if (!mapping.fullText || !anchor.quote) {
    return null;
  }

  const candidates: number[] = [];
  const exactSlice = mapping.fullText.slice(anchor.start, anchor.end);
  if (exactSlice === anchor.quote) {
    candidates.push(anchor.start);
  }

  let index = mapping.fullText.indexOf(anchor.quote);
  while (index !== -1) {
    if (!candidates.includes(index)) {
      candidates.push(index);
    }
    index = mapping.fullText.indexOf(anchor.quote, index + Math.max(1, anchor.quote.length));
  }

  if (!candidates.length) {
    return null;
  }

  let best: number | null = null;
  let bestScore = -Infinity;
  for (const candidate of candidates) {
    let score = 0;
    if (mapping.fullText.slice(Math.max(0, candidate - anchor.prefix.length), candidate) === anchor.prefix) {
      score += 12;
    }
    const suffix = mapping.fullText.slice(candidate + anchor.quote.length, candidate + anchor.quote.length + anchor.suffix.length);
    if (suffix === anchor.suffix) {
      score += 12;
    }
    score -= Math.abs(candidate - anchor.start) / 8;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (best === null) {
    return null;
  }

  const range = offsetsToRange(mapping, best, best + anchor.quote.length);
  if (!range) {
    return null;
  }

  return { range, start: best, end: best + anchor.quote.length };
}

function mergeRects(rects: DOMRect[], canvasRect: DOMRect): HighlightRect[] {
  const items = rects
    .filter((rect) => rect.width > 0 && rect.height > 0)
    .map((rect) => ({
      left: rect.left - canvasRect.left,
      top: rect.top - canvasRect.top,
      width: rect.width,
      height: rect.height,
    }))
    .sort((a, b) => a.top - b.top || a.left - b.left);

  if (!items.length) {
    return [];
  }

  const merged = [items[0]];
  for (let index = 1; index < items.length; index += 1) {
    const previous = merged[merged.length - 1];
    const current = items[index];
    const verticalOverlap = Math.abs(previous.top - current.top) < previous.height * 0.5;
    if (verticalOverlap) {
      const newLeft = Math.min(previous.left, current.left);
      const newRight = Math.max(previous.left + previous.width, current.left + current.width);
      const newTop = Math.min(previous.top, current.top);
      const newBottom = Math.max(previous.top + previous.height, current.top + current.height);
      previous.left = newLeft;
      previous.top = newTop;
      previous.width = newRight - newLeft;
      previous.height = newBottom - newTop;
    } else {
      merged.push(current);
    }
  }

  return merged;
}

function findAnchorAtPoint(x: number, y: number, layer: HTMLElement | null) {
  if (!layer) {
    return null;
  }

  const anchors = layer.querySelectorAll<HTMLElement>('[data-thread-id]');
  for (const anchor of anchors) {
    const rect = anchor.getBoundingClientRect();
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
      return anchor.dataset.threadId || null;
    }
  }

  return null;
}

function AnchoredCommentCanvas({
  renderedHtml,
  threads,
  canCreateThread,
  commentsVisible,
  showResolved,
  emptyMessage,
  onRequestCreateThread,
  onReply,
  onResolve,
  onDeleteThread,
  onEditMessage,
  onDeleteMessage,
}: {
  renderedHtml: string;
  threads: Thread[];
  canCreateThread: boolean;
  commentsVisible: boolean;
  showResolved: boolean;
  emptyMessage: string;
  onRequestCreateThread: (anchor: ThreadAnchor) => void;
  onReply: (threadId: string, parentMessageId: string, body: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
  onEditMessage: (messageId: string, body: string) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
}) {
  const previewCanvasRef = useRef<HTMLDivElement | null>(null);
  const previewMarkdownRef = useRef<HTMLDivElement | null>(null);
  const selectionBubbleRef = useRef<HTMLButtonElement | null>(null);
  const commentFabRef = useRef<HTMLButtonElement | null>(null);
  const highlightLayerRef = useRef<HTMLDivElement | null>(null);
  const [positionedThreads, setPositionedThreads] = useState<PositionedThread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [dialogThreadId, setDialogThreadId] = useState<string | null>(null);

  const { getAnchor, clearSelection } = usePreviewCommentSelection({
    rootRef: previewMarkdownRef,
    bubbleRef: selectionBubbleRef,
    fabRef: commentFabRef,
    enabled: commentsVisible && canCreateThread,
  });

  const computeLayout = useCallback(() => {
    if (!commentsVisible) {
      setPositionedThreads([]);
      return;
    }

    const root = previewMarkdownRef.current;
    const canvas = previewCanvasRef.current;
    if (!root || !canvas) {
      setPositionedThreads([]);
      return;
    }

    const canvasRect = canvas.getBoundingClientRect();
    const visibleThreads = [...threads]
      .filter((thread) => showResolved || !thread.resolved)
      .sort((a, b) => {
        const startDelta = a.anchor.start - b.anchor.start;
        if (startDelta !== 0) {
          return startDelta;
        }
        return a.createdAt.localeCompare(b.createdAt);
      })
      .map((thread) => {
        const match = locateAnchor(thread.anchor, root);
        if (!match) {
          return null;
        }
        const rects = mergeRects(Array.from(match.range.getClientRects()), canvasRect);
        if (!rects.length) {
          return null;
        }
        return {
          thread,
          highlightRects: rects,
        } satisfies PositionedThread;
      })
      .filter((item): item is PositionedThread => Boolean(item));

    setPositionedThreads(visibleThreads);
  }, [commentsVisible, showResolved, threads]);

  useEffect(() => {
    let frame = requestAnimationFrame(computeLayout);
    const handleResize = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(computeLayout);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', handleResize);
    };
  }, [computeLayout, renderedHtml]);

  useEffect(() => {
    if (!commentsVisible) {
      setActiveThreadId(null);
      setDialogThreadId(null);
      clearSelection();
    }
  }, [clearSelection, commentsVisible]);

  useEffect(() => {
    if (activeThreadId && !threads.some((thread) => thread.id === activeThreadId)) {
      setActiveThreadId(null);
    }
    if (dialogThreadId && !threads.some((thread) => thread.id === dialogThreadId)) {
      setDialogThreadId(null);
    }
  }, [activeThreadId, dialogThreadId, threads]);

  const visibleThreads = useMemo(
    () => positionedThreads.map((item) => item.thread),
    [positionedThreads],
  );

  function openThread(threadId: string) {
    setActiveThreadId(threadId);
    setDialogThreadId(threadId);
  }

  function handleCanvasClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!commentsVisible) {
      return;
    }

    const target = event.target as HTMLElement;
    if (target.closest('.selection-bubble, .comment-fab')) {
      return;
    }

    const threadId = findAnchorAtPoint(event.clientX, event.clientY, highlightLayerRef.current);
    if (!threadId) {
      setActiveThreadId(null);
      setDialogThreadId(null);
      return;
    }

    openThread(threadId);
  }

  function handleStartThread() {
    const anchor = getAnchor();
    if (!anchor) {
      return;
    }

    onRequestCreateThread(anchor);
    clearSelection();
  }

  const dialogThread = dialogThreadId ? visibleThreads.find((thread) => thread.id === dialogThreadId) ?? null : null;

  return (
    <>
      <div className="preview-scroll">
        <div className="preview-canvas" ref={previewCanvasRef} onClick={handleCanvasClick}>
          <button
            ref={selectionBubbleRef}
            type="button"
            className="selection-bubble"
            onMouseDown={(event) => event.preventDefault()}
            onClick={handleStartThread}
          >
            Add comment
          </button>
          <button
            ref={commentFabRef}
            type="button"
            className="comment-fab"
            onMouseDown={(event) => event.preventDefault()}
            onClick={handleStartThread}
          >
            Add comment
          </button>
          <div ref={highlightLayerRef} className="highlight-layer">
            {commentsVisible ? positionedThreads.flatMap((item) => item.highlightRects.map((rect, index) => (
              <div
                key={`${item.thread.id}-${index}`}
                className={`anchor-highlight ${item.thread.id === activeThreadId ? 'active' : ''}`}
                data-thread-id={item.thread.id}
                style={{
                  left: rect.left,
                  top: rect.top,
                  width: rect.width,
                  height: rect.height,
                }}
              />
            ))) : null}
          </div>
          <div className="preview-content">
            <div ref={previewMarkdownRef} className="markdown-body" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
            {commentsVisible && visibleThreads.length === 0 ? <p className="empty-state">{emptyMessage}</p> : null}
          </div>
        </div>
      </div>
      {dialogThread ? (
        <div className="modal-backdrop" onClick={() => setDialogThreadId(null)}>
          <div className="modal thread-modal" onClick={(event) => event.stopPropagation()}>
            <div className="thread-modal-close-wrap">
              <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => setDialogThreadId(null)}>
                Close
              </button>
            </div>
            <ThreadCard
              thread={dialogThread}
              active
              className="thread-card--stack"
              onReply={onReply}
              onResolve={onResolve}
              onDeleteThread={onDeleteThread}
              onEditMessage={onEditMessage}
              onDeleteMessage={onDeleteMessage}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}

function ThreadCard({
  thread,
  active = false,
  className = '',
  style,
  onReply,
  onResolve,
  onDeleteThread,
  onEditMessage,
  onDeleteMessage,
}: {
  thread: Thread;
  active?: boolean;
  className?: string;
  style?: CSSProperties;
  onReply: (threadId: string, parentMessageId: string, body: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
  onEditMessage: (messageId: string, body: string) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
}) {
  const messageTree = useMemo(() => buildMessageTree(thread.messages), [thread.messages]);
  const [replyBody, setReplyBody] = useState('');
  const [replyParentId, setReplyParentId] = useState(thread.messages[0]?.id || '');
  const [replying, setReplying] = useState(false);

  async function handleReply() {
    if (!replyBody.trim() || !replyParentId) {
      return;
    }

    setReplying(true);
    try {
      await onReply(thread.id, replyParentId, replyBody);
      setReplyBody('');
    } finally {
      setReplying(false);
    }
  }

  return (
    <div className={`thread-card ${active ? 'active' : ''} ${thread.resolved ? 'resolved' : ''} ${className}`.trim()} style={style}>
      <div className="thread-message-head">
        <strong className="thread-author">“{thread.anchor.quote}”</strong>
        <span className="thread-meta">{formatDate(thread.updatedAt)}</span>
      </div>
      <div className="thread-state">{thread.resolved ? 'Resolved' : 'Open'}</div>
      <div className="thread-tree" style={{ marginTop: '0.75rem' }}>
        {messageTree.map((node) => (
          <ThreadMessageNode
            key={node.message.id}
            node={node}
            canReply={thread.canReply}
            activeReplyTargetId={replyParentId}
            onReplyTarget={(messageId) => setReplyParentId(messageId)}
            onEditMessage={onEditMessage}
            onDeleteMessage={onDeleteMessage}
          />
        ))}
      </div>
      <div className="thread-footer">
        {thread.canResolve ? (
          <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={() => void onResolve(thread.id, !thread.resolved)}>
            {thread.resolved ? 'Reopen' : 'Resolve'}
          </button>
        ) : null}
        {thread.canDeleteThread ? (
          <button type="button" className="documine-btn documine-btn--sm documine-btn--danger" onClick={() => void onDeleteThread(thread.id)}>
            Delete thread
          </button>
        ) : null}
      </div>
      {thread.canReply ? (
        <div className="compact" style={{ marginTop: '0.75rem' }}>
          {replyParentId ? <div className="reply-target-note">Replying to selected comment</div> : null}
          <div className="field">
            <textarea value={replyBody} onChange={(event) => setReplyBody(event.target.value)} placeholder="Reply" />
          </div>
          <div className="modal-actions">
            <button type="button" className="primary" onClick={() => void handleReply()} disabled={replying || !replyBody.trim()}>
              {replying ? 'Saving...' : 'Reply'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

type MessageTreeNode = {
  message: ThreadMessage;
  children: MessageTreeNode[];
};

function buildMessageTree(messages: ThreadMessage[]) {
  const nodeMap = new Map<string, MessageTreeNode>();
  const roots: MessageTreeNode[] = [];

  for (const message of messages) {
    nodeMap.set(message.id, { message, children: [] });
  }

  for (const message of messages) {
    const node = nodeMap.get(message.id);
    if (!node) {
      continue;
    }

    if (message.parentId && nodeMap.has(message.parentId)) {
      nodeMap.get(message.parentId)?.children.push(node);
    } else {
      roots.push(node);
    }
  }

  return roots;
}

function ThreadMessageNode({
  node,
  canReply,
  activeReplyTargetId,
  onReplyTarget,
  onEditMessage,
  onDeleteMessage,
  depth = 0,
}: {
  node: MessageTreeNode;
  canReply: boolean;
  activeReplyTargetId: string;
  onReplyTarget: (messageId: string) => void;
  onEditMessage: (messageId: string, body: string) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
  depth?: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.message.body);

  async function handleSaveEdit() {
    await onEditMessage(node.message.id, draft);
    setEditing(false);
  }

  return (
    <div className="thread-node" style={{ ['--depth' as string]: depth }}>
      <div className={`thread-message ${depth === 0 ? 'thread-message-root' : 'thread-message-reply'} ${activeReplyTargetId === node.message.id ? 'thread-message-targeted' : ''}`}>
        <div className="thread-message-head">
          <strong className="thread-author thread-author-small">{node.message.authorName}</strong>
          <span className="thread-meta">{formatDate(node.message.updatedAt)}</span>
        </div>
        {editing ? (
          <div className="compact">
            <textarea value={draft} onChange={(event) => setDraft(event.target.value)} />
            <div className="modal-actions">
              <button type="button" className="primary" onClick={() => void handleSaveEdit()} disabled={!draft.trim()}>
                Save
              </button>
              <button type="button" className="ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="thread-body thread-body-small">{node.message.body}</div>
        )}
        <div className="thread-message-actions">
          {canReply ? (
            <button type="button" className="documine-btn documine-btn--link" onClick={() => onReplyTarget(node.message.id)}>
              {activeReplyTargetId === node.message.id ? 'Replying here' : 'Reply here'}
            </button>
          ) : null}
          {node.message.canEdit ? (
            <button type="button" className="documine-btn documine-btn--link" onClick={() => setEditing((current) => !current)}>
              Edit
            </button>
          ) : null}
          {node.message.canDelete ? (
            <button type="button" className="documine-btn documine-btn--link" onClick={() => void onDeleteMessage(node.message.id)}>
              Delete
            </button>
          ) : null}
        </div>
      </div>
      {node.children.length > 0 ? (
        <div className="thread-children">
          {node.children.map((child) => (
            <ThreadMessageNode
              key={child.message.id}
              node={child}
              canReply={canReply}
              activeReplyTargetId={activeReplyTargetId}
              depth={depth + 1}
              onReplyTarget={onReplyTarget}
              onEditMessage={onEditMessage}
              onDeleteMessage={onDeleteMessage}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default App;
