import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { readJson, writeJson, nowIso, createShortId, createId } from "../shared.js";
import { collabFromMarkdown, collabToMarkdown, saveCollabState, loadCollabState } from "../collab.js";
import type {
  NoteRecord,
  NoteMetaFile,
  NoteSummary,
  NoteAssetSummary,
  NotePdfExportSummary,
  ShareAccess,
} from "../types/notes.js";
import type { ArchiveNoteInput } from "../note-archive.js";

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface NoteStore {
  /** List all note summaries, optionally filtered by query */
  listNotes(query: string): NoteSummary[];

  /** Get a full note record by ID */
  getNote(id: string): NoteRecord | undefined;

  /** Create a new note with an optional title */
  createNote(title?: string): NoteRecord;

  /** Save (persist) a note to storage */
  saveNote(note: NoteRecord): void;

  /** Delete a note and all associated files */
  deleteNote(id: string): void;

  /** Summarize a note for list display */
  summarizeNote(note: NoteRecord, needle: string): NoteSummary;

  /** Count all stored notes */
  count(): number;

  /** Get all note titles (used for import deduplication) */
  existingTitles(): Set<string>;

  /** Get all note records as an iterable */
  allNotes(): Map<string, NoteRecord>;

  /** Select notes matching export criteria */
  selectForExport(body: { scope?: unknown; noteIds?: unknown }): NoteRecord[];

  /** Build archive input for a note export */
  buildArchiveInput(note: NoteRecord): ArchiveNoteInput;

  /** Find a note by its shareId */
  findByShareId(shareId: string): NoteRecord | undefined;

  // Path helpers
  noteMarkdownPath(id: string): string;
  noteMetaPath(id: string): string;
  noteAssetDirectory(id: string): string;
  noteExportDirectory(id: string): string;
  noteExportPath(id: string, fileName: string): string;
  noteExportAssetPath(id: string, fileName: string, suffix: string): string;
  noteAssetPath(id: string, fileName: string): string;

  // Asset helpers
  listAssets(note: NoteRecord, baseUrl: string): NoteAssetSummary[];
  deleteAsset(note: NoteRecord, fileName: string): boolean;
  saveAsset(note: NoteRecord, fileName: string, buffer: Buffer): void;
  assetExists(noteId: string, fileName: string): boolean;
  checkAssetInUse(note: NoteRecord, fileName: string): boolean;

  // Export helpers
  listExports(note: NoteRecord): NotePdfExportSummary[];
  saveExport(note: NoteRecord, fileName: string, pdf: Buffer): void;
  saveExportArtifact(note: NoteRecord, baseFileName: string, suffix: string, content: string): void;
  loadExport(note: NoteRecord, fileName: string): Buffer | null;
  buildExportFileName(note: NoteRecord, baseName: string): string;

  // Share tokens
  createExportShareToken(noteId: string, fileName: string): string;
  findExportShareToken(noteId: string, fileName: string): string | null;
  deleteExportShareToken(token: string): void;
  resolveExportShareToken(token: string): { noteId: string; fileName: string; createdAt: string } | null;
}

// ---------------------------------------------------------------------------
// Filesystem implementation
// ---------------------------------------------------------------------------

const NOTE_LIST_SNIPPET_SOURCE_LIMIT = 1000;
const imageMimeExtensions: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
};

export class FsNoteStore implements NoteStore {
  readonly dataDir: string;
  readonly notesDir: string;
  readonly assetsDir: string;
  readonly exportsDir: string;
  private notes = new Map<string, NoteRecord>();
  private exportShareTokens = new Map<string, { noteId: string; fileName: string; createdAt: string }>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.notesDir = path.join(dataDir, "notes");
    this.assetsDir = path.join(dataDir, "assets");
    this.exportsDir = path.join(dataDir, "exports");
    this.ensureDirectories();
    this.loadNotes();
    this.loadExportShareTokens();
  }

  // ---- Note CRUD ----

  listNotes(query: string): NoteSummary[] {
    if (!query) {
      return Array.from(this.notes.values(), (n) => this.summarizeNote(n, ""));
    }
    const needle = query.toLowerCase();
    const results: NoteSummary[] = [];
    for (const note of this.notes.values()) {
      const title = note.title.toLowerCase();
      const markdown = note.markdown.toLowerCase();
      if (title.includes(needle) || markdown.includes(needle)) {
        results.push(this.summarizeNote(note, needle));
      }
    }
    return results;
  }

  getNote(id: string): NoteRecord | undefined {
    return this.notes.get(id);
  }

  createNote(title?: string): NoteRecord {
    const note: NoteRecord = {
      id: createId(),
      title: title || "untitled",
      shareId: createShortId(),
      shareAccess: "none" as ShareAccess,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      markdown: "",
      threads: [],
      collab: collabFromMarkdown(""),
      clientAcks: new Map(),
    };
    this.notes.set(note.id, note);
    fs.mkdirSync(this.noteAssetDirectory(note.id), { recursive: true });
    this.saveNote(note);
    return note;
  }

  saveNote(note: NoteRecord): void {
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
    writeJson(this.noteMetaPath(note.id), meta);
    fs.writeFileSync(this.noteMarkdownPath(note.id), note.markdown, "utf8");
  }

  deleteNote(id: string): void {
    this.notes.delete(id);
    try {
      fs.unlinkSync(this.noteMarkdownPath(id));
    } catch {}
    try {
      fs.unlinkSync(this.noteMetaPath(id));
    } catch {}
    try {
      fs.rmSync(this.noteAssetDirectory(id), { recursive: true, force: true });
    } catch {}
    try {
      fs.rmSync(this.noteExportDirectory(id), { recursive: true, force: true });
    } catch {}
  }

  summarizeNote(note: NoteRecord, needle: string): NoteSummary {
    const snippet = this.buildSnippet(note, needle);
    return {
      id: note.id,
      title: note.title,
      updatedAt: note.updatedAt,
      shareId: note.shareId,
      snippet,
      isImportedUnread: Boolean(note.importedAt && note.importOpenedAt === null),
    };
  }

  count(): number {
    return this.notes.size;
  }

  existingTitles(): Set<string> {
    return new Set(Array.from(this.notes.values(), (n) => n.title));
  }

  allNotes(): Map<string, NoteRecord> {
    return this.notes;
  }

  findByShareId(shareId: string): NoteRecord | undefined {
    for (const note of this.notes.values()) {
      if (note.shareId === shareId) return note;
    }
    return undefined;
  }

  selectForExport(body: { scope?: unknown; noteIds?: unknown }): NoteRecord[] {
    if (body.scope === "all") return Array.from(this.notes.values());
    if (body.scope !== "selected" || !Array.isArray(body.noteIds)) return [];
    const selected: NoteRecord[] = [];
    for (const id of body.noteIds) {
      if (typeof id !== "string") continue;
      const note = this.notes.get(id);
      if (note) selected.push(note);
    }
    return selected;
  }

  buildArchiveInput(note: NoteRecord): ArchiveNoteInput {
    note.markdown = collabToMarkdown(note.collab);
    return {
      id: note.id,
      title: note.title,
      markdown: note.markdown,
      threads: note.threads,
      assets: this.collectArchiveAssets(note),
    };
  }

  // ---- Path helpers ----

  noteMarkdownPath(id: string): string {
    return path.join(this.notesDir, id, "note.md");
  }

  noteMetaPath(id: string): string {
    return path.join(this.notesDir, id, "meta.json");
  }

  noteAssetDirectory(id: string): string {
    return path.join(this.assetsDir, id);
  }

  noteExportDirectory(id: string): string {
    return path.join(this.exportsDir, id);
  }

  noteExportPath(id: string, fileName: string): string {
    return path.join(this.noteExportDirectory(id), `${fileName}.pdf`);
  }

  noteExportAssetPath(id: string, fileName: string, suffix: string): string {
    return path.join(this.noteExportDirectory(id), `${fileName}.${suffix.replace(/^\./, "")}`);
  }

  noteAssetPath(id: string, fileName: string): string {
    return path.join(this.noteAssetDirectory(id), fileName);
  }

  // ---- Asset helpers ----

  listAssets(note: NoteRecord, baseUrl: string): NoteAssetSummary[] {
    const assetDir = this.noteAssetDirectory(note.id);
    if (!fs.existsSync(assetDir)) return [];

    const assets: NoteAssetSummary[] = [];
    for (const entry of fs.readdirSync(assetDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const filePath = path.join(assetDir, entry.name);
      const stat = fs.statSync(filePath);
      const inUse = this.checkAssetInUse(note, entry.name);
      assets.push({
        fileName: entry.name,
        url: `${baseUrl}/assets/${note.id}/${entry.name}`,
        markdown: `[${entry.name}](${baseUrl}/assets/${note.id}/${entry.name})`,
        inUse,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
      });
    }
    return assets;
  }

  deleteAsset(note: NoteRecord, fileName: string): boolean {
    const assetPath = this.noteAssetPath(note.id, fileName);
    if (!fs.existsSync(assetPath)) return false;
    try {
      fs.unlinkSync(assetPath);
      return true;
    } catch {
      return false;
    }
  }

  saveAsset(note: NoteRecord, fileName: string, buffer: Buffer): void {
    fs.mkdirSync(this.noteAssetDirectory(note.id), { recursive: true });
    fs.writeFileSync(this.noteAssetPath(note.id, fileName), buffer);
  }

  assetExists(noteId: string, fileName: string): boolean {
    return fs.existsSync(this.noteAssetPath(noteId, fileName));
  }

  checkAssetInUse(note: NoteRecord, fileName: string): boolean {
    return note.markdown.includes(`/assets/${note.id}/${fileName}`);
  }

  // ---- Export helpers ----

  listExports(note: NoteRecord): NotePdfExportSummary[] {
    const exportDir = this.noteExportDirectory(note.id);
    if (!fs.existsSync(exportDir)) return [];

    const exports: NotePdfExportSummary[] = [];
    for (const entry of fs.readdirSync(exportDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".pdf")) continue;
      const fileName = entry.name.replace(/\.pdf$/, "");
      const exportPath = path.join(exportDir, entry.name);
      const stat = fs.statSync(exportPath);
      const token = this.findExportShareToken(note.id, fileName);

      exports.push({
        fileName,
        url: `/api/notes/${note.id}/exports/${fileName}`,
        downloadUrl: `/api/notes/${note.id}/exports/${fileName}?download=1`,
        debugUrl: `/api/notes/${note.id}/exports/${fileName}/debug`,
        debugHtmlUrl: `/api/notes/${note.id}/exports/${fileName}/debug/html`,
        debugCssUrl: `/api/notes/${note.id}/exports/${fileName}/debug/css`,
        debugMarkdownUrl: `/api/notes/${note.id}/exports/${fileName}/debug/markdown`,
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
        shareToken: token,
        shareUrl: token ? `/pdf/${token}` : null,
      });
    }
    return exports;
  }

  saveExport(note: NoteRecord, fileName: string, pdf: Buffer): void {
    fs.mkdirSync(this.noteExportDirectory(note.id), { recursive: true });
    fs.writeFileSync(this.noteExportPath(note.id, fileName), pdf);
  }

  saveExportArtifact(note: NoteRecord, baseFileName: string, suffix: string, content: string): void {
    fs.mkdirSync(this.noteExportDirectory(note.id), { recursive: true });
    fs.writeFileSync(this.noteExportAssetPath(note.id, baseFileName, suffix), content, "utf8");
  }

  loadExport(note: NoteRecord, fileName: string): Buffer | null {
    const exportPath = this.noteExportPath(note.id, fileName);
    if (!fs.existsSync(exportPath)) return null;
    return fs.readFileSync(exportPath);
  }

  buildExportFileName(note: NoteRecord, baseName: string): string {
    const existing = new Set<string>();
    for (const entry of fs.readdirSync(this.noteExportDirectory(note.id), { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".pdf")) {
        existing.add(entry.name.replace(/\.pdf$/, ""));
      }
    }

    let candidate = baseName;
    let index = 2;
    while (existing.has(candidate)) {
      candidate = `${baseName}-${index}`;
      index++;
    }
    return candidate;
  }

  // ---- Share tokens ----

  createExportShareToken(noteId: string, fileName: string): string {
    const token = crypto.randomUUID();
    this.exportShareTokens.set(token, { noteId, fileName, createdAt: nowIso() });
    this.saveExportShareTokens();
    return token;
  }

  findExportShareToken(noteId: string, fileName: string): string | null {
    for (const [token, entry] of this.exportShareTokens) {
      if (entry.noteId === noteId && entry.fileName === fileName) {
        return token;
      }
    }
    return null;
  }

  deleteExportShareToken(token: string): void {
    this.exportShareTokens.delete(token);
    this.saveExportShareTokens();
  }

  resolveExportShareToken(token: string): { noteId: string; fileName: string; createdAt: string } | null {
    const entry = this.exportShareTokens.get(token);
    return entry ? { ...entry } : null;
  }

  // ---- Internal helpers ----

  private collectArchiveAssets(note: NoteRecord): ArchiveNoteInput["assets"] {
    const directory = this.noteAssetDirectory(note.id);
    if (!fs.existsSync(directory)) return [];
    return fs.readdirSync(directory).flatMap((fileName) => {
      const filePath = this.noteAssetPath(note.id, fileName);
      if (!fs.statSync(filePath).isFile()) return [];
      const ext = path.extname(fileName).toLowerCase();
      const contentType = imageMimeExtensions[ext] || "application/octet-stream";
      return [{ fileName, bytes: fs.readFileSync(filePath), contentType }];
    });
  }

  private buildSnippet(note: NoteRecord, needle: string): string {
    const text = note.markdown.slice(0, NOTE_LIST_SNIPPET_SOURCE_LIMIT).replace(/\s+/g, " ").trim();
    if (!needle) return text.slice(0, 120);
    const idx = text.toLowerCase().indexOf(needle);
    if (idx === -1) return text.slice(0, 120);
    const start = Math.max(0, idx - 40);
    return (start > 0 ? "..." : "") + text.slice(start, start + 160);
  }

  private ensureDirectories() {
    fs.mkdirSync(this.notesDir, { recursive: true });
    fs.mkdirSync(this.assetsDir, { recursive: true });
    fs.mkdirSync(this.exportsDir, { recursive: true });
  }

  private noteRecordFromMeta(meta: NoteMetaFile, markdown: string): NoteRecord {
    return {
      id: meta.id,
      title: meta.title,
      shareId: meta.shareId,
      shareAccess: meta.shareAccess,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
      threads: meta.threads || [],
      markdown,
      collab:
        meta.collab || meta.collabState
          ? loadCollabState(meta.collab || meta.collabState!)
          : collabFromMarkdown(markdown),
      clientAcks: new Map(),
      importedAt: meta.importedAt,
      importOpenedAt: meta.importOpenedAt,
    };
  }

  private loadNotes() {
    if (!fs.existsSync(this.notesDir)) return;

    const loadedIds = new Set<string>();

    // Load notes from subdirectories (noteId/meta.json + noteId/note.md)
    for (const entry of fs.readdirSync(this.notesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      const meta = readJson<NoteMetaFile | null>(this.noteMetaPath(id), null);
      if (!meta || !meta.id) continue;
      loadedIds.add(id);

      const markdown = fs.existsSync(this.noteMarkdownPath(id))
        ? fs.readFileSync(this.noteMarkdownPath(id), "utf8")
        : "";

      const note = this.noteRecordFromMeta(meta, markdown);
      this.notes.set(note.id, note);
    }

    // Load notes from flat files (noteId.md + noteId.json in notesDir root)
    for (const entry of fs.readdirSync(this.notesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const id = path.basename(entry.name, ".md");
      if (loadedIds.has(id)) continue;
      const metaPath = path.join(this.notesDir, `${id}.json`);
      const meta = readJson<NoteMetaFile | null>(metaPath, null);
      if (!meta || !meta.id) continue;

      const markdown = fs.readFileSync(path.join(this.notesDir, entry.name), "utf8");

      const note = this.noteRecordFromMeta(meta, markdown);
      this.notes.set(note.id, note);
    }
  }

  private loadExportShareTokens() {
    const tokensPath = path.join(this.dataDir, "export-share-tokens.json");
    const data = readJson<Record<string, { noteId: string; fileName: string; createdAt: string }>>(tokensPath, {});
    for (const [token, entry] of Object.entries(data)) {
      if (entry && typeof entry.noteId === "string" && typeof entry.fileName === "string") {
        this.exportShareTokens.set(token, entry);
      }
    }
  }

  private saveExportShareTokens() {
    const tokensPath = path.join(this.dataDir, "export-share-tokens.json");
    const data: Record<string, { noteId: string; fileName: string; createdAt: string }> = {};
    for (const [token, entry] of this.exportShareTokens) {
      data[token] = entry;
    }
    writeJson(tokensPath, data);
  }
}
