import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { getRequestListener } from '@hono/node-server';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { Hono, type Context } from 'hono';
import hljs from 'highlight.js';
import { marked, type Tokens } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  createNotesExportZip,
  importNotesExportZip,
  type ArchiveNoteInput,
} from './note-archive.js';
import {
  defaultPdfExportSettings,
  detectPdfExportCapabilities,
  exportMarkdownToPdf,
  loadPdfExportSettings,
  savePdfExportSettings,
  buildPdfCss,
  mergeSettings,
  warmPdfPreviewEngine,
} from './pdf-export.js';
import {
  type CollabState,
  type ClientMutation,
  type ClientMutationMessage,
  type ClientPresenceMessage,
  type SavedCollabState,
  type ServerHelloMessage,
  type ServerMutationMessage,
  type ServerPresenceLeaveMessage,
  type ServerPresenceMessage,
  applyClientMutations,
  collabFromMarkdown,
  collabToMarkdown,
  idAtIndex,
  idBeforeIndex,
  loadCollabState,
  newCollabState,
  saveCollabState,
} from './collab.js';

type CommentAnchor = {
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
};

type CommentMessage = {
  id: string;
  parentId: string | null;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

type CommentThread = {
  id: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  anchor: CommentAnchor;
  messages: CommentMessage[];
};

type ShareAccess = 'none' | 'view' | 'comment' | 'edit';

type NoteMetaFile = {
  id: string;
  title: string;
  shareId: string;
  shareAccess: ShareAccess;
  createdAt: string;
  updatedAt: string;
  threads: CommentThread[];
  collab?: SavedCollabState;
  collabState?: SavedCollabState;
  importedAt?: string;
  importOpenedAt?: string | null;
};

type NoteRecord = {
  id: string;
  title: string;
  shareId: string;
  shareAccess: ShareAccess;
  createdAt: string;
  updatedAt: string;
  threads: CommentThread[];
  markdown: string;
  collab: CollabState;
  clientAcks: Map<string, number>;
  importedAt?: string;
  importOpenedAt?: string | null;
};

type NoteSummary = {
  id: string;
  title: string;
  updatedAt: string;
  shareId: string;
  snippet: string;
  isImportedUnread: boolean;
};

type NoteAssetSummary = {
  fileName: string;
  url: string;
  markdown: string;
  inUse: boolean;
  size: number;
  updatedAt: string;
};

type NotePdfExportSummary = {
  fileName: string;
  url: string;
  downloadUrl: string;
  debugUrl: string;
  debugHtmlUrl: string;
  debugCssUrl: string;
  debugMarkdownUrl: string;
  size: number;
  createdAt: string;
};

type DeviceToken = {
  id: string;
  salt: string;
  hash: string;
  createdAt: string;
  lastUsedAt: string;
};

type ApiKey = {
  id: string;
  label: string;
  keySalt: string;
  keyHash: string;
  createdAt: string;
};

type AuthData = {
  passwordSalt: string;
  passwordHash: string;
  tokens: DeviceToken[];
  apiKeys?: ApiKey[];
};

type AuthGuardLoginRequest = {
  ip: string;
  timestamp: string;
};

type AuthGuardFailedLogin = {
  ip: string;
  timestamp: string;
};

type AuthGuardIpBan = {
  ip: string;
  bannedAt: string;
  expiresAt: string;
  reason: string;
};

type AuthGuardEvent = {
  type: 'login-requested' | 'login-failed' | 'login-succeeded' | 'login-blocked' | 'ip-banned' | 'ip-unbanned' | 'login-enabled' | 'login-disabled' | 'login-locked';
  ip: string;
  timestamp: string;
  detail: string;
};

type AuthGuardData = {
  loginEnabled: boolean;
  globalLock: {
    active: boolean;
    lockedAt: string | null;
    expiresAt: string | null;
    reason: string | null;
  };
  bannedIps: AuthGuardIpBan[];
};

type AuthGuardRuntime = {
  loginRequests: AuthGuardLoginRequest[];
  failedLogins: AuthGuardFailedLogin[];
};

type AuthGuardSummary = {
  loginEnabled: boolean;
  globalLockActive: boolean;
  globalLockAt: string | null;
  globalLockExpiresAt: string | null;
  globalLockReason: string | null;
  recentLoginRequestCount: number;
  bannedIpCount: number;
};

type ViewerInfo = {
  isOwner: boolean;
  commenterName: string | null;
  hasCommenterIdentity: boolean;
};

type ClientConn = {
  ws: WebSocket;
  kind: 'editor' | 'public-editor' | 'public-viewer';
  noteId: string;
  shareId: string;
  clientId: string;
  name: string;
  color: string;
  alive: boolean;
  selection?: ClientPresenceMessage['selection'];
};

type ShareParticipantMessage = {
  type: 'participants';
  participants: Array<{
    clientId: string;
    name: string;
    permissionLabel: string;
  }>;
};

type AnyServerMessage =
  | (ServerHelloMessage & { clientId?: string })
  | ServerMutationMessage
  | ServerPresenceMessage
  | ServerPresenceLeaveMessage
  | ShareParticipantMessage
  | { type: 'updated'; noteId: string; shareId: string; updatedAt: string }
  | { type: 'threads-updated'; noteId: string; shareId: string };

function cliArg(name: string) {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.split('=').slice(1).join('=') : null;
}

const port = Number(cliArg('port') || process.env.PORT || 3120);
const dataDir = cliArg('data') || process.env.DATA_DIR || path.join(process.cwd(), 'data');
const notesDir = path.join(dataDir, 'notes');
const noteAssetsDir = path.join(dataDir, 'assets');
const noteExportsDir = path.join(dataDir, 'exports');
const authFilePath = path.join(dataDir, 'auth.json');
const authGuardFilePath = path.join(dataDir, 'auth-guard.json');
const authGuardLogFilePath = path.join(dataDir, 'auth-guard.jsonl');
const exportSettingsFilePath = path.join(dataDir, 'export-settings.json');
const activePdfPreviewControllers = new Map<string, AbortController>();
const ownerSessionCookieName = 'documine_owner_session';
const ownerLocalStorageTokenKey = 'documine_owner_token';
const commenterIdCookieName = 'documine_commenter_id';
const commenterNameCookieName = 'documine_commenter_name';
const ownerCookieMaxAgeSeconds = 60 * 60 * 24 * 30;
const commenterCookieMaxAgeSeconds = 60 * 60 * 24 * 365;
const authIpBanDurationMs = 1000 * 60 * 15;
const authFailedAttemptWindowMs = 1000 * 60 * 15;
const authFailedAttemptBanThreshold = 3;
const authGlobalLoginWindowMs = 1000 * 60 * 5;
const authGlobalLoginThreshold = 10;
const shareAccessLevels: Record<ShareAccess, number> = { none: 0, view: 1, comment: 2, edit: 3 };
const maxImageUploadBytes = 10 * 1024 * 1024;
const maxNotesImportZipBytes = 100 * 1024 * 1024;
const imageMimeExtensions: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
};
const notes = new Map<string, NoteRecord>();
const clients: ClientConn[] = [];
const CURSOR_COLORS = ['#4285f4', '#ea4335', '#34a853', '#fbbc04', '#9c27b0', '#ff6d00', '#00bcd4', '#e91e63'];
let nextColorIndex = 0;
let clientIdCounter = 0;

const codeRenderer = new marked.Renderer();
codeRenderer.code = ({ text, lang }: Tokens.Code) => {
  const language = (lang || '').trim().split(/\s+/)[0];
  if (language === 'mermaid') {
    return `<pre class="mermaid">${escapeHtml(text)}</pre>`;
  }
  const validLanguage = language && hljs.getLanguage(language) ? language : null;
  const highlighted = validLanguage
    ? hljs.highlight(text, { language: validLanguage }).value
    : escapeHtml(text);
  const languageClass = validLanguage ? ` class="hljs language-${escapeHtml(validLanguage)}"` : ' class="hljs"';
  return `<pre><code${languageClass}>${highlighted}</code></pre>`;
};

marked.setOptions({
  gfm: true,
  breaks: false,
  renderer: codeRenderer,
});

ensureDirectories();
loadNotesIntoMemory();
const authGuardRuntime = loadAuthGuardRuntime();

const app = new Hono();

app.use('/api/*', async (c, next) => {
  const origin = c.req.header('origin');
  if (origin && isAllowedBrowserOrigin(origin)) {
    c.header('Access-Control-Allow-Origin', origin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    c.header('Vary', 'Origin');
  }

  if (c.req.method === 'OPTIONS') {
    return c.body(null, 204);
  }

  await next();
});

app.get('/', (c) => c.json({ ok: true, service: 'documine-api' }));

app.get('/health', (c) => c.text('ok'));

app.get('/assets/:noteId/:fileName', (c) => {
  const note = notes.get(c.req.param('noteId'));
  if (!note) {
    return c.text('Not found.', 404);
  }
  if (!isOwnerAuthenticated(c) && shareAccessLevels[note.shareAccess] < shareAccessLevels.view) {
    return c.text('Forbidden.', 403);
  }

  const fileName = path.basename(c.req.param('fileName'));
  const filePath = path.join(noteAssetDirectory(note.id), fileName);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return c.text('Not found.', 404);
  }

  const extension = path.extname(fileName).toLowerCase();
  const contentType = imageContentTypeFromExtension(extension);
  if (!contentType) {
    return c.text('Unsupported media type.', 415);
  }

  return c.body(fs.readFileSync(filePath), 200, {
    'Content-Type': contentType,
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
});

app.get('/api/viewer', (c) => {
  const authGuard = loadAuthGuardData();
  if (pruneAuthGuardData(authGuard)) {
    saveAuthGuardData(authGuard);
  }

  return c.json({
    ok: true,
    authConfigured: authConfigured(),
    ownerAuthenticated: isOwnerAuthenticated(c),
    ownerLocalStorageTokenKey,
    authGuard: buildAuthGuardSummary(authGuard),
    viewer: buildViewerInfo(c),
  });
});

app.post('/api/auth/setup', async (c) => {
  if (authConfigured()) {
    return c.json({ ok: false, error: 'Password already configured.' }, 400);
  }

  const body = await readJsonBody(c);
  const password = String(body.password || '');
  const confirmPassword = String(body.confirmPassword || '');

  if (password.length < 8) {
    return c.json({ ok: false, error: 'Use at least 8 characters.' }, 400);
  }

  if (password !== confirmPassword) {
    return c.json({ ok: false, error: 'Passwords do not match.' }, 400);
  }

  const token = initializeOwnerAuth(password);
  return c.json({ ok: true, token, ownerLocalStorageTokenKey });
});

app.post('/api/auth/login', async (c) => {
  if (!authConfigured()) {
    return c.json({ ok: false, error: 'Password is not configured yet.' }, 400);
  }

  const authGuard = loadAuthGuardData();
  if (pruneAuthGuardData(authGuard)) {
    saveAuthGuardData(authGuard);
  }
  const ip = getClientIp(c);

  if (!authGuard.loginEnabled) {
    appendAuthGuardEvent({
      type: 'login-blocked',
      ip,
      timestamp: nowIso(),
      detail: authGuard.globalLock.active
        ? 'Owner login is locked due to suspicious activity.'
        : 'Owner login is disabled.',
    });
    saveAuthGuardData(authGuard);
    return c.json({
      ok: false,
      error: authGuard.globalLock.active
        ? authGuard.globalLock.expiresAt
          ? `Owner login is temporarily locked until ${authGuard.globalLock.expiresAt}.`
          : 'Owner login is locked due to suspicious activity. Use the CLI or auth-guard.json to re-enable it.'
        : 'Owner login is currently disabled.',
    }, authGuard.globalLock.active ? 423 : 403);
  }

  const timestamp = nowIso();
  recordAuthGuardLoginRequest(ip, timestamp);
  if (authGuardRuntime.loginRequests.length > authGlobalLoginThreshold) {
    authGuard.loginEnabled = false;
    authGuard.globalLock = {
      active: true,
      lockedAt: timestamp,
      expiresAt: null,
      reason: `More than ${authGlobalLoginThreshold} login requests in ${Math.round(authGlobalLoginWindowMs / 60000)} minutes.`,
    };
    appendAuthGuardEvent({
      type: 'login-locked',
      ip,
      timestamp,
      detail: authGuard.globalLock.reason || 'Owner login locked due to suspicious activity.',
    });
    console.warn(`[auth-guard] login-locked ip=${ip} timestamp=${timestamp} reason=${authGuard.globalLock.reason}`);
    saveAuthGuardData(authGuard);
    return c.json({ ok: false, error: 'Owner login has been locked due to suspicious activity. The current owner can re-enable it from the CLI or auth-guard.json.' }, 423);
  }

  const activeBan = getActiveIpBan(authGuard, ip);
  if (activeBan) {
    appendAuthGuardEvent({
      type: 'login-blocked',
      ip,
      timestamp,
      detail: `Blocked by temporary IP ban until ${activeBan.expiresAt}.`,
    });
    saveAuthGuardData(authGuard);
    return c.json({ ok: false, error: `Too many failed login attempts from this IP. Login is disabled until ${activeBan.expiresAt}.` }, 429);
  }

  const body = await readJsonBody(c);
  const password = String(body.password || '');
  if (!passwordMatches(password)) {
    recordAuthGuardFailedLogin(ip, timestamp);
    const failedAttemptsForIp = authGuardRuntime.failedLogins.filter((attempt) => attempt.ip === ip).length;

    if (failedAttemptsForIp >= authFailedAttemptBanThreshold) {
      const expiresAt = new Date(Date.now() + authIpBanDurationMs).toISOString();
      const existingBan = authGuard.bannedIps.find((item) => item.ip === ip);
      if (existingBan) {
        existingBan.bannedAt = timestamp;
        existingBan.expiresAt = expiresAt;
        existingBan.reason = `${authFailedAttemptBanThreshold} failed owner login attempts.`;
      } else {
        authGuard.bannedIps.push({
          ip,
          bannedAt: timestamp,
          expiresAt,
          reason: `${authFailedAttemptBanThreshold} failed owner login attempts.`,
        });
      }
      authGuard.loginEnabled = false;
      authGuard.globalLock = {
        active: true,
        lockedAt: timestamp,
        expiresAt,
        reason: `${authFailedAttemptBanThreshold} failed owner login attempts triggered a temporary login lock.`,
      };
      appendAuthGuardEvent({
        type: 'ip-banned',
        ip,
        timestamp,
        detail: `Temporary ban active until ${expiresAt}.`,
      });
      appendAuthGuardEvent({
        type: 'login-locked',
        ip,
        timestamp,
        detail: `Owner login temporarily locked until ${expiresAt} after ${authFailedAttemptBanThreshold} failed password attempts.`,
      });
      console.warn(`[auth-guard] ip-banned ip=${ip} timestamp=${timestamp} expiresAt=${expiresAt}`);
      console.warn(`[auth-guard] login-locked ip=${ip} timestamp=${timestamp} expiresAt=${expiresAt} reason=${authGuard.globalLock.reason}`);
      saveAuthGuardData(authGuard);
      return c.json({ ok: false, error: `Owner login is temporarily locked until ${expiresAt}.` }, 423);
    }

    saveAuthGuardData(authGuard);
    return c.json({ ok: false, error: 'Invalid credentials.' }, 401);
  }

  clearAuthGuardFailedLoginsForIp(ip);
  appendAuthGuardEvent({
    type: 'login-succeeded',
    ip,
    timestamp,
    detail: 'Owner login succeeded.',
  });
  saveAuthGuardData(authGuard);

  const token = issueOwnerToken();
  return c.json({ ok: true, token, ownerLocalStorageTokenKey });
});

app.post('/api/auth/token', async (c) => {
  const body = await readJsonBody(c);
  const token = String(body.token || '');
  if (!token || !verifyOwnerToken(token)) {
    clearOwnerSessionCookie(c);
    return c.json({ ok: false }, 401);
  }

  setOwnerSessionCookie(c, token);
  return c.json({ ok: true });
});

app.post('/api/auth/logout', (c) => {
  const token = getOwnerSessionToken(c);
  if (token) {
    revokeOwnerToken(token);
  }
  clearOwnerSessionCookie(c);
  return c.json({ ok: true });
});

app.get('/api/auth/guard', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const authGuard = loadAuthGuardData();
  if (pruneAuthGuardData(authGuard)) {
    saveAuthGuardData(authGuard);
  }
  return c.json({ ok: true, authGuard: buildAuthGuardSummary(authGuard), bans: authGuard.bannedIps });
});

app.put('/api/auth/guard/login', async (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const body = await readJsonBody(c);
  const enabled = body.enabled === true;
  const authGuard = loadAuthGuardData();
  pruneAuthGuardData(authGuard);
  authGuard.loginEnabled = enabled;
  authGuard.globalLock = {
    active: false,
    lockedAt: null,
    expiresAt: null,
    reason: null,
  };
  const timestamp = nowIso();
  appendAuthGuardEvent({
    type: enabled ? 'login-enabled' : 'login-disabled',
    ip: getClientIp(c),
    timestamp,
    detail: enabled ? 'Owner login manually enabled.' : 'Owner login manually disabled.',
  });
  console.warn(`[auth-guard] ${enabled ? 'login-enabled' : 'login-disabled'} ip=${getClientIp(c)} timestamp=${timestamp}`);
  saveAuthGuardData(authGuard);
  return c.json({ ok: true, authGuard: buildAuthGuardSummary(authGuard), bans: authGuard.bannedIps });
});

app.delete('/api/auth/guard/bans/:ip', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const authGuard = loadAuthGuardData();
  pruneAuthGuardData(authGuard);
  const ip = decodeURIComponent(c.req.param('ip'));
  const before = authGuard.bannedIps.length;
  authGuard.bannedIps = authGuard.bannedIps.filter((item) => item.ip !== ip);
  clearAuthGuardFailedLoginsForIp(ip);
  if (authGuard.bannedIps.length === before) {
    return c.json({ ok: false, error: 'IP ban not found.' }, 404);
  }
  const timestamp = nowIso();
  appendAuthGuardEvent({
    type: 'ip-unbanned',
    ip,
    timestamp,
    detail: 'Temporary IP ban removed by owner.',
  });
  console.warn(`[auth-guard] ip-unbanned ip=${ip} timestamp=${timestamp}`);
  saveAuthGuardData(authGuard);
  return c.json({ ok: true, authGuard: buildAuthGuardSummary(authGuard), bans: authGuard.bannedIps });
});

app.get('/api/keys', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  return c.json({ ok: true, keys: listApiKeys() });
});

app.get('/api/export/settings', async (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const [settings, capabilities] = await Promise.all([
    loadPdfExportSettings(exportSettingsFilePath),
    detectPdfExportCapabilities(),
  ]);

  return c.json({ ok: true, settings, defaults: defaultPdfExportSettings, capabilities });
});

app.put('/api/export/settings', async (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const body = await readJsonBody(c);
  const settings = await savePdfExportSettings(exportSettingsFilePath, body.settings);
  const capabilities = await detectPdfExportCapabilities();
  return c.json({ ok: true, settings, defaults: defaultPdfExportSettings, capabilities });
});

app.post('/api/keys', async (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const body = await readJsonBody(c);
  const label = String(body.label || 'unnamed');
  const result = createApiKey(label);
  return c.json({ ok: true, ...result });
});

app.delete('/api/keys/:id', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const deleted = deleteApiKey(c.req.param('id'));
  if (!deleted) {
    return c.json({ ok: false, error: 'API key not found.' }, 404);
  }

  return c.json({ ok: true });
});

app.get('/api/notes', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const query = c.req.query('q') || '';
  return c.json({ ok: true, notes: searchNotes(query) });
});

app.post('/api/notes', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = createNote();
  return c.json({ ok: true, note: summarizeNote(note, '') });
});

app.post('/api/notes/export', async (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const body = await readJsonBody(c) as { scope?: unknown; noteIds?: unknown };
  const selectedNotes = selectNotesForExport(body);
  if (!selectedNotes.length) {
    return c.json({ ok: false, error: 'Select at least one note to export.' }, 400);
  }

  const archiveNotes = selectedNotes.map((note) => buildArchiveNoteInput(note));
  const zip = createNotesExportZip({ notes: archiveNotes, exportedAt: nowIso() });
  const fileName = archiveNotes.length === 1
    ? `${slugifyFileName(archiveNotes[0].title) || 'note'}.documine.zip`
    : `documine-notes-${new Date().toISOString().slice(0, 10)}.zip`;
  return c.body(new Uint8Array(zip), 200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="${fileName}"`,
    'Cache-Control': 'no-store',
  });
});

app.post(
  '/api/notes/import',
  bodyLimit({
    maxSize: maxNotesImportZipBytes,
    onError: (c) => c.json({ ok: false, error: 'This export is too large to import.' }, 413),
  }),
  async (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: 'Unauthorized.' }, 401);
    }

    const body = await c.req.parseBody();
    const file = body.file;
    if (!(file instanceof File) || !file.name.toLowerCase().endsWith('.zip')) {
      return c.json({ ok: false, error: 'Choose a .zip file exported from Documine.' }, 400);
    }

    let result;
    try {
      result = importNotesExportZip({
        zipBuffer: Buffer.from(await file.arrayBuffer()),
        existingTitles: new Set(Array.from(notes.values()).map((note) => note.title)),
        now: nowIso(),
        createId: () => createShortId(),
      });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : 'This file is not a valid Documine notes export.' }, 400);
    }

    for (const imported of result.imported) {
      const note: NoteRecord = {
        id: imported.id,
        title: normalizeTitle(imported.title),
        shareId: imported.shareId,
        shareAccess: 'none',
        createdAt: imported.createdAt,
        updatedAt: imported.updatedAt,
        markdown: imported.markdown,
        threads: imported.threads,
        collab: collabFromMarkdown(imported.markdown),
        clientAcks: new Map(),
        importedAt: imported.importedAt,
        importOpenedAt: imported.importOpenedAt,
      };
      notes.set(note.id, note);
      fs.mkdirSync(noteAssetDirectory(note.id), { recursive: true });
      for (const asset of imported.assets) {
        fs.writeFileSync(noteAssetPath(note.id, asset.fileName), asset.bytes);
      }
      persistNote(note);
    }

    return c.json({
      ok: true,
      imported: result.imported.map((note) => ({ id: note.id, title: note.title, updatedAt: note.updatedAt })),
      skipped: result.skipped,
      warnings: result.warnings,
    });
  },
);

app.get('/api/notes/:id', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  const offsetQuery = c.req.query('offset');
  const limitQuery = c.req.query('limit');
  const offset = offsetQuery ? Number(offsetQuery) : null;
  const limit = limitQuery ? Number(limitQuery) : null;

  if (offset !== null || limit !== null) {
    const lines = note.markdown.split('\n');
    const start = Math.max(0, (offset || 1) - 1);
    const end = limit ? Math.min(lines.length, start + limit) : lines.length;
    const slice = lines.slice(start, end);
    const totalLines = lines.length;
    const remaining = totalLines - end;

    return c.json({
      ok: true,
      note: {
        id: note.id,
        title: note.title,
        totalLines,
        offset: start + 1,
        limit: slice.length,
        remaining,
        content: slice.map((line, index) => `${start + index + 1}: ${line}`).join('\n'),
      },
    });
  }

  if (note.importedAt && note.importOpenedAt === null) {
    note.importOpenedAt = nowIso();
    persistNote(note);
  }

  return c.json({ ok: true, ...serializeNoteForClient(note, c) });
});

app.get('/api/notes/:id/exports', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  return c.json({ ok: true, exports: collectNoteExports(note) });
});

app.get('/api/notes/:id/exports/:fileName', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  const exportFile = loadManagedNoteExportFile(note.id, c.req.param('fileName'));
  if (!exportFile) {
    return c.json({ ok: false, error: 'Export not found.' }, 404);
  }

  const asDownload = c.req.query('download') === '1';
  const asInline = c.req.query('inline') === '1' || !asDownload;
  const dispositionType = asInline ? 'inline' : 'attachment';
  return c.body(fs.readFileSync(exportFile.filePath), 200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${dispositionType}; filename="${exportFile.fileName}"`,
    'Cache-Control': 'no-store',
  });
});

app.get('/api/notes/:id/exports/:fileName/debug', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  const exportFile = loadManagedDebugExportFile(note.id, c.req.param('fileName'));
  if (!exportFile) {
    return c.json({ ok: false, error: 'Export debug not found.' }, 404);
  }

  return c.json({ ok: true, fileName: exportFile.fileName, ...exportFile.debug });
});

app.get('/api/notes/:id/exports/:fileName/debug/:kind', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  const exportFile = loadManagedDebugExportFile(note.id, c.req.param('fileName'));
  if (!exportFile) {
    return c.json({ ok: false, error: 'Export debug not found.' }, 404);
  }

  const kind = c.req.param('kind');
  if (kind === 'html') {
    return c.body(exportFile.debug.html, 200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  if (kind === 'css') {
    return c.body(exportFile.debug.css, 200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  if (kind === 'markdown') {
    return c.body(exportFile.debug.markdown, 200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' });
  }
  return c.json({ ok: false, error: 'Unknown debug artifact.' }, 404);
});

app.delete('/api/notes/:id/exports/:fileName', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  const exportFile = loadManagedNoteExportFile(note.id, c.req.param('fileName'));
  if (!exportFile) {
    return c.json({ ok: false, error: 'Export not found.' }, 404);
  }

  try { fs.unlinkSync(exportFile.filePath); } catch {}
  try { fs.unlinkSync(noteExportAssetPath(note.id, exportFile.fileName, '.html')); } catch {}
  try { fs.unlinkSync(noteExportAssetPath(note.id, exportFile.fileName, '.css')); } catch {}
  try { fs.unlinkSync(noteExportAssetPath(note.id, exportFile.fileName, '.md')); } catch {}
  try { fs.unlinkSync(noteExportAssetPath(note.id, exportFile.fileName, '.json')); } catch {}

  return c.json({ ok: true, exports: collectNoteExports(note) });
});

app.post('/api/notes/:id/export/html-preview', async (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  const body = await readJsonBody(c) as { markdown?: unknown; settings?: unknown };
  const savedSettings = await loadPdfExportSettings(exportSettingsFilePath);
  const previewKey = `${note.id}:owner-preview`;
  activePdfPreviewControllers.get(previewKey)?.abort();
  const controller = new AbortController();
  activePdfPreviewControllers.set(previewKey, controller);
  const requestStartedAt = performance.now();

  try {
    const markdown = typeof body.markdown === 'string' ? body.markdown : note.markdown;
    const settings = body.settings === undefined ? savedSettings : body.settings;
    const html = renderPrintPreviewHtml(markdown, note.title, settings);
    if (activePdfPreviewControllers.get(previewKey) === controller) {
      activePdfPreviewControllers.delete(previewKey);
    }
    const baseHref = `${new URL(c.req.url).origin}/`;
    const outHtml = injectPreviewBaseHref(html, baseHref);
    console.log(`[html-preview] note=${note.id} total=${Math.round(performance.now() - requestStartedAt)}ms`);
    return c.body(outHtml, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  } catch (error) {
    if (activePdfPreviewControllers.get(previewKey) === controller) {
      activePdfPreviewControllers.delete(previewKey);
    }
    const message = error instanceof Error ? error.message : 'Preview failed.';
    if (controller.signal.aborted) {
      console.log(`[html-preview] note=${note.id} cancelled after ${Math.round(performance.now() - requestStartedAt)}ms`);
      return c.json({ ok: false, error: 'Preview superseded by a newer request.' }, 409);
    }
    console.log(`[html-preview] note=${note.id} failed after ${Math.round(performance.now() - requestStartedAt)}ms error=${message}`);
    return c.json({ ok: false, error: message }, 500);
  }
});

app.post('/api/notes/:id/export/pdf', async (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  const body = await readJsonBody(c) as { markdown?: unknown; settings?: unknown };
  const savedSettings = await loadPdfExportSettings(exportSettingsFilePath);

  try {
    const result = await exportMarkdownToPdf({
      noteId: note.id,
      noteTitle: note.title,
      markdown: typeof body.markdown === 'string' ? body.markdown : note.markdown,
      settings: body.settings === undefined ? savedSettings : body.settings,
      assetDirectory: noteAssetDirectory(note.id),
    });
    const finalFileName = buildIncrementedExportFileName(note.id, note.title || result.fileName.replace(/\.pdf$/i, ''));
    const exportPath = noteExportPath(note.id, finalFileName);
    fs.mkdirSync(noteExportDirectory(note.id), { recursive: true });
    fs.writeFileSync(exportPath, result.pdf);
    fs.writeFileSync(noteExportAssetPath(note.id, finalFileName, '.html'), result.debug.html, 'utf8');
    fs.writeFileSync(noteExportAssetPath(note.id, finalFileName, '.css'), result.debug.css, 'utf8');
    fs.writeFileSync(noteExportAssetPath(note.id, finalFileName, '.md'), result.debug.markdown, 'utf8');
    writeJson(noteExportAssetPath(note.id, finalFileName, '.json'), {
      noteId: note.id,
      noteTitle: note.title,
      createdAt: nowIso(),
      settings: body.settings === undefined ? savedSettings : body.settings,
      fileName: finalFileName,
    });
    return c.json({
      ok: true,
      export: collectNoteExports(note).find((item) => item.fileName === finalFileName) || null,
      exports: collectNoteExports(note),
    });
  } catch (error) {
    return c.json({ ok: false, error: error instanceof Error ? error.message : 'PDF export failed.' }, 500);
  }
});

app.put('/api/notes/:id', async (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  const body = await readJsonBody(c);
  const titleProvided = Object.prototype.hasOwnProperty.call(body, 'title');
  const markdownProvided = Object.prototype.hasOwnProperty.call(body, 'markdown');
  const shareAccessProvided = Object.prototype.hasOwnProperty.call(body, 'shareAccess');
  const nextTitle = titleProvided ? normalizeTitle(String(body.title || note.title)) : note.title;
  const nextMarkdown = markdownProvided ? String(body.markdown || '') : note.markdown;
  const nextShareAccess = shareAccessProvided && ['none', 'view', 'comment', 'edit'].includes(String(body.shareAccess))
    ? (String(body.shareAccess) as ShareAccess)
    : note.shareAccess;

  const titleChanged = nextTitle !== note.title;
  const markdownChanged = nextMarkdown !== note.markdown;
  const shareAccessChanged = nextShareAccess !== note.shareAccess;

  note.title = nextTitle;
  note.shareAccess = nextShareAccess;
  if (markdownChanged) {
    note.collab = collabFromMarkdown(nextMarkdown, note.collab.serverCounter + 1);
    note.markdown = nextMarkdown;
  }
  note.updatedAt = nowIso();
  persistNote(note, false);

  if (shareAccessChanged) {
    enforceShareAccessForConnections(note);
  }
  if (titleChanged || markdownChanged || shareAccessChanged) {
    broadcastEditorHello(note);
    broadcastNoteUpdate(note);
  }

  return c.json({ ok: true, savedAt: note.updatedAt, shareAccess: note.shareAccess });
});

app.delete('/api/notes/:id', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const noteId = c.req.param('id');
  const note = notes.get(noteId);
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  notes.delete(noteId);
  closeConnectionsForNote(note.id);
  try { fs.unlinkSync(noteMarkdownPath(noteId)); } catch {}
  try { fs.unlinkSync(noteMetaPath(noteId)); } catch {}
  try { fs.rmSync(noteAssetDirectory(noteId), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(noteExportDirectory(noteId), { recursive: true, force: true }); } catch {}
  return c.json({ ok: true });
});

app.post('/api/notes/:id/edit', async (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  const body = await readJsonBody(c);
  const edits = body.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    return c.json({ ok: false, error: 'edits must be a non-empty array of {oldText, newText}.' }, 400);
  }

  const result = applyTextEditsToNote(note, edits);
  if (!result.ok) {
    return c.json({ ok: false, errors: result.errors }, 400);
  }

  const titleProvided = Object.prototype.hasOwnProperty.call(body, 'title');
  const titleChanged = titleProvided && normalizeTitle(String(body.title || note.title)) !== note.title;
  if (titleProvided) {
    note.title = normalizeTitle(String(body.title || note.title));
  }
  note.updatedAt = nowIso();
  persistNote(note, false);

  if (titleChanged) {
    broadcastEditorHello(note);
  } else if (result.idListUpdates.length > 0) {
    broadcastEditorMutation(note, {
      type: 'mutation',
      senderId: '__api__',
      senderCounter: result.senderCounter,
      serverCounter: note.collab.serverCounter,
      markdown: note.markdown,
      idListUpdates: result.idListUpdates,
    });
  }
  broadcastNoteUpdate(note);
  return c.json({ ok: true, savedAt: note.updatedAt });
});

app.get('/api/notes/:id/assets', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  return c.json({ ok: true, assets: listNoteAssets(note, c) });
});

app.delete('/api/notes/:id/assets/:fileName', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  const fileName = path.basename(c.req.param('fileName'));
  const asset = listNoteAssets(note, c).find((item) => item.fileName === fileName);
  if (!asset) {
    return c.json({ ok: false, error: 'Asset not found.' }, 404);
  }
  if (asset.inUse) {
    return c.json({ ok: false, error: 'Remove this image from the note before deleting it.' }, 400);
  }

  try {
    fs.unlinkSync(noteAssetPath(note.id, fileName));
  } catch {
    return c.json({ ok: false, error: 'Failed to delete asset.' }, 500);
  }

  return c.json({ ok: true, assets: listNoteAssets(note, c) });
});

app.post(
  '/api/notes/:id/images',
  bodyLimit({
    maxSize: maxImageUploadBytes,
    onError: (c) => c.json({ ok: false, error: 'Image exceeds the 10 MB upload limit.' }, 413),
  }),
  async (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: 'Unauthorized.' }, 401);
    }

    const note = notes.get(c.req.param('id'));
    if (!note) {
      return c.json({ ok: false, error: 'Note not found.' }, 404);
    }

    return handleImageUpload(c, note);
  },
);

app.post('/api/notes/:id/threads', async (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  const body = await readJsonBody(c);
  const commentBody = normalizeCommentBody(String(body.body || ''));
  let anchor = sanitizeAnchor(body.anchor);

  if (!anchor) {
    const quote = String(body.quote || '');
    if (!quote || !commentBody) {
      return c.json({ ok: false, error: 'quote and body are required.' }, 400);
    }

    const start = note.markdown.indexOf(quote);
    if (start === -1) {
      return c.json({ ok: false, error: 'Quoted text not found in note.' }, 400);
    }

    const end = start + quote.length;
    anchor = {
      quote,
      prefix: note.markdown.slice(Math.max(0, start - 32), start),
      suffix: note.markdown.slice(end, end + 32),
      start,
      end,
    };
  }

  if (!commentBody) {
    return c.json({ ok: false, error: 'quote and body are required.' }, 400);
  }

  const bearer = getBearerToken(c);
  const apiKeyLabel = bearer ? getApiKeyLabel(bearer) : null;
  const authorName = apiKeyLabel || 'Owner';
  const timestamp = nowIso();

  const thread: CommentThread = {
    id: createId(10),
    resolved: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    anchor,
    messages: [
      {
        id: createId(10),
        parentId: null,
        authorId: '__owner__',
        authorName,
        body: commentBody,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  };

  note.threads.push(thread);
  note.updatedAt = timestamp;
  persistNote(note);
  broadcastThreadsUpdated(note);
  return c.json({ ok: true, threads: serializeThreads(note, c) });
});

app.post('/api/notes/:id/threads/:threadId/replies', async (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  const thread = note.threads.find((item) => item.id === c.req.param('threadId'));
  if (!thread) {
    return c.json({ ok: false, error: 'Thread not found.' }, 404);
  }

  const body = await readJsonBody(c);
  const commentBody = normalizeCommentBody(String(body.body || ''));
  const parentMessageId = String(body.parentMessageId || thread.messages[0]?.id || '');
  if (!commentBody) {
    return c.json({ ok: false, error: 'body is required.' }, 400);
  }
  if (!thread.messages.some((message) => message.id === parentMessageId)) {
    return c.json({ ok: false, error: 'Parent message not found.' }, 400);
  }

  const bearer = getBearerToken(c);
  const apiKeyLabel = bearer ? getApiKeyLabel(bearer) : null;
  const authorName = apiKeyLabel || 'Owner';
  const timestamp = nowIso();

  thread.messages.push({
    id: createId(10),
    parentId: parentMessageId,
    authorId: '__owner__',
    authorName,
    body: commentBody,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  thread.updatedAt = timestamp;
  note.updatedAt = timestamp;
  persistNote(note);
  broadcastThreadsUpdated(note);
  return c.json({ ok: true, threads: serializeThreads(note, c) });
});

app.patch('/api/notes/:id/threads/:threadId', async (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  const thread = note.threads.find((item) => item.id === c.req.param('threadId'));
  if (!thread) {
    return c.json({ ok: false, error: 'Thread not found.' }, 404);
  }

  const body = await readJsonBody(c);
  thread.resolved = Boolean(body.resolved);
  thread.updatedAt = nowIso();
  note.updatedAt = thread.updatedAt;
  persistNote(note);
  broadcastThreadsUpdated(note);
  return c.json({ ok: true, threads: serializeThreads(note, c) });
});

app.delete('/api/notes/:id/threads/:threadId', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  note.threads = note.threads.filter((item) => item.id !== c.req.param('threadId'));
  note.updatedAt = nowIso();
  persistNote(note);
  broadcastThreadsUpdated(note);
  return c.json({ ok: true, threads: serializeThreads(note, c) });
});

app.patch('/api/notes/:id/messages/:messageId', async (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  const located = locateMessage(note, c.req.param('messageId'));
  if (!located) {
    return c.json({ ok: false, error: 'Message not found.' }, 404);
  }

  const body = await readJsonBody(c);
  const commentBody = normalizeCommentBody(String(body.body || ''));
  if (!commentBody) {
    return c.json({ ok: false, error: 'Body is required.' }, 400);
  }

  located.message.body = commentBody;
  located.message.updatedAt = nowIso();
  located.thread.updatedAt = located.message.updatedAt;
  note.updatedAt = located.message.updatedAt;
  persistNote(note);
  broadcastThreadsUpdated(note);
  return c.json({ ok: true, threads: serializeThreads(note, c) });
});

app.delete('/api/notes/:id/messages/:messageId', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  const located = locateMessage(note, c.req.param('messageId'));
  if (!located) {
    return c.json({ ok: false, error: 'Message not found.' }, 404);
  }

  located.thread.messages = located.thread.messages.filter((message) => message.id !== located.message.id);
  if (located.thread.messages.length === 0) {
    note.threads = note.threads.filter((thread) => thread.id !== located.thread.id);
  } else {
    located.thread.updatedAt = nowIso();
  }
  note.updatedAt = nowIso();
  persistNote(note);
  broadcastThreadsUpdated(note);
  return c.json({ ok: true, threads: serializeThreads(note, c) });
});

app.get('/api/notes/:id/collab', (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const note = notes.get(c.req.param('id'));
  if (!note) {
    return c.json({ ok: false, error: 'Note not found.' }, 404);
  }

  return c.json({
    ok: true,
    noteId: note.id,
    title: note.title,
    shareId: note.shareId,
    shareUrl: makeShareUrl(c, note.shareId),
    serverCounter: note.collab.serverCounter,
    collabState: saveCollabState(note.collab),
  });
});

app.post('/api/render', async (c) => {
  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Unauthorized.' }, 401);
  }

  const body = await readJsonBody(c);
  return c.json({ ok: true, html: renderMarkdown(String(body.markdown || '')) });
});

app.get('/api/share/:shareId/meta', (c) => {
  const note = requireShareAccess(c, 'view');
  if (!note) {
    return c.json({ ok: false, error: 'Shared note not found.' }, 404);
  }

  return c.json({
    ok: true,
    title: note.title,
    shareId: note.shareId,
    shareUrl: makeShareUrl(c, note.shareId),
    updatedAt: note.updatedAt,
  });
});

app.get('/api/share/:shareId', (c) => {
  const note = requireShareAccess(c, 'view');
  if (!note) {
    return c.json({ ok: false, error: 'Shared note not found.' }, 404);
  }
  if (!requireSharedIdentity(c)) {
    return c.json({ ok: false, error: 'Set your name first.', requiresIdentity: true }, 401);
  }

  return c.json({ ok: true, ...serializeNoteForClient(note, c) });
});

app.get('/api/share/:shareId/note', (c) => {
  const note = requireShareAccess(c, 'view');
  if (!note) {
    return c.json({ ok: false, error: 'Shared note not found.' }, 404);
  }
  if (!requireSharedIdentity(c)) {
    return c.json({ ok: false, error: 'Set your name first.', requiresIdentity: true }, 401);
  }

  return c.json({
    ok: true,
    note: {
      id: note.id,
      title: note.title,
      markdown: note.markdown,
      shareAccess: note.shareAccess,
      updatedAt: note.updatedAt,
    },
    threads: serializeThreads(note, c),
  });
});

app.get('/api/share/:shareId/collab', (c) => {
  const note = requireShareAccess(c, 'edit');
  if (!note) {
    return c.json({ ok: false, error: 'Shared note not found.' }, 404);
  }
  if (!requireSharedIdentity(c)) {
    return c.json({ ok: false, error: 'Set your name first.', requiresIdentity: true }, 401);
  }

  return c.json({
    ok: true,
    noteId: note.id,
    title: note.title,
    shareId: note.shareId,
    shareUrl: makeShareUrl(c, note.shareId),
    serverCounter: note.collab.serverCounter,
    collabState: saveCollabState(note.collab),
  });
});

app.post('/api/share/:shareId/edit', async (c) => {
  const note = requireShareAccess(c, 'edit');
  if (!note) {
    return c.json({ ok: false, error: 'Shared note not found.' }, 404);
  }
  if (!requireSharedIdentity(c)) {
    return c.json({ ok: false, error: 'Set your name first.', requiresIdentity: true }, 401);
  }

  const body = await readJsonBody(c);
  const edits = body.edits;
  if (!Array.isArray(edits) || edits.length === 0) {
    return c.json({ ok: false, error: 'edits must be a non-empty array of {oldText, newText}.' }, 400);
  }

  const result = applyTextEditsToNote(note, edits);
  if (!result.ok) {
    return c.json({ ok: false, errors: result.errors }, 400);
  }

  note.updatedAt = nowIso();
  persistNote(note, false);
  if (result.idListUpdates.length > 0) {
    broadcastEditorMutation(note, {
      type: 'mutation',
      senderId: '__api__',
      senderCounter: result.senderCounter,
      serverCounter: note.collab.serverCounter,
      markdown: note.markdown,
      idListUpdates: result.idListUpdates,
    });
  }
  broadcastNoteUpdate(note);
  return c.json({ ok: true, savedAt: note.updatedAt });
});

app.post('/api/share/:shareId/render', async (c) => {
  const note = requireShareAccess(c, 'view');
  if (!note) {
    return c.json({ ok: false, error: 'Shared note not found.' }, 404);
  }
  if (!requireSharedIdentity(c)) {
    return c.json({ ok: false, error: 'Set your name first.', requiresIdentity: true }, 401);
  }

  const body = await readJsonBody(c);
  return c.json({ ok: true, html: renderMarkdown(String(body.markdown || '')) });
});

app.post('/api/share/:shareId/export/html-preview', async (c) => {
  const note = requireShareAccess(c, 'view');
  if (!note) {
    return c.json({ ok: false, error: 'Shared note not found.' }, 404);
  }
  if (!requireSharedIdentity(c)) {
    return c.json({ ok: false, error: 'Set your name first.', requiresIdentity: true }, 401);
  }

  const body = await readJsonBody(c) as { markdown?: unknown; settings?: unknown };
  const markdown = typeof body.markdown === 'string' ? body.markdown : note.markdown;
  const settings = body.settings === undefined ? defaultPdfExportSettings : body.settings;
  const html = renderPrintPreviewHtml(markdown, note.title, settings);
  const baseHref = `${new URL(c.req.url).origin}/`;
  const outHtml = injectPreviewBaseHref(html, baseHref);
  return c.body(outHtml, 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
});

app.post('/api/share/:shareId/identity', async (c) => {
  const note = requireShareAccess(c, 'view');
  if (!note) {
    return c.json({ ok: false, error: 'Shared note not found.' }, 404);
  }

  const body = await readJsonBody(c);
  const name = normalizeCommenterName(String(body.name || ''));
  if (!name) {
    return c.json({ ok: false, error: 'Name is required.' }, 400);
  }

  const commenterId = getOrCreateCommenterId(c);
  setCommenterNameCookie(c, name);
  return c.json({
    ok: true,
    commenterIdSet: Boolean(commenterId),
    viewer: buildViewerInfo(c, { commenterNameOverride: name, hasCommenterIdentityOverride: true }),
  });
});

app.post(
  '/api/share/:shareId/images',
  bodyLimit({
    maxSize: maxImageUploadBytes,
    onError: (c) => c.json({ ok: false, error: 'Image exceeds the 10 MB upload limit.' }, 413),
  }),
  async (c) => {
    const note = requireShareAccess(c, 'edit');
    if (!note) {
      return c.json({ ok: false, error: 'Shared note not found.' }, 404);
    }
    if (!requireSharedIdentity(c)) {
      return c.json({ ok: false, error: 'Set your name first.', requiresIdentity: true }, 401);
    }

    return handleImageUpload(c, note);
  },
);

app.post('/api/share/:shareId/threads', async (c) => {
  const note = requireShareAccess(c, 'comment');
  if (!note) {
    return c.json({ ok: false, error: 'Shared note not found.' }, 404);
  }
  if (!requireSharedIdentity(c)) {
    return c.json({ ok: false, error: 'Set your name first.', requiresIdentity: true }, 401);
  }

  const body = await readJsonBody(c);
  const identity = ensureCommentAuthor(c, body);
  if (!identity) {
    return c.json({ ok: false, error: 'Set your name first.' }, 400);
  }

  const anchor = sanitizeAnchor(body.anchor);
  const commentBody = normalizeCommentBody(String(body.body || ''));
  if (!anchor || !commentBody) {
    return c.json({ ok: false, error: 'Anchor and comment body are required.' }, 400);
  }

  const timestamp = nowIso();
  note.threads.push({
    id: createId(10),
    resolved: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    anchor,
    messages: [
      {
        id: createId(10),
        parentId: null,
        authorId: identity.authorId,
        authorName: identity.authorName,
        body: commentBody,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
  });
  note.updatedAt = timestamp;
  persistNote(note);
  broadcastThreadsUpdated(note);
  return c.json({ ok: true, threads: serializeThreads(note, c) });
});

app.post('/api/share/:shareId/threads/:threadId/replies', async (c) => {
  const note = requireShareAccess(c, 'comment');
  if (!note) {
    return c.json({ ok: false, error: 'Shared note not found.' }, 404);
  }
  if (!requireSharedIdentity(c)) {
    return c.json({ ok: false, error: 'Set your name first.', requiresIdentity: true }, 401);
  }

  const thread = note.threads.find((item) => item.id === c.req.param('threadId'));
  if (!thread) {
    return c.json({ ok: false, error: 'Thread not found.' }, 404);
  }

  const body = await readJsonBody(c);
  const identity = ensureCommentAuthor(c, body);
  if (!identity) {
    return c.json({ ok: false, error: 'Set your name first.' }, 400);
  }

  const commentBody = normalizeCommentBody(String(body.body || ''));
  if (!commentBody) {
    return c.json({ ok: false, error: 'Reply body is required.' }, 400);
  }

  const requestedParentId = typeof body.parentMessageId === 'string' ? String(body.parentMessageId) : '';
  const parentMessageId = requestedParentId || thread.messages[0]?.id || '';
  if (!parentMessageId || !thread.messages.some((message) => message.id === parentMessageId)) {
    return c.json({ ok: false, error: 'Parent message not found.' }, 400);
  }

  const timestamp = nowIso();
  thread.messages.push({
    id: createId(10),
    parentId: parentMessageId,
    authorId: identity.authorId,
    authorName: identity.authorName,
    body: commentBody,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  thread.updatedAt = timestamp;
  note.updatedAt = timestamp;
  persistNote(note);
  broadcastThreadsUpdated(note);
  return c.json({ ok: true, threads: serializeThreads(note, c) });
});

app.patch('/api/share/:shareId/threads/:threadId', async (c) => {
  const note = requireShareAccess(c, 'comment');
  if (!note) {
    return c.json({ ok: false, error: 'Shared note not found.' }, 404);
  }
  if (!requireSharedIdentity(c)) {
    return c.json({ ok: false, error: 'Set your name first.', requiresIdentity: true }, 401);
  }

  const thread = note.threads.find((item) => item.id === c.req.param('threadId'));
  if (!thread) {
    return c.json({ ok: false, error: 'Thread not found.' }, 404);
  }

  if (!canManageThread(c, thread)) {
    return c.json({ ok: false, error: 'Not allowed.' }, 403);
  }

  const body = await readJsonBody(c);
  thread.resolved = Boolean(body.resolved);
  thread.updatedAt = nowIso();
  note.updatedAt = thread.updatedAt;
  persistNote(note);
  broadcastThreadsUpdated(note);
  return c.json({ ok: true, threads: serializeThreads(note, c) });
});

app.delete('/api/share/:shareId/threads/:threadId', (c) => {
  const note = requireShareAccess(c, 'comment');
  if (!note) {
    return c.json({ ok: false, error: 'Shared note not found.' }, 404);
  }
  if (!requireSharedIdentity(c)) {
    return c.json({ ok: false, error: 'Set your name first.', requiresIdentity: true }, 401);
  }

  const thread = note.threads.find((item) => item.id === c.req.param('threadId'));
  if (!thread) {
    return c.json({ ok: false, error: 'Thread not found.' }, 404);
  }

  if (!isOwnerAuthenticated(c)) {
    return c.json({ ok: false, error: 'Only the owner can delete a whole thread.' }, 403);
  }

  note.threads = note.threads.filter((item) => item.id !== thread.id);
  note.updatedAt = nowIso();
  persistNote(note);
  broadcastThreadsUpdated(note);
  return c.json({ ok: true, threads: serializeThreads(note, c) });
});

app.patch('/api/share/:shareId/messages/:messageId', async (c) => {
  const note = requireShareAccess(c, 'comment');
  if (!note) {
    return c.json({ ok: false, error: 'Shared note not found.' }, 404);
  }
  if (!requireSharedIdentity(c)) {
    return c.json({ ok: false, error: 'Set your name first.', requiresIdentity: true }, 401);
  }

  const located = locateMessage(note, c.req.param('messageId'));
  if (!located) {
    return c.json({ ok: false, error: 'Message not found.' }, 404);
  }

  if (!canManageMessage(c, located.message)) {
    return c.json({ ok: false, error: 'Not allowed.' }, 403);
  }

  const body = await readJsonBody(c);
  const commentBody = normalizeCommentBody(String(body.body || ''));
  if (!commentBody) {
    return c.json({ ok: false, error: 'Body is required.' }, 400);
  }

  located.message.body = commentBody;
  located.message.updatedAt = nowIso();
  located.thread.updatedAt = located.message.updatedAt;
  note.updatedAt = located.message.updatedAt;
  persistNote(note);
  broadcastThreadsUpdated(note);
  return c.json({ ok: true, threads: serializeThreads(note, c) });
});

app.delete('/api/share/:shareId/messages/:messageId', (c) => {
  const note = requireShareAccess(c, 'comment');
  if (!note) {
    return c.json({ ok: false, error: 'Shared note not found.' }, 404);
  }
  if (!requireSharedIdentity(c)) {
    return c.json({ ok: false, error: 'Set your name first.', requiresIdentity: true }, 401);
  }

  const located = locateMessage(note, c.req.param('messageId'));
  if (!located) {
    return c.json({ ok: false, error: 'Message not found.' }, 404);
  }

  if (!canManageMessage(c, located.message)) {
    return c.json({ ok: false, error: 'Not allowed.' }, 403);
  }

  located.thread.messages = located.thread.messages.filter((message) => message.id !== located.message.id);
  if (located.thread.messages.length === 0) {
    note.threads = note.threads.filter((thread) => thread.id !== located.thread.id);
  } else {
    located.thread.updatedAt = nowIso();
  }
  note.updatedAt = nowIso();
  persistNote(note);
  broadcastThreadsUpdated(note);
  return c.json({ ok: true, threads: serializeThreads(note, c) });
});

app.notFound((c) => {
  if (c.req.path.startsWith('/api/') || c.req.path === '/' || c.req.path === '/health') {
    return c.json({ ok: false, error: 'Not found.' }, 404);
  }
  return c.text('Not found.', 404);
});

app.onError((error, c) => {
  console.error(error);
  if (c.req.path.startsWith('/api/')) {
    return c.json({ ok: false, error: 'Internal server error.' }, 500);
  }
  return c.text('Internal server error.', 500);
});

const listener = getRequestListener(app.fetch);
const server = http.createServer(listener);
const wss = new WebSocketServer({ noServer: true });

const heartbeatInterval = setInterval(() => {
  for (const conn of clients) {
    if (!conn.alive) {
      conn.ws.terminate();
      continue;
    }
    conn.alive = false;
    if (conn.ws.readyState === 1) {
      conn.ws.ping();
    }
  }
}, 30000);

wss.on('close', () => clearInterval(heartbeatInterval));

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', `http://localhost:${port}`);
  const noteId = url.searchParams.get('noteId') || '';
  const shareId = url.searchParams.get('shareId') || '';

  if (noteId) {
    if (!isOwnerAuthenticatedIncomingRequest(req)) {
      ws.close();
      return;
    }

    const note = notes.get(noteId);
    if (!note) {
      ws.close();
      return;
    }

    const clientId = `c${++clientIdCounter}`;
    const color = CURSOR_COLORS[nextColorIndex++ % CURSOR_COLORS.length];
    const conn: ClientConn = {
      ws,
      kind: 'editor',
      noteId: note.id,
      shareId: note.shareId,
      clientId,
      name: 'Owner',
      color,
      alive: true,
    };
    clients.push(conn);
    sendServerMessage(ws, { ...buildHelloMessage(note), clientId });
    sendExistingPresence(conn);
    broadcastShareParticipants(note.id);

    ws.on('pong', () => { conn.alive = true; });
    ws.on('message', (data) => handleEditorMessage(conn, String(data)));
    ws.on('close', () => handleDisconnect(conn));
    ws.on('error', () => handleDisconnect(conn));
    return;
  }

  if (shareId) {
    const note = findNoteByShareId(shareId);
    if (!note || note.shareAccess === 'none') {
      ws.close();
      return;
    }

    if (note.shareAccess === 'edit') {
      const commenterIdentity = getCommenterIdentityFromHeaders(req.headers);
      if (!commenterIdentity.id || !commenterIdentity.name) {
        ws.close();
        return;
      }
      const clientId = `c${++clientIdCounter}`;
      const color = CURSOR_COLORS[nextColorIndex++ % CURSOR_COLORS.length];
      const conn: ClientConn = {
        ws,
        kind: 'public-editor',
        noteId: note.id,
        shareId: note.shareId,
        clientId,
        name: commenterIdentity.name,
        color,
        alive: true,
      };
      clients.push(conn);
      sendServerMessage(ws, { ...buildHelloMessage(note), clientId });
      sendExistingPresence(conn);
      broadcastShareParticipants(note.id);

      ws.on('pong', () => { conn.alive = true; });
      ws.on('message', (data) => handleEditorMessage(conn, String(data)));
      ws.on('close', () => handleDisconnect(conn));
      ws.on('error', () => handleDisconnect(conn));
      return;
    }

    const commenterIdentity = getCommenterIdentityFromHeaders(req.headers);
    if (!commenterIdentity.id || !commenterIdentity.name) {
      ws.close();
      return;
    }
    const clientId = `c${++clientIdCounter}`;
    const conn: ClientConn = {
      ws,
      kind: 'public-viewer',
      noteId: note.id,
      shareId: note.shareId,
      clientId,
      name: commenterIdentity.name,
      color: '',
      alive: true,
    };
    clients.push(conn);
    broadcastShareParticipants(note.id);
    ws.on('pong', () => { conn.alive = true; });
    ws.on('close', () => handleDisconnect(conn));
    ws.on('error', () => handleDisconnect(conn));
    return;
  }

  ws.close();
});

server.listen(port, () => {
  console.log(`documine api listening on http://localhost:${port}`);
  console.log(`data: ${path.resolve(dataDir)}`);
  void warmPdfPreviewEngine()
    .then(() => {
      console.log('[pdf-preview] browser engine ready');
    })
    .catch((error) => {
      console.warn(`[pdf-preview] browser engine failed: ${error instanceof Error ? error.message : String(error)}`);
    });
});

function readJsonBody(c: Context) {
  return c.req.json().catch(() => ({} as Record<string, unknown>)) as Promise<Record<string, unknown>>;
}

function isCollaborativeConn(conn: ClientConn, noteId: string) {
  return (conn.kind === 'editor' || conn.kind === 'public-editor') && conn.noteId === noteId;
}

function sharePermissionLabel(conn: ClientConn, note: NoteRecord): string {
  if (conn.kind === 'public-editor') {
    return 'Edit and comment';
  }
  if (conn.kind === 'public-viewer') {
    if (note.shareAccess === 'comment') {
      return 'View and comment';
    }
    return 'View only';
  }
  return 'Owner';
}

function broadcastShareParticipants(noteId: string) {
  const note = notes.get(noteId);
  if (!note) {
    return;
  }

  const participants = clients
    .filter((conn) => conn.noteId === noteId && conn.kind !== 'editor')
    .map((conn) => ({
      clientId: conn.clientId,
      name: conn.name || 'Guest',
      permissionLabel: sharePermissionLabel(conn, note),
    }));

  const outgoing: ShareParticipantMessage = {
    type: 'participants',
    participants,
  };

  for (const conn of clients) {
    if (conn.noteId === noteId) {
      sendServerMessage(conn.ws, outgoing);
    }
  }
}

function handleDisconnect(conn: ClientConn) {
  const index = clients.indexOf(conn);
  if (index !== -1) {
    clients.splice(index, 1);
  }
  if (conn.kind === 'editor' || conn.kind === 'public-editor') {
    broadcastPresenceLeave(conn);
  }
  broadcastShareParticipants(conn.noteId);
}

function handleEditorMessage(conn: ClientConn, data: string) {
  let message: ClientMutationMessage | ClientPresenceMessage;
  try {
    message = JSON.parse(data) as ClientMutationMessage | ClientPresenceMessage;
  } catch {
    return;
  }

  if (message.type === 'presence') {
    if (message.clientId !== conn.clientId) {
      return;
    }
    conn.selection = message.selection;
    broadcastPresence(conn, message);
    return;
  }

  if (message.type !== 'mutation' || !message.clientId || !Array.isArray(message.mutations) || message.mutations.length === 0) {
    return;
  }

  if (message.clientId !== conn.clientId) {
    return;
  }

  const note = notes.get(conn.noteId);
  if (!note) {
    return;
  }

  const senderCounter = message.mutations.at(-1)?.clientCounter || 0;
  const lastAcknowledgedCounter = note.clientAcks.get(message.clientId) || 0;
  const freshMutations = message.mutations.filter((mutation) => mutation.clientCounter > lastAcknowledgedCounter);

  if (freshMutations.length === 0) {
    sendServerMessage(conn.ws, {
      type: 'mutation',
      senderId: message.clientId,
      senderCounter,
      serverCounter: note.collab.serverCounter,
      markdown: note.markdown,
      idListUpdates: [],
    });
    return;
  }

  let result;
  try {
    result = applyClientMutations(note.collab, freshMutations);
  } catch (error) {
    console.error(error);
    sendServerMessage(conn.ws, { ...buildHelloMessage(note), clientId: conn.clientId });
    return;
  }
  note.clientAcks.set(message.clientId, senderCounter);

  if (!result.changed) {
    sendServerMessage(conn.ws, {
      type: 'mutation',
      senderId: message.clientId,
      senderCounter,
      serverCounter: note.collab.serverCounter,
      markdown: note.markdown,
      idListUpdates: [],
    });
    return;
  }

  note.collab = result.state;
  note.markdown = result.markdown;
  note.updatedAt = nowIso();
  persistNote(note, false);

  broadcastEditorMutation(note, {
    type: 'mutation',
    senderId: message.clientId,
    senderCounter,
    serverCounter: note.collab.serverCounter,
    markdown: note.markdown,
    idListUpdates: result.idListUpdates,
  });
  broadcastNoteUpdate(note);
}

function sendServerMessage(ws: WebSocket, message: AnyServerMessage) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

function buildHelloMessage(note: NoteRecord): ServerHelloMessage {
  return {
    type: 'hello',
    noteId: note.id,
    title: note.title,
    shareId: note.shareId,
    markdown: note.markdown,
    idListState: saveCollabState(note.collab).idListState,
    serverCounter: note.collab.serverCounter,
  };
}

function sendExistingPresence(target: ClientConn) {
  for (const conn of clients) {
    if (conn === target || !isCollaborativeConn(conn, target.noteId) || !conn.selection) {
      continue;
    }

    sendServerMessage(target.ws, {
      type: 'presence',
      clientId: conn.clientId,
      name: conn.name,
      color: conn.color,
      selection: conn.selection,
    });
  }
}

function broadcastEditorHello(note: NoteRecord) {
  const message = buildHelloMessage(note);
  for (const conn of clients) {
    if (isCollaborativeConn(conn, note.id)) {
      sendServerMessage(conn.ws, conn.clientId ? { ...message, clientId: conn.clientId } : message);
    }
  }
}

function broadcastEditorMutation(note: NoteRecord, message: ServerMutationMessage) {
  for (const conn of clients) {
    if (isCollaborativeConn(conn, note.id)) {
      sendServerMessage(conn.ws, message);
    }
  }
}

function enforceShareAccessForConnections(note: NoteRecord) {
  for (const conn of [...clients]) {
    if (conn.shareId !== note.shareId) {
      continue;
    }
    if (conn.kind === 'public-editor' && note.shareAccess !== 'edit') {
      try { conn.ws.close(); } catch {}
      continue;
    }
    if (conn.kind === 'public-viewer' && note.shareAccess === 'none') {
      try { conn.ws.close(); } catch {}
    }
  }
}

function broadcastNoteUpdate(note: NoteRecord) {
  const message = {
    type: 'updated' as const,
    noteId: note.id,
    shareId: note.shareId,
    updatedAt: note.updatedAt,
  };
  for (const conn of clients) {
    if (conn.kind === 'public-viewer' && conn.shareId === note.shareId) {
      sendServerMessage(conn.ws, message);
    }
  }
}

function broadcastThreadsUpdated(note: NoteRecord) {
  const message = { type: 'threads-updated' as const, noteId: note.id, shareId: note.shareId };
  for (const conn of clients) {
    if (conn.noteId === note.id) {
      sendServerMessage(conn.ws, message);
    }
  }
}

function broadcastPresence(sender: ClientConn, message: ClientPresenceMessage) {
  const outgoing: ServerPresenceMessage = {
    type: 'presence',
    clientId: sender.clientId,
    name: sender.name,
    color: sender.color,
    selection: message.selection,
  };
  for (const conn of clients) {
    if (conn === sender) {
      continue;
    }
    if (isCollaborativeConn(conn, sender.noteId)) {
      sendServerMessage(conn.ws, outgoing);
    }
  }
}

function broadcastPresenceLeave(sender: ClientConn) {
  const outgoing: ServerPresenceLeaveMessage = {
    type: 'presence-leave',
    clientId: sender.clientId,
  };
  for (const conn of clients) {
    if (conn === sender) {
      continue;
    }
    if (isCollaborativeConn(conn, sender.noteId)) {
      sendServerMessage(conn.ws, outgoing);
    }
  }
}

function closeConnectionsForNote(noteId: string) {
  for (const conn of [...clients]) {
    if (conn.noteId === noteId) {
      try { conn.ws.close(); } catch {}
      handleDisconnect(conn);
    }
  }
}

function ensureDirectories() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(notesDir, { recursive: true });
  fs.mkdirSync(noteAssetsDir, { recursive: true });
  fs.mkdirSync(noteExportsDir, { recursive: true });
}

function noteAssetDirectory(noteId: string) {
  return path.join(noteAssetsDir, noteId);
}

function noteExportDirectory(noteId: string) {
  return path.join(noteExportsDir, noteId);
}

function noteAssetPath(noteId: string, fileName: string) {
  return path.join(noteAssetDirectory(noteId), fileName);
}

function buildIncrementedExportFileName(noteId: string, noteTitle: string) {
  const baseName = sanitizeExportBaseName(noteTitle || noteId);
  const directory = noteExportDirectory(noteId);
  fs.mkdirSync(directory, { recursive: true });
  let nextIndex = 1;
  const existingFiles = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  for (const file of existingFiles) {
    const match = file.match(new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:-(\\d+))?\\.pdf$`, 'i'));
    if (!match) {
      continue;
    }
    const currentIndex = match[1] ? Number(match[1]) : 1;
    if (Number.isFinite(currentIndex)) {
      nextIndex = Math.max(nextIndex, currentIndex + 1);
    }
  }
  return nextIndex === 1 ? `${baseName}.pdf` : `${baseName}-${nextIndex}.pdf`;
}

function sanitizeExportBaseName(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'note';
}

function noteExportPath(noteId: string, fileName: string) {
  return path.join(noteExportDirectory(noteId), fileName);
}

function noteExportAssetPath(noteId: string, fileName: string, suffix: '.html' | '.css' | '.md' | '.json') {
  return path.join(noteExportDirectory(noteId), `${fileName}${suffix}`);
}

function noteExportReferencePath(noteId: string, fileName: string) {
  return `/api/notes/${encodeURIComponent(noteId)}/exports/${encodeURIComponent(fileName)}`;
}

function collectNoteExports(note: NoteRecord): NotePdfExportSummary[] {
  const directory = noteExportDirectory(note.id);
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs.readdirSync(directory)
    .filter((file) => file.toLowerCase().endsWith('.pdf'))
    .map((fileName) => {
      const filePath = noteExportPath(note.id, fileName);
      const stats = fs.statSync(filePath);
      const baseUrl = noteExportReferencePath(note.id, fileName);
      return {
        fileName,
        url: `${baseUrl}?inline=1`,
        downloadUrl: `${baseUrl}?download=1`,
        debugUrl: `${baseUrl}/debug`,
        debugHtmlUrl: `${baseUrl}/debug/html`,
        debugCssUrl: `${baseUrl}/debug/css`,
        debugMarkdownUrl: `${baseUrl}/debug/markdown`,
        size: stats.size,
        createdAt: stats.birthtime.toISOString(),
      } satisfies NotePdfExportSummary;
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function loadNoteExportDebug(noteId: string, fileName: string) {
  const metadataPath = noteExportAssetPath(noteId, fileName, '.json');
  const htmlPath = noteExportAssetPath(noteId, fileName, '.html');
  const cssPath = noteExportAssetPath(noteId, fileName, '.css');
  const markdownPath = noteExportAssetPath(noteId, fileName, '.md');
  if (!fs.existsSync(metadataPath) || !fs.existsSync(htmlPath) || !fs.existsSync(cssPath) || !fs.existsSync(markdownPath)) {
    return null;
  }
  return {
    metadata: readJson<Record<string, unknown> | null>(metadataPath, null),
    html: fs.readFileSync(htmlPath, 'utf8'),
    css: fs.readFileSync(cssPath, 'utf8'),
    markdown: fs.readFileSync(markdownPath, 'utf8'),
  };
}

function loadManagedNoteExportFile(noteId: string, rawFileName: string) {
  const fileName = path.basename(rawFileName);
  if (!fileName.toLowerCase().endsWith('.pdf')) {
    return null;
  }
  const filePath = noteExportPath(noteId, fileName);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  return { fileName, filePath };
}

function loadManagedDebugExportFile(noteId: string, rawFileName: string) {
  const fileName = path.basename(rawFileName);
  const exportFile = loadManagedNoteExportFile(noteId, fileName);
  if (!exportFile) {
    return null;
  }
  const debug = loadNoteExportDebug(noteId, exportFile.fileName);
  if (!debug) {
    return null;
  }
  return { fileName: exportFile.fileName, debug };
}

function loadNotesIntoMemory() {
  notes.clear();
  const files = fs.readdirSync(notesDir).filter((file) => file.endsWith('.md'));

  for (const file of files) {
    const id = path.basename(file, '.md');
    const markdownPath = noteMarkdownPath(id);
    const metaPath = noteMetaPath(id);
    if (!fs.existsSync(metaPath)) {
      continue;
    }

    const markdown = fs.readFileSync(markdownPath, 'utf8');
    const meta = readJson<NoteMetaFile | null>(metaPath, null);
    if (!meta) {
      continue;
    }

    const threads = Array.isArray(meta.threads)
      ? meta.threads.map((thread) => ({
          ...thread,
          messages: Array.isArray(thread.messages)
            ? thread.messages.map((message) => ({
                ...message,
                parentId: typeof message.parentId === 'string' ? message.parentId : null,
              }))
            : [],
        }))
      : [];

    let collab: CollabState;
    if (meta.collab) {
      collab = loadCollabState(meta.collab);
    } else if (meta.collabState) {
      collab = loadCollabState(meta.collabState);
    } else {
      collab = collabFromMarkdown(markdown);
    }

    notes.set(id, {
      ...meta,
      shareAccess: meta.shareAccess || 'none',
      markdown: collabToMarkdown(collab),
      threads,
      collab,
      clientAcks: new Map(),
      importedAt: meta.importedAt,
      importOpenedAt: Object.prototype.hasOwnProperty.call(meta, 'importOpenedAt') ? meta.importOpenedAt ?? null : undefined,
    });
  }
}

function noteMarkdownPath(id: string) {
  return path.join(notesDir, `${id}.md`);
}

function noteMetaPath(id: string) {
  return path.join(notesDir, `${id}.json`);
}

function readJson<T>(filePath: string, fallback: T) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createNote() {
  const timestamp = nowIso();
  const id = createShortId();
  const note: NoteRecord = {
    id,
    title: 'untitled',
    shareId: createShortId(14),
    shareAccess: 'none',
    createdAt: timestamp,
    updatedAt: timestamp,
    markdown: '',
    threads: [],
    collab: newCollabState(),
    clientAcks: new Map(),
  };

  notes.set(id, note);
  persistNote(note);
  return note;
}

function persistNote(note: NoteRecord, broadcastUpdate = true) {
  note.markdown = collabToMarkdown(note.collab);

  const meta: NoteMetaFile = {
    id: note.id,
    title: note.title,
    shareId: note.shareId,
    shareAccess: note.shareAccess,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    threads: note.threads,
    collab: saveCollabState(note.collab),
    importedAt: note.importedAt,
    importOpenedAt: note.importOpenedAt,
  };

  fs.writeFileSync(noteMarkdownPath(note.id), note.markdown, 'utf8');
  writeJson(noteMetaPath(note.id), meta);
  if (broadcastUpdate) {
    broadcastNoteUpdate(note);
  }
}

function selectNotesForExport(body: { scope?: unknown; noteIds?: unknown }) {
  if (body.scope === 'all') {
    return Array.from(notes.values());
  }
  if (body.scope !== 'selected' || !Array.isArray(body.noteIds)) {
    return [];
  }
  const selected: NoteRecord[] = [];
  for (const id of body.noteIds) {
    if (typeof id !== 'string') {
      continue;
    }
    const note = notes.get(id);
    if (note) {
      selected.push(note);
    }
  }
  return selected;
}

function buildArchiveNoteInput(note: NoteRecord): ArchiveNoteInput {
  note.markdown = collabToMarkdown(note.collab);
  return {
    id: note.id,
    title: note.title,
    markdown: note.markdown,
    threads: note.threads,
    assets: collectArchiveAssets(note),
  };
}

function collectArchiveAssets(note: NoteRecord): ArchiveNoteInput['assets'] {
  const directory = noteAssetDirectory(note.id);
  if (!fs.existsSync(directory)) {
    return [];
  }
  return fs.readdirSync(directory).flatMap((fileName) => {
    const filePath = noteAssetPath(note.id, fileName);
    if (!fs.statSync(filePath).isFile()) {
      return [];
    }
    const extension = path.extname(fileName).toLowerCase();
    const contentType = imageContentTypeFromExtension(extension);
    if (!contentType) {
      return [];
    }
    return [{ fileName, bytes: fs.readFileSync(filePath), contentType }];
  });
}

function slugifyFileName(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function searchNotes(query: string) {
  const needle = query.trim().toLowerCase();
  return Array.from(notes.values())
    .map((note) => summarizeNote(note, needle))
    .filter((note) => !needle || note.title.toLowerCase().includes(needle) || note.snippet.toLowerCase().includes(needle))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function summarizeNote(note: NoteRecord, needle: string): NoteSummary {
  return {
    id: note.id,
    title: note.title,
    updatedAt: note.updatedAt,
    shareId: note.shareId,
    snippet: buildSnippet(note, needle),
    isImportedUnread: Boolean(note.importedAt && note.importOpenedAt === null),
  };
}

function buildSnippet(note: NoteRecord, needle: string) {
  const source = note.markdown.replace(/\s+/g, ' ').trim();
  if (!source) {
    return '';
  }
  if (!needle) {
    return source.slice(0, 140);
  }
  const index = source.toLowerCase().indexOf(needle);
  if (index === -1) {
    return source.slice(0, 140);
  }
  const start = Math.max(0, index - 40);
  const end = Math.min(source.length, index + needle.length + 80);
  return source.slice(start, end);
}

function findNoteByShareId(shareId: string) {
  for (const note of notes.values()) {
    if (note.shareId === shareId) {
      return note;
    }
  }
  return null;
}

function locateMessage(note: NoteRecord, messageId: string) {
  for (const thread of note.threads) {
    const message = thread.messages.find((item) => item.id === messageId);
    if (message) {
      return { thread, message };
    }
  }
  return null;
}

function buildViewerInfo(
  c: Context,
  overrides?: { commenterNameOverride?: string; hasCommenterIdentityOverride?: boolean },
): ViewerInfo {
  const commenter = getCommenterIdentity(c);
  return {
    isOwner: isOwnerAuthenticated(c),
    commenterName: overrides?.commenterNameOverride ?? commenter.name,
    hasCommenterIdentity: overrides?.hasCommenterIdentityOverride ?? Boolean(commenter.id),
  };
}

function serializeThreads(note: NoteRecord, c: Context) {
  const viewer = buildViewerInfo(c);
  const commenter = getCommenterIdentity(c);

  return [...note.threads]
    .sort((a, b) => {
      const startDelta = a.anchor.start - b.anchor.start;
      if (startDelta !== 0) {
        return startDelta;
      }
      return a.createdAt.localeCompare(b.createdAt);
    })
    .map((thread) => ({
      id: thread.id,
      resolved: thread.resolved,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      anchor: thread.anchor,
      canReply: viewer.isOwner || viewer.hasCommenterIdentity,
      canResolve: viewer.isOwner || viewer.hasCommenterIdentity,
      canDeleteThread: viewer.isOwner,
      messages: [...thread.messages]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((message) => ({
          id: message.id,
          parentId: message.parentId,
          authorName: message.authorName,
          body: message.body,
          createdAt: message.createdAt,
          updatedAt: message.updatedAt,
          canEdit: viewer.isOwner || (Boolean(commenter.id) && commenter.id === message.authorId),
          canDelete: viewer.isOwner || (Boolean(commenter.id) && commenter.id === message.authorId),
        })),
    }));
}

function serializeNoteForClient(note: NoteRecord, c: Context) {
  return {
    note: {
      id: note.id,
      title: note.title,
      markdown: note.markdown,
      renderedHtml: renderMarkdown(note.markdown),
      shareId: note.shareId,
      shareAccess: note.shareAccess,
      shareUrl: makeShareUrl(c, note.shareId),
      updatedAt: note.updatedAt,
      createdAt: note.createdAt,
    },
    viewer: buildViewerInfo(c),
    threads: serializeThreads(note, c),
  };
}

function requireShareAccess(c: Context, minAccess: ShareAccess) {
  const note = findNoteByShareId(c.req.param('shareId') || '');
  if (!note) {
    return null;
  }
  if (shareAccessLevels[note.shareAccess] < shareAccessLevels[minAccess]) {
    return null;
  }
  return note;
}

function requireSharedIdentity(c: Context) {
  const commenter = getCommenterIdentity(c);
  return Boolean(commenter.id && commenter.name);
}

function countOccurrences(haystack: string, needle: string) {
  let count = 0;
  let index = 0;
  while (index < haystack.length) {
    const found = haystack.indexOf(needle, index);
    if (found === -1) {
      break;
    }
    count++;
    index = found + needle.length;
  }
  return count;
}

function normalizeTitle(input: string) {
  return input.trim().slice(0, 160) || 'untitled';
}

function normalizeCommentBody(input: string) {
  return input.trim().slice(0, 5000);
}

function normalizeCommenterName(input: string) {
  return input.trim().slice(0, 80);
}

function listNoteAssets(note: NoteRecord, c: Context): NoteAssetSummary[] {
  const directory = noteAssetDirectory(note.id);
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs.readdirSync(directory)
    .map((fileName) => {
      const safeFileName = path.basename(fileName);
      const filePath = noteAssetPath(note.id, safeFileName);
      if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return null;
      }

      const stat = fs.statSync(filePath);
      const url = makeAssetUrl(c, note.id, safeFileName);
      return {
        fileName: safeFileName,
        url,
        markdown: `![${escapeMarkdownImageAlt(safeFileName)}](${url})`,
        inUse: note.markdown.includes(assetMarkdownReferencePath(note.id, safeFileName)),
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
      } satisfies NoteAssetSummary;
    })
    .filter((item): item is NoteAssetSummary => Boolean(item))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

function assetMarkdownReferencePath(noteId: string, fileName: string) {
  return `/assets/${encodeURIComponent(noteId)}/${encodeURIComponent(fileName)}`;
}

function sanitizeAnchor(input: unknown) {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const source = input as Record<string, unknown>;
  const quote = String(source.quote || '').slice(0, 1000);
  const prefix = String(source.prefix || '').slice(0, 200);
  const suffix = String(source.suffix || '').slice(0, 200);
  const start = Number(source.start);
  const end = Number(source.end);

  if (!quote || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    return null;
  }

  return { quote, prefix, suffix, start, end } satisfies CommentAnchor;
}

async function handleImageUpload(c: Context, note: NoteRecord) {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) {
    return c.json({ ok: false, error: 'Image file is required.' }, 400);
  }

  const extension = imageMimeExtensions[file.type];
  if (!extension) {
    return c.json({ ok: false, error: 'Only PNG, JPEG, GIF, WebP, and AVIF images are supported.' }, 400);
  }
  if (file.size <= 0) {
    return c.json({ ok: false, error: 'Image file is empty.' }, 400);
  }
  if (file.size > maxImageUploadBytes) {
    return c.json({ ok: false, error: 'Image exceeds the 10 MB upload limit.' }, 413);
  }

  fs.mkdirSync(noteAssetDirectory(note.id), { recursive: true });
  const fileName = `${createId(18)}${extension}`;
  fs.writeFileSync(noteAssetPath(note.id, fileName), Buffer.from(await file.arrayBuffer()));

  const url = makeAssetUrl(c, note.id, fileName);
  return c.json({
    ok: true,
    asset: {
      url,
      markdown: `![${escapeMarkdownImageAlt(file.name)}](${url})`,
    },
  });
}

function escapeMarkdownImageAlt(input: string) {
  const base = input.trim().replace(/\.[A-Za-z0-9]+$/, '').replace(/[\[\]\\]/g, '').trim();
  return base || 'image';
}

function imageContentTypeFromExtension(extension: string) {
  return Object.entries(imageMimeExtensions).find(([, value]) => value === extension)?.[0] || null;
}

function makeAssetUrl(c: Context, noteId: string, fileName: string) {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}${assetMarkdownReferencePath(noteId, fileName)}`;
}

function applyPreviewImageAttributeHints(rawHtml: string) {
  return rawHtml.replace(/<p>(\s*<img\b[^>]*?)(?:\s*)\{([^{}]+)\}(\s*)<\/p>/gi, (_match, imgHtml: string, attrs: string, trailingSpace: string) => {
    const title = attrs.replace(/&quot;/g, '"').trim();
    if (!title) {
      return `<p>${imgHtml}${trailingSpace}</p>`;
    }
    if (/\btitle\s*=/.test(imgHtml)) {
      return `<p>${imgHtml}${trailingSpace}</p>`;
    }
    const escapedTitle = escapeHtml(title);
    const hintedImgHtml = imgHtml.replace(/\s*\/?>$/, (ending) => ` title="${escapedTitle}"${ending}`);
    return `<p>${hintedImgHtml}${trailingSpace}</p>`;
  });
}

function renderMarkdown(markdown: string) {
  const rawHtml = applyPreviewImageAttributeHints(marked.parse(markdown) as string);
  return sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      'img',
      'h1',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'pre',
      'code',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'blockquote',
      'span',
    ]),
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title'],
      code: ['class'],
      span: ['class'],
    },
    allowedClasses: {
      code: ['hljs', /^language-/],
      span: [/^hljs.*/],
      pre: ['mermaid'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
    },
  });
}

function renderPrintPreviewHtml(markdown: string, title: string, settings: unknown): string {
  const merged = mergeSettings(settings);
  const body = renderMarkdown(markdown);
  const css = buildPdfCss(title, merged);
  const safeTitle = escapeHtml(title || 'Untitled');
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    `<meta charset="UTF-8">`,
    `<title>${safeTitle}</title>`,
    `<style>${css}</style>`,
    '</head>',
    `<body>${body}</body>`,
    '</html>',
  ].join('\n');
}

function makeShareUrl(c: Context, shareId: string) {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}/s/${shareId}`;
}

function buildPreviewPaginationScript(): string {
  return `<script>
(() => {
  const root = document.documentElement;
  const UNSPLITTABLE_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'NAV', 'PRE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'UL', 'OL', 'DL', 'DT', 'DD']);

  const readPx = (name, fallback) => {
    const raw = getComputedStyle(root).getPropertyValue(name).trim();
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const debounce = (fn, delay) => {
    let timer = 0;
    return () => {
      if (timer) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => {
        timer = 0;
        fn();
      }, delay);
    };
  };

  const createPage = () => {
    const page = document.createElement('section');
    page.className = 'documine-preview-page';
    page.innerHTML = '<div class="documine-preview-page-content"></div>';
    return page;
  };

  const createMeasureBox = (pageWidth, margins) => {
    const box = document.createElement('div');
    box.className = 'documine-preview-measure';
    box.style.width = pageWidth + 'px';
    box.style.padding = margins.top + 'px ' + margins.right + 'px ' + margins.bottom + 'px ' + margins.left + 'px';
    box.style.boxSizing = 'border-box';
    box.style.position = 'absolute';
    box.style.left = '-10000px';
    box.style.top = '0';
    box.style.visibility = 'hidden';
    box.style.pointerEvents = 'none';
    box.style.overflow = 'visible';
    return box;
  };

  const state = {
    source: null,
    pages: null,
    measure: null,
  };

  const collectTextSegments = (node) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const segments = [];
    let total = 0;
    let current = walker.nextNode();
    while (current) {
      const text = current.nodeValue || '';
      if (text.length > 0) {
        segments.push({ node: current, start: total, end: total + text.length });
        total += text.length;
      }
      current = walker.nextNode();
    }
    return { segments, length: total };
  };

  const pointAtOffset = (textInfo, offset) => {
    if (!textInfo.segments.length) {
      return null;
    }
    if (offset <= 0) {
      return { node: textInfo.segments[0].node, offset: 0 };
    }
    for (const segment of textInfo.segments) {
      if (offset <= segment.end) {
        return { node: segment.node, offset: offset - segment.start };
      }
    }
    const last = textInfo.segments[textInfo.segments.length - 1];
    return { node: last.node, offset: (last.node.nodeValue || '').length };
  };

  const cloneFragment = (node, textInfo, startOffset, endOffset) => {
    const startPoint = pointAtOffset(textInfo, startOffset);
    const endPoint = pointAtOffset(textInfo, endOffset);
    const range = document.createRange();
    range.selectNodeContents(node);
    if (startPoint) {
      range.setStart(startPoint.node, startPoint.offset);
    }
    if (endPoint) {
      range.setEnd(endPoint.node, endPoint.offset);
    }
    return range.cloneContents();
  };

  const setSplitMargins = (element, kind) => {
    if (!(element instanceof HTMLElement)) {
      return;
    }
    if (kind === 'start') {
      element.style.marginBottom = '0';
    } else if (kind === 'continue') {
      element.style.marginTop = '0';
    }
  };

  const buildSplitNode = (node, fragment, kind) => {
    const clone = node.cloneNode(false);
    clone.appendChild(fragment);
    setSplitMargins(clone, kind);
    return clone;
  };

  const measureNode = (node) => {
    state.measure.innerHTML = '';
    state.measure.appendChild(node.cloneNode(true));
    return state.measure.scrollHeight;
  };

  const splitNodeToFit = (node, availableHeight) => {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    if (UNSPLITTABLE_TAGS.has(node.tagName)) {
      return null;
    }

    const textInfo = collectTextSegments(node);
    if (!textInfo.length) {
      return null;
    }

    let low = 1;
    let high = textInfo.length;
    let best = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const firstFragment = cloneFragment(node, textInfo, 0, mid);
      const firstNode = buildSplitNode(node, firstFragment, 'start');
      const height = measureNode(firstNode);
      if (height <= availableHeight) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (!best || best >= textInfo.length) {
      return null;
    }

    const firstFragment = cloneFragment(node, textInfo, 0, best);
    const secondFragment = cloneFragment(node, textInfo, best, textInfo.length);
    return {
      first: buildSplitNode(node, firstFragment, 'start'),
      second: buildSplitNode(node, secondFragment, 'continue'),
    };
  };

  const paginate = () => {
    if (!state.source || !state.pages || !state.measure) {
      return;
    }

    const pageHeight = readPx('--documine-page-height', 1123);
    const margins = {
      top: readPx('--documine-page-margin-top', 96),
      right: readPx('--documine-page-margin-right', 96),
      bottom: readPx('--documine-page-margin-bottom', 96),
      left: readPx('--documine-page-margin-left', 96),
    };
    const pageWidth = readPx('--documine-page-width', 794);
    // Leave a tiny safety buffer so the preview matches Chromium's print pagination.
    const availableHeight = Math.max(1, pageHeight - 4);

    state.pages.innerHTML = '';
    state.measure.innerHTML = '';
    state.measure.style.width = pageWidth + 'px';
    state.measure.style.padding = margins.top + 'px ' + margins.right + 'px ' + margins.bottom + 'px ' + margins.left + 'px';

    let currentPage = createPage();
    let content = currentPage.querySelector('.documine-preview-page-content');
    state.pages.appendChild(currentPage);

    for (const originalNode of Array.from(state.source.children)) {
      let pending = originalNode.cloneNode(true);

      while (pending) {
        state.measure.appendChild(pending.cloneNode(true));

        if (state.measure.scrollHeight <= availableHeight) {
          content.appendChild(pending);
          pending = null;
          continue;
        }

        state.measure.removeChild(state.measure.lastElementChild);

        if (content.childNodes.length > 0) {
          currentPage = createPage();
          content = currentPage.querySelector('.documine-preview-page-content');
          state.pages.appendChild(currentPage);
          state.measure.innerHTML = '';
          continue;
        }

        const split = splitNodeToFit(pending, availableHeight);
        if (!split) {
          content.appendChild(pending);
          state.measure.appendChild(pending.cloneNode(true));
          pending = null;
          continue;
        }

        content.appendChild(split.first);
        state.measure.appendChild(split.first.cloneNode(true));
        pending = split.second;
      }
    }
  };

  const initialize = () => {
    const body = document.body;
    if (!body) {
      return;
    }

    if (!state.source || !state.pages) {
      const source = document.createElement('div');
      source.id = 'documine-preview-source';
      source.className = 'documine-preview-source';
      for (const child of Array.from(body.children)) {
        source.appendChild(child.cloneNode(true));
      }

      body.innerHTML = '';
      body.appendChild(source);

      const pages = document.createElement('div');
      pages.id = 'documine-preview-pages';
      pages.className = 'documine-preview-pages';
      body.appendChild(pages);

      state.source = source;
      state.pages = pages;
      state.measure = createMeasureBox(
        readPx('--documine-page-width', 794),
        {
          top: readPx('--documine-page-margin-top', 96),
          right: readPx('--documine-page-margin-right', 96),
          bottom: readPx('--documine-page-margin-bottom', 96),
          left: readPx('--documine-page-margin-left', 96),
        },
      );
      body.appendChild(state.measure);
    }

    paginate();
  };

  const rerender = debounce(initialize, 50);
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    queueMicrotask(initialize);
  } else {
    window.addEventListener('load', initialize, { once: true });
  }
  window.addEventListener('resize', rerender);
  document.addEventListener('load', (event) => {
    if (event.target instanceof HTMLImageElement) {
      rerender();
    }
  }, true);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(rerender).catch(() => {});
  }
})();
</script>`;
}

function injectPreviewBaseHref(html: string, baseHref: string) {
  const baseTag = `<base href="${escapeHtml(baseHref)}">`;
  const previewScript = buildPreviewPaginationScript();

  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (headTag) => `${headTag}\n    ${baseTag}\n    ${previewScript}`);
  }

  return html;
}

function isAllowedBrowserOrigin(origin: string) {
  try {
    const url = new URL(origin);
    const isLocalHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (isLocalHost && url.protocol === 'http:') {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

function nowIso() {
  return new Date().toISOString();
}

function createShortId(length = 8) {
  return crypto.randomBytes(length).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, length);
}

function createId(length = 12) {
  return createShortId(length);
}

function escapeHtml(input: string) {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function hashSecret(value: string, salt: string) {
  return crypto.scryptSync(value, salt, 64).toString('hex');
}

function secureEqualsHex(a: string, b: string) {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

function loadAuthData() {
  return readJson<AuthData | null>(authFilePath, null);
}

function saveAuthData(authData: AuthData) {
  writeJson(authFilePath, authData);
}

function defaultAuthGuardData(): AuthGuardData {
  return {
    loginEnabled: true,
    globalLock: {
      active: false,
      lockedAt: null,
      expiresAt: null,
      reason: null,
    },
    bannedIps: [],
  };
}

function defaultAuthGuardRuntime(): AuthGuardRuntime {
  return {
    loginRequests: [],
    failedLogins: [],
  };
}

function loadAuthGuardData(): AuthGuardData {
  const raw = readJson<Record<string, unknown> | null>(authGuardFilePath, null);
  const fallback = defaultAuthGuardData();
  const authGuard: AuthGuardData = {
    loginEnabled: typeof raw?.loginEnabled === 'boolean' ? raw.loginEnabled : fallback.loginEnabled,
    globalLock: {
      active: typeof raw?.globalLock === 'object' && raw?.globalLock !== null && typeof (raw.globalLock as { active?: unknown }).active === 'boolean'
        ? Boolean((raw.globalLock as { active: boolean }).active)
        : fallback.globalLock.active,
      lockedAt: typeof raw?.globalLock === 'object' && raw?.globalLock !== null && typeof (raw.globalLock as { lockedAt?: unknown }).lockedAt === 'string'
        ? String((raw.globalLock as { lockedAt: string }).lockedAt)
        : fallback.globalLock.lockedAt,
      expiresAt: typeof raw?.globalLock === 'object' && raw?.globalLock !== null && typeof (raw.globalLock as { expiresAt?: unknown }).expiresAt === 'string'
        ? String((raw.globalLock as { expiresAt: string }).expiresAt)
        : fallback.globalLock.expiresAt,
      reason: typeof raw?.globalLock === 'object' && raw?.globalLock !== null && typeof (raw.globalLock as { reason?: unknown }).reason === 'string'
        ? String((raw.globalLock as { reason: string }).reason)
        : fallback.globalLock.reason,
    },
    bannedIps: Array.isArray(raw?.bannedIps) ? raw.bannedIps.filter((item): item is AuthGuardIpBan => Boolean(item && typeof item === 'object' && typeof (item as AuthGuardIpBan).ip === 'string' && typeof (item as AuthGuardIpBan).bannedAt === 'string' && typeof (item as AuthGuardIpBan).expiresAt === 'string' && typeof (item as AuthGuardIpBan).reason === 'string')) : [],
  };
  if (!fs.existsSync(authGuardFilePath)) {
    saveAuthGuardData(authGuard);
  }
  return authGuard;
}

function loadAuthGuardRuntime(): AuthGuardRuntime {
  const runtime = defaultAuthGuardRuntime();
  const loginRequestCutoff = Date.now() - authGlobalLoginWindowMs;
  const failedLoginCutoff = Date.now() - authFailedAttemptWindowMs;

  if (!fs.existsSync(authGuardLogFilePath)) {
    pruneAuthGuardRuntimeEntries(runtime);
    return runtime;
  }

  const content = fs.readFileSync(authGuardLogFilePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as Partial<AuthGuardEvent>;
      if (typeof event.ip !== 'string' || typeof event.timestamp !== 'string' || typeof event.type !== 'string') {
        continue;
      }
      const timestamp = Date.parse(event.timestamp);
      if (Number.isNaN(timestamp)) {
        continue;
      }
      if (event.type === 'login-requested' && timestamp >= loginRequestCutoff) {
        runtime.loginRequests.push({ ip: event.ip, timestamp: event.timestamp });
      }
      if (event.type === 'login-failed' && timestamp >= failedLoginCutoff) {
        runtime.failedLogins.push({ ip: event.ip, timestamp: event.timestamp });
      }
    } catch {
      continue;
    }
  }
  pruneAuthGuardRuntimeEntries(runtime);
  return runtime;
}

function saveAuthGuardData(authGuard: AuthGuardData) {
  writeJson(authGuardFilePath, authGuard);
}

function pruneAuthGuardData(authGuard: AuthGuardData, now = Date.now()) {
  const bannedIpCount = authGuard.bannedIps.length;
  const previousLoginEnabled = authGuard.loginEnabled;
  const previousGlobalLock = JSON.stringify(authGuard.globalLock);

  authGuard.bannedIps = authGuard.bannedIps.filter((item) => {
    const expiresAt = Date.parse(item.expiresAt);
    return !Number.isNaN(expiresAt) && expiresAt > now;
  });

  const globalLockExpiresAt = authGuard.globalLock.expiresAt ? Date.parse(authGuard.globalLock.expiresAt) : Number.NaN;
  if (authGuard.globalLock.active && !Number.isNaN(globalLockExpiresAt) && globalLockExpiresAt <= now) {
    authGuard.loginEnabled = true;
    authGuard.globalLock = {
      active: false,
      lockedAt: null,
      expiresAt: null,
      reason: null,
    };
  }

  return authGuard.bannedIps.length !== bannedIpCount
    || authGuard.loginEnabled !== previousLoginEnabled
    || JSON.stringify(authGuard.globalLock) !== previousGlobalLock;
}

function pruneAuthGuardRuntimeEntries(runtime: AuthGuardRuntime, now = Date.now()) {
  const loginRequestCutoff = now - authGlobalLoginWindowMs;
  const failedLoginCutoff = now - authFailedAttemptWindowMs;
  runtime.loginRequests = runtime.loginRequests.filter((item) => {
    const timestamp = Date.parse(item.timestamp);
    return !Number.isNaN(timestamp) && timestamp >= loginRequestCutoff;
  });
  runtime.failedLogins = runtime.failedLogins.filter((item) => {
    const timestamp = Date.parse(item.timestamp);
    return !Number.isNaN(timestamp) && timestamp >= failedLoginCutoff;
  });
}

function pruneAuthGuardRuntime(now = Date.now()) {
  pruneAuthGuardRuntimeEntries(authGuardRuntime, now);
}

function appendAuthGuardEvent(event: AuthGuardEvent) {
  fs.appendFileSync(authGuardLogFilePath, `${JSON.stringify(event)}\n`, 'utf8');
}

function recordAuthGuardLoginRequest(ip: string, timestamp: string) {
  pruneAuthGuardRuntime();
  authGuardRuntime.loginRequests.push({ ip, timestamp });
  appendAuthGuardEvent({
    type: 'login-requested',
    ip,
    timestamp,
    detail: 'Owner login request received.',
  });
}

function recordAuthGuardFailedLogin(ip: string, timestamp: string) {
  pruneAuthGuardRuntime();
  authGuardRuntime.failedLogins.push({ ip, timestamp });
  appendAuthGuardEvent({
    type: 'login-failed',
    ip,
    timestamp,
    detail: 'Invalid owner password.',
  });
}

function clearAuthGuardFailedLoginsForIp(ip: string) {
  authGuardRuntime.failedLogins = authGuardRuntime.failedLogins.filter((item) => item.ip !== ip);
}

function getActiveIpBan(authGuard: AuthGuardData, ip: string) {
  const now = Date.now();
  return authGuard.bannedIps.find((item) => item.ip === ip && Date.parse(item.expiresAt) > now) || null;
}

function buildAuthGuardSummary(authGuard: AuthGuardData): AuthGuardSummary {
  pruneAuthGuardRuntime();
  return {
    loginEnabled: authGuard.loginEnabled,
    globalLockActive: authGuard.globalLock.active,
    globalLockAt: authGuard.globalLock.lockedAt,
    globalLockExpiresAt: authGuard.globalLock.expiresAt,
    globalLockReason: authGuard.globalLock.reason,
    recentLoginRequestCount: authGuardRuntime.loginRequests.length,
    bannedIpCount: authGuard.bannedIps.length,
  };
}

function authConfigured() {
  const auth = loadAuthData();
  return Boolean(auth?.passwordSalt && auth?.passwordHash);
}

function passwordMatches(password: string) {
  const auth = loadAuthData();
  if (!auth) {
    return false;
  }
  return secureEqualsHex(hashSecret(password, auth.passwordSalt), auth.passwordHash);
}

function initializeOwnerAuth(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const auth: AuthData = {
    passwordSalt: salt,
    passwordHash: hashSecret(password, salt),
    tokens: [],
  };
  saveAuthData(auth);
  saveAuthGuardData(defaultAuthGuardData());
  return issueOwnerToken();
}

function issueOwnerToken() {
  const auth = loadAuthData();
  if (!auth) {
    throw new Error('Password not configured.');
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  const timestamp = nowIso();
  auth.tokens.push({
    id: createId(10),
    salt,
    hash: hashSecret(token, salt),
    createdAt: timestamp,
    lastUsedAt: timestamp,
  });
  saveAuthData(auth);
  return token;
}

function verifyOwnerToken(token: string) {
  const auth = loadAuthData();
  if (!auth) {
    return false;
  }

  let changed = false;
  for (const stored of auth.tokens) {
    if (secureEqualsHex(hashSecret(token, stored.salt), stored.hash)) {
      const lastSeen = Date.parse(stored.lastUsedAt);
      if (Number.isNaN(lastSeen) || Date.now() - lastSeen > 1000 * 60 * 60 * 12) {
        stored.lastUsedAt = nowIso();
        changed = true;
      }
      if (changed) {
        saveAuthData(auth);
      }
      return true;
    }
  }

  return false;
}

function revokeOwnerToken(token: string) {
  const auth = loadAuthData();
  if (!auth) {
    return;
  }

  const tokens = auth.tokens.filter((stored) => !secureEqualsHex(hashSecret(token, stored.salt), stored.hash));
  if (tokens.length !== auth.tokens.length) {
    auth.tokens = tokens;
    saveAuthData(auth);
  }
}

function parseCookies(header: string | undefined) {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const item of header.split(';')) {
    const index = item.indexOf('=');
    if (index === -1) {
      continue;
    }
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function getOwnerSessionTokenFromHeaders(headers: http.IncomingHttpHeaders) {
  return parseCookies(headerValue(headers.cookie))[ownerSessionCookieName] || null;
}

function forwardedForToIp(value: string | null) {
  if (!value) {
    return null;
  }
  return value.split(',')[0]?.trim() || null;
}

function forwardedHeaderToIp(value: string | null) {
  if (!value) {
    return null;
  }
  const match = value.match(/for=(?:"?)(\[[^\]]+\]|[^;,"]+)/i);
  return match?.[1]?.replace(/^\[/, '').replace(/\]$/, '').trim() || null;
}

function getClientIp(c: Context) {
  return forwardedForToIp(c.req.header('cf-connecting-ip') || null)
    || forwardedForToIp(c.req.header('x-real-ip') || null)
    || forwardedForToIp(c.req.header('x-forwarded-for') || null)
    || forwardedHeaderToIp(c.req.header('forwarded') || null)
    || 'unknown';
}

function getBearerTokenFromHeaders(headers: http.IncomingHttpHeaders) {
  const header = headerValue(headers.authorization);
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice(7).trim() || null;
}

function getOwnerSessionToken(c: Context) {
  return getCookie(c, ownerSessionCookieName) || null;
}

function isSecureRequest(c: Context) {
  const forwarded = c.req.header('x-forwarded-proto');
  if (forwarded) {
    return forwarded.split(',')[0]?.trim() === 'https';
  }
  return new URL(c.req.url).protocol === 'https:';
}

function setOwnerSessionCookie(c: Context, token: string) {
  setCookie(c, ownerSessionCookieName, token, {
    path: '/',
    sameSite: 'Lax',
    maxAge: ownerCookieMaxAgeSeconds,
    httpOnly: true,
    secure: isSecureRequest(c),
  });
}

function clearOwnerSessionCookie(c: Context) {
  deleteCookie(c, ownerSessionCookieName, {
    path: '/',
    secure: isSecureRequest(c),
  });
}

function isOwnerAuthenticatedHeaders(headers: http.IncomingHttpHeaders) {
  const bearer = getBearerTokenFromHeaders(headers);
  if (bearer && verifyApiKey(bearer)) {
    return true;
  }
  const token = getOwnerSessionTokenFromHeaders(headers);
  return Boolean(token && verifyOwnerToken(token));
}

function isOwnerAuthenticated(c: Context) {
  const bearer = getBearerToken(c);
  if (bearer && verifyApiKey(bearer)) {
    return true;
  }
  const token = getOwnerSessionToken(c);
  return Boolean(token && verifyOwnerToken(token));
}

function isOwnerAuthenticatedIncomingRequest(req: http.IncomingMessage) {
  return isOwnerAuthenticatedHeaders(req.headers);
}

function getBearerToken(c: Context) {
  const header = c.req.header('authorization');
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice(7).trim() || null;
}

function verifyApiKey(key: string) {
  const auth = loadAuthData();
  if (!auth?.apiKeys) {
    return false;
  }
  for (const stored of auth.apiKeys) {
    if (secureEqualsHex(hashSecret(key, stored.keySalt), stored.keyHash)) {
      return true;
    }
  }
  return false;
}

function getApiKeyLabel(key: string) {
  const auth = loadAuthData();
  if (!auth?.apiKeys) {
    return null;
  }
  for (const stored of auth.apiKeys) {
    if (secureEqualsHex(hashSecret(key, stored.keySalt), stored.keyHash)) {
      return stored.label;
    }
  }
  return null;
}

function createApiKey(label: string) {
  const auth = loadAuthData();
  if (!auth) {
    throw new Error('Password not configured.');
  }
  if (!auth.apiKeys) {
    auth.apiKeys = [];
  }

  const rawKey = crypto.randomBytes(32).toString('base64url');
  const salt = crypto.randomBytes(16).toString('hex');
  const apiKey: ApiKey = {
    id: createId(10),
    label: label.trim().slice(0, 80) || 'unnamed',
    keySalt: salt,
    keyHash: hashSecret(rawKey, salt),
    createdAt: nowIso(),
  };

  auth.apiKeys.push(apiKey);
  saveAuthData(auth);
  return { id: apiKey.id, label: apiKey.label, key: rawKey, createdAt: apiKey.createdAt };
}

function deleteApiKey(keyId: string) {
  const auth = loadAuthData();
  if (!auth?.apiKeys) {
    return false;
  }

  const before = auth.apiKeys.length;
  auth.apiKeys = auth.apiKeys.filter((key) => key.id !== keyId);
  if (auth.apiKeys.length !== before) {
    saveAuthData(auth);
    return true;
  }
  return false;
}

function listApiKeys() {
  const auth = loadAuthData();
  if (!auth?.apiKeys) {
    return [];
  }
  return auth.apiKeys.map((key) => ({ id: key.id, label: key.label, createdAt: key.createdAt }));
}

function getCommenterIdentityFromHeaders(headers: http.IncomingHttpHeaders) {
  const cookies = parseCookies(headerValue(headers.cookie));
  return {
    id: cookies[commenterIdCookieName] || null,
    name: cookies[commenterNameCookieName] || null,
  };
}

function getCommenterIdentity(c: Context) {
  return {
    id: getCookie(c, commenterIdCookieName) || null,
    name: getCookie(c, commenterNameCookieName) || null,
  };
}

function getOrCreateCommenterId(c: Context) {
  const existing = getCommenterIdentity(c).id;
  if (existing) {
    return existing;
  }
  const created = crypto.randomBytes(24).toString('base64url');
  setCookie(c, commenterIdCookieName, created, {
    path: '/',
    sameSite: 'Lax',
    maxAge: commenterCookieMaxAgeSeconds,
    httpOnly: true,
    secure: isSecureRequest(c),
  });
  return created;
}

function setCommenterNameCookie(c: Context, name: string) {
  setCookie(c, commenterNameCookieName, name, {
    path: '/',
    sameSite: 'Lax',
    maxAge: commenterCookieMaxAgeSeconds,
    httpOnly: true,
    secure: isSecureRequest(c),
  });
}

function ensureCommentAuthor(c: Context, body: Record<string, unknown>) {
  if (isOwnerAuthenticated(c)) {
    return { authorId: '__owner__', authorName: 'Owner' };
  }

  const commenter = getCommenterIdentity(c);
  const name = commenter.name || normalizeCommenterName(String(body.name || ''));
  if (!name) {
    return null;
  }

  const commenterId = commenter.id || getOrCreateCommenterId(c);
  return { authorId: commenterId, authorName: name };
}

function canManageMessage(c: Context, message: CommentMessage) {
  if (isOwnerAuthenticated(c)) {
    return true;
  }
  const commenter = getCommenterIdentity(c);
  return Boolean(commenter.id && commenter.id === message.authorId);
}

function canManageThread(c: Context, thread: CommentThread) {
  if (isOwnerAuthenticated(c)) {
    return true;
  }
  const commenter = getCommenterIdentity(c);
  return Boolean(commenter.id && thread.messages.some((message) => message.authorId === commenter.id));
}

function applyTextEditsToNote(note: NoteRecord, edits: unknown[]) {
  let workingCollab = note.collab;
  let markdown = note.markdown;
  let senderCounter = 0;
  const errors: string[] = [];
  const idListUpdates: ServerMutationMessage['idListUpdates'] = [];

  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index] as Record<string, unknown>;
    const oldText = String(edit?.oldText || '');
    const newText = String(edit?.newText || '');

    if (!oldText) {
      errors.push(`Edit ${index}: oldText is empty.`);
      continue;
    }

    const firstIndex = markdown.indexOf(oldText);
    if (firstIndex === -1) {
      errors.push(`Edit ${index}: oldText not found.`);
      continue;
    }

    const secondIndex = markdown.indexOf(oldText, firstIndex + 1);
    if (secondIndex !== -1) {
      errors.push(`Edit ${index}: oldText is ambiguous (found ${countOccurrences(markdown, oldText)} times).`);
      continue;
    }

    let nextClientCounter = senderCounter + 1;
    const mutations: ClientMutation[] = [];

    mutations.push({
      name: 'delete',
      clientCounter: nextClientCounter++,
      args: {
        startId: idAtIndex(workingCollab, firstIndex),
        endId: idAtIndex(workingCollab, firstIndex + oldText.length - 1),
        contentLength: oldText.length,
      },
    });

    if (newText.length > 0) {
      mutations.push({
        name: 'insert',
        clientCounter: nextClientCounter++,
        args: {
          before: firstIndex > 0 ? idBeforeIndex(workingCollab, firstIndex) : null,
          id: { bunchId: crypto.randomUUID(), counter: 0 },
          content: newText,
          isInWord: false,
        },
      });
    }

    const result = applyClientMutations(workingCollab, mutations);
    workingCollab = result.state;
    markdown = result.markdown;
    idListUpdates.push(...result.idListUpdates);
    senderCounter = mutations.at(-1)?.clientCounter || senderCounter;
  }

  if (errors.length > 0) {
    return { ok: false as const, errors, senderCounter: 0, idListUpdates: [] as ServerMutationMessage['idListUpdates'] };
  }

  note.collab = workingCollab;
  note.markdown = markdown;
  return { ok: true as const, errors: [] as string[], senderCounter, idListUpdates };
}
