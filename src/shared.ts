import fs from "node:fs";
import path from "node:path";
import type { Context } from "hono";

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

export function nowIso(): string {
  return new Date().toISOString();
}

export function createShortId(length = 8): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export function createId(length = 12): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function escapeMarkdownImageAlt(input: string): string {
  return input.replace(/[[\]]/g, "");
}

export function normalizeTitle(input: string): string {
  return input.trim().slice(0, 500) || "untitled";
}

export function normalizeCommentBody(input: string): string {
  return input.trim().slice(0, 10000) || "";
}

export function normalizeCommenterName(input: string): string {
  return input.trim().slice(0, 100) || "Anonymous";
}

export function slugifyFileName(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

export function readJson<T>(filePath: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function writeJson(filePath: string, value: unknown) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Hono request body reader
// ---------------------------------------------------------------------------

export async function readJsonBody(c: Context): Promise<Record<string, unknown>> {
  try {
    return await c.req.json<Record<string, unknown>>();
  } catch {
    return {};
  }
}
