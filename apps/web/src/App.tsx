import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type RefCallback, type RefObject } from 'react';
import {
  ApiError,
  apiRequest,
  buildWsUrl,
  deleteNotePdf,
  formatDate,
  getApiHttpOrigin,
  listNotePdfExports,
  requestRenderedHtmlPreview,
  requestSharedRenderedHtmlPreview,
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
import { createCollabEditor, type CollabEditorHandle, type ShareParticipant } from './lib/collab-editor';

const OWNER_TOKEN_KEY = 'documine_owner_token';

type Route =
  | { kind: 'login' }
  | { kind: 'list' }
  | { kind: 'note'; noteId: string }
  | { kind: 'share'; shareId: string };

type EditorHistoryState = {
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
};

type CollabTextareaProps = {
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
  onScrollMetricsChange?: (metrics: ScrollMetrics) => void;
  onUploadImage?: (file: File) => Promise<{ ok: true; asset: { url: string; markdown: string } }>;
  onEditorMount?: (handle: CollabEditorHandle | null) => void;
};

type AgentModalConfig = {
  title: string;
  hint: string;
  requiresApiKey?: boolean;
  buildInstructions: (apiKey: string | null) => string;
};

type PreviewMode = 'markdown' | 'rendered-pdf';

const RENDERED_PDF_ZOOM_MIN = 50;
const RENDERED_PDF_ZOOM_MAX = 200;
const RENDERED_PDF_ZOOM_STEP = 5;
const RENDERED_PDF_ZOOM_DEFAULT = 80;

type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

function hasScrolledToNewViewport(previous: ScrollMetrics | null, next: ScrollMetrics) {
  return !previous || previous.scrollTop !== next.scrollTop;
}

function summarizeHistoryStatus(history: EditorHistoryState): string {
  if (!history.canUndo && !history.canRedo) {
    return 'No local edits yet';
  }

  const parts: string[] = [];
  if (history.canUndo) {
    parts.push(`Undo: ${history.undoLabel || 'change'}`);
  }
  if (history.canRedo) {
    parts.push(`Redo: ${history.redoLabel || 'change'}`);
  }
  return parts.join(' · ');
}

function renderHistoryBadge(history: EditorHistoryState) {
  const summary = summarizeHistoryStatus(history);
  const isIdle = !history.canUndo && !history.canRedo;
  return (
    <span className={`history-pill ${isIdle ? 'history-pill--idle' : 'history-pill--active'}`} aria-live="polite" title={summary}>
      <span className="history-pill__dot" aria-hidden="true" />
      <span className="history-pill__label">{summary}</span>
    </span>
  );
}

type PreviewScrollAnchor = ThreadAnchor & {
  heading: { text: string; level: number } | null;
};

type AnchorWithOptionalHeading = ThreadAnchor & {
  heading?: { text: string; level: number } | null;
};

type ScrollSyncContext = {
  metrics: ScrollMetrics;
  anchor: PreviewScrollAnchor | null;
};

function buildOwnerAgentModal(noteId: string): AgentModalConfig {
  const apiBaseUrl = getApiHttpOrigin();
  return {
    title: 'Agent setup',
    hint: 'Generate an owner API key below. It is only shown once. Then copy the fully connected instructions.',
    requiresApiKey: true,
    buildInstructions: (apiKey) => [
      '# Install the CLI globally',
      'npm install -g documine',
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
      'npm install -g documine',
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

function AgentSetupModal({
  config,
  onClose,
  initialApiKey = null,
  onApiKeyGenerated,
}: {
  config: AgentModalConfig;
  onClose: () => void;
  initialApiKey?: string | null;
  onApiKeyGenerated?: (apiKey: string) => void;
}) {
  const [apiKey, setApiKey] = useState<string | null>(initialApiKey);
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
      onApiKeyGenerated?.(payload.key);
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

function getStoredEditorWrapEnabled() {
  const value = window.localStorage.getItem('documine_editor_wrap');
  return value == null ? true : value !== 'off';
}

function setStoredEditorWrapEnabled(enabled: boolean) {
  window.localStorage.setItem('documine_editor_wrap', enabled ? 'on' : 'off');
}

function getStoredPreviewScrollSyncEnabled() {
  const value = window.localStorage.getItem('documine_preview_scroll_sync');
  return value == null ? true : value !== 'off';
}

function setStoredPreviewScrollSyncEnabled(enabled: boolean) {
  window.localStorage.setItem('documine_preview_scroll_sync', enabled ? 'on' : 'off');
}

function getStoredPreviewMode(): PreviewMode {
  const value = window.localStorage.getItem('documine_preview_mode');
  return value === 'rendered-pdf' ? 'rendered-pdf' : 'markdown';
}

function setStoredPreviewMode(mode: PreviewMode) {
  window.localStorage.setItem('documine_preview_mode', mode);
}

function normalizePreviewText(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function findTextOccurrences(text: string, pattern: string) {
  const indices: number[] = [];
  if (!text || !pattern) {
    return indices;
  }

  let index = text.indexOf(pattern);
  while (index !== -1) {
    indices.push(index);
    index = text.indexOf(pattern, index + Math.max(1, pattern.length));
  }
  return indices;
}

function getSyncedScrollTop(metrics: ScrollMetrics, targetScrollHeight: number, targetClientHeight: number) {
  const sourceScrollable = Math.max(1, metrics.scrollHeight - metrics.clientHeight);
  const targetScrollable = Math.max(0, targetScrollHeight - targetClientHeight);
  if (targetScrollable === 0) {
    return 0;
  }
  const ratio = Math.min(1, Math.max(0, metrics.scrollTop / sourceScrollable));
  return Math.round(ratio * targetScrollable);
}

function usePreviewScrollSyncController(previewMode: PreviewMode) {
  const [scrollWithMarkdownEnabled, setScrollWithMarkdownEnabled] = useState(() => getStoredPreviewScrollSyncEnabled());
  const scrollWithMarkdownEnabledRef = useRef(scrollWithMarkdownEnabled);
  const previewModeRef = useRef(previewMode);
  const markdownPreviewNodeRef = useRef<HTMLDivElement | null>(null);
  const pdfFrameNodeRef = useRef<HTMLIFrameElement | null>(null);
  const pdfFrameLoadCleanupRef = useRef<(() => void) | null>(null);
  const pdfFrameScrollCleanupRef = useRef<(() => void) | null>(null);
  const currentScrollContextRef = useRef<ScrollSyncContext | null>(null);
  const markdownPreviewLockedRef = useRef(false);
  const pdfPreviewLockedRef = useRef(false);
  const previewProgrammaticScrollRef = useRef(false);
  const manualMarkdownScrollTopRef = useRef(0);
  const manualPdfScrollTopRef = useRef(0);

  scrollWithMarkdownEnabledRef.current = scrollWithMarkdownEnabled;
  previewModeRef.current = previewMode;

  const detachPdfFrameScrollTracking = useCallback(() => {
    pdfFrameScrollCleanupRef.current?.();
    pdfFrameScrollCleanupRef.current = null;
  }, []);

  const attachPdfFrameScrollTracking = useCallback((frame: HTMLIFrameElement) => {
    const contentWindow = frame.contentWindow;
    const contentDocument = frame.contentDocument;
    const scroller = contentDocument?.scrollingElement || contentDocument?.documentElement || contentDocument?.body || null;
    if (!contentWindow || !contentDocument || !scroller) {
      return;
    }

    const handleScroll = () => {
      if (previewProgrammaticScrollRef.current) {
        return;
      }
      pdfPreviewLockedRef.current = true;
      manualPdfScrollTopRef.current = scroller.scrollTop;
    };

    contentWindow.addEventListener('scroll', handleScroll, { passive: true });
    contentDocument.addEventListener('scroll', handleScroll, { passive: true });
    scroller.addEventListener('scroll', handleScroll, { passive: true });
    pdfFrameScrollCleanupRef.current = () => {
      contentWindow.removeEventListener('scroll', handleScroll);
      contentDocument.removeEventListener('scroll', handleScroll);
      scroller.removeEventListener('scroll', handleScroll);
    };
  }, []);

  const handleMarkdownPreviewScroll = useCallback(() => {
    if (previewProgrammaticScrollRef.current) {
      return;
    }
    const preview = markdownPreviewNodeRef.current;
    if (preview) {
      markdownPreviewLockedRef.current = true;
      manualMarkdownScrollTopRef.current = preview.scrollTop;
    }
  }, []);

  const syncMarkdownPreviewScroll = useCallback((context?: ScrollSyncContext | null) => {
    const preview = markdownPreviewNodeRef.current;
    if (!preview) {
      return;
    }

    const nextContext = context ?? currentScrollContextRef.current;
    previewProgrammaticScrollRef.current = true;

    if (nextContext?.metrics.scrollTop === 0) {
      manualMarkdownScrollTopRef.current = 0;
      preview.scrollTop = 0;
      requestAnimationFrame(() => {
        previewProgrammaticScrollRef.current = false;
      });
      return;
    }

    if (scrollWithMarkdownEnabledRef.current && !markdownPreviewLockedRef.current && nextContext) {
      const targetScrollTop = getSyncedScrollTop(nextContext.metrics, preview.scrollHeight, preview.clientHeight);
      manualMarkdownScrollTopRef.current = targetScrollTop;
      preview.scrollTop = targetScrollTop;
      requestAnimationFrame(() => {
        previewProgrammaticScrollRef.current = false;
      });
      return;
    }

    preview.scrollTop = manualMarkdownScrollTopRef.current;
    requestAnimationFrame(() => {
      previewProgrammaticScrollRef.current = false;
    });
  }, []);

  const syncPdfPreviewScroll = useCallback((context?: ScrollSyncContext | null) => {
    const frame = pdfFrameNodeRef.current;
    if (!frame) {
      return;
    }

    const contentDocument = frame.contentDocument;
    const contentWindow = frame.contentWindow;
    const scroller = contentDocument?.scrollingElement || contentDocument?.documentElement || contentDocument?.body || null;
    if (!contentDocument || !contentWindow || !scroller) {
      return;
    }

    const nextContext = context ?? currentScrollContextRef.current;
    previewProgrammaticScrollRef.current = true;

    if (nextContext?.metrics.scrollTop === 0) {
      manualPdfScrollTopRef.current = 0;
      scroller.scrollTop = 0;
      contentWindow.scrollTo(0, 0);
      requestAnimationFrame(() => {
        previewProgrammaticScrollRef.current = false;
      });
      return;
    }

    if (scrollWithMarkdownEnabledRef.current && !pdfPreviewLockedRef.current && nextContext) {
      const targetScrollTop = getSyncedScrollTop(nextContext.metrics, scroller.scrollHeight, scroller.clientHeight);
      manualPdfScrollTopRef.current = targetScrollTop;
      scroller.scrollTop = targetScrollTop;
      contentWindow.scrollTo(0, targetScrollTop);
      requestAnimationFrame(() => {
        previewProgrammaticScrollRef.current = false;
      });
      return;
    }

    scroller.scrollTop = manualPdfScrollTopRef.current;
    contentWindow.scrollTo(0, manualPdfScrollTopRef.current);
    requestAnimationFrame(() => {
      previewProgrammaticScrollRef.current = false;
    });
  }, []);

  const syncPreviewScroll = useCallback((context?: ScrollSyncContext | null, targetMode: PreviewMode = previewModeRef.current) => {
    if (targetMode === 'rendered-pdf') {
      syncPdfPreviewScroll(context);
      return;
    }
    syncMarkdownPreviewScroll(context);
  }, [syncMarkdownPreviewScroll, syncPdfPreviewScroll]);

  const previewScrollRef = useCallback((node: HTMLDivElement | null) => {
    const current = markdownPreviewNodeRef.current;
    if (current) {
      current.removeEventListener('scroll', handleMarkdownPreviewScroll);
    }
    markdownPreviewNodeRef.current = node;
    if (node) {
      manualMarkdownScrollTopRef.current = node.scrollTop;
      node.addEventListener('scroll', handleMarkdownPreviewScroll, { passive: true });
      syncMarkdownPreviewScroll();
    }
  }, [handleMarkdownPreviewScroll, syncMarkdownPreviewScroll]);

  const pdfPreviewFrameRef = useCallback((node: HTMLIFrameElement | null) => {
    pdfFrameLoadCleanupRef.current?.();
    pdfFrameLoadCleanupRef.current = null;
    detachPdfFrameScrollTracking();
    pdfFrameNodeRef.current = node;
    if (!node) {
      return;
    }

    const handleLoad = () => {
      detachPdfFrameScrollTracking();
      attachPdfFrameScrollTracking(node);
      syncPdfPreviewScroll(currentScrollContextRef.current);
    };

    node.addEventListener('load', handleLoad);
    pdfFrameLoadCleanupRef.current = () => node.removeEventListener('load', handleLoad);

    if (node.contentDocument?.readyState === 'complete') {
      handleLoad();
    }
  }, [attachPdfFrameScrollTracking, detachPdfFrameScrollTracking, syncPdfPreviewScroll]);

  const handleEditorScrollChange = useCallback((context: ScrollSyncContext) => {
    currentScrollContextRef.current = context;
    if (scrollWithMarkdownEnabledRef.current) {
      if (previewModeRef.current === 'rendered-pdf') {
        pdfPreviewLockedRef.current = false;
      } else {
        markdownPreviewLockedRef.current = false;
      }
      syncPreviewScroll(context);
    }
  }, [syncPreviewScroll]);

  const toggleScrollWithMarkdown = useCallback(() => {
    const nextEnabled = !scrollWithMarkdownEnabledRef.current;
    scrollWithMarkdownEnabledRef.current = nextEnabled;
    setScrollWithMarkdownEnabled(nextEnabled);
    setStoredPreviewScrollSyncEnabled(nextEnabled);
    if (nextEnabled) {
      if (previewModeRef.current === 'rendered-pdf') {
        pdfPreviewLockedRef.current = false;
      } else {
        markdownPreviewLockedRef.current = false;
      }
      requestAnimationFrame(() => syncPreviewScroll());
    }
  }, [syncPreviewScroll]);

  useEffect(() => {
    syncPreviewScroll(currentScrollContextRef.current);
  }, [previewMode, syncPreviewScroll]);

  return {
    scrollWithMarkdownEnabled,
    previewScrollRef,
    pdfPreviewFrameRef,
    handleEditorScrollChange,
    toggleScrollWithMarkdown,
    syncPreviewScroll,
  };
}

type ViewerStoreSnapshot = {
  payload: ViewerPayload | null;
  loading: boolean;
};

type AuthGuardToastSnapshot = {
  message: string | null;
};

const routeServerSnapshot: Route = { kind: 'list' };
const viewerServerSnapshot: ViewerStoreSnapshot = { payload: null, loading: true };
const authGuardToastServerSnapshot: AuthGuardToastSnapshot = { message: null };
const routeStoreListeners = new Set<() => void>();
const viewerStoreListeners = new Set<() => void>();
const authGuardToastListeners = new Set<() => void>();
let routeSnapshot: Route = typeof window !== 'undefined' ? parseRoute(window.location.pathname) : routeServerSnapshot;
let viewerStoreSnapshot: ViewerStoreSnapshot = { payload: null, loading: true };
let authGuardToastSnapshot: AuthGuardToastSnapshot = { message: null };
let authGuardToastTimeoutId: number | null = null;
let viewerStoreStarted = false;
let viewerPollingIntervalId: number | null = null;
let ownerSessionRestoreAttempted = false;
let routeStoreListening = false;

if (typeof window !== 'undefined') {
  applyTheme(getStoredTheme());
}

function emitRouteChange() {
  routeSnapshot = parseRoute(window.location.pathname);
  for (const listener of routeStoreListeners) {
    listener();
  }
}

function ensureRouteStoreStarted() {
  if (routeStoreListening || typeof window === 'undefined') {
    return;
  }
  routeStoreListening = true;
  window.addEventListener('popstate', emitRouteChange);
}

function subscribeRoute(listener: () => void) {
  ensureRouteStoreStarted();
  routeStoreListeners.add(listener);
  return () => {
    routeStoreListeners.delete(listener);
    if (routeStoreListeners.size === 0 && routeStoreListening && typeof window !== 'undefined') {
      window.removeEventListener('popstate', emitRouteChange);
      routeStoreListening = false;
    }
  };
}

function getRouteSnapshot() {
  return routeSnapshot;
}

function useRoute() {
  return useSyncExternalStore(subscribeRoute, getRouteSnapshot, () => routeServerSnapshot);
}

function navigateTo(nextPath: string, replace = false) {
  if (replace) {
    window.history.replaceState({}, '', nextPath);
  } else {
    window.history.pushState({}, '', nextPath);
  }
  emitRouteChange();
}

function emitViewerStoreChange() {
  for (const listener of viewerStoreListeners) {
    listener();
  }
}

function setAuthGuardToastMessage(message: string | null) {
  if (authGuardToastTimeoutId != null) {
    window.clearTimeout(authGuardToastTimeoutId);
    authGuardToastTimeoutId = null;
  }
  authGuardToastSnapshot = { message };
  for (const listener of authGuardToastListeners) {
    listener();
  }
  if (!message) {
    return;
  }
  authGuardToastTimeoutId = window.setTimeout(() => {
    authGuardToastTimeoutId = null;
    authGuardToastSnapshot = { message: null };
    for (const listener of authGuardToastListeners) {
      listener();
    }
  }, 5000);
}

function maybeShowAuthGuardToast(previousPayload: ViewerPayload | null, nextPayload: ViewerPayload) {
  if (!previousPayload?.ownerAuthenticated || !nextPayload.ownerAuthenticated) {
    return;
  }
  if (previousPayload.authGuard.loginEnabled && !nextPayload.authGuard.loginEnabled) {
    setAuthGuardToastMessage(nextPayload.authGuard.globalLockActive
      ? 'Owner login was locked due to suspicious activity.'
      : 'Owner login was disabled.');
  }
}

async function restoreOwnerSessionFromStorage() {
  if (ownerSessionRestoreAttempted || typeof window === 'undefined') {
    return;
  }
  ownerSessionRestoreAttempted = true;
  const token = window.localStorage.getItem(OWNER_TOKEN_KEY);
  if (!token) {
    return;
  }
  try {
    await apiRequest('/api/auth/token', { method: 'POST', body: { token } });
  } catch {
    window.localStorage.removeItem(OWNER_TOKEN_KEY);
  }
}

async function refreshViewerStore(options?: { silent?: boolean }) {
  if (!options?.silent) {
    viewerStoreSnapshot = { ...viewerStoreSnapshot, loading: true };
    emitViewerStoreChange();
  }

  const previousPayload = viewerStoreSnapshot.payload;
  try {
    const payload = await apiRequest<ViewerPayload>('/api/viewer');
    viewerStoreSnapshot = { payload, loading: false };
    maybeShowAuthGuardToast(previousPayload, payload);
    emitViewerStoreChange();
    if (payload.ownerAuthenticated && window.location.pathname === '/login') {
      navigateTo('/', true);
    }
    return payload;
  } catch (error) {
    viewerStoreSnapshot = { ...viewerStoreSnapshot, loading: false };
    emitViewerStoreChange();
    throw error;
  }
}

function ensureViewerStoreStarted() {
  if (viewerStoreStarted || typeof window === 'undefined') {
    return;
  }
  viewerStoreStarted = true;
  void (async () => {
    await restoreOwnerSessionFromStorage();
    await refreshViewerStore().catch(() => undefined);
  })();
  viewerPollingIntervalId = window.setInterval(() => {
    void refreshViewerStore({ silent: true }).catch(() => undefined);
  }, 10000);
}

function subscribeViewerStore(listener: () => void) {
  ensureViewerStoreStarted();
  viewerStoreListeners.add(listener);
  return () => {
    viewerStoreListeners.delete(listener);
    if (viewerStoreListeners.size === 0 && viewerPollingIntervalId != null) {
      window.clearInterval(viewerPollingIntervalId);
      viewerPollingIntervalId = null;
      viewerStoreStarted = false;
    }
  };
}

function useViewerStore() {
  return useSyncExternalStore(subscribeViewerStore, () => viewerStoreSnapshot, () => viewerServerSnapshot);
}

function subscribeAuthGuardToast(listener: () => void) {
  authGuardToastListeners.add(listener);
  return () => {
    authGuardToastListeners.delete(listener);
  };
}

function useAuthGuardToastStore() {
  return useSyncExternalStore(subscribeAuthGuardToast, () => authGuardToastSnapshot, () => authGuardToastServerSnapshot);
}

function App() {
  const route = useRoute();
  const { payload: viewerPayload, loading: viewerLoading } = useViewerStore();
  const { message: authGuardToastMessage } = useAuthGuardToastStore();
  const [, setTheme] = useState(() => getStoredTheme());

  const toggleTheme = useCallback(() => {
    setTheme((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      return next;
    });
  }, []);

  const ownerTokenKey = viewerPayload?.ownerLocalStorageTokenKey ?? OWNER_TOKEN_KEY;

  const handleLogout = useCallback(async () => {
    await apiRequest('/api/auth/logout', { method: 'POST' });
    window.localStorage.removeItem(ownerTokenKey);
    await refreshViewerStore();
    navigateTo('/login', true);
  }, [ownerTokenKey]);

  const handleAuthenticated = useCallback(async () => {
    await refreshViewerStore();
    if (route.kind === 'note') {
      navigateTo(`/notes/${route.noteId}`, true);
      return;
    }
    navigateTo('/', true);
  }, [route]);

  if (route.kind === 'share') {
    return <SharedNotePage shareId={route.shareId} onToggleTheme={toggleTheme} />;
  }

  if (viewerLoading || !viewerPayload) {
    return <LoadingPage message="Loading" />;
  }

  if (route.kind === 'login' || !viewerPayload.ownerAuthenticated) {
    return (
      <LoginPage
        ownerTokenKey={ownerTokenKey}
        viewerPayload={viewerPayload}
        onAuthenticated={handleAuthenticated}
        onToggleTheme={toggleTheme}
      />
    );
  }

  if (route.kind === 'note') {
    return (
      <>
        <OwnerAuthGuardToast message={authGuardToastMessage} onDismiss={() => setAuthGuardToastMessage(null)} />
        <OwnerNotePage
          noteId={route.noteId}
          onBack={() => navigateTo('/')}
          onLogout={handleLogout}
          onToggleTheme={toggleTheme}
        />
      </>
    );
  }

  return (
    <>
      <OwnerAuthGuardToast message={authGuardToastMessage} onDismiss={() => setAuthGuardToastMessage(null)} />
      <NotesListPage onOpenNote={(noteId) => navigateTo(`/notes/${noteId}`)} onLogout={handleLogout} onToggleTheme={toggleTheme} />
    </>
  );
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

function OwnerAuthGuardToast({ message, onDismiss }: { message: string | null; onDismiss: () => void }) {
  if (!message) {
    return null;
  }

  return (
    <div className="auth-guard-toast" role="status" aria-live="polite">
      <span>{message}</span>
      <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

function LoginPage({
  ownerTokenKey,
  viewerPayload,
  onAuthenticated,
  onToggleTheme,
}: {
  ownerTokenKey: string;
  viewerPayload: ViewerPayload | null;
  onAuthenticated: () => Promise<void>;
  onToggleTheme: () => void;
}) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const mode = viewerPayload?.authConfigured ? 'login' : 'setup';
  const loginDisabled = mode === 'login' && Boolean(viewerPayload && !viewerPayload.authGuard.loginEnabled);

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
      if (cause instanceof ApiError && (cause.status === 403 || cause.status === 423 || cause.status === 429)) {
        setError('Owner sign-in is unavailable. Contact the owner.');
      } else {
        setError(cause instanceof Error ? cause.message : 'Request failed.');
      }
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
        <div className={`auth-error ${error || loginDisabled ? '' : 'hidden'}`}>
          {error || (loginDisabled ? 'Owner sign-in is unavailable. Contact the owner.' : '')}
        </div>
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
            <button type="submit" className="primary" disabled={submitting || loginDisabled}>
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
  const [previewMode, setPreviewMode] = useState<PreviewMode>(() => getStoredPreviewMode());
  const [editorWrapEnabled, setEditorWrapEnabled] = useState(() => getStoredEditorWrapEnabled());
  const {
    scrollWithMarkdownEnabled,
    previewScrollRef,
    pdfPreviewFrameRef,
    handleEditorScrollChange,
    toggleScrollWithMarkdown,
    syncPreviewScroll,
  } = usePreviewScrollSyncController(previewMode);
  const [renderedPdfUrl, setRenderedPdfUrl] = useState('');
  const [renderedPdfZoom, setRenderedPdfZoom] = useState(RENDERED_PDF_ZOOM_DEFAULT);
  const [renderedPdfLoading, setRenderedPdfLoading] = useState(false);
  const [renderedPdfError, setRenderedPdfError] = useState('');
  const [renderedPdfDirty, setRenderedPdfDirty] = useState(false);
  const [renderedPdfElapsedMs, setRenderedPdfElapsedMs] = useState(0);
  const [renderedPdfLastDurationMs, setRenderedPdfLastDurationMs] = useState<number | null>(null);
  const renderedPdfRequestIdRef = useRef(0);
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [agentApiKey, setAgentApiKey] = useState<string | null>(null);
  const [showExportModal, setShowExportModal] = useState(false);
  const [showAssetsModal, setShowAssetsModal] = useState(false);
  const [shareParticipants, setShareParticipants] = useState<ShareParticipant[]>([]);
  const [assets, setAssets] = useState<NoteAsset[]>([]);
  const [assetsLoading, setAssetsLoading] = useState(false);
  const [showComments, setShowComments] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [pendingThreadAnchor, setPendingThreadAnchor] = useState<ThreadAnchor | null>(null);
  const editorHandleRef = useRef<CollabEditorHandle | null>(null);
  const [editorHistory, setEditorHistory] = useState<EditorHistoryState>({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
  const lastEditorScrollMetricsRef = useRef<ScrollMetrics | null>(null);

  const handleEditorScrollMetricsChange = useCallback((metrics: ScrollMetrics) => {
    const previousMetrics = lastEditorScrollMetricsRef.current;
    lastEditorScrollMetricsRef.current = metrics;
    if (!hasScrolledToNewViewport(previousMetrics, metrics)) {
      return;
    }

    handleEditorScrollChange({
      metrics,
      anchor: scrollWithMarkdownEnabled ? editorHandleRef.current?.getScrollAnchor() ?? null : null,
    });
  }, [handleEditorScrollChange, scrollWithMarkdownEnabled]);

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

  useEffect(() => {
    setRenderedPdfDirty(true);
  }, [markdown, noteId]);

  useEffect(() => {
    if (previewMode !== 'rendered-pdf') {
      setRenderedPdfLoading(false);
      setRenderedPdfError('');
      return;
    }

    const shouldRefresh = !renderedPdfUrl || renderedPdfDirty;
    if (!shouldRefresh) {
      setRenderedPdfError('');
      return;
    }

    // Let typing settle before re-rendering the PDF preview.
    const delayMs = !renderedPdfUrl ? 0 : 600;
    const requestId = ++renderedPdfRequestIdRef.current;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (cancelled) {
        return;
      }
      const startedAt = performance.now();
      setRenderedPdfLoading(true);
      setRenderedPdfElapsedMs(0);
      setRenderedPdfError('');
      try {
        const blob = await requestRenderedHtmlPreview(noteId, markdown);
        if (cancelled || renderedPdfRequestIdRef.current !== requestId) {
          return;
        }
        const nextUrl = URL.createObjectURL(blob);
        setRenderedPdfUrl((current) => {
          if (current) {
            URL.revokeObjectURL(current);
          }
          return nextUrl;
        });
        setRenderedPdfDirty(false);
        setRenderedPdfLastDurationMs(Math.round(performance.now() - startedAt));
      } catch (cause) {
        if (!cancelled && renderedPdfRequestIdRef.current === requestId) {
          setRenderedPdfError(cause instanceof Error ? cause.message : 'Failed to render preview.');
          setRenderedPdfLastDurationMs(Math.round(performance.now() - startedAt));
        }
      } finally {
        if (!cancelled && renderedPdfRequestIdRef.current === requestId) {
          setRenderedPdfLoading(false);
        }
      }
    }, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [markdown, noteId, previewMode, renderedPdfDirty, renderedPdfUrl]);

  const handleRenderedPdfZoomOut = useCallback(() => {
    setRenderedPdfZoom((current) => Math.max(RENDERED_PDF_ZOOM_MIN, current - RENDERED_PDF_ZOOM_STEP));
  }, []);

  const handleRenderedPdfZoomIn = useCallback(() => {
    setRenderedPdfZoom((current) => Math.min(RENDERED_PDF_ZOOM_MAX, current + RENDERED_PDF_ZOOM_STEP));
  }, []);

  const handleRenderedPdfZoomReset = useCallback(() => {
    setRenderedPdfZoom(RENDERED_PDF_ZOOM_DEFAULT);
  }, []);

  useEffect(() => {
    if (!renderedPdfLoading) {
      return;
    }

    const startedAt = performance.now();
    const interval = window.setInterval(() => {
      setRenderedPdfElapsedMs(Math.round(performance.now() - startedAt));
    }, 100);

    return () => window.clearInterval(interval);
  }, [renderedPdfLoading]);

  useEffect(() => {
    return () => {
      if (renderedPdfUrl) {
        URL.revokeObjectURL(renderedPdfUrl);
      }
    };
  }, [renderedPdfUrl]);

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
    <div className="app-root" data-page="editor">
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
          {renderHistoryBadge(editorHistory)}
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
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowAssetsModal(true)}>
            Images
          </button>
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowComments((current) => !current)}>
            {showComments ? 'Hide comments' : 'Show comments'}
          </button>
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowResolved((current) => !current)} disabled={!showComments}>
            {showResolved ? 'Hide resolved' : 'Show resolved'}
          </button>
          <div className="documine-segmented-control" role="group" aria-label="Edit history">
            <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => editorHandleRef.current?.undo()} disabled={!editorHistory.canUndo} title="Undo (Ctrl+Z)">
              Undo
            </button>
            <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => editorHandleRef.current?.redo()} disabled={!editorHistory.canRedo} title="Redo (Ctrl+Y or Ctrl+Shift+Z)">
              Redo
            </button>
          </div>
          <div className="documine-segmented-control" role="group" aria-label="Editor line wrapping">
            <button type="button" className={`documine-btn documine-btn--md ${editorWrapEnabled ? 'documine-btn--primary' : 'documine-btn--ghost'}`} onClick={() => {
              setEditorWrapEnabled(true);
              setStoredEditorWrapEnabled(true);
            }}>
              Wrap
            </button>
            <button type="button" className={`documine-btn documine-btn--md ${!editorWrapEnabled ? 'documine-btn--primary' : 'documine-btn--ghost'}`} onClick={() => {
              setEditorWrapEnabled(false);
              setStoredEditorWrapEnabled(false);
            }}>
              No wrap
            </button>
          </div>
          <button
            type="button"
            className={`documine-btn documine-btn--md ${scrollWithMarkdownEnabled ? 'documine-btn--primary' : 'documine-btn--ghost'}`}
            aria-pressed={scrollWithMarkdownEnabled}
            onClick={handleToggleScrollWithMarkdown}
          >
            {scrollWithMarkdownEnabled ? 'Following markdown' : 'Follow markdown'}
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
          {shareParticipants.length ? (
            <div className="presence-avatars" aria-label="People currently in this share">
              {shareParticipants.map((participant) => (
                <div
                  key={participant.clientId}
                  className="presence-avatar"
                  title={`${participant.name} · ${participant.permissionLabel}`}
                  aria-label={`${participant.name}. ${participant.permissionLabel}`}
                >
                  {participant.name.trim().charAt(0).toUpperCase() || '?'}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </header>

      <div className="workspace">
        <div className="editor-pane">
          {!connected ? <div className="editor-disconnected">Reconnecting...</div> : null}
          <CollabTextarea
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
              setSaveStatus('Live');
            }}
            onConnectionChange={setConnected}
            onThreadsUpdated={() => void loadNote({ background: true })}
            onParticipantsChange={setShareParticipants}
            onHistoryChange={setEditorHistory}
          />
        </div>

        <section className={`preview-stage ${showPreview ? 'preview-open' : ''}`}>
          <div className="preview-controls">
            <div className="preview-mode-toggle">
              <button type="button" className={`documine-btn documine-btn--sm ${previewMode === 'markdown' ? 'documine-btn--primary' : 'documine-btn--ghost'}`} onClick={() => handlePreviewModeChange('markdown')}>
                Markdown
              </button>
              <button type="button" className={`documine-btn documine-btn--sm ${previewMode === 'rendered-pdf' ? 'documine-btn--primary' : 'documine-btn--ghost'}`} onClick={() => handlePreviewModeChange('rendered-pdf')}>
                Print preview
              </button>
            </div>
            {previewMode === 'rendered-pdf' ? (
              <>
                <span className="pdf-preview-note pdf-preview-note--inline">
                  {renderedPdfLoading
                    ? `Refreshing preview... ${formatDurationMs(renderedPdfElapsedMs)}`
                    : renderedPdfDirty
                      ? 'Waiting for typing to pause before refreshing.'
                      : renderedPdfLastDurationMs !== null
                        ? `Last refresh: ${formatDurationMs(renderedPdfLastDurationMs)}`
                        : 'Auto-refreshes after a short idle delay.'}
                </span>
                <div className="pdf-preview-zoom-controls" aria-label="Preview zoom controls">
                  <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={handleRenderedPdfZoomOut} disabled={renderedPdfZoom <= RENDERED_PDF_ZOOM_MIN} aria-label="Zoom out preview">
                    -
                  </button>
                  <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost pdf-preview-zoom-value" onClick={handleRenderedPdfZoomReset} aria-label="Reset preview zoom">
                    {renderedPdfZoom}%
                  </button>
                  <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={handleRenderedPdfZoomIn} disabled={renderedPdfZoom >= RENDERED_PDF_ZOOM_MAX} aria-label="Zoom in preview">
                    +
                  </button>
                </div>
              </>
            ) : null}
            <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost preview-close-btn" onClick={() => setShowPreview(false)}>
              Close
            </button>
          </div>
          {previewMode === 'rendered-pdf' ? (
            <RenderedPreview url={renderedPdfUrl} zoom={renderedPdfZoom} loading={renderedPdfLoading} error={renderedPdfError} dirty={renderedPdfDirty} iframeRef={pdfPreviewFrameRef} />
          ) : (
            <AnchoredCommentCanvas
              renderedHtml={renderedHtml}
              previewScrollRef={previewScrollRef}
              syncPreviewScroll={syncPreviewScroll}
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
      {showExportModal ? <PdfExportModal noteId={noteId} markdown={markdown} onClose={() => {
        setShowExportModal(false);
        setRenderedPdfDirty(true);
      }} /> : null}
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

function SharedNotePage({ shareId, onToggleTheme }: { shareId: string; onToggleTheme: () => void }) {
  const [payload, setPayload] = useState<NotePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [identityName, setIdentityName] = useState('');
  const [markdown, setMarkdown] = useState('');
  const [renderedHtml, setRenderedHtml] = useState('');
  const [connected, setConnected] = useState(false);
  const [editorWrapEnabled, setEditorWrapEnabled] = useState(() => getStoredEditorWrapEnabled());
  const [previewMode, setPreviewMode] = useState<PreviewMode>(() => getStoredPreviewMode());
  const {
    scrollWithMarkdownEnabled,
    previewScrollRef,
    pdfPreviewFrameRef,
    handleEditorScrollChange,
    toggleScrollWithMarkdown,
    syncPreviewScroll,
  } = usePreviewScrollSyncController(previewMode);
  const [renderedPdfUrl, setRenderedPdfUrl] = useState('');
  const [renderedPdfZoom, setRenderedPdfZoom] = useState(RENDERED_PDF_ZOOM_DEFAULT);
  const [renderedPdfLoading, setRenderedPdfLoading] = useState(false);
  const [renderedPdfError, setRenderedPdfError] = useState('');
  const [renderedPdfDirty, setRenderedPdfDirty] = useState(false);
  const [renderedPdfElapsedMs, setRenderedPdfElapsedMs] = useState(0);
  const [renderedPdfLastDurationMs, setRenderedPdfLastDurationMs] = useState<number | null>(null);
  const renderedPdfRequestIdRef = useRef(0);
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [showComments, setShowComments] = useState(true);
  const [showResolved, setShowResolved] = useState(false);
  const [showIdentityModal, setShowIdentityModal] = useState(false);
  const [pendingThreadAnchor, setPendingThreadAnchor] = useState<ThreadAnchor | null>(null);
  const editorHandleRef = useRef<CollabEditorHandle | null>(null);
  const [editorHistory, setEditorHistory] = useState<EditorHistoryState>({ canUndo: false, canRedo: false, undoLabel: null, redoLabel: null });
  const lastEditorScrollMetricsRef = useRef<ScrollMetrics | null>(null);

  const handleEditorScrollMetricsChange = useCallback((metrics: ScrollMetrics) => {
    const previousMetrics = lastEditorScrollMetricsRef.current;
    lastEditorScrollMetricsRef.current = metrics;
    if (!hasScrolledToNewViewport(previousMetrics, metrics)) {
      return;
    }

    handleEditorScrollChange({
      metrics,
      anchor: scrollWithMarkdownEnabled ? editorHandleRef.current?.getScrollAnchor() ?? null : null,
    });
  }, [handleEditorScrollChange, scrollWithMarkdownEnabled]);

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

  const handleRenderedPdfZoomOut = useCallback(() => {
    setRenderedPdfZoom((current) => Math.max(RENDERED_PDF_ZOOM_MIN, current - RENDERED_PDF_ZOOM_STEP));
  }, []);

  const handleRenderedPdfZoomIn = useCallback(() => {
    setRenderedPdfZoom((current) => Math.min(RENDERED_PDF_ZOOM_MAX, current + RENDERED_PDF_ZOOM_STEP));
  }, []);

  const handleRenderedPdfZoomReset = useCallback(() => {
    setRenderedPdfZoom(RENDERED_PDF_ZOOM_DEFAULT);
  }, []);

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

  useEffect(() => {
    setRenderedPdfDirty(true);
  }, [markdown, shareId]);

  useEffect(() => {
    if (previewMode !== 'rendered-pdf') {
      setRenderedPdfLoading(false);
      setRenderedPdfError('');
      return;
    }

    const shouldRefresh = !renderedPdfUrl || renderedPdfDirty;
    if (!shouldRefresh) {
      setRenderedPdfError('');
      return;
    }

    const delayMs = !renderedPdfUrl ? 0 : 600;
    const requestId = ++renderedPdfRequestIdRef.current;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      if (cancelled) {
        return;
      }
      const startedAt = performance.now();
      setRenderedPdfLoading(true);
      setRenderedPdfElapsedMs(0);
      setRenderedPdfError('');
      try {
        const blob = await requestSharedRenderedHtmlPreview(shareId, markdown);
        if (cancelled || renderedPdfRequestIdRef.current !== requestId) {
          return;
        }
        const nextUrl = URL.createObjectURL(blob);
        setRenderedPdfUrl((current) => {
          if (current) {
            URL.revokeObjectURL(current);
          }
          return nextUrl;
        });
        setRenderedPdfDirty(false);
        setRenderedPdfLastDurationMs(Math.round(performance.now() - startedAt));
      } catch (cause) {
        if (!cancelled && renderedPdfRequestIdRef.current === requestId) {
          setRenderedPdfError(cause instanceof Error ? cause.message : 'Failed to render preview.');
          setRenderedPdfLastDurationMs(Math.round(performance.now() - startedAt));
        }
      } finally {
        if (!cancelled && renderedPdfRequestIdRef.current === requestId) {
          setRenderedPdfLoading(false);
        }
      }
    }, delayMs);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [markdown, previewMode, renderedPdfDirty, renderedPdfUrl, shareId]);

  useEffect(() => {
    if (!renderedPdfLoading) {
      return;
    }

    const startedAt = performance.now();
    const interval = window.setInterval(() => {
      setRenderedPdfElapsedMs(Math.round(performance.now() - startedAt));
    }, 100);

    return () => window.clearInterval(interval);
  }, [renderedPdfLoading]);

  useEffect(() => {
    return () => {
      if (renderedPdfUrl) {
        URL.revokeObjectURL(renderedPdfUrl);
      }
    };
  }, [renderedPdfUrl]);

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
    <div className="app-root" data-page="public">
      <header className="topbar">
        <div className="topbar-left">
          <div className="topbar-title">{payload.note.title}</div>
          <span className="status-text">Updated {formatDate(payload.note.updatedAt)}</span>
          {isEditable ? renderHistoryBadge(editorHistory) : null}
        </div>
        <div className="topbar-right">
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowComments((current) => !current)}>
            {showComments ? 'Hide comments' : 'Show comments'}
          </button>
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowResolved((current) => !current)} disabled={!showComments}>
            {showResolved ? 'Hide resolved' : 'Show resolved'}
          </button>
          {isEditable ? (
            <div className="documine-segmented-control" role="group" aria-label="Edit history">
              <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => editorHandleRef.current?.undo()} disabled={!editorHistory.canUndo} title="Undo (Ctrl+Z)">
                Undo
              </button>
              <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => editorHandleRef.current?.redo()} disabled={!editorHistory.canRedo} title="Redo (Ctrl+Y or Ctrl+Shift+Z)">
                Redo
              </button>
            </div>
          ) : null}
          <div className="documine-segmented-control" role="group" aria-label="Editor line wrapping">
            <button type="button" className={`documine-btn documine-btn--md ${editorWrapEnabled ? 'documine-btn--primary' : 'documine-btn--ghost'}`} onClick={() => {
              setEditorWrapEnabled(true);
              setStoredEditorWrapEnabled(true);
            }}>
              Wrap
            </button>
            <button type="button" className={`documine-btn documine-btn--md ${!editorWrapEnabled ? 'documine-btn--primary' : 'documine-btn--ghost'}`} onClick={() => {
              setEditorWrapEnabled(false);
              setStoredEditorWrapEnabled(false);
            }}>
              No wrap
            </button>
          </div>
          {isEditable ? (
            <button
              type="button"
              className={`documine-btn documine-btn--md ${scrollWithMarkdownEnabled ? 'documine-btn--primary' : 'documine-btn--ghost'}`}
              aria-pressed={scrollWithMarkdownEnabled}
              onClick={handleToggleScrollWithMarkdown}
            >
              {scrollWithMarkdownEnabled ? 'Following markdown' : 'Follow markdown'}
            </button>
          ) : null}
          <button type="button" className="documine-btn documine-btn--md documine-btn--ghost" onClick={() => setShowAgentModal(true)}>
            Agent
          </button>
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
            <div className="preview-controls">
              <div className="preview-mode-toggle">
                <button type="button" className={`documine-btn documine-btn--sm ${previewMode === 'markdown' ? 'documine-btn--primary' : 'documine-btn--ghost'}`} onClick={() => handlePreviewModeChange('markdown')}>
                  Markdown
                </button>
                <button type="button" className={`documine-btn documine-btn--sm ${previewMode === 'rendered-pdf' ? 'documine-btn--primary' : 'documine-btn--ghost'}`} onClick={() => handlePreviewModeChange('rendered-pdf')}>
                  Print preview
                </button>
              </div>
              {previewMode === 'rendered-pdf' ? (
                <>
                  <span className="pdf-preview-note pdf-preview-note--inline">
                    {renderedPdfLoading
                      ? `Refreshing preview... ${formatDurationMs(renderedPdfElapsedMs)}`
                      : renderedPdfDirty
                        ? 'Waiting for typing to pause before refreshing.'
                        : renderedPdfLastDurationMs !== null
                          ? `Last refresh: ${formatDurationMs(renderedPdfLastDurationMs)}`
                          : 'Auto-refreshes after a short idle delay.'}
                  </span>
                  <div className="pdf-preview-zoom-controls" aria-label="Preview zoom controls">
                    <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={handleRenderedPdfZoomOut} disabled={renderedPdfZoom <= RENDERED_PDF_ZOOM_MIN} aria-label="Zoom out preview">
                      -
                    </button>
                    <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost pdf-preview-zoom-value" onClick={handleRenderedPdfZoomReset} aria-label="Reset preview zoom">
                      {renderedPdfZoom}%
                    </button>
                    <button type="button" className="documine-btn documine-btn--sm documine-btn--ghost" onClick={handleRenderedPdfZoomIn} disabled={renderedPdfZoom >= RENDERED_PDF_ZOOM_MAX} aria-label="Zoom in preview">
                      +
                    </button>
                  </div>
                </>
              ) : null}
            </div>
            {previewMode === 'rendered-pdf' ? (
              <RenderedPreview url={renderedPdfUrl} zoom={renderedPdfZoom} loading={renderedPdfLoading} error={renderedPdfError} dirty={renderedPdfDirty} iframeRef={pdfPreviewFrameRef} />
            ) : (
              <AnchoredCommentCanvas
                renderedHtml={renderedHtml}
                previewScrollRef={previewScrollRef}
                syncPreviewScroll={syncPreviewScroll}
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
  const callbacksRef = useRef({ onReady, onTextChange, onConnectionChange, onThreadsUpdated, onParticipantsChange, onHistoryChange, onScrollMetricsChange, onUploadImage });
  const onEditorMountRef = useRef(onEditorMount);

  useEffect(() => {
    callbacksRef.current = { onReady, onTextChange, onConnectionChange, onThreadsUpdated, onParticipantsChange, onHistoryChange, onScrollMetricsChange, onUploadImage };
  }, [onConnectionChange, onHistoryChange, onParticipantsChange, onReady, onScrollMetricsChange, onTextChange, onThreadsUpdated, onUploadImage]);

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
      onParticipantsChange: (participants: ShareParticipant[]) => callbacksRef.current.onParticipantsChange?.(participants),
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
  }, [noteId, shareId]);

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
    textarea.addEventListener('scroll', syncFromTextarea);
    textarea.addEventListener('input', syncMetrics);
    horizontalScroll.addEventListener('scroll', syncFromScrollbar);

    const resizeObserver = new ResizeObserver(syncMetrics);
    resizeObserver.observe(textarea);

    const intervalId = window.setInterval(syncMetrics, 250);

    return () => {
      textarea.removeEventListener('scroll', syncFromTextarea);
      textarea.removeEventListener('input', syncMetrics);
      horizontalScroll.removeEventListener('scroll', syncFromScrollbar);
      resizeObserver.disconnect();
      window.clearInterval(intervalId);
    };
  }, [wrapEnabled, initialValue]);

  return (
    <div className={`editor-textarea-shell ${wrapEnabled ? '' : 'editor-textarea-shell--nowrap'}`.trim()}>
      <textarea ref={textareaRef} className={`editor-textarea ${wrapEnabled ? '' : 'editor-textarea--nowrap'}`.trim()} spellCheck={false} wrap={wrapEnabled ? 'soft' : 'off'} />
      <div ref={horizontalScrollRef} className="editor-horizontal-scroll" aria-hidden={wrapEnabled}>
        <div ref={horizontalScrollSpacerRef} className="editor-horizontal-scroll-spacer" />
      </div>
    </div>
  );
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

function formatDurationMs(value: number) {
  if (value < 1000) {
    return `${value} ms`;
  }
  return `${(value / 1000).toFixed(1)} s`;
}

function handleCommentTextareaKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, canSubmit: boolean, submit: () => void) {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.nativeEvent.isComposing) {
    return;
  }
  event.preventDefault();
  if (canSubmit) {
    submit();
  }
}

function RenderedPreview({ url, zoom, loading, error, dirty, iframeRef }: { url: string; zoom: number; loading: boolean; error: string; dirty: boolean; iframeRef: RefCallback<HTMLIFrameElement> }) {
  return (
    <div className="preview-scroll preview-scroll--pdf">
      <div className="pdf-preview-shell">
        {error ? <div className="inline-error">{error}</div> : null}
        {url ? (
          <iframe
            ref={iframeRef}
            title="Rendered print preview"
            className="pdf-preview-frame pdf-preview-frame--document"
            src={url}
            style={{ zoom: zoom / 100 }}
          />
        ) : !loading && !dirty ? (
          <p className="pdf-preview-status">No rendered preview available yet.</p>
        ) : null}
      </div>
    </div>
  );
}

function PdfExportModal({ noteId, markdown, onClose }: { noteId: string; markdown: string; onClose: () => void }) {
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
      const response = await saveNotePdf(noteId, markdown, settings);
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
            Engine: Browser PDF · Defaults saved to instance data
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
          <textarea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            onKeyDown={(event) => handleCommentTextareaKeyDown(event, !busy && !!body.trim(), () => void handleSubmit())}
            placeholder="Comment"
          />
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

function locateAnchor(anchor: AnchorWithOptionalHeading, root: HTMLElement) {
  const mapping = collectTextNodes(root);
  if (!mapping.fullText || !anchor.quote) {
    return null;
  }

  const candidates: number[] = [];
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

  const headingText = normalizePreviewText(anchor.heading?.text || '');
  const headingOccurrences = headingText ? findTextOccurrences(normalizePreviewText(mapping.fullText), headingText) : [];

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

    if (headingOccurrences.length) {
      let nearestHeadingDistance = Infinity;
      for (const headingIndex of headingOccurrences) {
        if (headingIndex <= candidate) {
          nearestHeadingDistance = Math.min(nearestHeadingDistance, candidate - headingIndex);
        }
      }
      if (nearestHeadingDistance !== Infinity) {
        score += 10;
        score -= Math.min(nearestHeadingDistance / 10, 10);
      } else {
        score -= 10;
      }
    }

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

function usePreviewScrollHtmlSync(renderedHtml: string, syncPreviewScroll: () => void) {
  useEffect(() => {
    syncPreviewScroll();
  }, [renderedHtml, syncPreviewScroll]);
}

function AnchoredCommentCanvas({
  renderedHtml,
  previewScrollRef,
  syncPreviewScroll,
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
  previewScrollRef: RefCallback<HTMLDivElement>;
  syncPreviewScroll: () => void;
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

  usePreviewScrollHtmlSync(renderedHtml, syncPreviewScroll);

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
      <div ref={previewScrollRef} className="preview-scroll">
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
            <textarea
              value={replyBody}
              onChange={(event) => setReplyBody(event.target.value)}
              onKeyDown={(event) => handleCommentTextareaKeyDown(event, !replying && !!replyBody.trim(), () => void handleReply())}
              placeholder="Reply"
            />
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
