import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import puppeteer from 'puppeteer';

const execFileAsync = promisify(execFile);

const MARKDOWN_FROM = 'markdown+raw_attribute+link_attributes+fenced_divs+bracketed_spans+grid_tables+pipe_tables+simple_tables+multiline_tables';
const PDF_STYLE_PRESETS = ['report', 'academic', 'clean', 'compact'] as const;
const PDF_PAGE_SIZES = ['A4', 'Letter', 'Legal'] as const;
const PDF_ENGINES = ['browser'] as const;
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
  signal?: AbortSignal;
  onStageTiming?: (stage: 'pandoc' | 'browser' | 'total', durationMs: number) => void;
};

export type ExportPdfResult = {
  fileName: string;
  pdf: Buffer;
  debug: {
    markdown: string;
    css: string;
    html: string;
  };
};

export type PdfPreviewResult = {
  fileName: string;
  pdf: Buffer;
};

export type ExportHtmlPreviewResult = {
  markdown: string;
  css: string;
  html: string;
};

export const defaultPdfExportSettings: PdfExportSettings = {
  stylePreset: 'report',
  pageSize: 'A4',
  orientation: 'portrait',
  engine: 'browser',
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

let cachedCapabilities: PdfExportCapabilities | null = null;

async function hasExecutable(command: string): Promise<boolean> {
  try {
    await execFileAsync(command, ['--version']);
    return true;
  } catch {
    return false;
  }
}

function cmToPx(value: number): number {
  return value * 37.7952755906;
}

function pageDimensionsPx(pageSize: PdfPageSize, orientation: PdfOrientation) {
  const dimensionsBySize: Record<PdfPageSize, { width: number; height: number }> = {
    A4: { width: 794, height: 1123 },
    Letter: { width: 816, height: 1056 },
    Legal: { width: 816, height: 1344 },
  };
  const base = dimensionsBySize[pageSize];
  return orientation === 'landscape' ? { width: base.height, height: base.width } : base;
}

function rewriteMarkdownAssetPaths(markdown: string, noteId: string, assetDirectory: string): string {
  const escapedNoteId = encodeURIComponent(noteId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assetPrefixPattern = String.raw`(?:https?:\/\/[^\s)"']+)?\/assets\/${escapedNoteId}\/`;
  return markdown
    .replace(new RegExp(`(!\\[[^\\]]*\\]\\()${assetPrefixPattern}([^\\)]+)(\\))`, 'g'), (_match, prefix: string, fileName: string, suffix: string) => {
      const assetPath = path.join(assetDirectory, decodeURIComponent(fileName));
      return `${prefix}<${pathToFileURL(assetPath).toString()}>${suffix}`;
    })
    .replace(new RegExp(`(<img[^>]*src=["'])${assetPrefixPattern}([^"']+)(["'][^>]*>)`, 'gi'), (_match, prefix: string, fileName: string, suffix: string) => {
      const assetPath = path.join(assetDirectory, decodeURIComponent(fileName));
      return `${prefix}${pathToFileURL(assetPath).toString()}${suffix}`;
    });
}

function prependExportHeader(markdown: string, title: string, settings: PdfExportSettings): string {
  const lines: string[] = [];
  if (settings.includeTitle) {
    lines.push(title);
  }
  if (settings.includeDate) {
    lines.push(new Date().toLocaleDateString('en-CA'));
  }
  if (lines.length === 0) {
    return markdown;
  }
  return `${lines.join('\n\n')}\n\n${markdown}`;
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

function screenPreviewCss(): string {
  return `
@media screen {
  html {
    background: #d1d5db;
    padding: 1.25rem 0 2rem;
  }

  body {
    margin: 0;
    padding: 0;
  }

  .documine-preview-pages {
    display: flex;
    flex-direction: column;
    gap: 1.25rem;
    align-items: center;
    padding: 0 1rem;
  }

  .documine-preview-page {
    width: var(--documine-page-width);
    min-height: var(--documine-page-height);
    background: #fff;
    box-shadow: 0 20px 45px rgba(15, 23, 42, 0.18);
    overflow: hidden;
  }

  .documine-preview-page-content {
    box-sizing: border-box;
    width: 100%;
    min-height: var(--documine-page-height);
    padding: var(--documine-page-margin-top) var(--documine-page-margin-right) var(--documine-page-margin-bottom) var(--documine-page-margin-left);
  }

  .documine-preview-page-content > :first-child {
    margin-top: 0;
  }

  .documine-preview-source {
    display: none;
  }
}
`;
}

function buildPdfCss(title: string, settings: PdfExportSettings): string {
  const family = settings.fontFamily === 'system-ui'
    ? 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    : JSON.stringify(settings.fontFamily);
  const dimensions = pageDimensionsPx(settings.pageSize, settings.orientation);
  return `
:root {
  --documine-page-width: ${dimensions.width}px;
  --documine-page-height: ${dimensions.height}px;
  --documine-page-margin-top: ${cmToPx(settings.marginsCm.top)}px;
  --documine-page-margin-right: ${cmToPx(settings.marginsCm.right)}px;
  --documine-page-margin-bottom: ${cmToPx(settings.marginsCm.bottom)}px;
  --documine-page-margin-left: ${cmToPx(settings.marginsCm.left)}px;
}

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

nav#TOC {
  margin: 0 0 1.2em;
  page-break-inside: avoid;
}

nav#TOC ul,
nav#TOC ol {
  margin: 0.2em 0;
  padding: 0;
  list-style: none;
}

nav#TOC ul ul,
nav#TOC ul ol,
nav#TOC ol ul,
nav#TOC ol ol {
  margin-left: 1.4em;
}

nav#TOC li {
  margin: 0.12em 0;
}

nav#TOC a,
nav#TOC .documine-toc-link {
  display: block;
  color: #000;
  text-decoration: none;
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
${screenPreviewCss()}
`.trim() + '\n';
}

function transformExportHtml(bodyHtml: string, settings: PdfExportSettings): string {
  const figureStyle = `display:block;width:100%;max-width:100%;margin:0.6em 0;text-align:${imageTextAlign(settings.imageAlign)};`;
  const imageStyleBase = `display:block;height:auto;margin:${imageAutoMargin(settings.imageAlign)};`;
  const imageStyleWithDefaultWidth = `${imageStyleBase}max-width:${settings.imageMaxWidthPercent}%;`;
  const figcaptionStyle = `display:block;text-align:${imageTextAlign(settings.imageAlign)};margin:0.35em 0 0;font-size:0.95em;`;

  const withOrderedToc = bodyHtml.replace(/<nav id="TOC"\b[^>]*>[\s\S]*?<\/nav>/i, (tocHtml) => {
    return tocHtml
      .replace(/<(\/?)ul\b/gi, '<$1ol')
      .replace(/<a\b([^>]*?)\shref=(['"])(#[^'"]+)\2([^>]*)>([\s\S]*?)<\/a>/gi, '<span class="documine-toc-link" data-target="$3">$5</span>');
  });
  const withStyledFigures = withOrderedToc.replace(/<figure>/g, `<figure style="${figureStyle}">`);
  const withStyledCaptions = withStyledFigures.replace(/<figcaption(\b[^>]*)>/gi, `<figcaption$1 style="${figcaptionStyle}">`);

  return withStyledCaptions.replace(/<img\b([^>]*?)\s*\/?>(?![^<]*<\/img>)/gi, (match, attrs: string) => {
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

async function markdownToHtmlString(source: string, cssContent: string, settings: PdfExportSettings, toc: boolean, cwd: string, options?: { signal?: AbortSignal }): Promise<string> {
  const args = [
    source,
    '--from',
    MARKDOWN_FROM,
    '--to',
    'html5',
    '--standalone',
    '--metadata',
    'title=',
  ];
  if (toc) {
    args.push('--toc');
  }

  const { stdout } = await execFileAsync('pandoc', args, {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env },
    signal: options?.signal,
  });
  const standaloneHtml = String(stdout);
  const withoutBundledStyles = standaloneHtml.replace(/\s*<style>[\s\S]*?<\/style>\s*/i, '\n');
  const withInjectedStyles = withoutBundledStyles.includes('</head>')
    ? withoutBundledStyles.replace('</head>', `  <style>\n${cssContent}  </style>\n</head>`)
    : withoutBundledStyles;
  return withInjectedStyles.replace(/<body(\b[^>]*)>([\s\S]*?)<\/body>/i, (_match, attrs: string, bodyHtml: string) => {
    return `<body${attrs}>\n${transformExportHtml(bodyHtml, settings)}\n</body>`;
  });
}

async function htmlToPdfWithBrowser(htmlPath: string, pdfPath: string, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new Error('PDF export superseded by a newer request.');
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--allow-file-access-from-files'],
  });

  try {
    const page = await browser.newPage();
    if (signal?.aborted) {
      throw new Error('PDF export superseded by a newer request.');
    }
    await page.goto(pathToFileURL(htmlPath).toString(), { waitUntil: 'networkidle0' });
    await page.emulateMediaType('print');
    await page.pdf({
      path: pdfPath,
      printBackground: true,
      preferCSSPageSize: true,
    });
  } finally {
    await browser.close();
  }
}

function sanitizeFileNameSegment(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'note';
}

function previewWorkspaceSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'note';
}

async function ensurePreviewWorkspace(noteId: string): Promise<{ tempDir: string }> {
  const rootDir = path.join(os.tmpdir(), 'documine-pdf-preview-cache', previewWorkspaceSegment(noteId));
  const rendersDir = path.join(rootDir, 'renders');
  await fs.mkdir(rendersDir, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(rendersDir, 'render-'));
  return { tempDir };
}

async function renderMarkdownToHtmlFile(input: ExportPdfInput, tempDir: string, htmlPath: string, options?: { signal?: AbortSignal }): Promise<{ markdown: string; css: string; html: string }> {
  const settings = mergeSettings(input.settings);
  const title = input.noteTitle || 'Untitled';
  const rewrittenMarkdown = rewriteMarkdownAssetPaths(prependExportHeader(input.markdown, title, settings), input.noteId, input.assetDirectory);
  const markdownPath = path.join(tempDir, 'note.md');
  const cssContent = buildPdfCss(title, settings);

  await fs.writeFile(markdownPath, rewrittenMarkdown, 'utf8');
  await markdownToHtmlString(markdownPath, cssContent, settings, settings.toc, tempDir, { signal: options?.signal }).then((html) => fs.writeFile(htmlPath, html, 'utf8'));
  const html = await fs.readFile(htmlPath, 'utf8');
  return { markdown: rewrittenMarkdown, css: cssContent, html };
}

export async function detectPdfExportCapabilities(): Promise<PdfExportCapabilities> {
  if (cachedCapabilities) {
    return cachedCapabilities;
  }

  const pandoc = await hasExecutable('pandoc');
  cachedCapabilities = {
    pandoc,
    browser: true,
    availableEngines: ['browser'],
    styles: [...PDF_STYLE_PRESETS],
    pageSizes: [...PDF_PAGE_SIZES],
    fontFamilies: [...PDF_FONT_FAMILIES],
    headerModes: [...PDF_HEADER_MODES],
    codeWrapModes: [...PDF_CODE_WRAP_MODES],
    imageAlignments: [...PDF_IMAGE_ALIGNMENTS],
  };
  return cachedCapabilities;
}

function resolvePdfEngine(_requested: PdfEngine, capabilities: PdfExportCapabilities): PdfEngine {
  if (!capabilities.browser) {
    throw new Error('No supported PDF engine found. Install a Chromium browser.');
  }
  return 'browser';
}

export async function renderMarkdownToExportHtml(input: ExportPdfInput): Promise<ExportHtmlPreviewResult> {
  const capabilities = await detectPdfExportCapabilities();
  if (!capabilities.pandoc) {
    throw new Error('pandoc is required but was not found in PATH.');
  }

  const settings = mergeSettings(input.settings);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'documine-export-preview-'));
  try {
    const htmlPath = path.join(tempDir, 'export.html');
    const result = await renderMarkdownToHtmlFile(input, tempDir, htmlPath, { signal: input.signal });
    return {
      markdown: result.markdown,
      css: result.css,
      html: result.html,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function renderMarkdownToPdfBuffer(input: ExportPdfInput): Promise<ExportPdfResult> {
  const totalStartedAt = performance.now();
  const capabilities = await detectPdfExportCapabilities();
  if (!capabilities.pandoc) {
    throw new Error('pandoc is required but was not found in PATH.');
  }

  const settings = mergeSettings(input.settings);
  resolvePdfEngine(settings.engine, capabilities);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'documine-pdf-'));
  try {
    const htmlPath = path.join(tempDir, 'export.html');
    const pdfPath = path.join(tempDir, 'export.pdf');
    const title = input.noteTitle || 'Untitled';

    const pandocStartedAt = performance.now();
    const { markdown, css, html } = await renderMarkdownToHtmlFile(input, tempDir, htmlPath, { signal: input.signal });
    input.onStageTiming?.('pandoc', performance.now() - pandocStartedAt);

    const browserStartedAt = performance.now();
    await htmlToPdfWithBrowser(htmlPath, pdfPath, input.signal);
    input.onStageTiming?.('browser', performance.now() - browserStartedAt);

    const pdf = await fs.readFile(pdfPath);
    input.onStageTiming?.('total', performance.now() - totalStartedAt);
    return {
      fileName: `${sanitizeFileNameSegment(title)}.pdf`,
      pdf,
      debug: { markdown, css, html },
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

export async function renderMarkdownToPdfPreview(input: ExportPdfInput): Promise<PdfPreviewResult> {
  const result = await renderMarkdownToPdfBuffer(input);
  return {
    fileName: result.fileName,
    pdf: result.pdf,
  };
}

export async function exportMarkdownToPdf(input: ExportPdfInput): Promise<ExportPdfResult> {
  return renderMarkdownToPdfBuffer(input);
}

export async function warmPdfPreviewEngine(): Promise<void> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--allow-file-access-from-files'],
  });
  await browser.close();
}
