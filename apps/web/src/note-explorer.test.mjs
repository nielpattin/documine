import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const stylesSource = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

test('owner editor renders an in-editor note explorer for switching notes', () => {
  assert.match(appSource, /function NoteExplorer\(/);
  assert.match(appSource, /<NoteExplorer\s+[^>]*activeNoteId=\{noteId\}/s);
  assert.match(appSource, /onOpenNote=\{onOpenNote\}/);
});

test('owner editor exposes new note creation without returning to the notes list', () => {
  assert.match(appSource, /onCreateNote: \(\) => Promise<void>/);
  assert.match(appSource, /<button[^>]*onClick=\{\(\) => void onCreateNote\(\)\}[^>]*>\s*New note\s*<\/button>/s);
  assert.match(appSource, /<NoteExplorer\s+[^>]*onCreateNote=\{onCreateNote\}/s);
});

test('note explorer has dedicated responsive layout styles', () => {
  assert.match(stylesSource, /\.note-explorer\s*\{/);
  assert.match(stylesSource, /\.note-explorer-row\.active\s*\{/);
  assert.match(stylesSource, /@media \(max-width: 600px\)[\s\S]*\.note-explorer\s*\{/);
});

test('owner editor keeps the editor shell visible while a note loads', () => {
  assert.doesNotMatch(appSource, /if \(loading\) \{\s*return <LoadingPage message="Loading note" \/>;\s*\}/);
  assert.match(appSource, /const noteReady = Boolean\(payload\) && !loading;/);
  assert.match(appSource, /className="editor-loading-state"/);
  assert.match(stylesSource, /\.editor-loading-state\s*\{/);
});

test('switching notes keeps the note explorer mounted', () => {
  assert.doesNotMatch(appSource, /<OwnerNotePage\s+key=\{route\.noteId\}/s);
});
