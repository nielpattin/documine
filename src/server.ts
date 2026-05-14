import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer, type WebSocket } from "ws";


import type { ClientPresenceMessage } from "./collab.js";

import { registerAuthRoutes } from "./routes/auth.js";
import { registerNotesRoutes } from "./routes/notes.js";
import { registerSharedRoutes } from "./routes/shared-notes.js";
import {
  clients,
  initCollabWs,
  setupHeartbeat,
  nextClientId,
  pickColor,
  handleDisconnect,
  handleEditorMessage,
  sendServerMessage,
  buildHelloMessage,
  sendExistingPresence,
  broadcastShareParticipants,
} from "./lib/collab-ws.js";
import { initAuthPaths, isOwnerAuthenticated, isOwnerAuthenticatedIncomingRequest, getCommenterIdentityFromHeaders } from "./lib/auth.js";
import { FsNoteStore } from "./lib/note-store.js";
import { port, dataDir } from "./lib/config.js";
import { isAllowedBrowserOrigin } from "./shared.js";
import { imageContentTypeFromExtension, noteAssetPath } from "./lib/note-utils.js";
import { shareAccessLevels } from "./lib/config.js";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

initAuthPaths(dataDir);
const noteStore = new FsNoteStore(dataDir);

// ---------------------------------------------------------------------------
// Hono app
// ---------------------------------------------------------------------------

const app = new Hono();

const frontendDist = path.resolve(__dirname, "../apps/web/dist");
const frontendDistExists = fs.existsSync(frontendDist) && fs.statSync(frontendDist).isDirectory();

app.use("/api/*", async (c, next) => {
  const origin = c.req.header("origin");
  if (origin && isAllowedBrowserOrigin(origin)) {
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Access-Control-Allow-Credentials", "true");
    c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    c.header("Vary", "Origin");
  }

  if (c.req.method === "OPTIONS") {
    return c.body(null, 204);
  }

  await next();
});

app.get("/", (c) => {
  if (frontendDistExists) {
    const indexPath = path.join(frontendDist, "index.html");
    if (fs.existsSync(indexPath)) {
      return c.body(fs.readFileSync(indexPath), 200, {
        "Content-Type": "text/html",
      });
    }
  }
  return c.json({ ok: true, service: "documine-api" });
});

app.get("/health", (c) => c.text("ok"));

app.get("/assets/:noteId/:fileName", (c) => {
  const note = noteStore.getNote(c.req.param("noteId"));
  if (!note) {
    return c.text("Not found.", 404);
  }
  if (!isOwnerAuthenticated(c) && shareAccessLevels[note.shareAccess] < shareAccessLevels.view) {
    return c.text("Forbidden.", 403);
  }

  const fileName = path.basename(c.req.param("fileName"));
  const filePath = noteAssetPath(note.id, fileName);
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return c.text("Not found.", 404);
  }

  const extension = path.extname(fileName).toLowerCase();
  const contentType = imageContentTypeFromExtension(extension);
  if (!contentType) {
    return c.text("Unsupported media type.", 415);
  }

  return c.body(fs.readFileSync(filePath), 200, {
    "Content-Type": contentType,
    "Cache-Control": "private, max-age=31536000, immutable",
  });
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

registerAuthRoutes(app);
registerNotesRoutes(app, noteStore);
registerSharedRoutes(app, noteStore);

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

type ClientConn = {
  ws: WebSocket;
  kind: "editor" | "public-editor" | "public-viewer";
  noteId: string;
  shareId: string;
  clientId: string;
  name: string;
  color: string;
  alive: boolean;
  selection?: ClientPresenceMessage["selection"];
};

initCollabWs(noteStore);

const listener = getRequestListener(app.fetch);
const server = http.createServer(listener);
const wss = new WebSocketServer({ noServer: true });

setupHeartbeat(wss);

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://localhost:${port}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const url = new URL(req.url || "/", `http://localhost:${port}`);
  const noteId = url.searchParams.get("noteId") || "";
  const shareId = url.searchParams.get("shareId") || "";

  if (noteId) {
    if (!isOwnerAuthenticatedIncomingRequest(req)) {
      ws.close();
      return;
    }

    const note = noteStore.getNote(noteId);
    if (!note) {
      ws.close();
      return;
    }

    const clientId = nextClientId();
    const color = pickColor();
    const conn: ClientConn = {
      ws,
      kind: "editor",
      noteId: note.id,
      shareId: note.shareId,
      clientId,
      name: "Owner",
      color,
      alive: true,
    };
    clients.push(conn);
    sendServerMessage(ws, { ...buildHelloMessage(note), clientId });
    sendExistingPresence(conn);
    broadcastShareParticipants(note.id);

    ws.on("pong", () => {
      conn.alive = true;
    });
    ws.on("message", (data) => handleEditorMessage(conn, String(data)));
    ws.on("close", () => handleDisconnect(conn));
    ws.on("error", () => handleDisconnect(conn));
    return;
  }

  if (shareId) {
    const note = noteStore.findByShareId(shareId);
    if (!note || note.shareAccess === "none") {
      ws.close();
      return;
    }

    const commenterIdentity = getCommenterIdentityFromHeaders(req.headers);
    if (!commenterIdentity.id || !commenterIdentity.name) {
      ws.close();
      return;
    }

    if (note.shareAccess === "edit") {
      const clientId = nextClientId();
      const color = pickColor();
      const conn: ClientConn = {
        ws,
        kind: "public-editor",
        noteId: note.id,
        shareId: note.shareId,
        clientId,
        name: commenterIdentity.name,
        color,
        alive: true,
      };
      clients.push(conn);
      sendServerMessage(ws, { ...buildHelloMessage(note), clientId });
      sendExistingPresence(conn);
      broadcastShareParticipants(note.id);

      ws.on("pong", () => {
        conn.alive = true;
      });
      ws.on("message", (data) => handleEditorMessage(conn, String(data)));
      ws.on("close", () => handleDisconnect(conn));
      ws.on("error", () => handleDisconnect(conn));
      return;
    }

    const clientId = nextClientId();
    const conn: ClientConn = {
      ws,
      kind: "public-viewer",
      noteId: note.id,
      shareId: note.shareId,
      clientId,
      name: commenterIdentity.name,
      color: "",
      alive: true,
    };
    clients.push(conn);
    broadcastShareParticipants(note.id);
    ws.on("pong", () => {
      conn.alive = true;
    });
    ws.on("close", () => handleDisconnect(conn));
    ws.on("error", () => handleDisconnect(conn));
    return;
  }

  ws.close();
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(port, () => {
  console.log(`documine api listening on http://localhost:${port}`);
  console.log(`data: ${path.resolve(dataDir)}`);

});
