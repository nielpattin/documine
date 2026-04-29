import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const editorSource = readFileSync(new URL('./lib/collab-editor.ts', import.meta.url), 'utf8');

test('image upload waits for the placeholder mutation to be acknowledged before replacement', () => {
  assert.match(editorSource, /function waitForLocalMutationsSettled\(/);
  assert.match(
    editorSource,
    /replaceRangeWithText\([\s\S]*?pending\.map[\s\S]*?await waitForLocalMutationsSettled\(\)[\s\S]*?const payload = await onUploadImage\(item\.file\)[\s\S]*?replaceFirstOccurrence\(item\.placeholder, payload\.asset\.markdown\)/,
  );
});
