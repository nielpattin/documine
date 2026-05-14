import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import fs from "node:fs";
import path from "node:path";

import {
  readJsonBody,
  nowIso,
  normalizeTitle,
  normalizeCommentBody,
  slugifyFileName,
  createShortId,
  createId,
  writeJson,
} from "../shared.js";
import { createNotesExportZip, importNotesExportZip } from "../note-archive.js";
import {
  loadPdfExportSettings,
  defaultPdfExportSettings,
  exportMarkdownToPdf,
  highlightCodeBlocksWithShiki,
} from "../pdf-export.js";
import { collabFromMarkdown, saveCollabState } from "../collab.js";
import { type NoteRecord, type ShareAccess } from "../types/notes.js";

import { isOwnerAuthenticated, getBearerToken, getApiKeyLabel } from "../lib/auth.js";

import {
  broadcastEditorHello,
  broadcastEditorMutation,
  broadcastNoteUpdate,
  broadcastThreadsUpdated,
  enforceShareAccessForConnections,
  closeConnectionsForNote,
} from "../lib/collab-ws.js";

import type { NoteStore } from "../lib/note-store.js";

import {
  activePdfPreviewControllers,
  exportSettingsFilePath,
  loadManagedNoteExportFile,
  loadManagedDebugExportFile,
  serializeNoteForClient,
  serializeThreads,
  handleImageUpload,
  sanitizeAnchor,
  applyTextEditsToNote,
  locateMessage,
  makeShareUrl,
  maxNotesImportZipBytes,
  maxImageUploadBytes,
  renderPrintPreviewHtml,
  renderMarkdown,
  injectPreviewBaseHref,
} from "../server.js";

export function registerNotesRoutes(app: Hono, store: NoteStore) {
  app.get("/api/notes", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const query = c.req.query("q") || "";
    return c.json({ ok: true, notes: store.listNotes(query) });
  });

  app.post("/api/notes", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.createNote();
    return c.json({ ok: true, note: store.summarizeNote(note, "") });
  });

  app.post("/api/notes/export", async (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const body = (await readJsonBody(c)) as { scope?: unknown; noteIds?: unknown };
    const selectedNotes = store.selectForExport(body);
    if (!selectedNotes.length) {
      return c.json({ ok: false, error: "Select at least one note to export." }, 400);
    }

    const archiveNotes = selectedNotes.map((note) => store.buildArchiveInput(note));
    const zip = createNotesExportZip({ notes: archiveNotes, exportedAt: nowIso() });
    const fileName =
      archiveNotes.length === 1
        ? `${slugifyFileName(archiveNotes[0].title) || "note"}.documine.zip`
        : `documine-notes-${new Date().toISOString().slice(0, 10)}.zip`;
    return c.body(new Uint8Array(zip), 200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    });
  });

  app.post(
    "/api/notes/import",
    bodyLimit({
      maxSize: maxNotesImportZipBytes,
      onError: (c) => c.json({ ok: false, error: "This export is too large to import." }, 413),
    }),
    async (c) => {
      if (!isOwnerAuthenticated(c)) {
        return c.json({ ok: false, error: "Unauthorized." }, 401);
      }

      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File) || !file.name.toLowerCase().endsWith(".zip")) {
        return c.json({ ok: false, error: "Choose a .zip file exported from Documine." }, 400);
      }

      let result;
      try {
        result = importNotesExportZip({
          zipBuffer: Buffer.from(await file.arrayBuffer()),
          existingTitles: new Set(Array.from(store.allNotes().values()).map((note: NoteRecord) => note.title)),
          now: nowIso(),
          createId: () => createShortId(),
        });
      } catch (error) {
        return c.json(
          {
            ok: false,
            error: error instanceof Error ? error.message : "This file is not a valid Documine notes export.",
          },
          400,
        );
      }

      for (const imported of result.imported) {
        const note: NoteRecord = {
          id: imported.id,
          title: normalizeTitle(imported.title),
          shareId: imported.shareId,
          shareAccess: "none",
          createdAt: imported.createdAt,
          updatedAt: imported.updatedAt,
          markdown: imported.markdown,
          threads: imported.threads,
          collab: collabFromMarkdown(imported.markdown),
          clientAcks: new Map(),
          importedAt: imported.importedAt,
          importOpenedAt: imported.importOpenedAt,
        };
        // note already in store
        fs.mkdirSync(store.noteAssetDirectory(note.id), { recursive: true });
        for (const asset of imported.assets) {
          store.saveAsset(note, asset.fileName, asset.bytes);
        }
        store.saveNote(note);
      }

      return c.json({
        ok: true,
        imported: result.imported.map((note) => ({ id: note.id, title: note.title, updatedAt: note.updatedAt })),
        skipped: result.skipped,
        warnings: result.warnings,
      });
    },
  );

  app.get("/api/notes/:id", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    const offsetQuery = c.req.query("offset");
    const limitQuery = c.req.query("limit");
    const offset = offsetQuery ? Number(offsetQuery) : null;
    const limit = limitQuery ? Number(limitQuery) : null;

    if (offset !== null || limit !== null) {
      const lines = note.markdown.split("\n");
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
          content: slice.map((line, index) => `${start + index + 1}: ${line}`).join("\n"),
        },
      });
    }

    if (note.importedAt && note.importOpenedAt === null) {
      note.importOpenedAt = nowIso();
      store.saveNote(note);
    }

    return c.json({ ok: true, ...serializeNoteForClient(note, c) });
  });

  app.get("/api/notes/:id/exports", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    return c.json({ ok: true, exports: store.listExports(note) });
  });

  app.get("/api/notes/:id/exports/:fileName", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    const exportFile = loadManagedNoteExportFile(note.id, c.req.param("fileName"));
    if (!exportFile) {
      return c.json({ ok: false, error: "Export not found." }, 404);
    }

    const asDownload = c.req.query("download") === "1";
    const asInline = c.req.query("inline") === "1" || !asDownload;
    const dispositionType = asInline ? "inline" : "attachment";
    return c.body(fs.readFileSync(exportFile.filePath), 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${dispositionType}; filename="${exportFile.fileName}.pdf"`,
      "Cache-Control": "no-store",
    });
  });

  app.get("/api/notes/:id/exports/:fileName/debug", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    const exportFile = loadManagedDebugExportFile(note.id, c.req.param("fileName"));
    if (!exportFile) {
      return c.json({ ok: false, error: "Export debug not found." }, 404);
    }

    return c.json({ ok: true, fileName: exportFile.fileName, ...exportFile.debug });
  });

  app.get("/api/notes/:id/exports/:fileName/debug/:kind", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    const exportFile = loadManagedDebugExportFile(note.id, c.req.param("fileName"));
    if (!exportFile) {
      return c.json({ ok: false, error: "Export debug not found." }, 404);
    }

    const kind = c.req.param("kind");
    if (kind === "html") {
      return c.body(exportFile.debug.html, 200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
    }
    if (kind === "css") {
      return c.body(exportFile.debug.css, 200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-store",
      });
    }
    if (kind === "markdown") {
      return c.body(exportFile.debug.markdown, 200, {
        "Content-Type": "text/markdown; charset=utf-8",
        "Cache-Control": "no-store",
      });
    }
    return c.json({ ok: false, error: "Unknown debug artifact." }, 404);
  });

  app.delete("/api/notes/:id/exports/:fileName", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    const exportFile = loadManagedNoteExportFile(note.id, c.req.param("fileName"));
    if (!exportFile) {
      return c.json({ ok: false, error: "Export not found." }, 404);
    }

    try {
      fs.unlinkSync(exportFile.filePath);
    } catch {}
    try {
      fs.unlinkSync(store.noteExportAssetPath(note.id, exportFile.fileName, "html"));
    } catch {}
    try {
      fs.unlinkSync(store.noteExportAssetPath(note.id, exportFile.fileName, "css"));
    } catch {}
    try {
      fs.unlinkSync(store.noteExportAssetPath(note.id, exportFile.fileName, "md"));
    } catch {}
    try {
      fs.unlinkSync(store.noteExportAssetPath(note.id, exportFile.fileName, "json"));
    } catch {}

    return c.json({ ok: true, exports: store.listExports(note) });
  });

  app.post("/api/notes/:id/exports/:fileName/share-token", async (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    const exportFile = loadManagedNoteExportFile(note.id, c.req.param("fileName"));
    if (!exportFile) {
      return c.json({ ok: false, error: "Export not found." }, 404);
    }

    const existing = store.findExportShareToken(note.id, exportFile.fileName);
    if (existing) {
      return c.json({ ok: true, token: existing, shareUrl: `/pdf/${existing}` });
    }

    const token = store.createExportShareToken(note.id, exportFile.fileName);
    return c.json({ ok: true, token, shareUrl: `/pdf/${token}` });
  });

  app.delete("/api/notes/:id/exports/:fileName/share-token", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    const exportFile = loadManagedNoteExportFile(note.id, c.req.param("fileName"));
    if (!exportFile) {
      return c.json({ ok: false, error: "Export not found." }, 404);
    }

    const existing = store.findExportShareToken(note.id, exportFile.fileName);
    if (existing) {
      store.deleteExportShareToken(existing);
    }

    return c.json({ ok: true, exports: store.listExports(note) });
  });

  app.get("/pdf/:token", (c) => {
    const token = c.req.param("token");
    const entry = store.resolveExportShareToken(token);
    if (!entry) {
      return c.json({ ok: false, error: "Link not found or revoked." }, 404);
    }

    const exportFile = loadManagedNoteExportFile(entry.noteId, entry.fileName);
    if (!exportFile) {
      store.deleteExportShareToken(token);
      return c.json({ ok: false, error: "Export no longer exists." }, 404);
    }

    const asDownload = c.req.query("download") === "1";
    const asInline = c.req.query("inline") === "1" || !asDownload;
    const dispositionType = asInline ? "inline" : "attachment";
    return c.body(fs.readFileSync(exportFile.filePath), 200, {
      "Content-Type": "application/pdf",
      "Content-Disposition": `${dispositionType}; filename="${exportFile.fileName}"`,
      "Cache-Control": "no-store",
    });
  });

  app.post("/api/notes/:id/export/html-preview", async (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    const body = (await readJsonBody(c)) as { markdown?: unknown; settings?: unknown };
    const savedSettings = await loadPdfExportSettings(exportSettingsFilePath);
    const previewKey = `${note.id}:owner-preview`;
    activePdfPreviewControllers.get(previewKey)?.abort();
    const controller = new AbortController();
    activePdfPreviewControllers.set(previewKey, controller);
    const requestStartedAt = performance.now();

    try {
      const markdown = typeof body.markdown === "string" ? body.markdown : note.markdown;
      const settings = body.settings === undefined ? savedSettings : body.settings;
      const html = await renderPrintPreviewHtml(markdown, note.title, settings);
      if (activePdfPreviewControllers.get(previewKey) === controller) {
        activePdfPreviewControllers.delete(previewKey);
      }
      const baseHref = `${new URL(c.req.url).origin}/`;
      const outHtml = injectPreviewBaseHref(html, baseHref);
      console.log(`[html-preview] note=${note.id} total=${Math.round(performance.now() - requestStartedAt)}ms`);
      return c.body(outHtml, 200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      });
    } catch (error) {
      if (activePdfPreviewControllers.get(previewKey) === controller) {
        activePdfPreviewControllers.delete(previewKey);
      }
      const message = error instanceof Error ? error.message : "Preview failed.";
      if (controller.signal.aborted) {
        console.log(
          `[html-preview] note=${note.id} cancelled after ${Math.round(performance.now() - requestStartedAt)}ms`,
        );
        return c.json({ ok: false, error: "Preview superseded by a newer request." }, 409);
      }
      console.log(
        `[html-preview] note=${note.id} failed after ${Math.round(performance.now() - requestStartedAt)}ms error=${message}`,
      );
      return c.json({ ok: false, error: message }, 500);
    }
  });

  app.post("/api/notes/:id/export/pdf", async (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    const body = (await readJsonBody(c)) as { markdown?: unknown; settings?: unknown };
    const savedSettings = await loadPdfExportSettings(exportSettingsFilePath);

    try {
      const result = await exportMarkdownToPdf({
        noteId: note.id,
        noteTitle: note.title,
        markdown: typeof body.markdown === "string" ? body.markdown : note.markdown,
        settings: body.settings === undefined ? savedSettings : body.settings,
        assetDirectory: store.noteAssetDirectory(note.id),
      });
      const finalFileName = store.buildExportFileName(note, result.fileName.replace(/\.pdf$/i, ""));
      fs.mkdirSync(store.noteExportDirectory(note.id), { recursive: true });
      store.saveExport(note, finalFileName, result.pdf);
      fs.writeFileSync(store.noteExportAssetPath(note.id, finalFileName, "html"), result.debug.html, "utf8");
      fs.writeFileSync(store.noteExportAssetPath(note.id, finalFileName, "css"), result.debug.css, "utf8");
      fs.writeFileSync(store.noteExportAssetPath(note.id, finalFileName, "md"), result.debug.markdown, "utf8");
      writeJson(store.noteExportAssetPath(note.id, finalFileName, "json"), {
        noteId: note.id,
        noteTitle: note.title,
        createdAt: nowIso(),
        settings: body.settings === undefined ? savedSettings : body.settings,
        fileName: finalFileName,
      });
      return c.json({
        ok: true,
        export: store.listExports(note).find((item) => item.fileName === finalFileName) || null,
        exports: store.listExports(note),
      });
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : "PDF export failed." }, 500);
    }
  });

  app.put("/api/notes/:id", async (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    const body = await readJsonBody(c);
    const titleProvided = Object.prototype.hasOwnProperty.call(body, "title");
    const markdownProvided = Object.prototype.hasOwnProperty.call(body, "markdown");
    const shareAccessProvided = Object.prototype.hasOwnProperty.call(body, "shareAccess");
    const nextTitle = titleProvided ? normalizeTitle(String(body.title || note.title)) : note.title;
    const nextMarkdown = markdownProvided ? String(body.markdown || "") : note.markdown;
    const nextShareAccess =
      shareAccessProvided && ["none", "view", "comment", "edit"].includes(String(body.shareAccess))
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
    store.saveNote(note);

    if (shareAccessChanged) {
      enforceShareAccessForConnections(note);
    }
    if (titleChanged || markdownChanged || shareAccessChanged) {
      broadcastEditorHello(note);
      broadcastNoteUpdate(note);
    }

    return c.json({ ok: true, savedAt: note.updatedAt, shareAccess: note.shareAccess });
  });

  app.delete("/api/notes/:id", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const noteId = c.req.param("id");
    const note = store.getNote(noteId);
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    store.deleteNote(noteId);
    closeConnectionsForNote(note.id);
    try {
      fs.unlinkSync(store.noteMarkdownPath(noteId));
    } catch {}
    try {
      fs.unlinkSync(store.noteMetaPath(noteId));
    } catch {}
    try {
      store.noteAssetDirectory(noteId);
    } catch {}
    try {
      store.noteExportDirectory(noteId);
    } catch {}
    return c.json({ ok: true });
  });

  app.post("/api/notes/:id/edit", async (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    const body = await readJsonBody(c);
    const edits = body.edits;
    if (!Array.isArray(edits) || edits.length === 0) {
      return c.json({ ok: false, error: "edits must be a non-empty array of {oldText, newText}." }, 400);
    }

    const result = applyTextEditsToNote(note, edits);
    if (!result.ok) {
      return c.json({ ok: false, errors: result.errors }, 400);
    }

    const titleProvided = Object.prototype.hasOwnProperty.call(body, "title");
    const titleChanged = titleProvided && normalizeTitle(String(body.title || note.title)) !== note.title;
    if (titleProvided) {
      note.title = normalizeTitle(String(body.title || note.title));
    }
    note.updatedAt = nowIso();
    store.saveNote(note);

    if (titleChanged) {
      broadcastEditorHello(note);
    } else if (result.idListUpdates.length > 0) {
      broadcastEditorMutation(note, {
        type: "mutation",
        senderId: "__api__",
        senderCounter: result.senderCounter,
        serverCounter: note.collab.serverCounter,
        markdown: note.markdown,
        idListUpdates: result.idListUpdates,
      });
    }
    broadcastNoteUpdate(note);
    return c.json({ ok: true, savedAt: note.updatedAt });
  });

  app.get("/api/notes/:id/assets", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    return c.json({ ok: true, assets: store.listAssets(note, new URL(c.req.url).origin) });
  });

  app.delete("/api/notes/:id/assets/:fileName", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    const fileName = path.basename(c.req.param("fileName"));
    const asset = store.listAssets(note, new URL(c.req.url).origin).find((item) => item.fileName === fileName);
    if (!asset) {
      return c.json({ ok: false, error: "Asset not found." }, 404);
    }
    if (asset.inUse) {
      return c.json({ ok: false, error: "Remove this image from the note before deleting it." }, 400);
    }

    try {
      store.deleteAsset(note, fileName);
    } catch {
      return c.json({ ok: false, error: "Failed to delete asset." }, 500);
    }

    return c.json({ ok: true, assets: store.listAssets(note, new URL(c.req.url).origin) });
  });

  app.post(
    "/api/notes/:id/images",
    bodyLimit({
      maxSize: maxImageUploadBytes,
      onError: (c) => c.json({ ok: false, error: "Image exceeds the 10 MB upload limit." }, 413),
    }),
    async (c) => {
      if (!isOwnerAuthenticated(c)) {
        return c.json({ ok: false, error: "Unauthorized." }, 401);
      }

      const note = store.getNote(c.req.param("id"));
      if (!note) {
        return c.json({ ok: false, error: "Note not found." }, 404);
      }

      return handleImageUpload(c, note);
    },
  );

  app.post("/api/notes/:id/threads", async (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    const body = await readJsonBody(c);
    const commentBody = normalizeCommentBody(String(body.body || ""));
    let anchor = sanitizeAnchor(body.anchor);

    if (!anchor) {
      const quote = String(body.quote || "");
      if (!quote || !commentBody) {
        return c.json({ ok: false, error: "quote and body are required." }, 400);
      }

      const start = note.markdown.indexOf(quote);
      if (start === -1) {
        return c.json({ ok: false, error: "Quoted text not found in note." }, 400);
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
      return c.json({ ok: false, error: "quote and body are required." }, 400);
    }

    const bearer = getBearerToken(c);
    const apiKeyLabel = bearer ? getApiKeyLabel(bearer) : null;
    const authorName = apiKeyLabel || "Owner";
    const timestamp = nowIso();

    const thread = {
      id: createId(10),
      resolved: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      anchor,
      messages: [
        {
          id: createId(10),
          parentId: null,
          authorId: "__owner__",
          authorName,
          body: commentBody,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    };

    note.threads.push(thread);
    note.updatedAt = timestamp;
    store.saveNote(note);
    broadcastThreadsUpdated(note);
    return c.json({ ok: true, threads: serializeThreads(note, c) });
  });

  app.post("/api/notes/:id/threads/:threadId/replies", async (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    const thread = note.threads.find((item) => item.id === c.req.param("threadId"));
    if (!thread) {
      return c.json({ ok: false, error: "Thread not found." }, 404);
    }

    const body = await readJsonBody(c);
    const commentBody = normalizeCommentBody(String(body.body || ""));
    const parentMessageId = String(body.parentMessageId || thread.messages[0]?.id || "");
    if (!commentBody) {
      return c.json({ ok: false, error: "body is required." }, 400);
    }
    if (!thread.messages.some((message) => message.id === parentMessageId)) {
      return c.json({ ok: false, error: "Parent message not found." }, 400);
    }

    const bearer = getBearerToken(c);
    const apiKeyLabel = bearer ? getApiKeyLabel(bearer) : null;
    const authorName = apiKeyLabel || "Owner";
    const timestamp = nowIso();

    thread.messages.push({
      id: createId(10),
      parentId: parentMessageId,
      authorId: "__owner__",
      authorName,
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

  app.patch("/api/notes/:id/threads/:threadId", async (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    const thread = note.threads.find((item) => item.id === c.req.param("threadId"));
    if (!thread) {
      return c.json({ ok: false, error: "Thread not found." }, 404);
    }

    const body = await readJsonBody(c);
    thread.resolved = Boolean(body.resolved);
    thread.updatedAt = nowIso();
    note.updatedAt = thread.updatedAt;
    store.saveNote(note);
    broadcastThreadsUpdated(note);
    return c.json({ ok: true, threads: serializeThreads(note, c) });
  });

  app.delete("/api/notes/:id/threads/:threadId", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    note.threads = note.threads.filter((item) => item.id !== c.req.param("threadId"));
    note.updatedAt = nowIso();
    store.saveNote(note);
    broadcastThreadsUpdated(note);
    return c.json({ ok: true, threads: serializeThreads(note, c) });
  });

  app.patch("/api/notes/:id/messages/:messageId", async (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    const located = locateMessage(note, c.req.param("messageId"));
    if (!located) {
      return c.json({ ok: false, error: "Message not found." }, 404);
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

  app.delete("/api/notes/:id/messages/:messageId", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
    }

    const located = locateMessage(note, c.req.param("messageId"));
    if (!located) {
      return c.json({ ok: false, error: "Message not found." }, 404);
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

  app.get("/api/notes/:id/collab", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const note = store.getNote(c.req.param("id"));
    if (!note) {
      return c.json({ ok: false, error: "Note not found." }, 404);
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

  app.post("/api/render", async (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const body = await readJsonBody(c);
    const html = renderMarkdown(String(body.markdown || ""));
    const withShiki = await highlightCodeBlocksWithShiki(html, defaultPdfExportSettings);
    return c.json({ ok: true, html: withShiki });
  });
}
