import { Hono } from "hono";

import { readJsonBody, nowIso } from "../shared.js";

import {
  getAuthGuardRuntime,
  ownerLocalStorageTokenKey,
  authFailedAttemptBanThreshold,
  authGlobalLoginWindowMs,
  authGlobalLoginThreshold,
  authIpBanDurationMs,
  isOwnerAuthenticated,
  authConfigured,
  passwordMatches,
  initializeOwnerAuth,
  issueOwnerToken,
  verifyOwnerToken,
  revokeOwnerToken,
  getOwnerSessionToken,
  setOwnerSessionCookie,
  clearOwnerSessionCookie,
  buildViewerInfo,
  getClientIp,
  createApiKey,
  deleteApiKey,
  listApiKeys,
  loadAuthGuardData,
  pruneAuthGuardData,
  saveAuthGuardData,
  buildAuthGuardSummary,
  appendAuthGuardEvent,
  recordAuthGuardLoginRequest,
  recordAuthGuardFailedLogin,
  clearAuthGuardFailedLoginsForIp,
  getActiveIpBan,
} from "../lib/auth.js";

import { exportSettingsFilePath } from "../lib/config.js";

import {
  loadPdfExportSettings,
  savePdfExportSettings,
  defaultPdfExportSettings,
  detectPdfExportCapabilities,
} from "../pdf-export.js";

export function registerAuthRoutes(app: Hono) {
  app.get("/api/viewer", (c) => {
    const authGuard = loadAuthGuardData();
    if (pruneAuthGuardData(authGuard)) {
      saveAuthGuardData(authGuard);
    }

    return c.json({
      ok: true,
      authConfigured: authConfigured(),
      ownerAuthenticated: isOwnerAuthenticated(c),
      ownerLocalStorageTokenKey,
      authGuard: buildAuthGuardSummary(authGuard),
      viewer: buildViewerInfo(c),
    });
  });

  app.post("/api/auth/setup", async (c) => {
    if (authConfigured()) {
      return c.json({ ok: false, error: "Password already configured." }, 400);
    }

    const body = await readJsonBody(c);
    const password = String(body.password || "");
    const confirmPassword = String(body.confirmPassword || "");

    if (password.length < 8) {
      return c.json({ ok: false, error: "Use at least 8 characters." }, 400);
    }

    if (password !== confirmPassword) {
      return c.json({ ok: false, error: "Passwords do not match." }, 400);
    }

    const token = initializeOwnerAuth(password);
    return c.json({ ok: true, token, ownerLocalStorageTokenKey });
  });

  app.post("/api/auth/login", async (c) => {
    if (!authConfigured()) {
      return c.json({ ok: false, error: "Password is not configured yet." }, 400);
    }

    const authGuard = loadAuthGuardData();
    if (pruneAuthGuardData(authGuard)) {
      saveAuthGuardData(authGuard);
    }
    const ip = getClientIp(c);

    if (!authGuard.loginEnabled) {
      appendAuthGuardEvent({
        type: "login-blocked",
        ip,
        timestamp: nowIso(),
        detail: authGuard.globalLock.active
          ? "Owner login is locked due to suspicious activity."
          : "Owner login is disabled.",
      });
      saveAuthGuardData(authGuard);
      return c.json(
        {
          ok: false,
          error: authGuard.globalLock.active
            ? authGuard.globalLock.expiresAt
              ? `Owner login is temporarily locked until ${authGuard.globalLock.expiresAt}.`
              : "Owner login is locked due to suspicious activity. Use the CLI or auth-guard.json to re-enable it."
            : "Owner login is currently disabled.",
        },
        authGuard.globalLock.active ? 423 : 403,
      );
    }

    const timestamp = nowIso();
    recordAuthGuardLoginRequest(ip, timestamp);
    if (getAuthGuardRuntime().loginRequests.length > authGlobalLoginThreshold) {
      authGuard.loginEnabled = false;
      authGuard.globalLock = {
        active: true,
        lockedAt: timestamp,
        expiresAt: null,
        reason: `More than ${authGlobalLoginThreshold} login requests in ${Math.round(authGlobalLoginWindowMs / 60000)} minutes.`,
      };
      appendAuthGuardEvent({
        type: "login-locked",
        ip,
        timestamp,
        detail: authGuard.globalLock.reason || "Owner login locked due to suspicious activity.",
      });
      console.warn(`[auth-guard] login-locked ip=${ip} timestamp=${timestamp} reason=${authGuard.globalLock.reason}`);
      saveAuthGuardData(authGuard);
      return c.json(
        {
          ok: false,
          error:
            "Owner login has been locked due to suspicious activity. The current owner can re-enable it from the CLI or auth-guard.json.",
        },
        423,
      );
    }

    const activeBan = getActiveIpBan(authGuard, ip);
    if (activeBan) {
      appendAuthGuardEvent({
        type: "login-blocked",
        ip,
        timestamp,
        detail: `Blocked by temporary IP ban until ${activeBan.expiresAt}.`,
      });
      saveAuthGuardData(authGuard);
      return c.json(
        {
          ok: false,
          error: `Too many failed login attempts from this IP. Login is disabled until ${activeBan.expiresAt}.`,
        },
        429,
      );
    }

    const body = await readJsonBody(c);
    const password = String(body.password || "");
    if (!passwordMatches(password)) {
      recordAuthGuardFailedLogin(ip, timestamp);
      const failedAttemptsForIp = getAuthGuardRuntime().failedLogins.filter(
        (attempt: { ip: string; timestamp: string }) => attempt.ip === ip,
      ).length;

      if (failedAttemptsForIp >= authFailedAttemptBanThreshold) {
        const expiresAt = new Date(Date.now() + authIpBanDurationMs).toISOString();
        const existingBan = authGuard.bannedIps.find((item) => item.ip === ip);
        if (existingBan) {
          existingBan.bannedAt = timestamp;
          existingBan.expiresAt = expiresAt;
          existingBan.reason = `${authFailedAttemptBanThreshold} failed owner login attempts.`;
        } else {
          authGuard.bannedIps.push({
            ip,
            bannedAt: timestamp,
            expiresAt,
            reason: `${authFailedAttemptBanThreshold} failed owner login attempts.`,
          });
        }
        authGuard.loginEnabled = false;
        authGuard.globalLock = {
          active: true,
          lockedAt: timestamp,
          expiresAt,
          reason: `${authFailedAttemptBanThreshold} failed owner login attempts triggered a temporary login lock.`,
        };
        appendAuthGuardEvent({
          type: "ip-banned",
          ip,
          timestamp,
          detail: `Temporary ban active until ${expiresAt}.`,
        });
        appendAuthGuardEvent({
          type: "login-locked",
          ip,
          timestamp,
          detail: `Owner login temporarily locked until ${expiresAt} after ${authFailedAttemptBanThreshold} failed password attempts.`,
        });
        console.warn(`[auth-guard] ip-banned ip=${ip} timestamp=${timestamp} expiresAt=${expiresAt}`);
        console.warn(
          `[auth-guard] login-locked ip=${ip} timestamp=${timestamp} expiresAt=${expiresAt} reason=${authGuard.globalLock.reason}`,
        );
        saveAuthGuardData(authGuard);
        return c.json({ ok: false, error: `Owner login is temporarily locked until ${expiresAt}.` }, 423);
      }

      saveAuthGuardData(authGuard);
      return c.json({ ok: false, error: "Invalid credentials." }, 401);
    }

    clearAuthGuardFailedLoginsForIp(ip);
    appendAuthGuardEvent({
      type: "login-succeeded",
      ip,
      timestamp,
      detail: "Owner login succeeded.",
    });
    saveAuthGuardData(authGuard);

    const token = issueOwnerToken();
    return c.json({ ok: true, token, ownerLocalStorageTokenKey });
  });

  app.post("/api/auth/token", async (c) => {
    const body = await readJsonBody(c);
    const token = String(body.token || "");
    if (!token || !verifyOwnerToken(token)) {
      clearOwnerSessionCookie(c);
      return c.json({ ok: false }, 401);
    }

    setOwnerSessionCookie(c, token);
    return c.json({ ok: true });
  });

  app.post("/api/auth/logout", (c) => {
    const token = getOwnerSessionToken(c);
    if (token) {
      revokeOwnerToken(token);
    }
    clearOwnerSessionCookie(c);
    return c.json({ ok: true });
  });

  app.get("/api/auth/guard", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const authGuard = loadAuthGuardData();
    if (pruneAuthGuardData(authGuard)) {
      saveAuthGuardData(authGuard);
    }
    return c.json({ ok: true, authGuard: buildAuthGuardSummary(authGuard), bans: authGuard.bannedIps });
  });

  app.put("/api/auth/guard/login", async (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const body = await readJsonBody(c);
    const enabled = body.enabled === true;
    const authGuard = loadAuthGuardData();
    pruneAuthGuardData(authGuard);
    authGuard.loginEnabled = enabled;
    authGuard.globalLock = {
      active: false,
      lockedAt: null,
      expiresAt: null,
      reason: null,
    };
    const timestamp = nowIso();
    appendAuthGuardEvent({
      type: enabled ? "login-enabled" : "login-disabled",
      ip: getClientIp(c),
      timestamp,
      detail: enabled ? "Owner login manually enabled." : "Owner login manually disabled.",
    });
    console.warn(
      `[auth-guard] ${enabled ? "login-enabled" : "login-disabled"} ip=${getClientIp(c)} timestamp=${timestamp}`,
    );
    saveAuthGuardData(authGuard);
    return c.json({ ok: true, authGuard: buildAuthGuardSummary(authGuard), bans: authGuard.bannedIps });
  });

  app.delete("/api/auth/guard/bans/:ip", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }

    const authGuard = loadAuthGuardData();
    pruneAuthGuardData(authGuard);
    const ip = decodeURIComponent(c.req.param("ip"));
    const before = authGuard.bannedIps.length;
    authGuard.bannedIps = authGuard.bannedIps.filter((item) => item.ip !== ip);
    clearAuthGuardFailedLoginsForIp(ip);
    if (authGuard.bannedIps.length === before) {
      return c.json({ ok: false, error: "IP ban not found." }, 404);
    }
    const timestamp = nowIso();
    appendAuthGuardEvent({
      type: "ip-unbanned",
      ip,
      timestamp,
      detail: "Temporary IP ban removed by owner.",
    });
    console.warn(`[auth-guard] ip-unbanned ip=${ip} timestamp=${timestamp}`);
    saveAuthGuardData(authGuard);
    return c.json({ ok: true, authGuard: buildAuthGuardSummary(authGuard), bans: authGuard.bannedIps });
  });

  // API key routes
  app.get("/api/keys", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }
    return c.json({ ok: true, keys: listApiKeys() });
  });

  app.post("/api/keys", async (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }
    const body = await readJsonBody(c);
    const label = String(body.label || "unnamed");
    const result = createApiKey(label);
    return c.json({ ok: true, ...result });
  });

  app.delete("/api/keys/:id", (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }
    const deleted = deleteApiKey(c.req.param("id"));
    if (!deleted) {
      return c.json({ ok: false, error: "API key not found." }, 404);
    }
    return c.json({ ok: true });
  });

  // Export settings

  app.get("/api/export/settings", async (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }
    const [settings, capabilities] = await Promise.all([
      loadPdfExportSettings(exportSettingsFilePath),
      detectPdfExportCapabilities(),
    ]);
    return c.json({ ok: true, settings, defaults: defaultPdfExportSettings, capabilities });
  });

  app.put("/api/export/settings", async (c) => {
    if (!isOwnerAuthenticated(c)) {
      return c.json({ ok: false, error: "Unauthorized." }, 401);
    }
    const body = await readJsonBody(c);
    const settings = await savePdfExportSettings(exportSettingsFilePath, body.settings);
    const capabilities = await detectPdfExportCapabilities();
    return c.json({ ok: true, settings, defaults: defaultPdfExportSettings, capabilities });
  });
}
