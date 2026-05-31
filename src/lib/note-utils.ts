import fs from "node:fs";
import path from "node:path";
import type { Context } from "hono";

import type { CommentAnchor, NoteRecord, ShareAccess } from "../types/notes.js";

import { escapeMarkdownImageAlt } from "../shared.js";

import {
  shareAccessLevels,
  imageMimeExtensions,
  noteAssetsDir,
  noteExportsDir,
  maxImageUploadBytes,
} from "./config.js";
import { createId } from "../shared.js";
import { getCommenterIdentity, getViewerContext } from "./auth.js";

// ---------------------------------------------------------------------------
// Asset paths
// ---------------------------------------------------------------------------

export function noteAssetDirectory(noteId: string) {
  return path.join(noteAssetsDir, noteId);
}

export function noteExportDirectory(noteId: string) {
  return path.join(noteExportsDir, noteId);
}

export function noteAssetPath(noteId: string, fileName: string) {
  return path.join(noteAssetDirectory(noteId), fileName);
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

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

export function assetMarkdownReferencePath(noteId: string, fileName: string) {
  return `/assets/${encodeURIComponent(noteId)}/${encodeURIComponent(fileName)}`;
}

export function makeAssetUrl(c: Context, noteId: string, fileName: string) {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}${assetMarkdownReferencePath(noteId, fileName)}`;
}

export function makeShareUrl(c: Context, shareId: string) {
  const url = new URL(c.req.url);
  return `${url.protocol}//${url.host}/s/${shareId}`;
}

export function imageContentTypeFromExtension(extension: string) {
  return Object.entries(imageMimeExtensions).find(([, value]) => value === extension)?.[0] || null;
}

// ---------------------------------------------------------------------------
// Note serialization
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Share access
// ---------------------------------------------------------------------------

export function requireShareAccess(
  c: Context,
  minAccess: ShareAccess,
  store: { findByShareId(id: string): NoteRecord | undefined },
): NoteRecord | null {
  const note = store.findByShareId(c.req.param("shareId") || "");
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

// ---------------------------------------------------------------------------
// Image upload
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Comment anchors
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Locate message in threads
// ---------------------------------------------------------------------------

export function locateMessage(note: NoteRecord, messageId: string) {
  for (const thread of note.threads) {
    const message = thread.messages.find((item) => item.id === messageId);
    if (message) {
      return { thread, message };
    }
  }
  return null;
}
