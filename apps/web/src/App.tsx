import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  apiRequest,
  buildWsUrl,
  formatDate,
  getApiHttpOrigin,
  type ApiKey,
  type NotePayload,
  type NoteSummary,
  type ShareAccess,
  type Thread,
  type ThreadMessage,
  type ViewerPayload,
} from './lib/api';
// @ts-expect-error js module
import { createCollabEditor } from './lib/collab-editor.js';

const FALLBACK_OWNER_TOKEN_KEY = 'documine_owner_token';

type Route =
  | { kind: 'login' }
  | { kind: 'list' }
  | { kind: 'note'; noteId: string }
  | { kind: 'share'; shareId: string };

type CollabEditorHandle = {
  destroy: () => void;
  getText: () => string;
};

type CollabTextareaProps = {
  noteId?: string;
  shareId?: string;
  initialValue: string;
  onReady?: (payload: { markdown: string; title: string; shareId: string }) => void;
  onTextChange: (markdown: string) => void;
  onConnectionChange: (connected: boolean) => void;
  onThreadsUpdated?: () => void;
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

  const loadNote = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const nextPayload = await apiRequest<NotePayload>(`/api/notes/${noteId}`);
      setPayload(nextPayload);
      setTitle(nextPayload.note.title);
      setShareAccess(nextPayload.note.shareAccess);
      setMarkdown(nextPayload.note.markdown);
      setRenderedHtml(nextPayload.note.renderedHtml);
      setSaveStatus('Saved');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load note.');
    } finally {
      setLoading(false);
    }
  }, [noteId]);

  useEffect(() => {
    void loadNote();
  }, [loadNote]);

  useEffect(() => {
    if (!payload) {
      return;
    }

    if (markdown === payload.note.markdown) {
      setRenderedHtml(payload.note.renderedHtml);
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const renderPayload = await apiRequest<{ ok: true; html: string }>('/api/render', {
          method: 'POST',
          body: { markdown },
        });
        setRenderedHtml(renderPayload.html);
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

  async function createThread(quote: string, body: string) {
    await apiRequest(`/api/notes/${noteId}/threads`, {
      method: 'POST',
      body: { quote, body },
    });
    await loadNote();
  }

  async function replyToThread(threadId: string, parentMessageId: string, body: string) {
    await apiRequest(`/api/notes/${noteId}/threads/${threadId}/replies`, {
      method: 'POST',
      body: { parentMessageId, body },
    });
    await loadNote();
  }

  async function setThreadResolved(threadId: string, resolved: boolean) {
    await apiRequest(`/api/notes/${noteId}/threads/${threadId}`, {
      method: 'PATCH',
      body: { resolved },
    });
    await loadNote();
  }

  async function deleteThread(threadId: string) {
    await apiRequest(`/api/notes/${noteId}/threads/${threadId}`, { method: 'DELETE' });
    await loadNote();
  }

  async function editMessage(messageId: string, body: string) {
    await apiRequest(`/api/notes/${noteId}/messages/${messageId}`, {
      method: 'PATCH',
      body: { body },
    });
    await loadNote();
  }

  async function deleteMessage(messageId: string) {
    await apiRequest(`/api/notes/${noteId}/messages/${messageId}`, { method: 'DELETE' });
    await loadNote();
  }

  const shareUrl = payload ? `${window.location.origin}/s/${payload.note.shareId}` : '';

  async function copyShareUrl() {
    if (!shareUrl) {
      return;
    }

    await navigator.clipboard.writeText(shareUrl);
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
            onReady={(next) => {
              setMarkdown(next.markdown);
            }}
            onTextChange={(nextMarkdown) => {
              setMarkdown(nextMarkdown);
              setSaveStatus('Live');
            }}
            onConnectionChange={setConnected}
            onThreadsUpdated={() => void loadNote()}
          />
        </div>

        <section className={`preview-stage ${showPreview ? 'preview-open' : ''}`}>
          <div className="preview-controls">
            <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost preview-close-btn" onClick={() => setShowPreview(false)}>
              Close
            </button>
          </div>
          <div className="preview-scroll">
            <div className="preview-canvas">
              <div className="preview-content">
                <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
                <ThreadPanel
                  threads={payload.threads}
                  canCreateThread
                  onCreateThread={createThread}
                  onReply={replyToThread}
                  onResolve={setThreadResolved}
                  onDeleteThread={deleteThread}
                  onEditMessage={editMessage}
                  onDeleteMessage={deleteMessage}
                />
              </div>
            </div>
          </div>
        </section>
      </div>
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

  const loadSharedNote = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const nextPayload = await apiRequest<NotePayload>(`/api/share/${shareId}`);
      setPayload(nextPayload);
      setIdentityName(nextPayload.viewer.commenterName || '');
      setMarkdown(nextPayload.note.markdown);
      setRenderedHtml(nextPayload.note.renderedHtml);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Failed to load shared note.');
    } finally {
      setLoading(false);
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
          void loadSharedNote();
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
      setRenderedHtml(payload.note.renderedHtml);
      return;
    }

    const timer = window.setTimeout(async () => {
      try {
        const renderPayload = await apiRequest<{ ok: true; html: string }>(`/api/share/${shareId}/render`, {
          method: 'POST',
          body: { markdown },
        });
        setRenderedHtml(renderPayload.html);
      } catch {
        // Keep last successful preview
      }
    }, 200);

    return () => window.clearTimeout(timer);
  }, [markdown, payload, shareId]);

  async function setIdentity() {
    await apiRequest(`/api/share/${shareId}/identity`, {
      method: 'POST',
      body: { name: identityName },
    });
    await loadSharedNote();
  }

  async function createThread(quote: string, body: string) {
    await apiRequest(`/api/share/${shareId}/threads`, {
      method: 'POST',
      body: {
        anchor: { quote, prefix: '', suffix: '', start: 0, end: 0 },
        body,
        name: identityName,
      },
    });
    await loadSharedNote();
  }

  async function replyToThread(threadId: string, parentMessageId: string, body: string) {
    await apiRequest(`/api/share/${shareId}/threads/${threadId}/replies`, {
      method: 'POST',
      body: { parentMessageId, body, name: identityName },
    });
    await loadSharedNote();
  }

  async function setThreadResolved(threadId: string, resolved: boolean) {
    await apiRequest(`/api/share/${shareId}/threads/${threadId}`, {
      method: 'PATCH',
      body: { resolved },
    });
    await loadSharedNote();
  }

  async function deleteThread(threadId: string) {
    await apiRequest(`/api/share/${shareId}/threads/${threadId}`, { method: 'DELETE' });
    await loadSharedNote();
  }

  async function editMessage(messageId: string, body: string) {
    await apiRequest(`/api/share/${shareId}/messages/${messageId}`, {
      method: 'PATCH',
      body: { body },
    });
    await loadSharedNote();
  }

  async function deleteMessage(messageId: string) {
    await apiRequest(`/api/share/${shareId}/messages/${messageId}`, { method: 'DELETE' });
    await loadSharedNote();
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
              onReady={(next) => {
                setMarkdown(next.markdown);
              }}
              onTextChange={(nextMarkdown) => {
                setMarkdown(nextMarkdown);
              }}
              onConnectionChange={setConnected}
              onThreadsUpdated={() => void loadSharedNote()}
            />
          </div>

          <section className={`preview-stage ${showPreview ? 'preview-open' : ''}`}>
            <div className="preview-controls">
              <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost preview-close-btn" onClick={() => setShowPreview(false)}>
                Close
              </button>
            </div>
            <div className="preview-scroll">
              <div className="preview-canvas">
                <div className="preview-content">
                  {canComment ? (
                    <div className="modal compact" style={{ marginBottom: '1rem' }}>
                      <h2>Comment identity</h2>
                      <p>Set a name to reply, edit, and resolve comment threads.</p>
                      <div className="field">
                        <input value={identityName} onChange={(event) => setIdentityName(event.target.value)} placeholder="Your name" />
                      </div>
                      <div className="modal-actions">
                        <button type="button" className="primary" onClick={() => void setIdentity()} disabled={!identityName.trim()}>
                          Save name
                        </button>
                      </div>
                    </div>
                  ) : null}
                  <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
                  <ThreadPanel
                    threads={payload.threads}
                    canCreateThread={canComment && payload.viewer.hasCommenterIdentity}
                    onCreateThread={createThread}
                    onReply={replyToThread}
                    onResolve={setThreadResolved}
                    onDeleteThread={deleteThread}
                    onEditMessage={editMessage}
                    onDeleteMessage={deleteMessage}
                  />
                </div>
              </div>
            </div>
          </section>
        </div>
      ) : (
        <section className="preview-stage public">
          <div className="preview-scroll">
            <div className="preview-canvas">
              <div className="preview-content">
                {canComment ? (
                  <div className="modal compact" style={{ marginBottom: '1rem' }}>
                    <h2>Comment identity</h2>
                    <p>Set a name to reply, edit, and resolve comment threads.</p>
                    <div className="field">
                      <input value={identityName} onChange={(event) => setIdentityName(event.target.value)} placeholder="Your name" />
                    </div>
                    <div className="modal-actions">
                      <button type="button" className="primary" onClick={() => void setIdentity()} disabled={!identityName.trim()}>
                        Save name
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className="markdown-body" dangerouslySetInnerHTML={{ __html: renderedHtml }} />
                <ThreadPanel
                  threads={payload.threads}
                  canCreateThread={canComment && payload.viewer.hasCommenterIdentity}
                  onCreateThread={createThread}
                  onReply={replyToThread}
                  onResolve={setThreadResolved}
                  onDeleteThread={deleteThread}
                  onEditMessage={editMessage}
                  onDeleteMessage={deleteMessage}
                />
              </div>
            </div>
          </div>
        </section>
      )}
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
}: CollabTextareaProps) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editorRef = useRef<CollabEditorHandle | null>(null);
  const callbacksRef = useRef({ onReady, onTextChange, onConnectionChange, onThreadsUpdated });

  useEffect(() => {
    callbacksRef.current = { onReady, onTextChange, onConnectionChange, onThreadsUpdated };
  }, [onConnectionChange, onReady, onTextChange, onThreadsUpdated]);

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
    });

    return () => {
      editorRef.current?.destroy();
      editorRef.current = null;
    };
  }, [noteId, shareId]);

  return <textarea ref={textareaRef} className="editor-textarea" spellCheck={false} />;
}

function ThreadPanel({
  threads,
  canCreateThread,
  onCreateThread,
  onReply,
  onResolve,
  onDeleteThread,
  onEditMessage,
  onDeleteMessage,
}: {
  threads: Thread[];
  canCreateThread: boolean;
  onCreateThread: (quote: string, body: string) => Promise<void>;
  onReply: (threadId: string, parentMessageId: string, body: string) => Promise<void>;
  onResolve: (threadId: string, resolved: boolean) => Promise<void>;
  onDeleteThread: (threadId: string) => Promise<void>;
  onEditMessage: (messageId: string, body: string) => Promise<void>;
  onDeleteMessage: (messageId: string) => Promise<void>;
}) {
  const [quote, setQuote] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  if (!canCreateThread && threads.length === 0) {
    return null;
  }

  async function handleCreate() {
    if (!quote.trim() || !body.trim()) {
      return;
    }

    setBusy(true);
    try {
      await onCreateThread(quote, body);
      setQuote('');
      setBody('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: '2rem' }}>
      {canCreateThread ? (
        <div className="modal compact" style={{ marginBottom: '1rem' }}>
          <h2>New comment thread</h2>
          <p>Paste the quoted text and add your comment.</p>
          <div className="field">
            <input value={quote} onChange={(event) => setQuote(event.target.value)} placeholder="Quoted text" />
          </div>
          <div className="field">
            <textarea value={body} onChange={(event) => setBody(event.target.value)} placeholder="Comment" />
          </div>
          <div className="modal-actions">
            <button type="button" className="primary" onClick={() => void handleCreate()} disabled={busy || !quote.trim() || !body.trim()}>
              {busy ? 'Saving...' : 'Add comment'}
            </button>
          </div>
        </div>
      ) : null}

      {threads.length === 0 ? <p className="empty-state">No comment threads yet.</p> : null}

      <div className="thread-tree">
        {threads.map((thread) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            onReply={onReply}
            onResolve={onResolve}
            onDeleteThread={onDeleteThread}
            onEditMessage={onEditMessage}
            onDeleteMessage={onDeleteMessage}
          />
        ))}
      </div>
    </div>
  );
}

function ThreadCard({
  thread,
  onReply,
  onResolve,
  onDeleteThread,
  onEditMessage,
  onDeleteMessage,
}: {
  thread: Thread;
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
    <div className={`thread-card active ${thread.resolved ? 'resolved' : ''}`} style={{ position: 'relative', right: 'auto', width: '100%' }}>
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
  onReplyTarget,
  onEditMessage,
  onDeleteMessage,
  depth = 0,
}: {
  node: MessageTreeNode;
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
      <div className={`thread-message ${depth === 0 ? 'thread-message-root' : 'thread-message-reply'}`}>
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
          <button type="button" className="documine-btn documine-btn--link" onClick={() => onReplyTarget(node.message.id)}>
            Reply here
          </button>
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
