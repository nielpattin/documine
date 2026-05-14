import hljs from "highlight.js";
import { marked, type Tokens } from "marked";
import sanitizeHtml from "sanitize-html";

import {
  buildPdfCss,
  highlightCodeBlocksWithShiki,
  mergeSettings,
  type PdfExportSettings,
} from "../pdf-export.js";
import { TOKEN_COLORS, CODE_CHROME, codePreStyle } from "../code-block-style.js";
import { escapeHtml } from "../shared.js";

// ---------------------------------------------------------------------------
// Marked setup
// ---------------------------------------------------------------------------

const codeRenderer = new marked.Renderer();
codeRenderer.code = ({ text, lang }: Tokens.Code) => {
  const language = (lang || "").trim().split(/\s+/)[0];
  if (language === "mermaid") {
    return `<pre class="mermaid">${escapeHtml(text)}</pre>`;
  }
  const validLanguage = language && hljs.getLanguage(language) ? language : null;
  const highlighted = validLanguage ? hljs.highlight(text, { language: validLanguage }).value : escapeHtml(text);
  const languageClass = validLanguage ? ` class="hljs language-${escapeHtml(validLanguage)}"` : ' class="hljs"';
  return `<pre><code${languageClass}>${highlighted}</code></pre>`;
};

marked.setOptions({
  gfm: true,
  breaks: false,
  renderer: codeRenderer,
});

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

export function applyPreviewImageAttributeHints(rawHtml: string) {
  return rawHtml.replace(
    /<p>(\s*<img\b[^>]*?)(?:\s*)\{([^{}]+)\}(\s*)<\/p>/gi,
    (_match, imgHtml: string, attrs: string, trailingSpace: string) => {
      const title = attrs.replace(/&quot;/g, '"').trim();
      if (!title) {
        return `<p>${imgHtml}${trailingSpace}</p>`;
      }
      if (/\btitle\s*=/.test(imgHtml)) {
        return `<p>${imgHtml}${trailingSpace}</p>`;
      }
      const escapedTitle = escapeHtml(title);
      const hintedImgHtml = imgHtml.replace(/\s*\/?>$/, (ending) => ` title="${escapedTitle}"${ending}`);
      return `<p>${hintedImgHtml}${trailingSpace}</p>`;
    },
  );
}

export function renderMarkdown(markdown: string) {
  const rawHtml = applyPreviewImageAttributeHints(marked.parse(markdown) as string);
  return sanitizeHtml(rawHtml, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat([
      "img",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "pre",
      "code",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "blockquote",
      "span",
    ]),
    allowedAttributes: {
      a: ["href", "name", "target", "rel"],
      img: ["src", "alt", "title"],
      code: ["class"],
      span: ["class"],
    },
    allowedClasses: {
      code: ["hljs", /^language-/],
      span: [/^hljs.*/],
      pre: ["mermaid"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
    },
  });
}

// ---------------------------------------------------------------------------
// Code block style inlining
// ---------------------------------------------------------------------------

export function inlineCodeBlockStyles(html: string, settings: PdfExportSettings): string {
  const PRE_BG = codePreStyle(settings.codeWrap === "wrap" ? "pre-wrap" : "pre");

  let result = html;

  result = result.replace(/<pre\b([^>]*)>/gi, (_, attrs) => {
    if (/style\s*=\s*["']/i.test(attrs)) {
      return `<pre${attrs.replace(/(style\s*=\s*["'])([^"']*)(["'])/i, `$1$2;${PRE_BG}$3`)}>`;
    }
    return `<pre${attrs} style="${PRE_BG}">`;
  });

  result = result.replace(/<span class="([^"]*)"([^>]*)>/gi, (_, classes, attrs) => {
    const classList = classes.split(/\s+/);
    let color: string | null = null;
    let isBold = false;
    let isItalic = false;
    for (const cls of classList) {
      if (cls === "hljs-strong") isBold = true;
      if (cls === "hljs-emphasis") isItalic = true;
      if (!color && TOKEN_COLORS[cls]) color = TOKEN_COLORS[cls];
    }
    let styleAdd = "";
    if (color) styleAdd += `color:${color};`;
    if (isBold) styleAdd += "font-weight:700;";
    if (isItalic) styleAdd += "font-style:italic;";

    if (!styleAdd) {
      return `<span class="${classes}"${attrs}>`;
    }

    if (/style\s*=\s*["']/i.test(attrs)) {
      return `<span class="${classes}"${attrs.replace(/(style\s*=\s*["'])([^"']*)(["'])/i, `$1$2;${styleAdd}$3`)}>`;
    }
    return `<span class="${classes}"${attrs} style="${styleAdd}">`;
  });

  return result;
}

// ---------------------------------------------------------------------------
// Print preview HTML
// ---------------------------------------------------------------------------

export async function renderPrintPreviewHtml(markdown: string, title: string, settings: unknown): Promise<string> {
  const merged = mergeSettings(settings);
  const body = renderMarkdown(markdown);
  const css = buildPdfCss(title, merged);
  const safeTitle = escapeHtml(title || "Untitled");
  const highlightedBody = await highlightCodeBlocksWithShiki(body, merged);
  const inlinedBody = inlineCodeBlockStyles(highlightedBody, merged);
  return [
    "<!DOCTYPE html>",
    "<html>",
    "<head>",
    `<meta charset="UTF-8">`,
    `<title>${safeTitle}</title>`,
    `<style>${css}</style>`,
    "</head>",
    `<body>${inlinedBody}</body>`,
    "</html>",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Preview scripts
// ---------------------------------------------------------------------------

function buildTokenStylesEntries(): string {
  return Object.entries(TOKEN_COLORS)
    .map(([cls, color]) => {
      if (cls.startsWith("hljs-")) {
        return `'${cls}': '${color.startsWith("font-") ? color : `color:${color};`}'`;
      }
      return `'${cls}': 'color:${color};'`;
    })
    .join(",\n    ");
}

export function buildPreviewPaginationScript(): string {
  return `<script>
(() => {
  const root = document.documentElement;
  const UNSPLITTABLE_TAGS = new Set(['H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'NAV', 'PRE', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'TH', 'TD', 'UL', 'OL', 'DL', 'DT', 'DD']);

  const readPx = (name, fallback) => {
    const raw = getComputedStyle(root).getPropertyValue(name).trim();
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  const debounce = (fn, delay) => {
    let timer = 0;
    return () => {
      if (timer) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(() => {
        timer = 0;
        fn();
      }, delay);
    };
  };

  const createPage = () => {
    const page = document.createElement('section');
    page.className = 'documine-preview-page';
    page.innerHTML = '<div class="documine-preview-page-content"></div>';
    return page;
  };

  const createMeasureBox = (pageWidth, margins) => {
    const box = document.createElement('div');
    box.className = 'documine-preview-measure';
    box.style.width = pageWidth + 'px';
    box.style.padding = margins.top + 'px ' + margins.right + 'px ' + margins.bottom + 'px ' + margins.left + 'px';
    box.style.boxSizing = 'border-box';
    box.style.position = 'absolute';
    box.style.left = '-10000px';
    box.style.top = '0';
    box.style.visibility = 'hidden';
    box.style.pointerEvents = 'none';
    box.style.overflow = 'visible';
    return box;
  };

  const state = {
    source: null,
    pages: null,
    measure: null,
  };

  const collectTextSegments = (node) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const segments = [];
    let total = 0;
    let current = walker.nextNode();
    while (current) {
      const text = current.nodeValue || '';
      if (text.length > 0) {
        segments.push({ node: current, start: total, end: total + text.length });
        total += text.length;
      }
      current = walker.nextNode();
    }
    return { segments, length: total };
  };

  const pointAtOffset = (textInfo, offset) => {
    if (!textInfo.segments.length) {
      return null;
    }
    if (offset <= 0) {
      return { node: textInfo.segments[0].node, offset: 0 };
    }
    for (const segment of textInfo.segments) {
      if (offset <= segment.end) {
        return { node: segment.node, offset: offset - segment.start };
      }
    }
    const last = textInfo.segments[textInfo.segments.length - 1];
    return { node: last.node, offset: (last.node.nodeValue || '').length };
  };

  const cloneFragment = (node, textInfo, startOffset, endOffset) => {
    const startPoint = pointAtOffset(textInfo, startOffset);
    const endPoint = pointAtOffset(textInfo, endOffset);
    const range = document.createRange();
    range.selectNodeContents(node);
    if (startPoint) {
      range.setStart(startPoint.node, startPoint.offset);
    }
    if (endPoint) {
      range.setEnd(endPoint.node, endPoint.offset);
    }
    return range.cloneContents();
  };

  const setSplitMargins = (element, kind) => {
    if (!(element instanceof HTMLElement)) {
      return;
    }
    if (kind === 'start') {
      element.style.marginBottom = '0';
    } else if (kind === 'continue') {
      element.style.marginTop = '0';
    }
  };

  const buildSplitNode = (node, fragment, kind) => {
    const clone = node.cloneNode(false);
    clone.appendChild(fragment);
    setSplitMargins(clone, kind);
    return clone;
  };

  const measureNode = (node) => {
    state.measure.innerHTML = '';
    state.measure.appendChild(node.cloneNode(true));
    return state.measure.scrollHeight;
  };

  const splitNodeToFit = (node, availableHeight) => {
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return null;
    }

    if (UNSPLITTABLE_TAGS.has(node.tagName)) {
      return null;
    }

    const textInfo = collectTextSegments(node);
    if (!textInfo.length) {
      return null;
    }

    let low = 1;
    let high = textInfo.length;
    let best = 0;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const firstFragment = cloneFragment(node, textInfo, 0, mid);
      const firstNode = buildSplitNode(node, firstFragment, 'start');
      const height = measureNode(firstNode);
      if (height <= availableHeight) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }

    if (!best || best >= textInfo.length) {
      return null;
    }

    const firstFragment = cloneFragment(node, textInfo, 0, best);
    const secondFragment = cloneFragment(node, textInfo, best, textInfo.length);
    return {
      first: buildSplitNode(node, firstFragment, 'start'),
      second: buildSplitNode(node, secondFragment, 'continue'),
    };
  };

  const paginate = () => {
    if (!state.source || !state.pages || !state.measure) {
      return;
    }

    const pageHeight = readPx('--documine-page-height', 1123);
    const margins = {
      top: readPx('--documine-page-margin-top', 96),
      right: readPx('--documine-page-margin-right', 96),
      bottom: readPx('--documine-page-margin-bottom', 96),
      left: readPx('--documine-page-margin-left', 96),
    };
    const pageWidth = readPx('--documine-page-width', 794);
    // Leave a tiny safety buffer so the preview matches Chromium's print pagination.
    const availableHeight = Math.max(1, pageHeight - 4);

    state.pages.innerHTML = '';
    state.measure.innerHTML = '';
    state.measure.style.width = pageWidth + 'px';
    state.measure.style.padding = margins.top + 'px ' + margins.right + 'px ' + margins.bottom + 'px ' + margins.left + 'px';

    let currentPage = createPage();
    let content = currentPage.querySelector('.documine-preview-page-content');
    state.pages.appendChild(currentPage);

    for (const originalNode of Array.from(state.source.children)) {
      let pending = originalNode.cloneNode(true);

      while (pending) {
        state.measure.appendChild(pending.cloneNode(true));

        if (state.measure.scrollHeight <= availableHeight) {
          content.appendChild(pending);
          pending = null;
          continue;
        }

        state.measure.removeChild(state.measure.lastElementChild);

        if (content.childNodes.length > 0) {
          currentPage = createPage();
          content = currentPage.querySelector('.documine-preview-page-content');
          state.pages.appendChild(currentPage);
          state.measure.innerHTML = '';
          continue;
        }

        const split = splitNodeToFit(pending, availableHeight);
        if (!split) {
          content.appendChild(pending);
          state.measure.appendChild(pending.cloneNode(true));
          pending = null;
          continue;
        }

        content.appendChild(split.first);
        state.measure.appendChild(split.first.cloneNode(true));
        pending = split.second;
      }
    }
  };

  const initialize = () => {
    const body = document.body;
    if (!body) {
      return;
    }

    if (!state.source || !state.pages) {
      const source = document.createElement('div');
      source.id = 'documine-preview-source';
      source.className = 'documine-preview-source';
      for (const child of Array.from(body.children)) {
        source.appendChild(child.cloneNode(true));
      }

      body.innerHTML = '';
      body.appendChild(source);

      const pages = document.createElement('div');
      pages.id = 'documine-preview-pages';
      pages.className = 'documine-preview-pages';
      body.appendChild(pages);

      state.source = source;
      state.pages = pages;
      state.measure = createMeasureBox(
        readPx('--documine-page-width', 794),
        {
          top: readPx('--documine-page-margin-top', 96),
          right: readPx('--documine-page-margin-right', 96),
          bottom: readPx('--documine-page-margin-bottom', 96),
          left: readPx('--documine-page-margin-left', 96),
        },
      );
      body.appendChild(state.measure);
    }

    paginate();
  };

  const rerender = debounce(initialize, 50);
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    queueMicrotask(initialize);
  } else {
    window.addEventListener('load', initialize, { once: true });
  }
  window.addEventListener('resize', rerender);
  document.addEventListener('load', (event) => {
    if (event.target instanceof HTMLImageElement) {
      rerender();
    }
  }, true);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(rerender).catch(() => {});
  }
})();
</script>`;
}

export function buildPreviewClipboardScript(): string {
  return `<script>
(() => {
  const TOKEN_STYLES = {
    ${buildTokenStylesEntries()}
  };

  document.addEventListener('copy', (event) => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
      return;
    }

    const range = selection.getRangeAt(0);
    const pre = range.commonAncestorContainer instanceof Element
      ? range.commonAncestorContainer.closest('pre')
      : range.commonAncestorContainer.parentElement?.closest('pre');
    if (!pre) {
      return;
    }

    const codeEl = pre.querySelector('code') || pre;
    const cloned = codeEl.cloneNode(true);

    for (const span of cloned.querySelectorAll('span[class]')) {
      for (const cls of span.classList) {
        const color = TOKEN_STYLES[cls];
        if (color) {
          span.setAttribute('style', (span.getAttribute('style') || '') + color);
        }
      }
    }

    const wrapper = document.createElement('pre');
    wrapper.style.cssText = 'margin:0;color:${CODE_CHROME.color};background-color:${CODE_CHROME.backgroundColor};font-family:${CODE_CHROME.fontFamily};font-weight:normal;font-size:${CODE_CHROME.fontSize};line-height:14pt;white-space:pre;padding:${CODE_CHROME.padding};border-radius:${CODE_CHROME.borderRadius};';

    const code = document.createElement('code');
    code.style.cssText = 'color:inherit;background:transparent;font:inherit;white-space:inherit;padding:0;';
    code.innerHTML = cloned.innerHTML;
    wrapper.appendChild(code);

    event.clipboardData.setData('text/html', wrapper.outerHTML);
    event.clipboardData.setData('text/plain', selection.toString());
    event.preventDefault();
  });
})();
</script>`;
}

export function buildCopyButtonsScript(): string {
  return `<script>
(() => {
  const STYLE = document.createElement('style');
  STYLE.textContent = \`
    .documine-cb-wrap { position:relative; display:block; }
    .documine-cb-wrap:hover .documine-cb-btn { opacity:0.7; }
    .documine-cb-btn {
      position:absolute; top:0; right:0;
      border:0; background:transparent;
      color:#d4d4d4; cursor:pointer;
      font-family:system-ui,sans-serif; font-size:11px;
      padding:4px 8px; opacity:0;
      transition:opacity 0.15s;
      z-index:1; line-height:1;
    }
    .documine-cb-btn:hover { opacity:1 !important; background:rgba(255,255,255,0.08); }
    .documine-cb-btn.copied { opacity:1 !important; }
    .documine-cb-btn.failed { opacity:1 !important; }
  \`;
  document.head.appendChild(STYLE);

  const TOKEN_STYLES = {
    ${buildTokenStylesEntries()}
  };

  function buildClipboardHtml(pre) {
    const codeEl = pre.querySelector('code') || pre;
    const cloned = codeEl.cloneNode(true);
    for (const span of cloned.querySelectorAll('span[class]')) {
      for (const cls of span.classList) {
        const color = TOKEN_STYLES[cls];
        if (color) {
          span.setAttribute('style', (span.getAttribute('style') || '') + color);
        }
      }
    }
    const lines = [];
    cloned.querySelectorAll('span.line').forEach(line => {
      lines.push(line.innerHTML || '&nbsp;');
    });
    if (!lines.length) {
      lines.push(cloned.innerHTML || '&nbsp;');
    }
    const cellHtml = lines.join('\\n');
    const tableHtml = '<table style="width:100%;margin:0;border-collapse:collapse;border-spacing:0"><tbody><tr><td style="background-color:${CODE_CHROME.backgroundColor};color:${CODE_CHROME.color};font-family:${CODE_CHROME.fontFamily};font-weight:400;font-size:${CODE_CHROME.fontSize};white-space:pre;text-align:left;vertical-align:top;padding:${CODE_CHROME.padding};border-radius:${CODE_CHROME.borderRadius}">' + cellHtml + '</td></tr></tbody></table>';
    return tableHtml;
  }

  function resetBtn(btn) {
    setTimeout(function() { btn.textContent = 'Copy'; btn.classList.remove('copied', 'failed'); }, 2000);
  }

  async function copyCodeToClipboard(copyHtml, copyText, btn) {
    btn.textContent = 'Copying...';
    btn.classList.add('copied');
    try {
      if (typeof ClipboardItem !== 'undefined' && navigator.clipboard && navigator.clipboard.write) {
        await navigator.clipboard.write([
          new ClipboardItem({
            'text/html': new Blob([copyHtml], { type: 'text/html' }),
            'text/plain': new Blob([copyText], { type: 'text/plain' }),
          }),
        ]);
        btn.textContent = 'Copied!';
        btn.classList.add('copied');
        resetBtn(btn);
        return;
      }
    } catch (_0) {}
    try {
      const container = document.createElement('div');
      container.contentEditable = 'true';
      container.style.cssText = 'position:fixed;left:-9999px;top:0;pointer-events:none;';
      container.innerHTML = copyHtml;
      document.body.appendChild(container);
      const range = document.createRange();
      range.selectNodeContents(container);
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); sel.addRange(range); }
      document.execCommand('copy');
      document.body.removeChild(container);
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
      resetBtn(btn);
      return;
    } catch (_1) {}
    try {
      await navigator.clipboard.writeText(copyText);
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
    } catch (_2) {
      btn.textContent = 'Failed';
      btn.classList.add('failed');
    }
    resetBtn(btn);
  }

  function wrapUnmatchedPreBlocks() {
    document.querySelectorAll('#documine-preview-pages pre.shiki:not([data-documine-copy-button]), #documine-preview-pages pre.documine-shiki:not([data-documine-copy-button])').forEach(pre => {
      pre.dataset.documineCopyButton = '1';
      const wrap = document.createElement('div');
      wrap.className = 'documine-cb-wrap';
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
      const btn = document.createElement('button');
      btn.className = 'documine-cb-btn';
      btn.textContent = 'Copy';
      wrap.appendChild(btn);
    });
  }

  function initWhenPagesReady() {
    var wrapTimer = 0;
    function debouncedWrap() {
      if (wrapTimer) clearTimeout(wrapTimer);
      wrapTimer = setTimeout(function() {
        wrapTimer = 0;
        if (document.getElementById('documine-preview-pages')) {
          wrapUnmatchedPreBlocks();
        }
      }, 30);
    }
    function cancelWrap() { if (wrapTimer) { clearTimeout(wrapTimer); wrapTimer = 0; } }
    window.addEventListener('beforeunload', cancelWrap, { once: true });
    const pages = document.getElementById('documine-preview-pages');
    if (pages) {
      wrapUnmatchedPreBlocks();
    }
    const obs = new MutationObserver(debouncedWrap);
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }

  initWhenPagesReady();

  document.addEventListener('click', async function(e) {
    const btn = e.target.closest('.documine-cb-btn');
    if (!btn) return;
    const wrap = btn.closest('.documine-cb-wrap');
    if (!wrap) return;
    const pre = wrap.querySelector('pre');
    if (!pre) return;
    e.preventDefault();
    e.stopPropagation();
    await copyCodeToClipboard(buildClipboardHtml(pre), (pre.textContent || '').trim(), btn);
  }, true);
})();
</script>`;
}

export function injectPreviewBaseHref(html: string, baseHref: string) {
  const baseTag = `<base href="${escapeHtml(baseHref)}">`;
  const previewScript = buildPreviewPaginationScript() + buildPreviewClipboardScript() + buildCopyButtonsScript();

  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b[^>]*>/i, (headTag) => `${headTag}\n    ${baseTag}\n    ${previewScript}`);
  }

  return html;
}
