import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type http from "node:http";
import type { Context } from "hono";

import type {
  AuthData,
  AuthGuardData,
  AuthGuardEvent,
  AuthGuardIpBan,
  AuthGuardRuntime,
  AuthGuardSummary,
  ApiKey,
  ViewerInfo,
  ViewerContext,
} from "../types/auth.js";
import type { CommentMessage, CommentThread } from "../types/notes.js";

import { readJson, writeJson, nowIso, createId, normalizeCommenterName } from "../shared.js";

const authDataCache = { value: null as AuthData | null, mtimeMs: -1 };
const verifiedOwnerTokenCache = new Map<string, number>();
const verifiedApiKeyCache = new Map<string, number>();
const requestViewerContextCache = new WeakMap<Context, ViewerContext>();
const ownerSessionCookieName = "documine_owner_session";
let _authFilePath = "";
let _authGuardFilePath = "";
let _authGuardLogFilePath = "";
const authTokenVerificationCacheMs = 1000 * 60 * 5;
const authKeyVerificationCacheMs = 1000 * 60 * 5;

export function initAuthPaths(dataDir: string) {
  _authFilePath = path.join(dataDir, "auth.json");
  _authGuardFilePath = path.join(dataDir, "auth-guard.json");
  _authGuardLogFilePath = path.join(dataDir, "auth-guard.jsonl");
}

export const ownerLocalStorageTokenKey = "documine_owner_token";
const commenterIdCookieName = "documine_commenter_id";
const commenterNameCookieName = "documine_commenter_name";
const ownerCookieMaxAgeSeconds = 60 * 60 * 24 * 30;
const commenterCookieMaxAgeSeconds = 60 * 60 * 24 * 365;
export const authIpBanDurationMs = 1000 * 60 * 15;
export const authFailedAttemptWindowMs = 1000 * 60 * 15;
export const authFailedAttemptBanThreshold = 3;
export const authGlobalLoginWindowMs = 1000 * 60 * 5;
export const authGlobalLoginThreshold = 10;
let _authGuardRuntime: AuthGuardRuntime | null = null;

export function getAuthGuardRuntime(): AuthGuardRuntime {
  if (!_authGuardRuntime) {
    _authGuardRuntime = loadAuthGuardRuntime();
  }
  return _authGuardRuntime;
}
export function hashSecret(value: string, salt: string) {
  return crypto.scryptSync(value, salt, 64).toString("hex");
}

export function secureEqualsHex(a: string, b: string) {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

export function loadAuthData() {
  const mtimeMs = fs.existsSync(_authFilePath) ? fs.statSync(_authFilePath).mtimeMs : -1;
  if (authDataCache.value && authDataCache.mtimeMs === mtimeMs) {
    return authDataCache.value;
  }
  authDataCache.value = readJson<AuthData | null>(_authFilePath, null);
  authDataCache.mtimeMs = mtimeMs;
  return authDataCache.value;
}

export function saveAuthData(authData: AuthData) {
  writeJson(_authFilePath, authData);
  authDataCache.value = authData;
  authDataCache.mtimeMs = fs.statSync(_authFilePath).mtimeMs;
  verifiedOwnerTokenCache.clear();
  verifiedApiKeyCache.clear();
}

export function defaultAuthGuardData(): AuthGuardData {
  return {
    loginEnabled: true,
    globalLock: {
      active: false,
      lockedAt: null,
      expiresAt: null,
      reason: null,
    },
    bannedIps: [],
  };
}

export function defaultAuthGuardRuntime(): AuthGuardRuntime {
  return {
    loginRequests: [],
    failedLogins: [],
  };
}

export function loadAuthGuardData(): AuthGuardData {
  const raw = readJson<Record<string, unknown> | null>(_authGuardFilePath, null);
  const fallback = defaultAuthGuardData();
  const authGuard: AuthGuardData = {
    loginEnabled: typeof raw?.loginEnabled === "boolean" ? raw.loginEnabled : fallback.loginEnabled,
    globalLock: {
      active:
        typeof raw?.globalLock === "object" &&
        raw?.globalLock !== null &&
        typeof (raw.globalLock as { active?: unknown }).active === "boolean"
          ? Boolean((raw.globalLock as { active: boolean }).active)
          : fallback.globalLock.active,
      lockedAt:
        typeof raw?.globalLock === "object" &&
        raw?.globalLock !== null &&
        typeof (raw.globalLock as { lockedAt?: unknown }).lockedAt === "string"
          ? String((raw.globalLock as { lockedAt: string }).lockedAt)
          : fallback.globalLock.lockedAt,
      expiresAt:
        typeof raw?.globalLock === "object" &&
        raw?.globalLock !== null &&
        typeof (raw.globalLock as { expiresAt?: unknown }).expiresAt === "string"
          ? String((raw.globalLock as { expiresAt: string }).expiresAt)
          : fallback.globalLock.expiresAt,
      reason:
        typeof raw?.globalLock === "object" &&
        raw?.globalLock !== null &&
        typeof (raw.globalLock as { reason?: unknown }).reason === "string"
          ? String((raw.globalLock as { reason: string }).reason)
          : fallback.globalLock.reason,
    },
    bannedIps: Array.isArray(raw?.bannedIps)
      ? raw.bannedIps.filter((item): item is AuthGuardIpBan =>
          Boolean(
            item &&
            typeof item === "object" &&
            typeof (item as AuthGuardIpBan).ip === "string" &&
            typeof (item as AuthGuardIpBan).bannedAt === "string" &&
            typeof (item as AuthGuardIpBan).expiresAt === "string" &&
            typeof (item as AuthGuardIpBan).reason === "string",
          ),
        )
      : [],
  };
  if (!fs.existsSync(_authGuardFilePath)) {
    saveAuthGuardData(authGuard);
  }
  return authGuard;
}

export function loadAuthGuardRuntime(): AuthGuardRuntime {
  const runtime = defaultAuthGuardRuntime();
  const loginRequestCutoff = Date.now() - authGlobalLoginWindowMs;
  const failedLoginCutoff = Date.now() - authFailedAttemptWindowMs;

  if (!fs.existsSync(_authGuardLogFilePath)) {
    pruneAuthGuardRuntimeEntries(runtime);
    return runtime;
  }

  const content = fs.readFileSync(_authGuardLogFilePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      const event = JSON.parse(trimmed) as Partial<AuthGuardEvent>;
      if (typeof event.ip !== "string" || typeof event.timestamp !== "string" || typeof event.type !== "string") {
        continue;
      }
      const timestamp = Date.parse(event.timestamp);
      if (Number.isNaN(timestamp)) {
        continue;
      }
      if (event.type === "login-requested" && timestamp >= loginRequestCutoff) {
        runtime.loginRequests.push({ ip: event.ip, timestamp: event.timestamp });
      }
      if (event.type === "login-failed" && timestamp >= failedLoginCutoff) {
        runtime.failedLogins.push({ ip: event.ip, timestamp: event.timestamp });
      }
    } catch {
      continue;
    }
  }
  pruneAuthGuardRuntimeEntries(runtime);
  return runtime;
}

export function saveAuthGuardData(authGuard: AuthGuardData) {
  writeJson(_authGuardFilePath, authGuard);
}

export function pruneAuthGuardData(authGuard: AuthGuardData, now = Date.now()) {
  const bannedIpCount = authGuard.bannedIps.length;
  const previousLoginEnabled = authGuard.loginEnabled;
  const previousGlobalLock = JSON.stringify(authGuard.globalLock);

  authGuard.bannedIps = authGuard.bannedIps.filter((item) => {
    const expiresAt = Date.parse(item.expiresAt);
    return !Number.isNaN(expiresAt) && expiresAt > now;
  });

  const globalLockExpiresAt = authGuard.globalLock.expiresAt ? Date.parse(authGuard.globalLock.expiresAt) : Number.NaN;
  if (authGuard.globalLock.active && !Number.isNaN(globalLockExpiresAt) && globalLockExpiresAt <= now) {
    authGuard.loginEnabled = true;
    authGuard.globalLock = {
      active: false,
      lockedAt: null,
      expiresAt: null,
      reason: null,
    };
  }

  return (
    authGuard.bannedIps.length !== bannedIpCount ||
    authGuard.loginEnabled !== previousLoginEnabled ||
    JSON.stringify(authGuard.globalLock) !== previousGlobalLock
  );
}

export function pruneAuthGuardRuntimeEntries(runtime: AuthGuardRuntime, now = Date.now()) {
  const loginRequestCutoff = now - authGlobalLoginWindowMs;
  const failedLoginCutoff = now - authFailedAttemptWindowMs;
  runtime.loginRequests = runtime.loginRequests.filter((item) => {
    const timestamp = Date.parse(item.timestamp);
    return !Number.isNaN(timestamp) && timestamp >= loginRequestCutoff;
  });
  runtime.failedLogins = runtime.failedLogins.filter((item) => {
    const timestamp = Date.parse(item.timestamp);
    return !Number.isNaN(timestamp) && timestamp >= failedLoginCutoff;
  });
}

export function pruneAuthGuardRuntime(now = Date.now()) {
  pruneAuthGuardRuntimeEntries(getAuthGuardRuntime(), now);
}

export function appendAuthGuardEvent(event: AuthGuardEvent) {
  fs.appendFileSync(_authGuardLogFilePath, `${JSON.stringify(event)}\n`, "utf8");
}

export function recordAuthGuardLoginRequest(ip: string, timestamp: string) {
  pruneAuthGuardRuntime();
  getAuthGuardRuntime().loginRequests.push({ ip, timestamp });
  appendAuthGuardEvent({
    type: "login-requested",
    ip,
    timestamp,
    detail: "Owner login request received.",
  });
}

export function recordAuthGuardFailedLogin(ip: string, timestamp: string) {
  pruneAuthGuardRuntime();
  getAuthGuardRuntime().failedLogins.push({ ip, timestamp });
  appendAuthGuardEvent({
    type: "login-failed",
    ip,
    timestamp,
    detail: "Invalid owner password.",
  });
}

export function clearAuthGuardFailedLoginsForIp(ip: string) {
  getAuthGuardRuntime().failedLogins = getAuthGuardRuntime().failedLogins.filter((item) => item.ip !== ip);
}

export function getActiveIpBan(authGuard: AuthGuardData, ip: string) {
  const now = Date.now();
  return authGuard.bannedIps.find((item) => item.ip === ip && Date.parse(item.expiresAt) > now) || null;
}

export function buildAuthGuardSummary(authGuard: AuthGuardData): AuthGuardSummary {
  pruneAuthGuardRuntime();
  return {
    loginEnabled: authGuard.loginEnabled,
    globalLockActive: authGuard.globalLock.active,
    globalLockAt: authGuard.globalLock.lockedAt,
    globalLockExpiresAt: authGuard.globalLock.expiresAt,
    globalLockReason: authGuard.globalLock.reason,
    recentLoginRequestCount: getAuthGuardRuntime().loginRequests.length,
    bannedIpCount: authGuard.bannedIps.length,
  };
}

export function authConfigured() {
  const auth = loadAuthData();
  return Boolean(auth?.passwordSalt && auth?.passwordHash);
}

export function passwordMatches(password: string) {
  const auth = loadAuthData();
  if (!auth) {
    return false;
  }
  return secureEqualsHex(hashSecret(password, auth.passwordSalt), auth.passwordHash);
}

export function initializeOwnerAuth(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const auth: AuthData = {
    passwordSalt: salt,
    passwordHash: hashSecret(password, salt),
    tokens: [],
  };
  saveAuthData(auth);
  saveAuthGuardData(defaultAuthGuardData());
  return issueOwnerToken();
}

export function issueOwnerToken() {
  const auth = loadAuthData();
  if (!auth) {
    throw new Error("Password not configured.");
  }

  const token = crypto.randomBytes(32).toString("base64url");
  const salt = crypto.randomBytes(16).toString("hex");
  const timestamp = nowIso();
  auth.tokens.push({
    id: createId(10),
    salt,
    hash: hashSecret(token, salt),
    createdAt: timestamp,
    lastUsedAt: timestamp,
  });
  saveAuthData(auth);
  return token;
}

export function verifyOwnerToken(token: string) {
  const cachedExpiresAt = verifiedOwnerTokenCache.get(token);
  if (cachedExpiresAt && cachedExpiresAt > Date.now()) {
    return true;
  }

  const auth = loadAuthData();
  if (!auth) {
    return false;
  }

  let changed = false;
  for (let index = auth.tokens.length - 1; index >= 0; index--) {
    const stored = auth.tokens[index];
    if (!secureEqualsHex(hashSecret(token, stored.salt), stored.hash)) {
      continue;
    }

    if (index !== auth.tokens.length - 1) {
      auth.tokens.splice(index, 1);
      auth.tokens.push(stored);
      changed = true;
    }

    const lastSeen = Date.parse(stored.lastUsedAt);
    if (Number.isNaN(lastSeen) || Date.now() - lastSeen > 1000 * 60 * 60 * 12) {
      stored.lastUsedAt = nowIso();
      changed = true;
    }
    if (changed) {
      saveAuthData(auth);
    }
    verifiedOwnerTokenCache.set(token, Date.now() + authTokenVerificationCacheMs);
    return true;
  }

  return false;
}

export function revokeOwnerToken(token: string) {
  const auth = loadAuthData();
  if (!auth) {
    return;
  }

  const tokens = auth.tokens.filter((stored) => !secureEqualsHex(hashSecret(token, stored.salt), stored.hash));
  if (tokens.length !== auth.tokens.length) {
    auth.tokens = tokens;
    saveAuthData(auth);
  }
}

export function parseCookies(header: string | undefined) {
  const cookies: Record<string, string> = {};
  if (!header) {
    return cookies;
  }
  for (const item of header.split(";")) {
    const index = item.indexOf("=");
    if (index === -1) {
      continue;
    }
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

export function headerValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function getOwnerSessionTokenFromHeaders(headers: http.IncomingHttpHeaders) {
  return parseCookies(headerValue(headers.cookie))[ownerSessionCookieName] || null;
}

export function forwardedForToIp(value: string | null) {
  if (!value) {
    return null;
  }
  return value.split(",")[0]?.trim() || null;
}

export function forwardedHeaderToIp(value: string | null) {
  if (!value) {
    return null;
  }
  const match = value.match(/for=(?:"?)(\[[^\]]+\]|[^;,"]+)/i);
  return match?.[1]?.replace(/^\[/, "").replace(/\]$/, "").trim() || null;
}

export function getClientIp(c: Context) {
  return (
    forwardedForToIp(c.req.header("cf-connecting-ip") || null) ||
    forwardedForToIp(c.req.header("x-real-ip") || null) ||
    forwardedForToIp(c.req.header("x-forwarded-for") || null) ||
    forwardedHeaderToIp(c.req.header("forwarded") || null) ||
    "unknown"
  );
}

export function getBearerTokenFromHeaders(headers: http.IncomingHttpHeaders) {
  const header = headerValue(headers.authorization);
  if (!header || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice(7).trim() || null;
}

export function getOwnerSessionToken(c: Context) {
  return getCookie(c, ownerSessionCookieName) || null;
}

export function isSecureRequest(c: Context) {
  const forwarded = c.req.header("x-forwarded-proto");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() === "https";
  }
  return new URL(c.req.url).protocol === "https:";
}

export function setOwnerSessionCookie(c: Context, token: string) {
  setCookie(c, ownerSessionCookieName, token, {
    path: "/",
    sameSite: "Lax",
    maxAge: ownerCookieMaxAgeSeconds,
    httpOnly: true,
    secure: isSecureRequest(c),
  });
}

export function clearOwnerSessionCookie(c: Context) {
  deleteCookie(c, ownerSessionCookieName, {
    path: "/",
    secure: isSecureRequest(c),
  });
}

export function isOwnerAuthenticatedHeaders(headers: http.IncomingHttpHeaders) {
  const bearer = getBearerTokenFromHeaders(headers);
  if (bearer && verifyApiKey(bearer)) {
    return true;
  }
  const token = getOwnerSessionTokenFromHeaders(headers);
  return Boolean(token && verifyOwnerToken(token));
}

export function isOwnerAuthenticated(c: Context) {
  const bearer = getBearerToken(c);
  if (bearer && verifyApiKey(bearer)) {
    return true;
  }
  const token = getOwnerSessionToken(c);
  return Boolean(token && verifyOwnerToken(token));
}

export function isOwnerAuthenticatedIncomingRequest(req: http.IncomingMessage) {
  return isOwnerAuthenticatedHeaders(req.headers);
}

export function getBearerToken(c: Context) {
  const header = c.req.header("authorization");
  if (!header || !header.startsWith("Bearer ")) {
    return null;
  }
  return header.slice(7).trim() || null;
}

export function verifyApiKey(key: string) {
  const cachedExpiresAt = verifiedApiKeyCache.get(key);
  if (cachedExpiresAt && cachedExpiresAt > Date.now()) {
    return true;
  }

  const auth = loadAuthData();
  if (!auth?.apiKeys) {
    return false;
  }
  for (let index = auth.apiKeys.length - 1; index >= 0; index--) {
    const stored = auth.apiKeys[index];
    if (secureEqualsHex(hashSecret(key, stored.keySalt), stored.keyHash)) {
      verifiedApiKeyCache.set(key, Date.now() + authKeyVerificationCacheMs);
      return true;
    }
  }
  return false;
}

export function getApiKeyLabel(key: string) {
  const auth = loadAuthData();
  if (!auth?.apiKeys) {
    return null;
  }
  for (let index = auth.apiKeys.length - 1; index >= 0; index--) {
    const stored = auth.apiKeys[index];
    if (secureEqualsHex(hashSecret(key, stored.keySalt), stored.keyHash)) {
      return stored.label;
    }
  }
  return null;
}

export function createApiKey(label: string) {
  const auth = loadAuthData();
  if (!auth) {
    throw new Error("Password not configured.");
  }
  if (!auth.apiKeys) {
    auth.apiKeys = [];
  }

  const rawKey = crypto.randomBytes(32).toString("base64url");
  const salt = crypto.randomBytes(16).toString("hex");
  const apiKey: ApiKey = {
    id: createId(10),
    label: label.trim().slice(0, 80) || "unnamed",
    keySalt: salt,
    keyHash: hashSecret(rawKey, salt),
    createdAt: nowIso(),
  };

  auth.apiKeys.push(apiKey);
  saveAuthData(auth);
  return { id: apiKey.id, label: apiKey.label, key: rawKey, createdAt: apiKey.createdAt };
}

export function deleteApiKey(keyId: string) {
  const auth = loadAuthData();
  if (!auth?.apiKeys) {
    return false;
  }

  const before = auth.apiKeys.length;
  auth.apiKeys = auth.apiKeys.filter((key) => key.id !== keyId);
  if (auth.apiKeys.length !== before) {
    saveAuthData(auth);
    return true;
  }
  return false;
}

export function listApiKeys() {
  const auth = loadAuthData();
  if (!auth?.apiKeys) {
    return [];
  }
  return auth.apiKeys.map((key) => ({ id: key.id, label: key.label, createdAt: key.createdAt }));
}

export function getCommenterIdentityFromHeaders(headers: http.IncomingHttpHeaders) {
  const cookies = parseCookies(headerValue(headers.cookie));
  return {
    id: cookies[commenterIdCookieName] || null,
    name: cookies[commenterNameCookieName] || null,
  };
}

export function getCommenterIdentity(c: Context) {
  return {
    id: getCookie(c, commenterIdCookieName) || null,
    name: getCookie(c, commenterNameCookieName) || null,
  };
}

export function getOrCreateCommenterId(c: Context) {
  const existing = getCommenterIdentity(c).id;
  if (existing) {
    return existing;
  }
  const created = crypto.randomBytes(24).toString("base64url");
  setCookie(c, commenterIdCookieName, created, {
    path: "/",
    sameSite: "Lax",
    maxAge: commenterCookieMaxAgeSeconds,
    httpOnly: true,
    secure: isSecureRequest(c),
  });
  return created;
}

export function setCommenterNameCookie(c: Context, name: string) {
  setCookie(c, commenterNameCookieName, name, {
    path: "/",
    sameSite: "Lax",
    maxAge: commenterCookieMaxAgeSeconds,
    httpOnly: true,
    secure: isSecureRequest(c),
  });
}

export function ensureCommentAuthor(c: Context, body: Record<string, unknown>) {
  if (isOwnerAuthenticated(c)) {
    return { authorId: "__owner__", authorName: "Owner" };
  }

  const commenter = getCommenterIdentity(c);
  const name = commenter.name || normalizeCommenterName(String(body.name || ""));
  if (!name) {
    return null;
  }

  const commenterId = commenter.id || getOrCreateCommenterId(c);
  return { authorId: commenterId, authorName: name };
}

export function canManageMessage(c: Context, message: CommentMessage) {
  if (isOwnerAuthenticated(c)) {
    return true;
  }
  const commenter = getCommenterIdentity(c);
  return Boolean(commenter.id && commenter.id === message.authorId);
}

export function canManageThread(c: Context, thread: CommentThread) {
  if (isOwnerAuthenticated(c)) {
    return true;
  }
  const commenter = getCommenterIdentity(c);
  return Boolean(commenter.id && thread.messages.some((message) => message.authorId === commenter.id));
}

// Viewer context (uses request cache)
export function getViewerContext(
  c: Context,
  overrides?: { commenterNameOverride?: string; hasCommenterIdentityOverride?: boolean },
): ViewerContext {
  if (!overrides) {
    const cached = requestViewerContextCache.get(c);
    if (cached) {
      return cached;
    }
  }

  const commenter = getCommenterIdentity(c);
  const viewer: ViewerInfo = {
    isOwner: isOwnerAuthenticated(c),
    commenterName: overrides?.commenterNameOverride ?? commenter.name,
    hasCommenterIdentity: overrides?.hasCommenterIdentityOverride ?? Boolean(commenter.id),
  };

  if (!overrides) {
    const context = { viewer, commenter };
    requestViewerContextCache.set(c, context);
    return context;
  }

  return { viewer, commenter };
}
export function buildViewerInfo(
  c: Context,
  overrides?: { commenterNameOverride?: string; hasCommenterIdentityOverride?: boolean },
): ViewerInfo {
  return getViewerContext(c, overrides).viewer;
}
