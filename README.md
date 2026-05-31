<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/nielpattin/documine/main/docs/screenshot.png">
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/nielpattin/documine/main/docs/screenshot.png">
    <img alt="DocuMine — collaborative markdown editor" src="https://raw.githubusercontent.com/nielpattin/documine/main/docs/screenshot.png" width="600">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@nielpattin/documine"><img src="https://img.shields.io/npm/v/@nielpattin/documine?style=flat&label=npm" alt="npm version"></a>
  <a href="https://github.com/nielpattin/documine/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@nielpattin/documine?style=flat" alt="MIT license"></a>
  <a href="https://github.com/nielpattin/documine/actions"><img src="https://img.shields.io/github/actions/workflow/status/nielpattin/documine/publish.yml?style=flat&label=build" alt="build status"></a>
  <a href="https://github.com/nielpattin/documine"><img src="https://img.shields.io/github/last-commit/nielpattin/documine?style=flat&label=updated" alt="last commit"></a>
  <a href="https://github.com/nielpattin/documine/graphs/contributors"><img src="https://img.shields.io/github/contributors/nielpattin/documine?style=flat&label=contributors" alt="contributors"></a>
</p>

<h1 align="center">DocuMine</h1>

<p align="center">
  <strong>Self-hosted collaborative markdown editor</strong> with live PDF preview, PDF export, inline comment threads, and a dual-mode CLI for humans and AI agents.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#features">Features</a> ·
  <a href="#cli">CLI</a> ·
  <a href="#http-api">HTTP API</a> ·
  <a href="#docker">Docker</a>
</p>

---

## Quick Start

```bash
pnpm install
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173) for the editor and [http://localhost:3120](http://localhost:3120) for the API.

Prefer a global install?

```bash
pnpm add -g @nielpattin/documine
documine serve --port=3120 --data=./data
```

---

## Features

|                           |                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| ✏️ **Real-time collab**   | Multiple cursors, live sync, undo/redo — works across tabs and users                                                |
| 🔍 **Live PDF preview**   | Rendered preview pane synced to the editor, with scroll sync                                                        |
| 🖨️ **PDF export**         | Configurable Pandoc PDF export with shareable, revocable links                                                      |
| 💬 **Anchored comments**  | Select text, add a thread. Reply, resolve, reopen. Threads survive edits                                            |
| 🔗 **Share with control** | Per-note links with configurable access: view, comment, or edit                                                     |
| 🤖 **Agent-ready CLI**    | Register with an API key or share link. Search, read bounded ranges, patch, and comment from a terminal or AI agent |
| 🌓 **Dark + light**       | Theme toggle with persisted preference                                                                              |
| 📱 **Mobile**             | Responsive layout for editing on smaller screens                                                                    |
| 🐳 **Docker**             | One-command deployment with `docker-compose`                                                                        |

---

## CLI

DocuMine's CLI works in two modes. Both are accessible to humans and agents alike.

### Owner mode

Create API keys from the settings gear on the landing page. Full access to all notes.

```bash
documine register myserver https://documine.example.com <api-key>
documine myserver list
documine myserver search "query"
documine myserver read <note-id>
documine myserver read <note-id> --range=1:120
documine myserver grep <note-id> "text" --context=20 --max-matches=5
documine myserver apply <note-id> --patch change.diff --check
documine myserver apply <note-id> --patch change.diff
documine myserver create "My note"
documine myserver delete <note-id>
```

### Shared mode

Share links are the credential. No API key needed. Access level set by the owner.

```bash
documine register shared https://documine.example.com/s/abc123
documine shared read
documine shared read --range=1:120
documine shared grep "text" --context=20 --max-matches=5
documine shared comment "quoted text" "comment body" --name="My Agent"
```

---

## HTTP API

All owner endpoints use `Authorization: Bearer <api-key>`.

| Method | Endpoint                              | Description                             |
| ------ | ------------------------------------- | --------------------------------------- |
| GET    | `/api/notes?q=<query>`                | List / search notes                     |
| POST   | `/api/notes`                          | Create note                             |
| GET    | `/api/notes/:id`                      | Read note for web clients               |
| GET    | `/api/notes/:id/range`                | Read bounded note lines                 |
| GET    | `/api/notes/:id/grep`                 | Search note with bounded context        |
| PUT    | `/api/notes/:id`                      | Update title, markdown, or share access |
| DELETE | `/api/notes/:id`                      | Delete note                             |
| POST   | `/api/notes/:id/apply`                | Apply unified diff patch                |
| POST   | `/api/notes/:id/threads`              | Create comment thread                   |
| POST   | `/api/notes/:id/threads/:tid/replies` | Reply to thread                         |
| PATCH  | `/api/notes/:id/threads/:tid`         | Resolve / reopen thread                 |
| DELETE | `/api/notes/:id/threads/:tid`         | Delete thread                           |
| PATCH  | `/api/notes/:id/messages/:mid`        | Edit comment                            |
| DELETE | `/api/notes/:id/messages/:mid`        | Delete comment                          |
| GET    | `/api/keys`                           | List API keys                           |
| POST   | `/api/keys`                           | Create API key                          |
| DELETE | `/api/keys/:id`                       | Delete API key                          |

<details>
<summary><strong>Shared note endpoints</strong> (no auth, access controlled per-note)</summary>

| Method | Endpoint                               | Description                      |
| ------ | -------------------------------------- | -------------------------------- |
| GET    | `/api/share/:sid`                      | Read shared note for web clients |
| GET    | `/api/share/:sid/note`                 | Read shared note for web clients |
| GET    | `/api/share/:sid/range`                | Read bounded shared note lines   |
| GET    | `/api/share/:sid/grep`                 | Search shared note context       |
| POST   | `/api/share/:sid/threads`              | Create comment                   |
| POST   | `/api/share/:sid/threads/:tid/replies` | Reply                            |
| POST   | `/api/share/:sid/render`               | Render markdown to HTML          |

</details>

---

## Architecture

```
apps/web          → React + Vite frontend (editor, preview, comments)
src/server.ts     → Hono API server with WebSocket collab
data/             → .md files on disk + .json sidecars (source of truth)
```

Notes are stored as markdown files on disk. The `.json` sidecar holds the collaborative editing state (history, cursors, threads). Markdown files are written for convenience — grep, backup, and external tooling.

---

## Docker

```bash
cd docker
bash control.sh startdev
```

Starts the API on `http://localhost:3120` and the frontend on `http://localhost:5175`.

---

## Development

```bash
git clone https://github.com/nielpattin/documine.git
cd documine
pnpm install
pnpm dev
```

The API runs on `http://localhost:3120`. The frontend runs on `http://localhost:5175`.

---

## Data layout

```
data/
  auth.json
  notes/
    <id>.md
    <id>.json
```

---

## Contributing

Contributions are welcome. Open an issue or pull request.

---

## License

[MIT](https://github.com/nielpattin/documine/blob/main/LICENSE)
