import { type WebSocket } from "ws";
import type { NoteRecord } from "../types/notes.js";
import type { NoteStore } from "./note-store.js";

import {
  type ClientMutationMessage,
  type ClientPresenceMessage,
  type ServerHelloMessage,
  type ServerMutationMessage,
  type ServerPresenceLeaveMessage,
  type ServerPresenceMessage,
  applyClientMutations,
  saveCollabState,
} from "../collab.js";

import { nowIso } from "../shared.js";

// ---------------------------------------------------------------------------
// Types
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

type ShareParticipantMessage = {
  type: "participants";
  participants: Array<{
    clientId: string;
    name: string;
    permissionLabel: string;
  }>;
};

type AnyServerMessage =
  | (ServerHelloMessage & { clientId?: string })
  | ServerMutationMessage
  | ServerPresenceMessage
  | ServerPresenceLeaveMessage
  | ShareParticipantMessage
  | { type: "updated"; noteId: string; shareId: string; updatedAt: string }
  | { type: "threads-updated"; noteId: string; shareId: string };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export const clients: ClientConn[] = [];
export const CURSOR_COLORS = ["#4285f4", "#ea4335", "#34a853", "#fbbc04", "#9c27b0", "#ff6d00", "#00bcd4", "#e91e63"];
export let nextColorIndex = 0;
let store: NoteStore;
export let clientIdCounter = 0;

// Allocate a new client ID for a WebSocket connection
export function nextClientId(): string {
  return `c${++clientIdCounter}`;
}

// Pick the next color from the rotation
export function pickColor(): string {
  return CURSOR_COLORS[nextColorIndex++ % CURSOR_COLORS.length];
}

export function initCollabWs(noteStore: NoteStore) {
  store = noteStore;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isCollaborativeConn(conn: ClientConn, noteId: string): boolean {
  return (conn.kind === "editor" || conn.kind === "public-editor") && conn.noteId === noteId;
}

export function sharePermissionLabel(conn: ClientConn, note: NoteRecord): string {
  if (conn.kind === "public-editor") {
    return "Edit and comment";
  }
  if (conn.kind === "public-viewer") {
    if (note.shareAccess === "comment") {
      return "View and comment";
    }
    return "View only";
  }
  return "Owner";
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

export function handleDisconnect(conn: ClientConn) {
  const index = clients.indexOf(conn);
  if (index !== -1) {
    clients.splice(index, 1);
  }
  if (conn.kind === "editor" || conn.kind === "public-editor") {
    broadcastPresenceLeave(conn);
  }
  broadcastShareParticipants(conn.noteId);
}

export function handleEditorMessage(conn: ClientConn, data: string) {
  let message: ClientMutationMessage | ClientPresenceMessage;
  try {
    message = JSON.parse(data) as ClientMutationMessage | ClientPresenceMessage;
  } catch {
    return;
  }

  if (message.type === "presence") {
    if (message.clientId !== conn.clientId) {
      return;
    }
    conn.selection = message.selection;
    broadcastPresence(conn, message);
    return;
  }

  if (
    message.type !== "mutation" ||
    !message.clientId ||
    !Array.isArray(message.mutations) ||
    message.mutations.length === 0
  ) {
    return;
  }

  if (message.clientId !== conn.clientId) {
    return;
  }

  const note = store?.getNote(conn.noteId);
  if (!note) return;

  const senderCounter = message.mutations.at(-1)?.clientCounter || 0;
  const lastAcknowledgedCounter = note.clientAcks.get(message.clientId) || 0;
  const freshMutations = message.mutations.filter((mutation) => mutation.clientCounter > lastAcknowledgedCounter);

  if (freshMutations.length === 0) {
    sendServerMessage(conn.ws, {
      type: "mutation",
      senderId: message.clientId,
      senderCounter,
      serverCounter: note.collab.serverCounter,
      markdown: note.markdown,
      idListUpdates: [],
    });
    return;
  }

  let result;
  try {
    result = applyClientMutations(note.collab, freshMutations);
  } catch (error) {
    console.error(error);
    sendServerMessage(conn.ws, { ...buildHelloMessage(note), clientId: conn.clientId });
    return;
  }
  note.clientAcks.set(message.clientId, senderCounter);

  if (!result.changed) {
    sendServerMessage(conn.ws, {
      type: "mutation",
      senderId: message.clientId,
      senderCounter,
      serverCounter: note.collab.serverCounter,
      markdown: note.markdown,
      idListUpdates: [],
    });
    return;
  }

  note.collab = result.state;
  note.markdown = result.markdown;
  note.updatedAt = nowIso();
  store?.saveNote(note);

  broadcastEditorMutation(note, {
    type: "mutation",
    senderId: message.clientId,
    senderCounter,
    serverCounter: note.collab.serverCounter,
    markdown: note.markdown,
    idListUpdates: result.idListUpdates,
  });
  broadcastNoteUpdate(note);
}

// ---------------------------------------------------------------------------
// Server message helpers
// ---------------------------------------------------------------------------

export function sendServerMessage(ws: WebSocket, message: AnyServerMessage) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(message));
  }
}

export function buildHelloMessage(note: NoteRecord): ServerHelloMessage {
  return {
    type: "hello",
    noteId: note.id,
    title: note.title,
    shareId: note.shareId,
    markdown: note.markdown,
    idListState: saveCollabState(note.collab).idListState,
    serverCounter: note.collab.serverCounter,
  };
}

export function sendExistingPresence(target: ClientConn) {
  for (const conn of clients) {
    if (conn === target || !isCollaborativeConn(conn, target.noteId) || !conn.selection) {
      continue;
    }
    sendServerMessage(target.ws, {
      type: "presence",
      clientId: conn.clientId,
      name: conn.name,
      color: conn.color,
      selection: conn.selection,
    });
  }
}

// ---------------------------------------------------------------------------
// Broadcast functions
// ---------------------------------------------------------------------------

export function broadcastEditorHello(note: NoteRecord) {
  const message = buildHelloMessage(note);
  for (const conn of clients) {
    if (isCollaborativeConn(conn, note.id)) {
      sendServerMessage(conn.ws, conn.clientId ? { ...message, clientId: conn.clientId } : message);
    }
  }
}

export function broadcastEditorMutation(note: NoteRecord, message: ServerMutationMessage) {
  for (const conn of clients) {
    if (isCollaborativeConn(conn, note.id)) {
      sendServerMessage(conn.ws, message);
    }
  }
}

export function enforceShareAccessForConnections(note: NoteRecord) {
  for (const conn of [...clients]) {
    if (conn.shareId !== note.shareId) {
      continue;
    }
    if (conn.kind === "public-editor" && note.shareAccess !== "edit") {
      try {
        conn.ws.close();
      } catch {}
      continue;
    }
    if (conn.kind === "public-viewer" && note.shareAccess === "none") {
      try {
        conn.ws.close();
      } catch {}
    }
  }
}

export function broadcastNoteUpdate(note: NoteRecord) {
  const message = {
    type: "updated" as const,
    noteId: note.id,
    shareId: note.shareId,
    updatedAt: note.updatedAt,
  };
  for (const conn of clients) {
    if (conn.kind === "public-viewer" && conn.shareId === note.shareId) {
      sendServerMessage(conn.ws, message);
    }
  }
}

export function broadcastThreadsUpdated(note: NoteRecord) {
  const message = { type: "threads-updated" as const, noteId: note.id, shareId: note.shareId };
  for (const conn of clients) {
    if (conn.noteId === note.id) {
      sendServerMessage(conn.ws, message);
    }
  }
}

export function broadcastPresence(sender: ClientConn, message: ClientPresenceMessage) {
  const outgoing: ServerPresenceMessage = {
    type: "presence",
    clientId: sender.clientId,
    name: sender.name,
    color: sender.color,
    selection: message.selection,
  };
  for (const conn of clients) {
    if (conn === sender) continue;
    if (isCollaborativeConn(conn, sender.noteId)) {
      sendServerMessage(conn.ws, outgoing);
    }
  }
}

export function broadcastPresenceLeave(sender: ClientConn) {
  const outgoing: ServerPresenceLeaveMessage = {
    type: "presence-leave",
    clientId: sender.clientId,
  };
  for (const conn of clients) {
    if (conn === sender) continue;
    if (isCollaborativeConn(conn, sender.noteId)) {
      sendServerMessage(conn.ws, outgoing);
    }
  }
}

export function closeConnectionsForNote(noteId: string) {
  for (const conn of [...clients]) {
    if (conn.noteId === noteId) {
      try {
        conn.ws.close();
      } catch {}
      handleDisconnect(conn);
    }
  }
}

export function broadcastShareParticipants(noteId: string) {
  const note = store?.getNote(noteId);
  if (!note) return;

  const participants = clients
    .filter((conn) => conn.noteId === noteId && conn.kind !== "editor")
    .map((conn) => ({
      clientId: conn.clientId,
      name: conn.name || "Guest",
      permissionLabel: sharePermissionLabel(conn, note),
    }));

  const outgoing: ShareParticipantMessage = {
    type: "participants",
    participants,
  };

  for (const conn of clients) {
    if (conn.noteId === noteId) {
      sendServerMessage(conn.ws, outgoing);
    }
  }
}

// ---------------------------------------------------------------------------
// Heartbeat
// ---------------------------------------------------------------------------

export function setupHeartbeat(wss: import("ws").WebSocketServer) {
  const heartbeatInterval = setInterval(() => {
    for (const conn of clients) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      if (conn.ws.readyState === 1) {
        conn.ws.ping();
      }
    }
  }, 30000);

  wss.on("close", () => clearInterval(heartbeatInterval));
}

export function handlePong(conn: ClientConn) {
  conn.alive = true;
}
