import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const serverSource = readFileSync(new URL('./server.ts', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../apps/web/src/App.tsx', import.meta.url), 'utf8');

test('opening a note returns markdown without rendering preview html first', () => {
  const serializerMatch = serverSource.match(/function serializeNoteForClient\([\s\S]*?\n\}/);
  assert.ok(serializerMatch, 'serializeNoteForClient should exist');
  assert.doesNotMatch(serializerMatch[0], /renderMarkdown\(note\.markdown\)/);
  assert.doesNotMatch(serializerMatch[0], /renderedHtml:/);
});

test('editor triggers markdown preview rendering after note payload loads', () => {
  assert.match(appSource, /setRenderedHtml\(nextPayload\.note\.renderedHtml \? preparePreviewHtml\(nextPayload\.note\.renderedHtml\) : ''\)/);
  assert.match(appSource, /if \(markdown === payload\.note\.markdown && payload\.note\.renderedHtml\) \{/);
});
