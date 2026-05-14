import path from "node:path";

// ---------------------------------------------------------------------------
// CLI argument helper
// ---------------------------------------------------------------------------

export function cliArg(name: string) {
  const match = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return match ? match.split("=").slice(1).join("=") : null;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const port = Number(cliArg("port") || process.env.PORT || 3120);
export const dataDir = cliArg("data") || process.env.DATA_DIR || path.join(process.cwd(), "data");
export const noteAssetsDir = path.join(dataDir, "assets");
export const noteExportsDir = path.join(dataDir, "exports");
export const exportSettingsFilePath = path.join(dataDir, "export-settings.json");

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export const maxImageUploadBytes = 10 * 1024 * 1024;
export const maxNotesImportZipBytes = 100 * 1024 * 1024;
export const shareAccessLevels: Record<string, number> = { none: 0, view: 1, comment: 2, edit: 3 };
export const imageMimeExtensions: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
};
