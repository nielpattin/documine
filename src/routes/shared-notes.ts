import { Hono } from "hono";
import type { NoteStore } from "../lib/note-store.js";
import { bodyLimit } from "hono/body-limit";

import { readJsonBody, nowIso, normalizeCommentBody, createId } from "../shared.js";
import { highlightCodeBlocksWithShiki, defaultPdfExportSettings } from "../pdf-export.js";

import { saveCollabState } from "../collab.js";

import {
  isOwnerAuthenticated,
  getOrCreateCommenterId,
  setCommenterNameCookie,
  buildViewerInfo,
  ensureCommentAuthor,
  canManageMessage,
  canManageThread,
} from "../lib/auth.js";

import { maxImageUploadBytes } from "../lib/config.js";
import {
  serializeNoteForClient,
  serializeThreads,
  makeShareUrl,
  handleImageUpload,
  sanitizeAnchor,
  locateMessage,
  requireShareAccess,
  requireSharedIdentity,
} from "../lib/note-utils.js";
import { renderMarkdown, renderPrintPreviewHtml, injectPreviewBaseHref } from "../lib/markdown.js";
import { formatMarkdownAround, formatMarkdownRange, grepMarkdown } from "../lib/note-ranges.js";

import { broadcastThreadsUpdated } from "../lib/collab-ws.js";

export function registerSharedRoutes(app: Hono, store: NoteStore) {
  app.get("/api/share/:shareId/meta", (c) => {
    const note = requireShareAccess(c, "view", store);
    if (!note) {
      return c.json({ ok: false, error: "Shared note not found." }, 404);
    }

    return c.json({
      ok: true,
      title: note.title,
      shareId: note.shareId,
      shareUrl: makeShareUrl(c, note.shareId),
      updatedAt: note.updatedAt,
    });
  });

  app.get("/api/share/:shareId", (c) => {
    const note = requireShareAccess(c, "view", store);
    if (!note) {
      return c.json({ ok: false, error: "Shared note not found." }, 404);
    }
    if (!requireSharedIdentity(c)) {
      return c.json({ ok: false, error: "Set your name first.", requiresIdentity: true }, 401);
    }

    return c.json({ ok: true, ...serializeNoteForClient(note, c) });
  });

  app.get("/api/share/:shareId/note", (c) => {
    const note = requireShareAccess(c, "view", store);
    if (!note) {
      return c.json({ ok: false, error: "Shared note not found." }, 404);
    }
    if (!requireSharedIdentity(c)) {
      return c.json({ ok: false, error: "Set your name first.", requiresIdentity: true }, 401);
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

  app.get("/api/share/:shareId/range", (c) => {
    const note = requireShareAccess(c, "view", store);
    if (!note) {
      return c.json({ ok: false, error: "Shared note not found." }, 404);
    }
    if (!requireSharedIdentity(c)) {
      return c.json({ ok: false, error: "Set your name first.", requiresIdentity: true }, 401);
    }

    const aroundLine = c.req.query("around");
    const context = Number(c.req.query("context") || "20");
    const range = aroundLine
      ? formatMarkdownAround(note.markdown, Number(aroundLine), context)
      : formatMarkdownRange(note.markdown, Number(c.req.query("start") || "1"), Number(c.req.query("end") || "1"));
    return c.json({ ok: true, note: { id: note.id, title: note.title, shareAccess: note.shareAccess, ...range } });
  });

  app.get("/api/share/:shareId/grep", (c) => {
    const note = requireShareAccess(c, "view", store);
    if (!note) {
      return c.json({ ok: false, error: "Shared note not found." }, 404);
    }
    if (!requireSharedIdentity(c)) {
      return c.json({ ok: false, error: "Set your name first.", requiresIdentity: true }, 401);
    }

    const query = c.req.query("q") || "";
    const context = Number(c.req.query("context") || "2");
    const maxMatches = Number(c.req.query("maxMatches") || "20");
    const result = grepMarkdown(note.markdown, query, context, maxMatches);
    return c.json({
      ok: true,
      note: { id: note.id, title: note.title, shareAccess: note.shareAccess, totalLines: result.totalLines },
      matches: result.matches,
      truncated: result.truncated,
    });
  });

  app.get("/api/share/:shareId/collab", (c) => {
    const note = requireShareAccess(c, "edit", store);
    if (!note) {
      return c.json({ ok: false, error: "Shared note not found." }, 404);
    }
    if (!requireSharedIdentity(c)) {
      return c.json({ ok: false, error: "Set your name first.", requiresIdentity: true }, 401);
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

  app.post("/api/share/:shareId/render", async (c) => {
    const note = requireShareAccess(c, "view", store);
    if (!note) {
      return c.json({ ok: false, error: "Shared note not found." }, 404);
    }
    if (!requireSharedIdentity(c)) {
      return c.json({ ok: false, error: "Set your name first.", requiresIdentity: true }, 401);
    }

    const body = await readJsonBody(c);
    const html = renderMarkdown(String(body.markdown || ""));
    const withShiki = await highlightCodeBlocksWithShiki(html, defaultPdfExportSettings);
    return c.json({ ok: true, html: withShiki });
  });

  app.post("/api/share/:shareId/export/html-preview", async (c) => {
    const note = requireShareAccess(c, "view", store);
    if (!note) {
      return c.json({ ok: false, error: "Shared note not found." }, 404);
    }
    if (!requireSharedIdentity(c)) {
      return c.json({ ok: false, error: "Set your name first.", requiresIdentity: true }, 401);
    }

    const body = (await readJsonBody(c)) as { markdown?: unknown; settings?: unknown };
    const markdown = typeof body.markdown === "string" ? body.markdown : note.markdown;
    const settings = body.settings === undefined ? defaultPdfExportSettings : body.settings;
    const html = await renderPrintPreviewHtml(markdown, note.title, settings);
    const baseHref = `${new URL(c.req.url).origin}/`;
    const outHtml = injectPreviewBaseHref(html, baseHref);
    return c.body(outHtml, 200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
  });

  app.post("/api/share/:shareId/identity", async (c) => {
    const note = requireShareAccess(c, "view", store);
    if (!note) {
      return c.json({ ok: false, error: "Shared note not found." }, 404);
    }

    const body = await readJsonBody(c);
    const name =
      normalizeCommentBody(String(body.name || ""))
        .trim()
        .slice(0, 100) || "";
    if (!name) {
      return c.json({ ok: false, error: "Name is required." }, 400);
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
    "/api/share/:shareId/images",
    bodyLimit({
      maxSize: maxImageUploadBytes,
      onError: (c) => c.json({ ok: false, error: "Image exceeds the 10 MB upload limit." }, 413),
    }),
    async (c) => {
      const note = requireShareAccess(c, "edit", store);
      if (!note) {
        return c.json({ ok: false, error: "Shared note not found." }, 404);
      }
      if (!requireSharedIdentity(c)) {
        return c.json({ ok: false, error: "Set your name first.", requiresIdentity: true }, 401);
      }

      return handleImageUpload(c, note);
    },
  );

  app.post("/api/share/:shareId/threads", async (c) => {
    const note = requireShareAccess(c, "comment", store);
    if (!note) {
      return c.json({ ok: false, error: "Shared note not found." }, 404);
    }
    if (!requireSharedIdentity(c)) {
      return c.json({ ok: false, error: "Set your name first.", requiresIdentity: true }, 401);
    }

    const body = await readJsonBody(c);
    const identity = ensureCommentAuthor(c, body);
    if (!identity) {
      return c.json({ ok: false, error: "Set your name first." }, 400);
    }

    const anchor = sanitizeAnchor(body.anchor);
    const commentBody = normalizeCommentBody(String(body.body || ""));
    if (!anchor || !commentBody) {
      return c.json({ ok: false, error: "Anchor and comment body are required." }, 400);
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
    store.saveNote(note);
    broadcastThreadsUpdated(note);
    return c.json({ ok: true, threads: serializeThreads(note, c) });
  });

  app.post("/api/share/:shareId/threads/:threadId/replies", async (c) => {
    const note = requireShareAccess(c, "comment", store);
    if (!note) {
      return c.json({ ok: false, error: "Shared note not found." }, 404);
    }
    if (!requireSharedIdentity(c)) {
      return c.json({ ok: false, error: "Set your name first.", requiresIdentity: true }, 401);
    }

    const thread = note.threads.find((item) => item.id === c.req.param("threadId"));
    if (!thread) {
      return c.json({ ok: false, error: "Thread not found." }, 404);
    }

    const body = await readJsonBody(c);
    const identity = ensureCommentAuthor(c, body);
    if (!identity) {
      return c.json({ ok: false, error: "Set your name first." }, 400);
    }

    const commentBody = normalizeCommentBody(String(body.body || ""));
    if (!commentBody) {
      return c.json({ ok: false, error: "Reply body is required." }, 400);
    }

    const requestedParentId = typeof body.parentMessageId === "string" ? String(body.parentMessageId) : "";
    const parentMessageId = requestedParentId || thread.messages[0]?.id || "";
    if (!parentMessageId || !thread.messages.some((message) => message.id === parentMessageId)) {
      return c.json({ ok: false, error: "Parent message not found." }, 400);
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
    store.saveNote(note);
    broadcastThreadsUpdated(note);
    return c.json({ ok: true, threads: serializeThreads(note, c) });
  });

  app.patch("/api/share/:shareId/threads/:threadId", async (c) => {
    const note = requireShareAccess(c, "comment", store);
    if (!note) {
      return c.json({ ok: false, error: "Shared note not found." }, 404);
    }
    if (!requireSharedIdentity(c)) {
      return c.json({ ok: false, error: "Set your name first.", requiresIdentity: true }, 401);
    }

    const thread = note.threads.find((item) => item.id === c.req.param("threadId"));
    if (!thread) {
      return c.json({ ok: false, error: "Thread not found." }, 404);
    }

    if (!canManageThread(c, thread)) {
      return c.json({ ok: false, error: "Not allowed." }, 403);
    }

    const body = await readJsonBody(c);
    thread.resolved = Boolean(body.resolved);
    thread.updatedAt = nowIso();
    note.updatedAt = thread.updatedAt;
    store.saveNote(note);
    broadcastThreadsUpdated(note);
    return c.json({ ok: true, threads: serializeThreads(note, c) });
  });

  app.delete("/api/share/:shareId/threads/:threadId", (c) => {
    const note = requireShareAccess(c, "comment", store);
    if (!note) {
      return c.json({ ok: false, error: "Shared note not found." }, 404);
    }
    if (!requireSharedIdentity(c)) {
      return c.json({ ok: false, error: "Set your name first.", requiresIdentity: true }, 401);
    }

    const thread = note.threads.find((item) => item.id === c.req.param("threadId"));
    if (!thread) {
      return c.json({ ok: false, error: "Thread not found." }, 404);
    }

    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Only the owner can delete a whole thread." }, 403);
    }

    note.threads = note.threads.filter((item) => item.id !== thread.id);
    note.updatedAt = nowIso();
    store.saveNote(note);
    broadcastThreadsUpdated(note);
    return c.json({ ok: true, threads: serializeThreads(note, c) });
  });

  app.patch("/api/share/:shareId/messages/:messageId", async (c) => {
    const note = requireShareAccess(c, "comment", store);
    if (!note) {
      return c.json({ ok: false, error: "Shared note not found." }, 404);
    }
    if (!requireSharedIdentity(c)) {
      return c.json({ ok: false, error: "Set your name first.", requiresIdentity: true }, 401);
    }

    const located = locateMessage(note, c.req.param("messageId"));
    if (!located) {
      return c.json({ ok: false, error: "Message not found." }, 404);
    }

    if (!canManageMessage(c, located.message)) {
      return c.json({ ok: false, error: "Not allowed." }, 403);
    }

    const body = await readJsonBody(c);
    const commentBody = normalizeCommentBody(String(body.body || ""));
    if (!commentBody) {
      return c.json({ ok: false, error: "Body is required." }, 400);
    }

    located.message.body = commentBody;
    located.message.updatedAt = nowIso();
    located.thread.updatedAt = located.message.updatedAt;
    note.updatedAt = located.message.updatedAt;
    store.saveNote(note);
    broadcastThreadsUpdated(note);
    return c.json({ ok: true, threads: serializeThreads(note, c) });
  });

  app.delete("/api/share/:shareId/messages/:messageId", (c) => {
    const note = requireShareAccess(c, "comment", store);
    if (!note) {
      return c.json({ ok: false, error: "Shared note not found." }, 404);
    }
    if (!requireSharedIdentity(c)) {
      return c.json({ ok: false, error: "Set your name first.", requiresIdentity: true }, 401);
    }

    const located = locateMessage(note, c.req.param("messageId"));
    if (!located) {
      return c.json({ ok: false, error: "Message not found." }, 404);
    }

    if (!canManageMessage(c, located.message)) {
      return c.json({ ok: false, error: "Not allowed." }, 403);
    }

    located.thread.messages = located.thread.messages.filter((message) => message.id !== located.message.id);
    if (located.thread.messages.length === 0) {
      note.threads = note.threads.filter((thread) => thread.id !== located.thread.id);
    } else {
      located.thread.updatedAt = nowIso();
    }
    note.updatedAt = nowIso();
    store.saveNote(note);
    broadcastThreadsUpdated(note);
    return c.json({ ok: true, threads: serializeThreads(note, c) });
  });
}
