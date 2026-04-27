import path from 'node:path';
import AdmZip from 'adm-zip';

export type ArchiveCommentAnchor = {
  quote: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
};

export type ArchiveCommentMessageInput = {
  id: string;
  parentId: string | null;
  authorId?: string;
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type ArchiveCommentThreadInput = {
  id: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  anchor: ArchiveCommentAnchor;
  messages: ArchiveCommentMessageInput[];
};

export type ArchiveAssetInput = {
  fileName: string;
  bytes: Buffer;
  contentType: string;
};

export type ArchiveNoteInput = {
  id: string;
  title: string;
  markdown: string;
  threads: ArchiveCommentThreadInput[];
  assets: ArchiveAssetInput[];
};

export type ImportedArchiveMessage = {
  id: string;
  parentId: string | null;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

export type ImportedArchiveThread = {
  id: string;
  resolved: boolean;
  createdAt: string;
  updatedAt: string;
  anchor: ArchiveCommentAnchor;
  messages: ImportedArchiveMessage[];
};

export type ImportedArchiveNote = {
  id: string;
  title: string;
  shareId: string;
  shareAccess: 'none';
  createdAt: string;
  updatedAt: string;
  importedAt: string;
  importOpenedAt: string | null;
  markdown: string;
  threads: ImportedArchiveThread[];
  assets: ArchiveAssetInput[];
};

export type ImportNotesResult = {
  imported: ImportedArchiveNote[];
  skipped: Array<{ title: string; error: string }>;
  warnings: Array<{ title: string; warning: string }>;
};

type ExportedManifest = {
  format: 'documine-notes-export';
  version: 1;
  exportedAt: string;
  notes: Array<{ folder: string; title: string }>;
};

const allowedAssetExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif']);
const assetContentTypes: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};
const maxNotesPerImport = 200;
const maxUncompressedImportBytes = 250 * 1024 * 1024;

export function createNotesExportZip({ notes, exportedAt }: { notes: ArchiveNoteInput[]; exportedAt: string }): Buffer {
  const zip = new AdmZip();
  const usedFolders = new Set<string>();
  const manifest: ExportedManifest = { format: 'documine-notes-export', version: 1, exportedAt, notes: [] };

  for (const note of notes) {
    const folder = uniqueSlug(note.title, usedFolders);
    manifest.notes.push({ folder, title: note.title });
    const basePath = `notes/${folder}`;
    const portable = rewriteMarkdownForExport(note.markdown, note.id, note.assets);
    zip.addFile(`${basePath}/note.md`, Buffer.from(portable.markdown, 'utf8'));
    zip.addFile(`${basePath}/note.json`, Buffer.from(JSON.stringify({
      format: 'documine-note',
      version: 1,
      title: note.title,
      exportedAt,
      threads: note.threads.map(stripThreadForExport),
    }, null, 2), 'utf8'));
    for (const asset of note.assets) {
      if (portable.referencedAssetNames.has(asset.fileName) && isAllowedAssetName(asset.fileName)) {
        zip.addFile(`${basePath}/assets/${asset.fileName}`, asset.bytes);
      }
    }
  }

  zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  return zip.toBuffer();
}

export function importNotesExportZip({ zipBuffer, existingTitles, now, createId }: {
  zipBuffer: Buffer;
  existingTitles: Set<string>;
  now: string;
  createId: () => string;
}): ImportNotesResult {
  const zip = new AdmZip(zipBuffer);
  validateZipEntries(zip);
  const manifest = readJsonEntry<ExportedManifest>(zip, 'manifest.json');
  if (!manifest || manifest.format !== 'documine-notes-export' || manifest.version !== 1 || !Array.isArray(manifest.notes)) {
    throw new Error('This file is not a valid Documine notes export.');
  }
  if (manifest.notes.length > maxNotesPerImport) {
    throw new Error('This export is too large to import.');
  }
  for (const item of manifest.notes) {
    if (!item || typeof item.folder !== 'string' || !isSafeRelativePath(item.folder) || item.folder.includes('/')) {
      throw new Error('Unsafe note folder.');
    }
  }

  const imported: ImportedArchiveNote[] = [];
  const skipped: ImportNotesResult['skipped'] = [];
  const warnings: ImportNotesResult['warnings'] = [];
  const usedTitles = new Set(existingTitles);

  for (const item of manifest.notes) {
    const folder = typeof item.folder === 'string' ? item.folder : '';
    const title = typeof item.title === 'string' ? item.title : 'untitled';
    try {
      if (!isSafeRelativePath(folder) || folder.includes('/')) {
        throw new Error('Unsafe note folder.');
      }
      const basePath = `notes/${folder}`;
      const noteJson = readJsonEntry<any>(zip, `${basePath}/note.json`);
      const markdownEntry = zip.getEntry(`${basePath}/note.md`);
      if (!noteJson || !markdownEntry) {
        throw new Error('Missing note files.');
      }
      const noteId = createId();
      const shareId = createId();
      const finalTitle = uniqueImportedTitle(String(noteJson.title || title || 'untitled'), usedTitles);
      const assets = collectImportedAssets(zip, basePath, finalTitle, warnings);
      const markdown = rewriteMarkdownForImport(markdownEntry.getData().toString('utf8'), noteId, assets.map((asset) => asset.fileName));
      imported.push({
        id: noteId,
        title: finalTitle,
        shareId,
        shareAccess: 'none',
        createdAt: now,
        updatedAt: now,
        importedAt: now,
        importOpenedAt: null,
        markdown,
        threads: importThreads(Array.isArray(noteJson.threads) ? noteJson.threads : [], createId),
        assets,
      });
    } catch (error) {
      skipped.push({ title, error: error instanceof Error ? error.message : 'Import failed.' });
    }
  }

  if (!imported.length && skipped.length) {
    return { imported, skipped, warnings };
  }
  return { imported, skipped, warnings };
}

function rewriteMarkdownForExport(markdown: string, noteId: string, assets: ArchiveAssetInput[]) {
  const referencedAssetNames = new Set<string>();
  let nextMarkdown = markdown;
  for (const asset of assets) {
    const escaped = escapeRegExp(asset.fileName);
    const patterns = [
      new RegExp(`/assets/${escapeRegExp(noteId)}/${escaped}`, 'g'),
      new RegExp(`https?://[^\\s)"']+/assets/${escapeRegExp(noteId)}/${escaped}`, 'g'),
    ];
    let replaced = false;
    for (const pattern of patterns) {
      if (pattern.test(nextMarkdown)) {
        replaced = true;
        nextMarkdown = nextMarkdown.replace(pattern, `assets/${asset.fileName}`);
      }
    }
    if (replaced) {
      referencedAssetNames.add(asset.fileName);
    }
  }
  return { markdown: nextMarkdown, referencedAssetNames };
}

function rewriteMarkdownForImport(markdown: string, noteId: string, assetNames: string[]) {
  let nextMarkdown = markdown;
  for (const fileName of assetNames) {
    nextMarkdown = nextMarkdown.replace(new RegExp(`assets/${escapeRegExp(fileName)}`, 'g'), `/assets/${noteId}/${fileName}`);
  }
  return nextMarkdown;
}

function stripThreadForExport(thread: ArchiveCommentThreadInput) {
  return {
    id: thread.id,
    resolved: Boolean(thread.resolved),
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    anchor: thread.anchor,
    messages: (thread.messages || []).map((message) => ({
      id: message.id,
      parentId: message.parentId,
      authorName: message.authorName,
      body: message.body,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    })),
  };
}

function importThreads(threads: any[], createId: () => string): ImportedArchiveThread[] {
  return threads.map((thread) => {
    const threadId = createId();
    const messageIds = new Map<string, string>();
    const messages = Array.isArray(thread.messages) ? thread.messages : [];
    for (const message of messages) {
      messageIds.set(String(message.id || createId()), createId());
    }
    return {
      id: threadId,
      resolved: Boolean(thread.resolved),
      createdAt: typeof thread.createdAt === 'string' ? thread.createdAt : new Date(0).toISOString(),
      updatedAt: typeof thread.updatedAt === 'string' ? thread.updatedAt : new Date(0).toISOString(),
      anchor: normalizeAnchor(thread.anchor),
      messages: messages.map((message: any) => ({
        id: messageIds.get(String(message.id)) || createId(),
        parentId: message.parentId ? messageIds.get(String(message.parentId)) || null : null,
        authorId: `imported-${createId()}`,
        authorName: String(message.authorName || 'Imported commenter'),
        body: String(message.body || ''),
        createdAt: typeof message.createdAt === 'string' ? message.createdAt : new Date(0).toISOString(),
        updatedAt: typeof message.updatedAt === 'string' ? message.updatedAt : new Date(0).toISOString(),
      })),
    };
  });
}

function normalizeAnchor(anchor: any): ArchiveCommentAnchor {
  return {
    quote: String(anchor?.quote || ''),
    prefix: String(anchor?.prefix || ''),
    suffix: String(anchor?.suffix || ''),
    start: Number.isFinite(anchor?.start) ? anchor.start : 0,
    end: Number.isFinite(anchor?.end) ? anchor.end : 0,
  };
}

function collectImportedAssets(zip: AdmZip, basePath: string, title: string, warnings: ImportNotesResult['warnings']): ArchiveAssetInput[] {
  const assets: ArchiveAssetInput[] = [];
  const usedNames = new Set<string>();
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory || !entry.entryName.startsWith(`${basePath}/assets/`)) {
      continue;
    }
    const rawName = entry.entryName.slice(`${basePath}/assets/`.length);
    if (!rawName || rawName.includes('/')) {
      warnings.push({ title, warning: `Skipped unsafe asset ${rawName}.` });
      continue;
    }
    if (!isAllowedAssetName(rawName)) {
      warnings.push({ title, warning: `Skipped unsupported asset ${rawName}.` });
      continue;
    }
    const fileName = uniqueAssetName(rawName, usedNames);
    assets.push({ fileName, bytes: entry.getData(), contentType: assetContentTypes[path.extname(fileName).toLowerCase()] || 'application/octet-stream' });
  }
  return assets;
}

function validateZipEntries(zip: AdmZip) {
  let total = 0;
  for (const entry of zip.getEntries()) {
    if (!isSafeRelativePath(entry.entryName)) {
      throw new Error('Unsafe zip entry.');
    }
    total += entry.header.size;
    if (total > maxUncompressedImportBytes) {
      throw new Error('This export is too large to import.');
    }
  }
}

function readJsonEntry<T>(zip: AdmZip, entryName: string): T | null {
  const entry = zip.getEntry(entryName);
  if (!entry) return null;
  return JSON.parse(entry.getData().toString('utf8')) as T;
}

function uniqueSlug(title: string, used: Set<string>) {
  const base = slugify(title) || 'untitled';
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function uniqueImportedTitle(title: string, used: Set<string>) {
  if (!used.has(title)) {
    used.add(title);
    return title;
  }
  let candidate = `${title} (imported)`;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${title} (imported ${index})`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function uniqueAssetName(fileName: string, used: Set<string>) {
  const parsed = path.parse(path.basename(fileName));
  let candidate = `${parsed.name}${parsed.ext}`;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${parsed.name}-${index}${parsed.ext}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function isAllowedAssetName(fileName: string) {
  return allowedAssetExtensions.has(path.extname(fileName).toLowerCase());
}

function isSafeRelativePath(value: string) {
  return Boolean(value) && !value.includes('\\') && !value.startsWith('/') && !value.split('/').includes('..');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
