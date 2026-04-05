import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const MARKDOWN_FROM = 'markdown+raw_attribute+link_attributes+fenced_divs+bracketed_spans+grid_tables+pipe_tables+simple_tables+multiline_tables';
const PDF_STYLE_PRESETS = ['report', 'academic', 'clean', 'compact'] as const;
const PDF_PAGE_SIZES = ['A4', 'Letter', 'Legal'] as const;
const PDF_ENGINES = ['auto', 'browser', 'wkhtmltopdf', 'weasyprint'] as const;
const PDF_ORIENTATIONS = ['portrait', 'landscape'] as const;
const PDF_FONT_FAMILIES = ['Times New Roman', 'Georgia', 'Arial', 'Inter', 'system-ui'] as const;
const PDF_HEADER_MODES = ['none', 'title', 'date', 'title-date'] as const;
const PDF_CODE_WRAP_MODES = ['wrap', 'scroll'] as const;
const PDF_IMAGE_ALIGNMENTS = ['left', 'center', 'right'] as const;

type PdfStylePreset = typeof PDF_STYLE_PRESETS[number];
type PdfPageSize = typeof PDF_PAGE_SIZES[number];
type PdfEngine = typeof PDF_ENGINES[number];
type PdfOrientation = typeof PDF_ORIENTATIONS[number];
type PdfFontFamily = typeof PDF_FONT_FAMILIES[number];
type PdfHeaderMode = typeof PDF_HEADER_MODES[number];
type PdfCodeWrapMode = typeof PDF_CODE_WRAP_MODES[number];
type PdfImageAlignment = typeof PDF_IMAGE_ALIGNMENTS[number];

export type PdfExportSettings = {
  stylePreset: PdfStylePreset;
  pageSize: PdfPageSize;
  orientation: PdfOrientation;
  engine: PdfEngine;
  toc: boolean;
  includeTitle: boolean;
  includeDate: boolean;
  fontFamily: PdfFontFamily;
  fontSizePt: number;
  lineHeight: number;
  marginsCm: {
    top: number;
    right: number;
    bottom: number;
    left: number;
  };
  headerMode: PdfHeaderMode;
  justifyText: boolean;
  imageMaxWidthPercent: number;
  imageAlign: PdfImageAlignment;
  codeWrap: PdfCodeWrapMode;
};

export type PdfExportCapabilities = {
  pandoc: boolean;
  browser: boolean;
  wkhtmltopdf: boolean;
  weasyprint: boolean;
  availableEngines: PdfEngine[];
  styles: PdfStylePreset[];
  pageSizes: PdfPageSize[];
  fontFamilies: PdfFontFamily[];
  headerModes: PdfHeaderMode[];
  codeWrapModes: PdfCodeWrapMode[];
  imageAlignments: PdfImageAlignment[];
};

export type ExportPdfInput = {
  noteId: string;
  noteTitle: string;
  markdown: string;
  settings: unknown;
  assetDirectory: string;
};

export const defaultPdfExportSettings: PdfExportSettings = {
  stylePreset: 'report',
  pageSize: 'A4',
  orientation: 'portrait',
  engine: 'weasyprint',
  toc: false,
  includeTitle: false,
  includeDate: false,
  fontFamily: 'Times New Roman',
  fontSizePt: 12,
  lineHeight: 1.45,
  marginsCm: {
    top: 2.54,
    right: 2.54,
    bottom: 2.54,
    left: 2.54,
  },
  headerMode: 'none',
  justifyText: true,
  imageMaxWidthPercent: 100,
  imageAlign: 'left',
  codeWrap: 'wrap',
};

function isOneOf<T extends readonly string[]>(value: unknown, allowed: T): value is T[number] {
  return typeof value === 'string' && allowed.includes(value);
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function mergeSettings(input: unknown): PdfExportSettings {
  const source = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const marginSource = source.marginsCm && typeof source.marginsCm === 'object'
    ? source.marginsCm as Record<string, unknown>
    : {};

  return {
    stylePreset: isOneOf(source.stylePreset, PDF_STYLE_PRESETS) ? source.stylePreset : defaultPdfExportSettings.stylePreset,
    pageSize: isOneOf(source.pageSize, PDF_PAGE_SIZES) ? source.pageSize : defaultPdfExportSettings.pageSize,
    orientation: isOneOf(source.orientation, PDF_ORIENTATIONS) ? source.orientation : defaultPdfExportSettings.orientation,
    engine: isOneOf(source.engine, PDF_ENGINES) ? source.engine : defaultPdfExportSettings.engine,
    toc: typeof source.toc === 'boolean' ? source.toc : defaultPdfExportSettings.toc,
    includeTitle: typeof source.includeTitle === 'boolean' ? source.includeTitle : defaultPdfExportSettings.includeTitle,
    includeDate: typeof source.includeDate === 'boolean' ? source.includeDate : defaultPdfExportSettings.includeDate,
    fontFamily: isOneOf(source.fontFamily, PDF_FONT_FAMILIES) ? source.fontFamily : defaultPdfExportSettings.fontFamily,
    fontSizePt: clampNumber(source.fontSizePt, defaultPdfExportSettings.fontSizePt, 9, 18),
    lineHeight: clampNumber(source.lineHeight, defaultPdfExportSettings.lineHeight, 1.1, 2),
    marginsCm: {
      top: clampNumber(marginSource.top, defaultPdfExportSettings.marginsCm.top, 0.5, 5),
      right: clampNumber(marginSource.right, defaultPdfExportSettings.marginsCm.right, 0.5, 5),
      bottom: clampNumber(marginSource.bottom, defaultPdfExportSettings.marginsCm.bottom, 0.5, 5),
      left: clampNumber(marginSource.left, defaultPdfExportSettings.marginsCm.left, 0.5, 5),
    },
    headerMode: isOneOf(source.headerMode, PDF_HEADER_MODES) ? source.headerMode : defaultPdfExportSettings.headerMode,
    justifyText: typeof source.justifyText === 'boolean' ? source.justifyText : defaultPdfExportSettings.justifyText,
    imageMaxWidthPercent: clampNumber(source.imageMaxWidthPercent, defaultPdfExportSettings.imageMaxWidthPercent, 30, 100),
    imageAlign: isOneOf(source.imageAlign, PDF_IMAGE_ALIGNMENTS) ? source.imageAlign : defaultPdfExportSettings.imageAlign,
    codeWrap: isOneOf(source.codeWrap, PDF_CODE_WRAP_MODES) ? source.codeWrap : defaultPdfExportSettings.codeWrap,
  };
}

export async function loadPdfExportSettings(filePath: string): Promise<PdfExportSettings> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as { defaults?: unknown };
    return mergeSettings(parsed.defaults);
  } catch {
    return defaultPdfExportSettings;
  }
}

export async function savePdfExportSettings(filePath: string, settingsInput: unknown): Promise<PdfExportSettings> {
  const settings = mergeSettings(settingsInput);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify({ version: 1, defaults: settings }, null, 2)}\n`, 'utf8');
  return settings;
}

async function hasExecutable(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ['--version']);
    return true;
  } catch {
    return false;
  }
}

function browserCandidates(): string[] {
  const envBrowser = process.env.CHROME_BIN || process.env.BROWSER_BIN;
  const candidates = [
    envBrowser,
    'chromium-browser',
    'chromium',
    'google-chrome',
    'chrome',
    'msedge',
    'microsoft-edge',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/c/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  ].filter(Boolean) as string[];
  return [...new Set(candidates)];
}

async function findBrowserExecutable(): Promise<string | null> {
  for (const candidate of browserCandidates()) {
    try {
      await execFileAsync(candidate, ['--version']);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export async function detectPdfExportCapabilities(): Promise<PdfExportCapabilities> {
  const pandoc = await hasExecutable('pandoc');
  const wkhtmltopdf = await hasExecutable('wkhtmltopdf');
  const weasyprint = await hasExecutable('weasyprint');
  const browser = false;
  const availableEngines: PdfEngine[] = ['auto'];
  if (wkhtmltopdf) availableEngines.push('wkhtmltopdf');
  if (weasyprint) availableEngines.push('weasyprint');

  return {
    pandoc,
    browser,
    wkhtmltopdf,
    weasyprint,
    availableEngines,
    styles: [...PDF_STYLE_PRESETS],
    pageSizes: [...PDF_PAGE_SIZES],
    fontFamilies: [...PDF_FONT_FAMILIES],
    headerModes: [...PDF_HEADER_MODES],
    codeWrapModes: [...PDF_CODE_WRAP_MODES],
    imageAlignments: [...PDF_IMAGE_ALIGNMENTS],
  };
}

function resolvePdfEngine(requested: PdfEngine, capabilities: PdfExportCapabilities): Exclude<PdfEngine, 'auto'> {
  if (requested === 'browser') {
    throw new Error('Browser PDF engine is disabled. Use weasyprint or wkhtmltopdf.');
  }
  if (requested !== 'auto') {
    if (!capabilities.availableEngines.includes(requested)) {
      throw new Error(`Requested PDF engine is not available: ${requested}`);
    }
    return requested;
  }
  if (capabilities.weasyprint) return 'weasyprint';
  if (capabilities.wkhtmltopdf) return 'wkhtmltopdf';
  throw new Error('No supported PDF engine found. Install weasyprint or wkhtmltopdf.');
}

function sanitizeFileNameSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'note';
}

function prependExportHeader(markdown: string, _title: string, settings: PdfExportSettings): string {
  const lines: string[] = [];
  if (settings.includeDate) {
    lines.push(new Date().toLocaleDateString('en-CA'));
  }
  if (lines.length === 0) {
    return markdown;
  }
  return `${lines.join('\n\n')}\n\n${markdown}`;
}

function decodeAssetFileName(rawFileName: string): string {
  try {
    return decodeURIComponent(rawFileName);
  } catch {
    return rawFileName;
  }
}

function rewriteMarkdownAssetPaths(markdown: string, noteId: string, assetDirectory: string): string {
  const escapedNoteId = encodeURIComponent(noteId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assetPrefixPattern = String.raw`(?:https?:\/\/[^\s)"']+)?\/assets\/${escapedNoteId}\/`;
  return markdown
    .replace(new RegExp(`(!\\[[^\\]]*\\]\\()${assetPrefixPattern}([^\\)]+)(\\))`, 'g'), (_match, prefix: string, fileName: string, suffix: string) => {
      const assetPath = path.join(assetDirectory, decodeAssetFileName(fileName));
      return `${prefix}<${pathToFileURL(assetPath).toString()}>${suffix}`;
    })
    .replace(new RegExp(`(<img[^>]*src=["'])${assetPrefixPattern}([^"']+)(["'][^>]*>)`, 'gi'), (_match, prefix: string, fileName: string, suffix: string) => {
      const assetPath = path.join(assetDirectory, decodeAssetFileName(fileName));
      return `${prefix}${pathToFileURL(assetPath).toString()}${suffix}`;
    });
}

function basePresetCss(preset: PdfStylePreset): string {
  switch (preset) {
    case 'academic':
      return `
html, body { color: #111827; }
h1, h2, h3, h4, h5, h6 { color: #111827; letter-spacing: 0.01em; }
blockquote { border-left: 3px solid #9ca3af; color: #374151; }
table { font-size: 10.5pt; }
`;
    case 'clean':
      return `
html, body { font-family: Arial, Helvetica, sans-serif; color: #111827; }
h1, h2, h3, h4, h5, h6 { font-family: Arial, Helvetica, sans-serif; color: #0f172a; }
pre, code { font-family: Consolas, "Courier New", monospace; }
blockquote { border-left: 3px solid #cbd5e1; color: #334155; }
`;
    case 'compact':
      return `
html, body { color: #000; }
h1, h2, h3, h4, h5, h6 { margin-top: 0.8em; margin-bottom: 0.3em; }
p, li { margin-top: 0.2em; margin-bottom: 0.35em; }
table { margin: 0.45em 0; font-size: 10pt; }
`;
    default:
      return '';
  }
}

function headerCss(title: string, settings: PdfExportSettings): string {
  let content = '';
  if (settings.headerMode === 'title') {
    content = JSON.stringify(title);
  } else if (settings.headerMode === 'date') {
    content = JSON.stringify(new Date().toLocaleDateString('en-CA'));
  } else if (settings.headerMode === 'title-date') {
    content = JSON.stringify(`${title} • ${new Date().toLocaleDateString('en-CA')}`);
  }
  if (!content) {
    return '.documine-export-header { display: none; }';
  }
  return `
body { padding-top: 2.2em; }
.documine-export-header {
  display: block;
  position: fixed;
  top: -0.8cm;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 9pt;
  color: #4b5563;
}
.documine-export-header::before { content: ${content}; }
`;
}

function imageMarginForAlignment(alignment: PdfImageAlignment): string {
  switch (alignment) {
    case 'center':
      return '0.6em auto';
    case 'right':
      return '0.6em 0 0.6em auto';
    default:
      return '0.6em 0';
  }
}

function imageTextAlign(alignment: PdfImageAlignment): string {
  switch (alignment) {
    case 'center':
      return 'center';
    case 'right':
      return 'right';
    default:
      return 'left';
  }
}

function imageAutoMargin(alignment: PdfImageAlignment): string {
  switch (alignment) {
    case 'center':
      return '0 auto';
    case 'right':
      return '0 0 0 auto';
    default:
      return '0 auto 0 0';
  }
}

function buildPdfCss(title: string, settings: PdfExportSettings): string {
  const family = settings.fontFamily === 'system-ui'
    ? 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    : JSON.stringify(settings.fontFamily);
  return `
@page {
  size: ${settings.pageSize} ${settings.orientation};
  margin: ${settings.marginsCm.top}cm ${settings.marginsCm.right}cm ${settings.marginsCm.bottom}cm ${settings.marginsCm.left}cm;
}

html, body {
  font-family: ${family};
  font-size: ${settings.fontSizePt}pt;
  line-height: ${settings.lineHeight};
  color: #000;
}

body {
  ${settings.justifyText ? 'text-align: justify;' : ''}
}

h1, h2, h3, h4, h5, h6 {
  font-family: ${family};
  color: #000;
  font-weight: 700;
  margin-top: 1.1em;
  margin-bottom: 0.45em;
  page-break-after: avoid;
}

p, li {
  ${settings.justifyText ? 'text-align: justify;' : ''}
}

table {
  width: 100%;
  border-collapse: collapse;
  margin: 0.7em 0;
  font-size: ${Math.max(9, settings.fontSizePt - 1)}pt;
}

th, td {
  border: 1px solid #000;
  padding: 6px 8px;
  vertical-align: top;
}

code, pre {
  font-family: "Consolas", "Courier New", monospace;
  font-size: ${Math.max(8, settings.fontSizePt - 2)}pt;
}

pre {
  white-space: ${settings.codeWrap === 'wrap' ? 'pre-wrap' : 'pre'};
  overflow-x: auto;
  border: 1px solid #000;
  padding: 8px;
}

figure {
  display: block;
  width: 100%;
  max-width: 100%;
  margin: 0.6em 0;
  text-align: ${imageTextAlign(settings.imageAlign)};
}

figure img {
  display: block;
  max-width: ${settings.imageMaxWidthPercent}%;
  height: auto;
  margin: ${imageAutoMargin(settings.imageAlign)};
}

figcaption {
  display: none;
}

p > img:only-child {
  display: block;
  max-width: ${settings.imageMaxWidthPercent}%;
  height: auto;
  margin: ${imageMarginForAlignment(settings.imageAlign)};
}

img {
  max-width: ${settings.imageMaxWidthPercent}%;
  height: auto;
}

${basePresetCss(settings.stylePreset)}
${headerCss(title, settings)}
`.trim() + '\n';
}

async function run(command: string, args: string[], cwd?: string): Promise<void> {
  try {
    await execFileAsync(command, args, {
      cwd,
      maxBuffer: 20 * 1024 * 1024,
      env: { ...process.env },
    });
  } catch (error) {
    const message = error instanceof Error && 'stderr' in error
      ? String((error as { stderr?: string }).stderr || (error as { stdout?: string }).stdout || error.message)
      : error instanceof Error
        ? error.message
        : 'unknown error';
    throw new Error(`${command} failed: ${message.trim()}`);
  }
}

function transformExportHtml(bodyHtml: string, settings: PdfExportSettings): string {
  const figureStyle = `display:block;width:100%;max-width:100%;margin:0.6em 0;text-align:${imageTextAlign(settings.imageAlign)};`;
  const imageStyleBase = `display:block;height:auto;margin:${imageAutoMargin(settings.imageAlign)};`;
  const imageStyleWithDefaultWidth = `${imageStyleBase}max-width:${settings.imageMaxWidthPercent}%;`;
  const figcaptionStyle = `display:block;text-align:${imageTextAlign(settings.imageAlign)};margin:0.35em 0 0;font-size:0.95em;`;

  const withStyledFigures = bodyHtml.replace(/<figure>/g, `<figure style="${figureStyle}">`);
  const withStyledCaptions = withStyledFigures.replace(/<figcaption(\b[^>]*)>/gi, `<figcaption$1 style="${figcaptionStyle}">`);

  return withStyledCaptions.replace(/<img\b([^>]*?)\s*\/?>/gi, (match, attrs: string) => {
    const styleMatch = attrs.match(/\sstyle=(['"])(.*?)\1/i);
    if (styleMatch) {
      const existingStyle = styleMatch[2].trim();
      const hasExplicitSize = /(^|;)\s*(width|height)\s*:/i.test(existingStyle);
      const mergedStyle = hasExplicitSize
        ? `${existingStyle}; ${imageStyleBase}`
        : `${existingStyle}; ${imageStyleWithDefaultWidth}`;
      return match.replace(styleMatch[0], ` style="${mergedStyle}"`);
    }
    return `<img${attrs} style="${imageStyleWithDefaultWidth}" />`;
  });
}

async function markdownToHtml(source: string, htmlOutput: string, cssContent: string, settings: PdfExportSettings, toc: boolean, cwd: string): Promise<void> {
  const bodyFragmentPath = path.join(cwd, 'body-fragment.html');
  const args = [
    source,
    '--from',
    MARKDOWN_FROM,
    '--to',
    'html5',
    '--embed-resources',
    '--resource-path',
    cwd,
    '-o',
    bodyFragmentPath,
  ];
  if (toc) {
    args.push('--toc');
  }
  await run('pandoc', args, cwd);

  const bodyHtml = transformExportHtml(await fs.readFile(bodyFragmentPath, 'utf8'), settings);
  const documentHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title></title>
  <style>
${cssContent}
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
  await fs.writeFile(htmlOutput, documentHtml, 'utf8');
}

async function htmlToPdfWithPandoc(htmlPath: string, pdfPath: string, engine: 'wkhtmltopdf', cwd: string): Promise<void> {
  await run('pandoc', [htmlPath, '--from', 'html', '--to', 'pdf', '--pdf-engine', engine, '-o', pdfPath], cwd);
}

async function htmlToPdfWithWeasyprint(htmlPath: string, pdfPath: string, cwd: string): Promise<void> {
  await run('weasyprint', [htmlPath, pdfPath], cwd);
}

async function htmlToPdfWithBrowser(htmlPath: string, pdfPath: string, tempDir: string): Promise<void> {
  const browser = await findBrowserExecutable();
  if (!browser) {
    throw new Error('No browser PDF backend found.');
  }
  const uri = pathToFileURL(htmlPath).toString();
  const userDataDir = path.join(tempDir, 'chrome-profile');
  await fs.mkdir(userDataDir, { recursive: true });
  const sharedArgs = [
    '--disable-gpu',
    '--no-sandbox',
    '--allow-file-access-from-files',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${userDataDir}`,
    '--window-size=1280,1696',
    '--no-pdf-header-footer',
    '--virtual-time-budget=12000',
    `--print-to-pdf=${pdfPath}`,
    uri,
  ];
  try {
    await run(browser, ['--headless=new', ...sharedArgs]);
  } catch {
    await run(browser, ['--headless', ...sharedArgs]);
  }
}

export async function exportMarkdownToPdf(input: ExportPdfInput): Promise<{ fileName: string; pdf: Buffer }> {
  const capabilities = await detectPdfExportCapabilities();
  if (!capabilities.pandoc) {
    throw new Error('pandoc is required but was not found in PATH.');
  }
  const settings = mergeSettings(input.settings);
  const engine = resolvePdfEngine(settings.engine, capabilities);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'documine-pdf-'));
  try {
    const markdownPath = path.join(tempDir, 'note.md');
    const cssPath = path.join(tempDir, 'export.css');
    const htmlPath = path.join(tempDir, 'export.html');
    const pdfPath = path.join(tempDir, 'export.pdf');
    const title = input.noteTitle || 'Untitled';

    const rewrittenMarkdown = rewriteMarkdownAssetPaths(prependExportHeader(input.markdown, title, settings), input.noteId, input.assetDirectory);
    await fs.writeFile(markdownPath, rewrittenMarkdown, 'utf8');
    const cssContent = buildPdfCss(title, settings);
    await fs.writeFile(cssPath, cssContent, 'utf8');
    await markdownToHtml(markdownPath, htmlPath, cssContent, settings, settings.toc, tempDir);

    if (engine === 'browser') {
      await htmlToPdfWithBrowser(htmlPath, pdfPath, tempDir);
    } else if (engine === 'weasyprint') {
      await htmlToPdfWithWeasyprint(htmlPath, pdfPath, tempDir);
    } else {
      await htmlToPdfWithPandoc(htmlPath, pdfPath, engine, tempDir);
    }

    const pdf = await fs.readFile(pdfPath);
    return {
      fileName: `${sanitizeFileNameSegment(title)}.pdf`,
      pdf,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
