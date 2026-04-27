#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const configDir = path.join(os.homedir(), ".config", "documine");
const configPath = path.join(configDir, "settings.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return { instances: [] };
  }
}

function saveConfig(config) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
}

function getInstance(name) {
  const config = loadConfig();
  const instance = config.instances.find((i) => i.name === name);
  if (!instance) {
    console.error(`Unknown instance: ${name}`);
    console.error(`Run: documine register <name> <baseUrl> <token>`);
    process.exit(1);
  }
  return instance;
}

async function request(instance, method, endpoint, body) {
  const url = `${instance.baseUrl.replace(/\/$/, "")}${endpoint}`;
  const options = {
    method,
    headers: {},
  };

  if (instance.token) {
    options.headers.Authorization = `Bearer ${instance.token}`;
  }

  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const payload = await response.json();

  if (!response.ok) {
    console.error(`Error ${response.status}: ${payload.error || payload.errors?.join(", ") || "Request failed"}`);
    process.exit(1);
  }

  return payload;
}

function getCreatedThreadId(payload) {
  const threadId = payload?.thread?.id;
  if (typeof threadId === "string" && threadId) {
    return threadId;
  }

  if (Array.isArray(payload?.threads) && payload.threads.length > 0) {
    const lastThreadId = payload.threads[payload.threads.length - 1]?.id;
    if (typeof lastThreadId === "string" && lastThreadId) {
      return lastThreadId;
    }
  }

  throw new Error("Comment succeeded but thread id was missing from the API response.");
}

function printAuthGuardStatus(payload) {
  const guard = payload.authGuard;
  console.log(`loginEnabled\t${guard.loginEnabled ? "yes" : "no"}`);
  console.log(`globalLock\t${guard.globalLockActive ? "active" : "inactive"}`);
  if (guard.globalLockAt) {
    console.log(`globalLockAt\t${guard.globalLockAt}`);
  }
  if (guard.globalLockReason) {
    console.log(`globalLockReason\t${guard.globalLockReason}`);
  }
  console.log(`recentLoginRequests\t${guard.recentLoginRequestCount}`);
  console.log(`activeIpBans\t${guard.bannedIpCount}`);
}

function isShareInstance(instance) {
  return Boolean(instance.shareId && !instance.token);
}

function imageContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".png") return "image/png";
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".gif") return "image/gif";
  if (extension === ".webp") return "image/webp";
  if (extension === ".avif") return "image/avif";
  return null;
}

async function uploadImage(instance, endpoint, filePath) {
  const contentType = imageContentType(filePath);
  if (!contentType) {
    console.error("Only PNG, JPEG, GIF, WebP, and AVIF images are supported.");
    process.exit(1);
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    console.error(`Image file not found: ${filePath}`);
    process.exit(1);
  }

  const boundary = `----documine-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const fileName = path.basename(filePath);
  const fileBytes = fs.readFileSync(filePath);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName.replace(/"/g, "")}"\r\nContent-Type: ${contentType}\r\n\r\n`, "utf8"),
    fileBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"),
  ]);

  const url = `${instance.baseUrl.replace(/\/$/, "")}${endpoint}`;
  const headers = { "Content-Type": `multipart/form-data; boundary=${boundary}` };
  if (instance.token) {
    headers.Authorization = `Bearer ${instance.token}`;
  }

  const response = await fetch(url, { method: "POST", headers, body });
  const payload = await response.json();
  if (!response.ok) {
    console.error(`Error ${response.status}: ${payload.error || payload.errors?.join(", ") || "Request failed"}`);
    process.exit(1);
  }
  return payload;
}

const args = process.argv.slice(2);
const command = args[0];

if (!command || command === "--help" || command === "-h" || command === "help") {
  printUsage();
  process.exit(0);
}

if (command === "serve") {
  const portArg = args.find((a) => a.startsWith("--port="));
  const dataArg = args.find((a) => a.startsWith("--data="));
  const cliDir = path.dirname(new URL(import.meta.url).pathname);
  const serverPath = path.join(cliDir, "..", "dist", "server.js");
  if (!fs.existsSync(serverPath)) {
    console.error(`Server not found at ${serverPath}. Run 'npm run build' first.`);
    process.exit(1);
  }
  const serverArgs = [serverPath];
  if (portArg) serverArgs.push(portArg);
  if (dataArg) serverArgs.push(dataArg);
  const { execFileSync } = await import("node:child_process");
  try {
    execFileSync(process.execPath, serverArgs, { stdio: "inherit" });
  } catch (e) {
    process.exit(e.status || 1);
  }
  process.exit(0);
}

if (command === "register") {
  const [, name, urlOrBase, token] = args;
  if (!name || !urlOrBase) {
    console.error("Usage: documine register <name> <baseUrl> <token>");
    console.error("       documine register <name> <shareUrl>");
    process.exit(1);
  }

  const config = loadConfig();
  config.instances = config.instances.filter((i) => i.name !== name);

  const shareMatch = urlOrBase.match(/^(https?:\/\/.+)\/s\/([a-z0-9]+)$/i);
  if (shareMatch) {
    config.instances.push({ name, baseUrl: shareMatch[1], shareId: shareMatch[2] });
    saveConfig(config);
    console.log(`Registered shared instance "${name}" at ${shareMatch[1]}`);
  } else {
    if (!token) {
      console.error("Usage: documine register <name> <baseUrl> <token>");
      process.exit(1);
    }
    config.instances.push({ name, baseUrl: urlOrBase, token });
    saveConfig(config);
    console.log(`Registered instance "${name}" at ${urlOrBase}`);
  }
  process.exit(0);
}

if (command === "unregister") {
  const name = args[1];
  if (!name) {
    console.error("Usage: documine unregister <name>");
    process.exit(1);
  }

  const config = loadConfig();
  const before = config.instances.length;
  config.instances = config.instances.filter((i) => i.name !== name);
  if (config.instances.length === before) {
    console.error(`Instance "${name}" not found.`);
    process.exit(1);
  }

  saveConfig(config);
  console.log(`Unregistered instance "${name}".`);
  process.exit(0);
}

if (command === "instances") {
  const config = loadConfig();
  if (config.instances.length === 0) {
    console.log("No registered instances.");
  } else {
    for (const instance of config.instances) {
      console.log(`${instance.name}  ${instance.baseUrl}`);
    }
  }
  process.exit(0);
}

const instanceName = command;
const subCommand = args[1];

if (!subCommand) {
  console.error(`Usage: documine <instance> <command> [args...]`);
  console.error(`Commands: list, search, read, create, edit, delete, update, upload-image, auth-status, login-enable, login-disable, login-bans, login-unban`);
  process.exit(1);
}

const instance = getInstance(instanceName);

if (isShareInstance(instance)) {
  const sid = instance.shareId;
  const plainArgs = args.filter((a) => !a.startsWith("--"));
  const nameArg = args.find((a) => a.startsWith("--name="));
  const agentName = nameArg ? nameArg.split("=").slice(1).join("=") : "Agent";

  switch (subCommand) {
    case "read": {
      const payload = await request(instance, "GET", `/api/share/${sid}/note`);
      const note = payload.note;
      console.log(`# ${note.title}`);
      console.log(`# id: ${note.id}`);
      console.log(`# updated: ${note.updatedAt}`);
      console.log(`# access: ${note.shareAccess}`);
      console.log();
      console.log(note.markdown);

      if (payload.threads && payload.threads.length > 0) {
        console.log();
        console.log("--- Comments ---");
        for (const thread of payload.threads) {
          const anchor = thread.anchor?.quote ? `"${thread.anchor.quote.slice(0, 60)}"` : "(no anchor)";
          console.log();
          console.log(`Thread ${thread.id} on ${anchor}${thread.resolved ? " [resolved]" : ""}`);
          for (const msg of thread.messages) {
            console.log(`  [${msg.id}] ${msg.authorName} (${msg.updatedAt}): ${msg.body}`);
          }
        }
      }
      break;
    }

    case "edit": {
      const editsJson = plainArgs[2];
      if (!editsJson) {
        console.error("Usage: documine <instance> edit '<json edits>'");
        process.exit(1);
      }
      let edits;
      try { edits = JSON.parse(editsJson); } catch { console.error("Invalid JSON."); process.exit(1); }
      const payload = await request(instance, "POST", `/api/share/${sid}/edit`, { edits });
      console.log(`Saved at ${payload.savedAt}`);
      break;
    }

    case "comment": {
      const quote = plainArgs[2];
      const body = plainArgs.slice(3).join(" ");
      if (!quote || !body) {
        console.error('Usage: documine <instance> comment <quote> <body>');
        process.exit(1);
      }
      const payload = await request(instance, "POST", `/api/share/${sid}/threads`, { anchor: { quote, prefix: "", suffix: "", start: 0, end: 0 }, body, name: agentName });
      console.log(`Comment added (thread ${getCreatedThreadId(payload)})`);
      break;
    }

    case "reply": {
      const threadId = plainArgs[2];
      const messageId = plainArgs[3];
      const body = plainArgs.slice(4).join(" ");
      if (!threadId || !messageId || !body) {
        console.error("Usage: documine <instance> reply <threadId> <messageId> <body>");
        process.exit(1);
      }
      await request(instance, "POST", `/api/share/${sid}/threads/${threadId}/replies`, { body, name: agentName, parentMessageId: messageId });
      console.log("Reply added");
      break;
    }

    default:
      console.error(`Unknown command for shared instance: ${subCommand}`);
      console.error("Available: read, edit, comment, reply");
      process.exit(1);
  }
} else {

switch (subCommand) {
  case "auth-status": {
    const payload = await request(instance, "GET", "/api/auth/guard");
    printAuthGuardStatus(payload);
    break;
  }

  case "login-enable": {
    const payload = await request(instance, "PUT", "/api/auth/guard/login", { enabled: true });
    printAuthGuardStatus(payload);
    break;
  }

  case "login-disable": {
    const payload = await request(instance, "PUT", "/api/auth/guard/login", { enabled: false });
    printAuthGuardStatus(payload);
    break;
  }

  case "login-bans": {
    const payload = await request(instance, "GET", "/api/auth/guard");
    if (!payload.bans || payload.bans.length === 0) {
      console.log("No active IP bans.");
      break;
    }
    for (const ban of payload.bans) {
      console.log(`${ban.ip}\t${ban.bannedAt}\t${ban.expiresAt}\t${ban.reason}`);
    }
    break;
  }

  case "login-unban": {
    const ip = args[2];
    if (!ip) {
      console.error("Usage: documine <instance> login-unban <ip>");
      process.exit(1);
    }
    const payload = await request(instance, "DELETE", `/api/auth/guard/bans/${encodeURIComponent(ip)}`);
    printAuthGuardStatus(payload);
    break;
  }

  case "list": {
    const payload = await request(instance, "GET", "/api/notes");
    for (const note of payload.notes) {
      console.log(`${note.id}\t${note.title}\t${note.updatedAt}`);
    }
    break;
  }

  case "search": {
    const query = args.slice(2).join(" ");
    if (!query) {
      console.error("Usage: documine <instance> search <query>");
      process.exit(1);
    }
    const payload = await request(instance, "GET", `/api/notes?q=${encodeURIComponent(query)}`);
    for (const note of payload.notes) {
      console.log(`${note.id}\t${note.title}\t${note.updatedAt}`);
    }
    break;
  }

  case "read": {
    const noteId = args[2];
    if (!noteId) {
      console.error("Usage: documine <instance> read <id> [--offset=N] [--limit=M]");
      process.exit(1);
    }

    const offsetArg = args.find((a) => a.startsWith("--offset="));
    const limitArg = args.find((a) => a.startsWith("--limit="));
    const offset = offsetArg ? offsetArg.split("=")[1] : null;
    const limit = limitArg ? limitArg.split("=")[1] : null;

    let endpoint = `/api/notes/${noteId}`;
    const params = [];
    if (offset) params.push(`offset=${offset}`);
    if (limit) params.push(`limit=${limit}`);
    if (params.length) endpoint += `?${params.join("&")}`;

    const payload = await request(instance, "GET", endpoint);
    const note = payload.note;

    if (note.content !== undefined) {
      console.log(`# ${note.title}`);
      console.log(`# id: ${note.id}`);
      console.log(`# lines: ${note.offset}-${note.offset + note.limit - 1} of ${note.totalLines}${note.remaining > 0 ? ` (${note.remaining} more)` : ""}`);
      console.log();
      console.log(note.content);
    } else {
      console.log(`# ${note.title}`);
      console.log(`# id: ${note.id}`);
      console.log(`# updated: ${note.updatedAt}`);
      console.log(`# share: ${note.shareUrl}`);
      console.log();
      console.log(note.markdown);

      if (payload.threads && payload.threads.length > 0) {
        console.log();
        console.log("--- Comments ---");
        for (const thread of payload.threads) {
          const anchor = thread.anchor?.quote ? `"${thread.anchor.quote.slice(0, 60)}"` : "(no anchor)";
          console.log();
          console.log(`Thread ${thread.id} on ${anchor}${thread.resolved ? " [resolved]" : ""}`);
          for (const msg of thread.messages) {
            console.log(`  [${msg.id}] ${msg.authorName} (${msg.updatedAt}): ${msg.body}`);
          }
        }
      }
    }
    break;
  }

  case "create": {
    const title = args.slice(2).join(" ") || "untitled";
    const payload = await request(instance, "POST", "/api/notes");
    if (title !== "untitled") {
      await request(instance, "PUT", `/api/notes/${payload.note.id}`, { title, markdown: "" });
    }
    console.log(`${payload.note.id}\t${title}`);
    break;
  }

  case "upload-image": {
    const noteId = args[2];
    const imagePath = args[3];
    if (!noteId || !imagePath) {
      console.error("Usage: documine <instance> upload-image <id> <imagePath>");
      process.exit(1);
    }
    const payload = await uploadImage(instance, `/api/notes/${encodeURIComponent(noteId)}/images`, imagePath);
    console.log(payload.asset.markdown);
    break;
  }

  case "comment": {
    const noteId = args[2];
    const quote = args[3];
    const body = args.slice(4).join(" ");
    if (!noteId || !quote || !body) {
      console.error("Usage: documine <instance> comment <id> <quote> <body>");
      console.error('Example: documine myserver comment abc123 "some text" "my comment"');
      process.exit(1);
    }
    const payload = await request(instance, "POST", `/api/notes/${noteId}/threads`, { quote, body });
    console.log(`Comment added (thread ${getCreatedThreadId(payload)})`);
    break;
  }

  case "reply": {
    const noteId = args[2];
    const threadId = args[3];
    const messageId = args[4];
    const body = args.slice(5).join(" ");
    if (!noteId || !threadId || !messageId || !body) {
      console.error("Usage: documine <instance> reply <noteId> <threadId> <messageId> <body>");
      process.exit(1);
    }
    await request(instance, "POST", `/api/notes/${noteId}/threads/${threadId}/replies`, { body, parentMessageId: messageId });
    console.log("Reply added");
    break;
  }

  case "resolve": {
    const noteId = args[2];
    const threadId = args[3];
    if (!noteId || !threadId) {
      console.error("Usage: documine <instance> resolve <noteId> <threadId>");
      process.exit(1);
    }
    await request(instance, "PATCH", `/api/notes/${noteId}/threads/${threadId}`, { resolved: true });
    console.log("Thread resolved");
    break;
  }

  case "reopen": {
    const noteId = args[2];
    const threadId = args[3];
    if (!noteId || !threadId) {
      console.error("Usage: documine <instance> reopen <noteId> <threadId>");
      process.exit(1);
    }
    await request(instance, "PATCH", `/api/notes/${noteId}/threads/${threadId}`, { resolved: false });
    console.log("Thread reopened");
    break;
  }

  case "delete-thread": {
    const noteId = args[2];
    const threadId = args[3];
    if (!noteId || !threadId) {
      console.error("Usage: documine <instance> delete-thread <noteId> <threadId>");
      process.exit(1);
    }
    await request(instance, "DELETE", `/api/notes/${noteId}/threads/${threadId}`);
    console.log("Thread deleted");
    break;
  }

  case "edit-comment": {
    const noteId = args[2];
    const messageId = args[3];
    const body = args.slice(4).join(" ");
    if (!noteId || !messageId || !body) {
      console.error("Usage: documine <instance> edit-comment <noteId> <messageId> <body>");
      process.exit(1);
    }
    await request(instance, "PATCH", `/api/notes/${noteId}/messages/${messageId}`, { body });
    console.log("Comment edited");
    break;
  }

  case "delete-comment": {
    const noteId = args[2];
    const messageId = args[3];
    if (!noteId || !messageId) {
      console.error("Usage: documine <instance> delete-comment <noteId> <messageId>");
      process.exit(1);
    }
    await request(instance, "DELETE", `/api/notes/${noteId}/messages/${messageId}`);
    console.log("Comment deleted");
    break;
  }

  case "edit": {
    const noteId = args[2];
    const editsJson = args[3];
    if (!noteId || !editsJson) {
      console.error("Usage: documine <instance> edit <id> '<json edits>'");
      console.error('Example: documine myserver edit abc123 \'[{"oldText":"hello","newText":"world"}]\'');
      process.exit(1);
    }

    let edits;
    try {
      edits = JSON.parse(editsJson);
    } catch {
      console.error("Invalid JSON for edits.");
      process.exit(1);
    }

    const payload = await request(instance, "POST", `/api/notes/${noteId}/edit`, { edits });
    console.log(`Saved at ${payload.savedAt}`);
    break;
  }

  case "share": {
    const noteId = args[2];
    const access = args[3];
    if (!noteId) {
      console.error("Usage: documine <instance> share <id> [none|view|comment|edit]");
      process.exit(1);
    }
    if (!access) {
      const payload = await request(instance, "GET", `/api/notes/${noteId}`);
      const note = payload.note;
      console.log(`${note.id}\t${note.shareAccess}\t${note.shareUrl}`);
      break;
    }
    if (!["none", "view", "comment", "edit"].includes(access)) {
      console.error("Access must be one of: none, view, comment, edit");
      process.exit(1);
    }
    const sharePayload = await request(instance, "PUT", `/api/notes/${noteId}`, { shareAccess: access });
    const readPayload = await request(instance, "GET", `/api/notes/${noteId}`);
    console.log(`${noteId}\t${readPayload.note.shareAccess}\t${readPayload.note.shareUrl}`);
    break;
  }

  case "update": {
    const noteId = args[2];
    const field = args[3];
    const value = args.slice(4).join(" ");
    if (!noteId || !field || !value) {
      console.error("Usage: documine <instance> update <id> title <value>");
      console.error("       documine <instance> update <id> markdown <value>");
      process.exit(1);
    }

    const body = {};
    if (field === "title") {
      body.title = value;
      body.markdown = undefined;
      const current = await request(instance, "GET", `/api/notes/${noteId}`);
      body.markdown = current.note.markdown;
    } else if (field === "markdown") {
      body.markdown = value;
      const current = await request(instance, "GET", `/api/notes/${noteId}`);
      body.title = current.note.title;
    } else {
      console.error(`Unknown field: ${field}. Use 'title' or 'markdown'.`);
      process.exit(1);
    }

    const payload = await request(instance, "PUT", `/api/notes/${noteId}`, body);
    console.log(`Saved at ${payload.savedAt}`);
    break;
  }

  case "delete": {
    const noteId = args[2];
    if (!noteId) {
      console.error("Usage: documine <instance> delete <id>");
      process.exit(1);
    }
    await request(instance, "DELETE", `/api/notes/${noteId}`);
    console.log(`Deleted ${noteId}`);
    break;
  }

  default:
    console.error(`Unknown command: ${subCommand}`);
    printUsage();
    process.exit(1);
}

} // end owner mode

function printUsage() {
  console.log(`Usage: documine <command> [args...]

Server:
  documine serve [--port=N] [--data=path]      Run the documine server

Instance management:
  documine register <name> <baseUrl> <token>   Register with API key (owner)
  documine register <name> <shareUrl>          Register with share link
  documine unregister <name>                   Remove a registered instance
  documine instances                           List registered instances

Owner commands:
  documine <instance> auth-status              Show owner login guard status
  documine <instance> login-enable             Re-enable owner password login
  documine <instance> login-disable            Disable owner password login
  documine <instance> login-bans               List active temporary IP bans
  documine <instance> login-unban <ip>         Remove an IP from the temporary ban list
  documine <instance> list                     List all notes
  documine <instance> search <query>           Search notes
  documine <instance> read <id>                Read a note with comments
  documine <instance> create [title]           Create a new note
  documine <instance> share <id> [access]      Get/set share access (none|view|comment|edit)
  documine <instance> upload-image <id> <path> Upload image and print markdown
  documine <instance> comment <id> <quote> <b> Comment on quoted text
  documine <instance> reply <id> <tid> <mid> b  Reply to a specific message
  documine <instance> resolve <id> <tid>        Resolve a thread
  documine <instance> reopen <id> <tid>         Reopen a thread
  documine <instance> edit-comment <id> <mid> b Edit a comment
  documine <instance> delete-comment <id> <mid> Delete a comment
  documine <instance> delete-thread <id> <tid>  Delete a thread
  documine <instance> edit <id> '<edits>'       Apply edits (JSON array of {oldText, newText})
  documine <instance> update <id> title <val>   Update note title
  documine <instance> update <id> markdown <v>  Replace full markdown
  documine <instance> delete <id>               Delete a note

Shared note commands:
  documine <instance> read                     Read the shared note
  documine <instance> edit '<edits>'           Edit (if edit access)
  documine <instance> comment <quote> <body>   Comment on text
  documine <instance> reply <tid> <mid> <body> Reply to a specific message
  Use --name="Name" to set display name for comments`);
}
