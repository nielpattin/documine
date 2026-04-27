import assert from 'node:assert/strict';
import { test } from 'node:test';

import AdmZip from 'adm-zip';
import {
  createNotesExportZip,
  importNotesExportZip,
  type ArchiveNoteInput,
} from './note-archive.js';

function makeNote(overrides: Partial<ArchiveNoteInput> = {}): ArchiveNoteInput {
  return {
    id: 'note-a',
    title: 'Project Plan',
    markdown: 'Hello ![diagram](/assets/note-a/diagram.png) ![old](/assets/note-a/old.png)',
    threads: [
      {
        id: 'thread-a',
        resolved: false,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z',
        anchor: { quote: 'Hello', prefix: '', suffix: ' ', start: 0, end: 5 },
        messages: [
          {
            id: 'message-a',
            parentId: null,
            authorId: 'local-secret-author-id',
            authorName: 'Alice',
            body: 'Looks good',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      },
    ],
    assets: [
      { fileName: 'diagram.png', bytes: Buffer.from('png-data'), contentType: 'image/png' },
      { fileName: 'unused.png', bytes: Buffer.from('unused-data'), contentType: 'image/png' },
    ],
    ...overrides,
  };
}

test('exports selected notes as a zip with portable markdown and referenced assets only', () => {
  const zipBuffer = createNotesExportZip({ notes: [makeNote()], exportedAt: '2026-04-27T00:00:00.000Z' });
  const zip = new AdmZip(zipBuffer);
  const entries = zip.getEntries().map((entry) => entry.entryName).sort();

  assert(entries.includes('manifest.json'));
  assert(entries.includes('notes/project-plan/note.md'));
  assert(entries.includes('notes/project-plan/note.json'));
  assert(entries.includes('notes/project-plan/assets/diagram.png'));
  assert(!entries.includes('notes/project-plan/assets/unused.png'));

  const markdown = zip.readAsText('notes/project-plan/note.md');
  assert.equal(markdown, 'Hello ![diagram](assets/diagram.png) ![old](/assets/note-a/old.png)');

  const noteJson = JSON.parse(zip.readAsText('notes/project-plan/note.json'));
  assert.equal(noteJson.title, 'Project Plan');
  assert.equal(noteJson.shareId, undefined);
  assert.equal(noteJson.shareAccess, undefined);
  assert.equal(noteJson.id, undefined);
  assert.equal(noteJson.threads[0].messages[0].authorName, 'Alice');
  assert.equal(noteJson.threads[0].messages[0].authorId, undefined);
});

test('imports notes as new private notes with title suffixes, badges, assets, and regenerated comment ids', () => {
  const zipBuffer = createNotesExportZip({ notes: [makeNote()], exportedAt: '2026-04-27T00:00:00.000Z' });
  const result = importNotesExportZip({
    zipBuffer,
    existingTitles: new Set(['Project Plan']),
    now: '2026-04-27T12:00:00.000Z',
    createId: (() => {
      const ids = ['new-note', 'new-share', 'new-thread', 'new-message'];
      return () => ids.shift() || 'extra-id';
    })(),
  });

  assert.equal(result.imported.length, 1);
  const note = result.imported[0];
  assert.equal(note.id, 'new-note');
  assert.equal(note.shareId, 'new-share');
  assert.equal(note.shareAccess, 'none');
  assert.equal(note.title, 'Project Plan (imported)');
  assert.equal(note.importedAt, '2026-04-27T12:00:00.000Z');
  assert.equal(note.importOpenedAt, null);
  assert.equal(note.markdown, 'Hello ![diagram](/assets/new-note/diagram.png) ![old](/assets/note-a/old.png)');
  assert.equal(note.assets[0].fileName, 'diagram.png');
  assert.equal(note.threads[0].id, 'new-thread');
  assert.equal(note.threads[0].messages[0].id, 'new-message');
  assert.equal(note.threads[0].messages[0].authorName, 'Alice');
  assert.notEqual(note.threads[0].messages[0].id, 'message-a');
});

test('rejects unsafe zip entries before importing notes', () => {
  const zip = new AdmZip();
  zip.addFile('manifest.json', Buffer.from(JSON.stringify({ format: 'documine-notes-export', version: 1, notes: [{ folder: '../evil', title: 'Bad' }] })));
  zip.addFile('../evil/note.md', Buffer.from('bad'));

  assert.throws(() => importNotesExportZip({
    zipBuffer: zip.toBuffer(),
    existingTitles: new Set(),
    now: '2026-04-27T12:00:00.000Z',
    createId: () => 'id',
  }), /valid Documine notes export|Unsafe/);
});
