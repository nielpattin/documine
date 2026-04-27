import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';

const cliPath = path.resolve('cli/documine.mjs');

function runCli(args, home) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: path.resolve('.'),
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`CLI timed out\nstdout=${stdout}\nstderr=${stderr}`));
    }, 5000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (status, signal) => {
      clearTimeout(timeout);
      resolve({ status, signal, stdout, stderr });
    });
  });
}

test('upload-image posts an image file and prints markdown', async () => {
  let requestHeaders = null;
  let requestBody = Buffer.alloc(0);

  const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/notes/note-1/images') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }

    requestHeaders = req.headers;
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      requestBody = Buffer.concat(chunks);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, asset: { markdown: '![diagram](http://127.0.0.1/assets/note-1/image.png)' } }));
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'documine-cli-test-'));
    const configDir = path.join(home, '.config', 'documine');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'settings.json'),
      JSON.stringify({ instances: [{ name: 'local', baseUrl, token: 'owner-token' }] }),
      'utf8',
    );

    const imagePath = path.join(home, 'diagram.png');
    fs.writeFileSync(imagePath, Buffer.from('png-bytes'));

    const result = await runCli(['local', 'upload-image', 'note-1', imagePath], home);

    assert.equal(result.status, 0, `signal=${result.signal}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.equal(result.stdout.trim(), '![diagram](http://127.0.0.1/assets/note-1/image.png)');
    assert.equal(requestHeaders.authorization, 'Bearer owner-token');
    assert.match(requestHeaders['content-type'], /^multipart\/form-data; boundary=/);
    assert.match(requestBody.toString('latin1'), /name="file"/);
    assert.match(requestBody.toString('latin1'), /filename="diagram\.png"/);
    assert.match(requestBody.toString('latin1'), /png-bytes/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
