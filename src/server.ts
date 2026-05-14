import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { getRequestListener } from "@hono/node-server";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Hono, type Context } from "hono";
import hljs from "highlight.js";
import { marked, type Tokens } from "marked";
import sanitizeHtml from "sanitize-html";
import { WebSocketServer, type WebSocket } from "ws";

import {
  buildPdfCss,
  highlightCodeBlocksWithShiki,
  mergeSettings,
  type PdfExportSettings,
  warmPdfPreviewEngine,
} from "./pdf-export.js";
import { TOKEN_COLORS, CODE_CHROME, codePreStyle } from "./code-block-style.js";
import {
  type ClientMutation,
  type ClientPresenceMessage,
  type ServerMutationMessage,
  applyClientMutations,
  idAtIndex,
  idBeforeIndex,
} from "./collab.js";

import type {
  CommentAnchor,
  CommentMessage,
  CommentThread,
  ShareAccess,
  NoteRecord,
  NoteAssetSummary,
} from "./types/notes.js";

import type {
  ApiKey,
  AuthData,
  AuthGuardData,
  AuthGuardEvent,
  AuthGuardRuntime,
  AuthGuardSummary,
  ViewerInfo,
  ViewerContext,
  AuthGuardIpBan,
} from "./types/auth.js";

export function cliArg(name: string) {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.split("=").slice(1).join("=") : null;
}

const port = Number(cliArg("port") || process.env.PORT || 3120);
const dataDir = cliArg("data") || process.env.DATA_DIR || path.join(process.cwd(), "data");
const noteAssetsDir = path.join(dataDir, "assets");
const noteExportsDir = path.join(dataDir, "exports");
const authFilePath = path.join(dataDir, "auth.json");
const authGuardFilePath = path.join(dataDir, "auth-guard.json");
const authGuardLogFilePath = path.join(dataDir, "auth-guard.jsonl");
const authTokenVerificationCacheMs = 1000 * 60 * 5;
const authKeyVerificationCacheMs = 1000 * 60 * 5;
export const exportSettingsFilePath = path.join(dataDir, "export-settings.json");
export const activePdfPreviewControllers = new Map<string, AbortController>();
const authDataCache = { value: null as AuthData | null, mtimeMs: -1 };
const verifiedOwnerTokenCache = new Map<string, number>();
const verifiedApiKeyCache = new Map<string, number>();
const requestViewerContextCache = new WeakMap<Context, ViewerContext>();
const ownerSessionCookieName = "documine_owner_session";
export const ownerLocalStorageTokenKey = "documine_owner_token";
const commenterIdCookieName = "documine_commenter_id";
const commenterNameCookieName = "documine_commenter_name";
const ownerCookieMaxAgeSeconds = 60 * 60 * 24 * 30;
const commenterCookieMaxAgeSeconds = 60 * 60 * 24 * 365;
export const authIpBanDurationMs = 1000 * 60 * 15;
export const authFailedAttemptWindowMs = 1000 * 60 * 15;
export const authFailedAttemptBanThreshold = 3;
export const authGlobalLoginWindowMs = 1000 * 60 * 5;
export const authGlobalLoginThreshold = 10;
export const shareAccessLevels: Record<ShareAccess, number> = { none: 0, view: 1, comment: 2, edit: 3 };
export const maxImageUploadBytes = 10 * 1024 * 1024;
export const maxNotesImportZipBytes = 100 * 1024 * 1024;
export const NOTE_LIST_SNIPPET_SOURCE_LIMIT = 1000;
export const imageMimeExtensions: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
};

const codeRenderer = new marked.Renderer();
codeRenderer.code = ({ text, lang }: Tokens.Code) => {
  const language = (lang || "").trim().split(/\s+/)[0];
  if (language === "mermaid") {
    return `<pre class="mermaid">${escapeHtml(text)}</pre>`;
  }
  const validLanguage = language && hljs.getLanguage(language) ? language : null;
  const highlighted = validLanguage ? hljs.highlight(text, { language: validLanguage }).value : escapeHtml(text);
  const languageClass = validLanguage ? ` class="hljs language-${escapeHtml(validLanguage)}"` : ' class="hljs"';
  return `<pre><code${languageClass}>${highlighted}</code></pre>`;
};

marked.setOptions({
  gfm: true,
  breaks: false,
  renderer: codeRenderer,
});

export const authGuardRuntime = loadAuthGuardRuntime();

const app = new Hono();

const frontendDist = path.resolve(__dirname, "../apps/web/dist");
const frontendDistExists = fs.existsSync(frontendDist) && fs.statSync(frontendDist).isDirectory();

app.use("/api/*", async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && isAllowedBrowserOrigin(origin)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    c.header("Vary", "Origin");
  }

  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }

  await next();
});

app.get("/", (c) => {
  if (frontendDistExists) {
    const indexPath = path.join(frontendDist, "index.html");
    if (fs.existsSync(indexPath)) {
      return c.body(fs.readFileSync(indexPath), 200, {
        "Content-Type": "text/html",
      });
    }
  }
  return c.json({ ok: true, service: "documine-api" });
});

app.get("/health", (c) => c.text("ok"));

app.get("/assets/:noteId/:fileName", (c) => {
  const note = noteStore.getNote(c.req.param("noteId"));
  if (!note) {
    return c.text("Not found.", 404);
  }
  if (!isOwnerAuthenticated(c) && shareAccessLevels[note.shareAccess] < shareAccessLevels.view) {
    return c.text("Forbidden.", 403);
  }

  const fileName = path.basename(c.req.param("fileName"));
  const filePath = path.join(noteAssetDirectory(note.id), fileName);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return c.text("Not found.", 404);
  }

  const extension = path.extname(fileName).toLowerCase();
  const contentType = imageContentTypeFromExtension(extension);
  if (!contentType) {
    return c.text("Unsupported media type.", 415);
  }

  return c.body(fs.readFileSync(filePath), 200, {
    "Content-Type": contentType,
    "Cache-Control": "private, max-age=31536000, immutable",
  });
});

import { registerAuthRoutes } from "./routes/auth.js";
registerAuthRoutes(app);

type ClientConn = {
  ws: WebSocket;
  kind: "editor" | "public-editor" | "public-viewer";
  noteId: string;
  shareId: string;
  clientId: string;
  name: string;
  color: string;
  alive: boolean;
  selection?: ClientPresenceMessage["selection"];
};

import { registerNotesRoutes } from "./routes/notes.js";
import { registerSharedRoutes } from "./routes/shared-notes.js";
import {
  clients,
  initCollabWs,
  setupHeartbeat,
  nextClientId,
  pickColor,
  handleDisconnect,
  handleEditorMessage,
  sendServerMessage,
  buildHelloMessage,
  sendExistingPresence,
  broadcastShareParticipants,
} from "./lib/collab-ws.js";
import { initAuthPaths } from "./lib/auth.js";
import { FsNoteStore } from "./lib/note-store.js";

initAuthPaths(dataDir);
const noteStore = new FsNoteStore(dataDir);
registerNotesRoutes(app, noteStore);
registerSharedRoutes(app, noteStore);

initCollabWs(noteStore);

const listener = getRequestListener(app.fetch);
const server = http.createServer(listener);
const wss = new WebSocketServer({ noServer: true });

setupHeartbeat(wss);

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://localhost:${port}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", `http://localhost:${port}`);
  const noteId = url.searchParams.get("noteId") || "";
  const shareId = url.searchParams.get("shareId") || "";

  if (noteId) {
    if (!isOwnerAuthenticatedIncomingRequest(req)) {
      ws.close();
      return;
    }

    const note = noteStore.getNote(noteId);
    if (!note) {
      ws.close();
      return;
    }

    const clientId = nextClientId();
    const color = pickColor();
    const conn: ClientConn = {
      ws,
      kind: "editor",
      noteId: note.id,
      shareId: note.shareId,
      clientId,
      name: "Owner",
      color,
      alive: true,
    };
    clients.push(conn);
    sendServerMessage(ws, { ...buildHelloMessage(note), clientId });
    sendExistingPresence(conn);
    broadcastShareParticipants(note.id);

    ws.on("pong", () => {
      conn.alive = true;
    });
    ws.on("message", (data) => handleEditorMessage(conn, String(data)));
    ws.on("close", () => handleDisconnect(conn));
    ws.on("error", () => handleDisconnect(conn));
    return;
  }

  if (shareId) {
    const note = noteStore.findByShareId(shareId);
    if (!note || note.shareAccess === "none") {
      ws.close();
      return;
    }

    if (note.shareAccess === "edit") {
      const commenterIdentity = getCommenterIdentityFromHeaders(req.headers);
      if (!commenterIdentity.id || !commenterIdentity.name) {
        ws.close();
        return;
      }
      const clientId = nextClientId();
      const color = pickColor();
      const conn: ClientConn = {
        ws,
        kind: "public-editor",
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

      ws.on("pong", () => {
        conn.alive = true;
      });
      ws.on("message", (data) => handleEditorMessage(conn, String(data)));
      ws.on("close", () => handleDisconnect(conn));
      ws.on("error", () => handleDisconnect(conn));
      return;
    }

    const commenterIdentity = getCommenterIdentityFromHeaders(req.headers);
    if (!commenterIdentity.id || !commenterIdentity.name) {
      ws.close();
      return;
    }
    const clientId = nextClientId();
    const conn: ClientConn = {
      ws,
      kind: "public-viewer",
      noteId: note.id,
      shareId: note.shareId,
      clientId,
      name: commenterIdentity.name,
      color: "",
      alive: true,
    };
    clients.push(conn);
    broadcastShareParticipants(note.id);
    ws.on("pong", () => {
      conn.alive = true;
    });
    ws.on("close", () => handleDisconnect(conn));
    ws.on("error", () => handleDisconnect(conn));
    return;
  }

  ws.close();
});

server.listen(port, () => {
  console.log(`documine api listening on http://localhost:${port}`);
  console.log(`data: ${path.resolve(dataDir)}`);
  void warmPdfPreviewEngine()
    .then(() => {
      console.log("[pdf-preview] browser engine ready");
    })
    .catch((error) => {
      console.warn(`[pdf-preview] browser engine failed: ${error instanceof Error ? error.message : String(error)}`);
    });
});

export function readJsonBody(c: Context) {
  return c.req.json().catch(() => ({}) as Record<string, unknown>) as Promise<Record<string, unknown>>;
}

export function noteAssetDirectory(noteId: string) {
  return path.join(noteAssetsDir, noteId);
}

export function noteExportDirectory(noteId: string) {
  return path.join(noteExportsDir, noteId);
}

export function noteAssetPath(noteId: string, fileName: string) {
  return path.join(noteAssetDirectory(noteId), fileName);
}

export function buildIncrementedExportFileName(noteId: string, noteTitle: string) {
  const baseName = sanitizeExportBaseName(noteTitle || noteId);
  const directory = noteExportDirectory(noteId);
  fs.mkdirSync(directory, { recursive: true });
  let nextIndex = 1;
  const existingFiles = fs.existsSync(directory) ? fs.readdirSync(directory) : [];
  for (const file of existingFiles) {
    const match = file.match(new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:-(\\d+))?\\.pdf$`, "i"));
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

export function sanitizeExportBaseName(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "note"
  );
}

export function noteExportPath(noteId: string, fileName: string) {
  return path.join(noteExportDirectory(noteId), fileName);
}

export function noteExportAssetPath(noteId: string, fileName: string, suffix: ".html" | ".css" | ".md" | ".json") {
  return path.join(noteExportDirectory(noteId), `${fileName}${suffix}`);
}

export function noteExportReferencePath(noteId: string, fileName: string) {
  return `/api/notes/${encodeURIComponent(noteId)}/exports/${encodeURIComponent(fileName)}`;
}

export function loadNoteExportDebug(noteId: string, fileName: string) {
  const metadataPath = noteExportAssetPath(noteId, fileName, ".json");
  const htmlPath = noteExportAssetPath(noteId, fileName, ".html");
  const cssPath = noteExportAssetPath(noteId, fileName, ".css");
  const markdownPath = noteExportAssetPath(noteId, fileName, ".md");
  if (
    !fs.existsSync(metadataPath) ||
    !fs.existsSync(htmlPath) ||
    !fs.existsSync(cssPath) ||
    !fs.existsSync(markdownPath)
  ) {
    return null;
  }
  return {
    metadata: readJson<Record<string, unknown> | null>(metadataPath, null),
    html: fs.readFileSync(htmlPath, "utf8"),
    css: fs.readFileSync(cssPath, "utf8"),
    markdown: fs.readFileSync(markdownPath, "utf8"),
  };
}

export function loadManagedNoteExportFile(noteId: string, rawFileName: string) {
  const baseName = path.basename(rawFileName).replace(/\.pdf$/i, "");
  const fileName = baseName;
  const filePath = noteExportPath(noteId, `${fileName}.pdf`);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return null;
  }
  return { fileName, filePath };
}

export function loadManagedDebugExportFile(noteId: string, rawFileName: string) {
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
function readJson<T>(filePath: string, fallback: T) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function slugifyFileName(value: string) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
export function buildSnippet(note: NoteRecord, needle: string) {
  const source = needle
    ? note.markdown.replace(/\s+/g, " ").trim()
    : note.markdown.slice(0, NOTE_LIST_SNIPPET_SOURCE_LIMIT).replace(/\s+/g, " ").trim();
  if (!source) {
    return "";
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
export function locateMessage(note: NoteRecord, messageId: string) {
  for (const thread of note.threads) {
    const message = thread.messages.find((item) => item.id === messageId);
    if (message) {
      return { thread, message };
    }
  }
  return null;
}

export function getViewerContext(
  c: Context,
  overrides?: { commenterNameOverride?: string; hasCommenterIdentityOverride?: boolean },
): ViewerContext {
  if (!overrides) {
    const cached = requestViewerContextCache.get(c);
    if (cached) {
      return cached;
    }
  }

  const commenter = getCommenterIdentity(c);
  const viewer: ViewerInfo = {
    isOwner: isOwnerAuthenticated(c),
    commenterName: overrides?.commenterNameOverride ?? commenter.name,
    hasCommenterIdentity: overrides?.hasCommenterIdentityOverride ?? Boolean(commenter.id),
  };

  if (!overrides) {
    const context = { viewer, commenter };
    requestViewerContextCache.set(c, context);
    return context;
  }

  return { viewer, commenter };
}

export function buildViewerInfo(
  c: Context,
  overrides?: { commenterNameOverride?: string; hasCommenterIdentityOverride?: boolean },
): ViewerInfo {
  return getViewerContext(c, overrides).viewer;
}

export function serializeThreads(note: NoteRecord, c: Context, viewerContext = getViewerContext(c)) {
  const viewer = viewerContext.viewer;
  const commenter = viewerContext.commenter;

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

export function serializeNoteForClient(note: NoteRecord, c: Context) {
  const viewerContext = getViewerContext(c);
  return {
    note: {
      id: note.id,
      title: note.title,
      markdown: note.markdown,
      shareId: note.shareId,
      shareAccess: note.shareAccess,
      shareUrl: makeShareUrl(c, note.shareId),
      updatedAt: note.updatedAt,
      createdAt: note.createdAt,
    },
    viewer: viewerContext.viewer,
    threads: serializeThreads(note, c, viewerContext),
  };
}

export function requireShareAccess(c: Context, minAccess: ShareAccess): NoteRecord | null {
  const note = noteStore.findByShareId(c.req.param("shareId") || "");
  if (!note) {
    return null;
  }
  if (shareAccessLevels[note.shareAccess] < shareAccessLevels[minAccess]) {
    return null;
  }
  return note;
}

export function requireSharedIdentity(c: Context) {
  const commenter = getCommenterIdentity(c);
  return Boolean(commenter.id && commenter.name);
}

export function countOccurrences(haystack: string, needle: string) {
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

export function normalizeTitle(input: string) {
  return input.trim().slice(0, 160) || "untitled";
}

export function normalizeCommentBody(input: string) {
  return input.trim().slice(0, 5000);
}

export function normalizeCommenterName(input: string) {
  return input.trim().slice(0, 80);
}

export function listNoteAssets(note: NoteRecord, c: Context): NoteAssetSummary[] {
  const directory = noteAssetDirectory(note.id);
  if (!fs.existsSync(directory)) {
    return [];
  }

  return fs
    .readdirSync(directory)
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

export function sanitizeAnchor(input: unknown) {
  if (!input || typeof input !== "object") {
    return null;
  }

  const source = input as Record<string, unknown>;
  const quote = String(source.quote || "").slice(0, 1000);
  const prefix = String(source.prefix || "").slice(0, 200);
  const suffix = String(source.suffix || "").slice(0, 200);
  const start = Number(source.start);
  const end = Number(source.end);

  if (!quote || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
    return null;
  }

  return { quote, prefix, suffix, start, end } satisfies CommentAnchor;
}

export async function handleImageUpload(c: Context, note: NoteRecord) {
  const body = await c.req.parseBody();
  const file = body.file;
  if (!(file instanceof File)) {
    return c.json({ ok: false, error: "Image file is required." }, 400);
  }

  const extension = imageMimeExtensions[file.type];
  if (!extension) {
    return c.json({ ok: false, error: "Only PNG, JPEG, GIF, WebP, and AVIF images are supported." }, 400);
  }
  if (file.size <= 0) {
    return c.json({ ok: false, error: "Image file is empty." }, 400);
  }
  if (file.size > maxImageUploadBytes) {
    return c.json({ ok: false, error: "Image exceeds the 10 MB upload limit." }, 413);
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

export function escapeMarkdownImageAlt(input: string) {
  const base = input
    .trim()
    .replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/[[\]\\]/g, "")
    .trim();
  return base || "image";
}

export function imageContentTypeFromExtension(extension: string) {
  return Object.entries(imageMimeExtensions).find(([, value]) => value === extension)?.[0] || null;
}

export function makeAssetUrl(c: Context, noteId: string, fileName: string) {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}${assetMarkdownReferencePath(noteId, fileName)}`;
}

export function applyPreviewImageAttributeHints(rawHtml: string) {
  return rawHtml.replace(
    /<p>(\s*<img\b[^>]*?)(?:\s*)\{([^{}]+)\}(\s*)<\/p>/gi,
    (_match, imgHtml: string, attrs: string, trailingSpace: string) => {
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
    },
  );
}

export function renderMarkdown(markdown: string) {
  const rawHtml = applyPreviewImageAttributeHints(marked.parse(markdown) as string);
  return sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "img",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "pre",
      "code",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "blockquote",
      "span",
    ]),
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "title"],
      code: ["class"],
      span: ["class"],
    },
    allowedClasses: {
      code: ["hljs", /^language-/],
      span: [/^hljs.*/],
      pre: ["mermaid"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
    },
  });
}

export async function renderPrintPreviewHtml(markdown: string, title: string, settings: unknown): Promise<string> {
  const merged = mergeSettings(settings);
  const body = renderMarkdown(markdown);
  const css = buildPdfCss(title, merged);
  const safeTitle = escapeHtml(title || "Untitled");
  const highlightedBody = await highlightCodeBlocksWithShiki(body, merged);
  const inlinedBody = inlineCodeBlockStyles(highlightedBody, merged);
  return [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    `<meta charset="UTF-8">`,
    `<title>${safeTitle}</title>`,
    `<style>${css}</style>`,
    "</head>",
    `<body>${inlinedBody}</body>`,
    "</html>",
  ].join("\n");
}

export function inlineCodeBlockStyles(html: string, settings: PdfExportSettings): string {
  const PRE_BG = codePreStyle(settings.codeWrap === "wrap" ? "pre-wrap" : "pre");

  let result = html;

  result = result.replace(/<pre\b([^>]*)>/gi, (_, attrs) => {
    if (/style\s*=\s*["']/i.test(attrs)) {
      return `<pre${attrs.replace(/(style\s*=\s*["'])([^"']*)(["'])/i, `$1$2;${PRE_BG}$3`)}>`;
    }
    return `<pre${attrs} style="${PRE_BG}">`;
  });

  result = result.replace(/<span class="([^"]*)"([^>]*)>/gi, (_, classes, attrs) => {
    const classList = classes.split(/\s+/);
    let color: string | null = null;
    let isBold = false;
    let isItalic = false;
    for (const cls of classList) {
      if (cls === "hljs-strong") isBold = true;
      if (cls === "hljs-emphasis") isItalic = true;
      if (!color && TOKEN_COLORS[cls]) color = TOKEN_COLORS[cls];
    }
    let styleAdd = "";
    if (color) styleAdd += `color:${color};`;
    if (isBold) styleAdd += "font-weight:700;";
    if (isItalic) styleAdd += "font-style:italic;";

    if (!styleAdd) {
      return `<span class="${classes}"${attrs}>`;
    }

    if (/style\s*=\s*["']/i.test(attrs)) {
      return `<span class="${classes}"${attrs.replace(/(style\s*=\s*["'])([^"']*)(["'])/i, `$1$2;${styleAdd}$3`)}>`;
    }
    return `<span class="${classes}"${attrs} style="${styleAdd}">`;
  });

  return result;
}

export function makeShareUrl(c: Context, shareId: string) {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}/s/${shareId}`;
}

export function buildPreviewPaginationScript(): string {
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

export function buildPreviewClipboardScript(): string {
  return `<script>
(() => {
  const TOKEN_STYLES = {
    ${Object.entries(TOKEN_COLORS)
      .map(([cls, color]) => {
        if (cls.startsWith("hljs-")) {
          return `'${cls}': '${color.startsWith("font-") ? color : `color:${color};`}'`;
        }
        return `'${cls}': 'color:${color};'`;
      })
      .join(",\n    ")}
  };

  document.addEventListener('copy', (event) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }

    const range = selection.getRangeAt(0);
    const pre = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer.closest('pre')
      : range.commonAncestorContainer.parentElement?.closest('pre');
    if (!pre) {
      return;
    }

    const codeEl = pre.querySelector('code') || pre;
    const cloned = codeEl.cloneNode(true);

    for (const span of cloned.querySelectorAll('span[class]')) {
      for (const cls of span.classList) {
        const color = TOKEN_STYLES[cls];
        if (color) {
          span.setAttribute('style', (span.getAttribute('style') || '') + color);
        }
      }
    }

    const wrapper = document.createElement('pre');
    wrapper.style.cssText = 'margin:0;color:${CODE_CHROME.color};background-color:${CODE_CHROME.backgroundColor};font-family:${CODE_CHROME.fontFamily};font-weight:normal;font-size:${CODE_CHROME.fontSize};line-height:14pt;white-space:pre;padding:${CODE_CHROME.padding};border-radius:${CODE_CHROME.borderRadius};';

    const code = document.createElement('code');
    code.style.cssText = 'color:inherit;background:transparent;font:inherit;white-space:inherit;padding:0;';
    code.innerHTML = cloned.innerHTML;
    wrapper.appendChild(code);

    event.clipboardData.setData('text/html', wrapper.outerHTML);
    event.clipboardData.setData('text/plain', selection.toString());
    event.preventDefault();
  });
})();
</script>`;
}

export function buildCopyButtonsScript(): string {
  return `<script>
(() => {
  const STYLE = document.createElement('style');
  STYLE.textContent = \`
    .documine-cb-wrap { position:relative; display:block; }
    .documine-cb-wrap:hover .documine-cb-btn { opacity:0.7; }
    .documine-cb-btn {
      position:absolute; top:0; right:0;
      border:0; background:transparent;
      color:#d4d4d4; cursor:pointer;
      font-family:system-ui,sans-serif; font-size:11px;
      padding:4px 8px; opacity:0;
      transition:opacity 0.15s;
      z-index:1; line-height:1;
    }
    .documine-cb-btn:hover { opacity:1 !important; background:rgba(255,255,255,0.08); }
    .documine-cb-btn.copied { opacity:1 !important; }
    .documine-cb-btn.failed { opacity:1 !important; }
  \`;
  document.head.appendChild(STYLE);

  const TOKEN_STYLES = {
    ${Object.entries(TOKEN_COLORS)
      .map(([cls, color]) => {
        if (cls.startsWith("hljs-")) {
          return `'${cls}': '${color.startsWith("font-") ? color : `color:${color};`}'`;
        }
        return `'${cls}': 'color:${color};'`;
      })
      .join(",\n    ")}
  };

  function buildClipboardHtml(pre) {
    const codeEl = pre.querySelector('code') || pre;
    const cloned = codeEl.cloneNode(true);
    for (const span of cloned.querySelectorAll('span[class]')) {
      for (const cls of span.classList) {
        const color = TOKEN_STYLES[cls];
        if (color) {
          span.setAttribute('style', (span.getAttribute('style') || '') + color);
        }
      }
    }
    const lines = [];
    cloned.querySelectorAll('span.line').forEach(line => {
      lines.push(line.innerHTML || '&nbsp;');
    });
    if (!lines.length) {
      lines.push(cloned.innerHTML || '&nbsp;');
    }
    const cellHtml = lines.join('\\n');
    const tableHtml = '<table style="width:100%;margin:0;border-collapse:collapse;border-spacing:0"><tbody><tr><td style="background-color:${CODE_CHROME.backgroundColor};color:${CODE_CHROME.color};font-family:${CODE_CHROME.fontFamily};font-weight:400;font-size:${CODE_CHROME.fontSize};white-space:pre;text-align:left;vertical-align:top;padding:${CODE_CHROME.padding};border-radius:${CODE_CHROME.borderRadius}">' + cellHtml + '</td></tr></tbody></table>';
    return tableHtml;
  }

  function resetBtn(btn) {
    setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied', 'failed'); }, 2000);
  }

  async function copyCodeToClipboard(copyHtml, copyText, btn) {
    btn.textContent = 'Copying...';
    btn.classList.add('copied');
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([copyHtml], { type: 'text/html' }),
            'text/plain': new Blob([copyText], { type: 'text/plain' }),
          }),
        ]);
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        resetBtn(btn);
        return;
      }
    } catch (_0) {}
    try {
      const container = document.createElement('div');
      container.contentEditable = 'true';
      container.style.cssText = 'position:fixed;left:-9999px;top:0;pointer-events:none;';
      container.innerHTML = copyHtml;
      document.body.appendChild(container);
      const range = document.createRange();
      range.selectNodeContents(container);
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      document.execCommand('copy');
      document.body.removeChild(container);
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      resetBtn(btn);
      return;
    } catch (_1) {}
    try {
      await navigator.clipboard.writeText(copyText);
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
    } catch (_2) {
      btn.textContent = 'Failed';
      btn.classList.add('failed');
    }
    resetBtn(btn);
  }

  function wrapUnmatchedPreBlocks() {
    document.querySelectorAll('#documine-preview-pages pre.shiki:not([data-documine-copy-button]), #documine-preview-pages pre.documine-shiki:not([data-documine-copy-button])').forEach(pre => {
      pre.dataset.documineCopyButton = '1';
      const wrap = document.createElement('div');
      wrap.className = 'documine-cb-wrap';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      const btn = document.createElement('button');
      btn.className = 'documine-cb-btn';
      btn.textContent = 'Copy';
      wrap.appendChild(btn);
    });
  }

  function initWhenPagesReady() {
    var wrapTimer = 0;
    function debouncedWrap() {
      if (wrapTimer) clearTimeout(wrapTimer);
      wrapTimer = setTimeout(function() {
        wrapTimer = 0;
        if (document.getElementById('documine-preview-pages')) {
          wrapUnmatchedPreBlocks();
        }
      }, 30);
    }
    function cancelWrap() { if (wrapTimer) { clearTimeout(wrapTimer); wrapTimer = 0; } }
    window.addEventListener('beforeunload', cancelWrap, { once: true });
    const pages = document.getElementById('documine-preview-pages');
    if (pages) {
      wrapUnmatchedPreBlocks();
    }
    const obs = new MutationObserver(debouncedWrap);
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  initWhenPagesReady();

  document.addEventListener('click', async function(e) {
    const btn = e.target.closest('.documine-cb-btn');
    if (!btn) return;
    const wrap = btn.closest('.documine-cb-wrap');
    if (!wrap) return;
    const pre = wrap.querySelector('pre');
    if (!pre) return;
    e.preventDefault();
    e.stopPropagation();
    await copyCodeToClipboard(buildClipboardHtml(pre), (pre.textContent || '').trim(), btn);
  }, true);
})();
</script>`;
}

export function injectPreviewBaseHref(html: string, baseHref: string) {
  const baseTag = `<base href="${escapeHtml(baseHref)}">`;
  const previewScript = buildPreviewPaginationScript() + buildPreviewClipboardScript() + buildCopyButtonsScript();

  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (headTag) => `${headTag}\n    ${baseTag}\n    ${previewScript}`);
  }

  return html;
}

export function isAllowedBrowserOrigin(origin: string) {
  try {
    const url = new URL(origin);
    const isLocalHost = url.hostname === "localhost" || url.hostname === "127.0.0.1";
    if (isLocalHost && url.protocol === "http:") {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

export function nowIso() {
  return new Date().toISOString();
}

export function createShortId(length = 8) {
  return crypto
    .randomBytes(length)
    .toString("base64url")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, length);
}

export function createId(length = 12) {
  return createShortId(length);
}

export function escapeHtml(input: string) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function hashSecret(value: string, salt: string) {
  return crypto.scryptSync(value, salt, 64).toString("hex");
}

export function secureEqualsHex(a: string, b: string) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export function loadAuthData() {
  const mtimeMs = fs.existsSync(authFilePath) ? fs.statSync(authFilePath).mtimeMs : -1;
  if (authDataCache.value && authDataCache.mtimeMs === mtimeMs) {
    return authDataCache.value;
  }
  authDataCache.value = readJson<AuthData | null>(authFilePath, null);
  authDataCache.mtimeMs = mtimeMs;
  return authDataCache.value;
}

export function saveAuthData(authData: AuthData) {
  writeJson(authFilePath, authData);
  authDataCache.value = authData;
  authDataCache.mtimeMs = fs.statSync(authFilePath).mtimeMs;
  verifiedOwnerTokenCache.clear();
  verifiedApiKeyCache.clear();
}

export function defaultAuthGuardData(): AuthGuardData {
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

export function loadAuthGuardData(): AuthGuardData {
  const raw = readJson<Record<string, unknown> | null>(authGuardFilePath, null);
  const fallback = defaultAuthGuardData();
  const authGuard: AuthGuardData = {
    loginEnabled: typeof raw?.loginEnabled === "boolean" ? raw.loginEnabled : fallback.loginEnabled,
    globalLock: {
      active:
        typeof raw?.globalLock === "object" &&
        raw?.globalLock !== null &&
        typeof (raw.globalLock as { active?: unknown }).active === "boolean"
          ? Boolean((raw.globalLock as { active: boolean }).active)
          : fallback.globalLock.active,
      lockedAt:
        typeof raw?.globalLock === "object" &&
        raw?.globalLock !== null &&
        typeof (raw.globalLock as { lockedAt?: unknown }).lockedAt === "string"
          ? String((raw.globalLock as { lockedAt: string }).lockedAt)
          : fallback.globalLock.lockedAt,
      expiresAt:
        typeof raw?.globalLock === "object" &&
        raw?.globalLock !== null &&
        typeof (raw.globalLock as { expiresAt?: unknown }).expiresAt === "string"
          ? String((raw.globalLock as { expiresAt: string }).expiresAt)
          : fallback.globalLock.expiresAt,
      reason:
        typeof raw?.globalLock === "object" &&
        raw?.globalLock !== null &&
        typeof (raw.globalLock as { reason?: unknown }).reason === "string"
          ? String((raw.globalLock as { reason: string }).reason)
          : fallback.globalLock.reason,
    },
    bannedIps: Array.isArray(raw?.bannedIps)
      ? raw.bannedIps.filter((item): item is AuthGuardIpBan =>
          Boolean(
            item &&
            typeof item === "object" &&
            typeof (item as AuthGuardIpBan).ip === "string" &&
            typeof (item as AuthGuardIpBan).bannedAt === "string" &&
            typeof (item as AuthGuardIpBan).expiresAt === "string" &&
            typeof (item as AuthGuardIpBan).reason === "string",
          ),
        )
      : [],
  };
  if (!fs.existsSync(authGuardFilePath)) {
    saveAuthGuardData(authGuard);
  }
  return authGuard;
}

export function loadAuthGuardRuntime(): AuthGuardRuntime {
  const runtime = defaultAuthGuardRuntime();
  const loginRequestCutoff = Date.now() - authGlobalLoginWindowMs;
  const failedLoginCutoff = Date.now() - authFailedAttemptWindowMs;

  if (!fs.existsSync(authGuardLogFilePath)) {
    pruneAuthGuardRuntimeEntries(runtime);
    return runtime;
  }

  const content = fs.readFileSync(authGuardLogFilePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as Partial<AuthGuardEvent>;
      if (typeof event.ip !== "string" || typeof event.timestamp !== "string" || typeof event.type !== "string") {
        continue;
      }
      const timestamp = Date.parse(event.timestamp);
      if (Number.isNaN(timestamp)) {
        continue;
      }
      if (event.type === "login-requested" && timestamp >= loginRequestCutoff) {
        runtime.loginRequests.push({ ip: event.ip, timestamp: event.timestamp });
      }
      if (event.type === "login-failed" && timestamp >= failedLoginCutoff) {
        runtime.failedLogins.push({ ip: event.ip, timestamp: event.timestamp });
      }
    } catch {
      continue;
    }
  }
  pruneAuthGuardRuntimeEntries(runtime);
  return runtime;
}

export function saveAuthGuardData(authGuard: AuthGuardData) {
  writeJson(authGuardFilePath, authGuard);
}

export function pruneAuthGuardData(authGuard: AuthGuardData, now = Date.now()) {
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

  return (
    authGuard.bannedIps.length !== bannedIpCount ||
    authGuard.loginEnabled !== previousLoginEnabled ||
    JSON.stringify(authGuard.globalLock) !== previousGlobalLock
  );
}

export function pruneAuthGuardRuntimeEntries(runtime: AuthGuardRuntime, now = Date.now()) {
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

export function pruneAuthGuardRuntime(now = Date.now()) {
  pruneAuthGuardRuntimeEntries(authGuardRuntime, now);
}

export function appendAuthGuardEvent(event: AuthGuardEvent) {
  fs.appendFileSync(authGuardLogFilePath, `${JSON.stringify(event)}\n`, "utf8");
}

export function recordAuthGuardLoginRequest(ip: string, timestamp: string) {
  pruneAuthGuardRuntime();
  authGuardRuntime.loginRequests.push({ ip, timestamp });
  appendAuthGuardEvent({
    type: "login-requested",
    ip,
    timestamp,
    detail: "Owner login request received.",
  });
}

export function recordAuthGuardFailedLogin(ip: string, timestamp: string) {
  pruneAuthGuardRuntime();
  authGuardRuntime.failedLogins.push({ ip, timestamp });
  appendAuthGuardEvent({
    type: "login-failed",
    ip,
    timestamp,
    detail: "Invalid owner password.",
  });
}

export function clearAuthGuardFailedLoginsForIp(ip: string) {
  authGuardRuntime.failedLogins = authGuardRuntime.failedLogins.filter((item) => item.ip !== ip);
}

export function getActiveIpBan(authGuard: AuthGuardData, ip: string) {
  const now = Date.now();
  return authGuard.bannedIps.find((item) => item.ip === ip && Date.parse(item.expiresAt) > now) || null;
}

export function buildAuthGuardSummary(authGuard: AuthGuardData): AuthGuardSummary {
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

export function authConfigured() {
  const auth = loadAuthData();
  return Boolean(auth?.passwordSalt && auth?.passwordHash);
}

export function passwordMatches(password: string) {
  const auth = loadAuthData();
  if (!auth) {
    return false;
  }
  return secureEqualsHex(hashSecret(password, auth.passwordSalt), auth.passwordHash);
}

export function initializeOwnerAuth(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const auth: AuthData = {
    passwordSalt: salt,
    passwordHash: hashSecret(password, salt),
    tokens: [],
  };
  saveAuthData(auth);
  saveAuthGuardData(defaultAuthGuardData());
  return issueOwnerToken();
}

export function issueOwnerToken() {
  const auth = loadAuthData();
  if (!auth) {
    throw new Error("Password not configured.");
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const salt = crypto.randomBytes(16).toString("hex");
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

export function verifyOwnerToken(token: string) {
  const cachedExpiresAt = verifiedOwnerTokenCache.get(token);
  if (cachedExpiresAt && cachedExpiresAt > Date.now()) {
    return true;
  }

  const auth = loadAuthData();
  if (!auth) {
    return false;
  }

  let changed = false;
  for (let index = auth.tokens.length - 1; index >= 0; index--) {
    const stored = auth.tokens[index];
    if (!secureEqualsHex(hashSecret(token, stored.salt), stored.hash)) {
      continue;
    }

    if (index !== auth.tokens.length - 1) {
      auth.tokens.splice(index, 1);
      auth.tokens.push(stored);
      changed = true;
    }

    const lastSeen = Date.parse(stored.lastUsedAt);
    if (Number.isNaN(lastSeen) || Date.now() - lastSeen > 1000 * 60 * 60 * 12) {
      stored.lastUsedAt = nowIso();
      changed = true;
    }
    if (changed) {
      saveAuthData(auth);
    }
    verifiedOwnerTokenCache.set(token, Date.now() + authTokenVerificationCacheMs);
    return true;
  }

  return false;
}

export function revokeOwnerToken(token: string) {
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

export function parseCookies(header: string | undefined) {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const item of header.split(";")) {
    const index = item.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function getOwnerSessionTokenFromHeaders(headers: http.IncomingHttpHeaders) {
  return parseCookies(headerValue(headers.cookie))[ownerSessionCookieName] || null;
}

export function forwardedForToIp(value: string | null) {
  if (!value) {
    return null;
  }
  return value.split(",")[0]?.trim() || null;
}

export function forwardedHeaderToIp(value: string | null) {
  if (!value) {
    return null;
  }
  const match = value.match(/for=(?:"?)(\[[^\]]+\]|[^;,"]+)/i);
  return match?.[1]?.replace(/^\[/, "").replace(/\]$/, "").trim() || null;
}

export function getClientIp(c: Context) {
  return (
    forwardedForToIp(c.req.header("cf-connecting-ip") || null) ||
    forwardedForToIp(c.req.header("x-real-ip") || null) ||
    forwardedForToIp(c.req.header("x-forwarded-for") || null) ||
    forwardedHeaderToIp(c.req.header("forwarded") || null) ||
    "unknown"
  );
}

export function getBearerTokenFromHeaders(headers: http.IncomingHttpHeaders) {
  const header = headerValue(headers.authorization);
  if (!header || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice(7).trim() || null;
}

export function getOwnerSessionToken(c: Context) {
  return getCookie(c, ownerSessionCookieName) || null;
}

export function isSecureRequest(c: Context) {
  const forwarded = c.req.header("x-forwarded-proto");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() === "https";
  }
  return new URL(c.req.url).protocol === "https:";
}

export function setOwnerSessionCookie(c: Context, token: string) {
  setCookie(c, ownerSessionCookieName, token, {
    path: "/",
    sameSite: "Lax",
    maxAge: ownerCookieMaxAgeSeconds,
    httpOnly: true,
    secure: isSecureRequest(c),
  });
}

export function clearOwnerSessionCookie(c: Context) {
  deleteCookie(c, ownerSessionCookieName, {
    path: "/",
    secure: isSecureRequest(c),
  });
}

export function isOwnerAuthenticatedHeaders(headers: http.IncomingHttpHeaders) {
  const bearer = getBearerTokenFromHeaders(headers);
  if (bearer && verifyApiKey(bearer)) {
    return true;
  }
  const token = getOwnerSessionTokenFromHeaders(headers);
  return Boolean(token && verifyOwnerToken(token));
}

export function isOwnerAuthenticated(c: Context) {
  const bearer = getBearerToken(c);
  if (bearer && verifyApiKey(bearer)) {
    return true;
  }
  const token = getOwnerSessionToken(c);
  return Boolean(token && verifyOwnerToken(token));
}

export function isOwnerAuthenticatedIncomingRequest(req: http.IncomingMessage) {
  return isOwnerAuthenticatedHeaders(req.headers);
}

export function getBearerToken(c: Context) {
  const header = c.req.header("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice(7).trim() || null;
}

export function verifyApiKey(key: string) {
  const cachedExpiresAt = verifiedApiKeyCache.get(key);
  if (cachedExpiresAt && cachedExpiresAt > Date.now()) {
    return true;
  }

  const auth = loadAuthData();
  if (!auth?.apiKeys) {
    return false;
  }
  for (let index = auth.apiKeys.length - 1; index >= 0; index--) {
    const stored = auth.apiKeys[index];
    if (secureEqualsHex(hashSecret(key, stored.keySalt), stored.keyHash)) {
      verifiedApiKeyCache.set(key, Date.now() + authKeyVerificationCacheMs);
      return true;
    }
  }
  return false;
}

export function getApiKeyLabel(key: string) {
  const auth = loadAuthData();
  if (!auth?.apiKeys) {
    return null;
  }
  for (let index = auth.apiKeys.length - 1; index >= 0; index--) {
    const stored = auth.apiKeys[index];
    if (secureEqualsHex(hashSecret(key, stored.keySalt), stored.keyHash)) {
      return stored.label;
    }
  }
  return null;
}

export function createApiKey(label: string) {
  const auth = loadAuthData();
  if (!auth) {
    throw new Error("Password not configured.");
  }
  if (!auth.apiKeys) {
    auth.apiKeys = [];
  }

  const rawKey = crypto.randomBytes(32).toString("base64url");
  const salt = crypto.randomBytes(16).toString("hex");
  const apiKey: ApiKey = {
    id: createId(10),
    label: label.trim().slice(0, 80) || "unnamed",
    keySalt: salt,
    keyHash: hashSecret(rawKey, salt),
    createdAt: nowIso(),
  };

  auth.apiKeys.push(apiKey);
  saveAuthData(auth);
  return { id: apiKey.id, label: apiKey.label, key: rawKey, createdAt: apiKey.createdAt };
}

export function deleteApiKey(keyId: string) {
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

export function listApiKeys() {
  const auth = loadAuthData();
  if (!auth?.apiKeys) {
    return [];
  }
  return auth.apiKeys.map((key) => ({ id: key.id, label: key.label, createdAt: key.createdAt }));
}

export function getCommenterIdentityFromHeaders(headers: http.IncomingHttpHeaders) {
  const cookies = parseCookies(headerValue(headers.cookie));
  return {
    id: cookies[commenterIdCookieName] || null,
    name: cookies[commenterNameCookieName] || null,
  };
}

export function getCommenterIdentity(c: Context) {
  return {
    id: getCookie(c, commenterIdCookieName) || null,
    name: getCookie(c, commenterNameCookieName) || null,
  };
}

export function getOrCreateCommenterId(c: Context) {
  const existing = getCommenterIdentity(c).id;
  if (existing) {
    return existing;
  }
  const created = crypto.randomBytes(24).toString("base64url");
  setCookie(c, commenterIdCookieName, created, {
    path: "/",
    sameSite: "Lax",
    maxAge: commenterCookieMaxAgeSeconds,
    httpOnly: true,
    secure: isSecureRequest(c),
  });
  return created;
}

export function setCommenterNameCookie(c: Context, name: string) {
  setCookie(c, commenterNameCookieName, name, {
    path: "/",
    sameSite: "Lax",
    maxAge: commenterCookieMaxAgeSeconds,
    httpOnly: true,
    secure: isSecureRequest(c),
  });
}

export function ensureCommentAuthor(c: Context, body: Record<string, unknown>) {
  if (isOwnerAuthenticated(c)) {
    return { authorId: "__owner__", authorName: "Owner" };
  }

  const commenter = getCommenterIdentity(c);
  const name = commenter.name || normalizeCommenterName(String(body.name || ""));
  if (!name) {
    return null;
  }

  const commenterId = commenter.id || getOrCreateCommenterId(c);
  return { authorId: commenterId, authorName: name };
}

export function canManageMessage(c: Context, message: CommentMessage) {
  if (isOwnerAuthenticated(c)) {
    return true;
  }
  const commenter = getCommenterIdentity(c);
  return Boolean(commenter.id && commenter.id === message.authorId);
}

export function canManageThread(c: Context, thread: CommentThread) {
  if (isOwnerAuthenticated(c)) {
    return true;
  }
  const commenter = getCommenterIdentity(c);
  return Boolean(commenter.id && thread.messages.some((message) => message.authorId === commenter.id));
}

export function applyTextEditsToNote(note: NoteRecord, edits: unknown[]) {
  let workingCollab = note.collab;
  let markdown = note.markdown;
  let senderCounter = 0;
  const errors: string[] = [];
  const idListUpdates: ServerMutationMessage["idListUpdates"] = [];

  for (let index = 0; index < edits.length; index++) {
    const edit = edits[index] as Record<string, unknown>;
    const oldText = String(edit?.oldText || "");
    const newText = String(edit?.newText || "");

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
      name: "delete",
      clientCounter: nextClientCounter++,
      args: {
        startId: idAtIndex(workingCollab, firstIndex),
        endId: idAtIndex(workingCollab, firstIndex + oldText.length - 1),
        contentLength: oldText.length,
      },
    });

    if (newText.length > 0) {
      mutations.push({
        name: "insert",
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
    return {
      ok: false as const,
      errors,
      senderCounter: 0,
      idListUpdates: [] as ServerMutationMessage["idListUpdates"],
    };
  }

  note.collab = workingCollab;
  note.markdown = markdown;
  return { ok: true as const, errors: [] as string[], senderCounter, idListUpdates };
}
