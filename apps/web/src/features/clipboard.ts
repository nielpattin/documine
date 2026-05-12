import { type ClipboardEvent } from 'react';
import { TOKEN_COLORS, CODE_CHROME } from '@shared/code-block-style';

const CODE_CLIPBOARD_PRE_STYLE = `display:block;margin:0;white-space:pre;font-family:${CODE_CHROME.fontFamily};font-size:${CODE_CHROME.fontSize};line-height:14pt;color:${CODE_CHROME.color};background:transparent;text-align:left;tab-size:4;`;

const CODE_CLIPBOARD_TABLE_STYLE = 'width:100%;margin:0;border-collapse:collapse;border-spacing:0;';

const CODE_CLIPBOARD_CELL_STYLE = `background-color:${CODE_CHROME.backgroundColor};color:${CODE_CHROME.color};font-family:${CODE_CHROME.fontFamily};font-weight:400;font-size:${CODE_CHROME.fontSize};white-space:pre;text-align:left;vertical-align:top;padding:${CODE_CHROME.padding};border-radius:${CODE_CHROME.borderRadius};`;

const CODE_CLIPBOARD_CODE_STYLE = 'color:inherit;background:transparent;padding:0;font:inherit;';



function applyInlineCodeTokenStyles(root: HTMLElement) {
  for (const span of root.querySelectorAll('span[class]')) {
    for (const cls of span.classList) {
      const color = TOKEN_COLORS[cls];
      if (color) {
        span.setAttribute('style', `${span.getAttribute('style') || ''}${color.startsWith('font-') ? color : `color:${color};`}`);
      }
    }
  }
}

function normalizeCssColor(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('#')) {
    return trimmed;
  }

  const rgbMatch = trimmed.match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
  if (!rgbMatch) {
    return trimmed;
  }

  return `#${rgbMatch.slice(1, 4).map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`;
}

function normalizeCodeClipboardColors(root: HTMLElement) {
  root.querySelectorAll('span[style*="color"]').forEach((span) => {
    const element = span as HTMLElement;
    const styleColor = element.style.color;
    const color = normalizeCssColor(styleColor || element.getAttribute('style')?.match(/color:\s*([^;]+)/i)?.[1] || '');
    if (!color) {
      return;
    }
    const font = root.ownerDocument.createElement('font');
    font.setAttribute('color', color);
    font.setAttribute('style', `color:${color};`);
    while (element.firstChild) {
      font.appendChild(element.firstChild);
    }
    element.replaceWith(font);
  });
}

function buildCodeClipboardBlock(block: HTMLElement) {
  const doc = block.ownerDocument;
  const table = doc.createElement('table');
  table.style.cssText = CODE_CLIPBOARD_TABLE_STYLE;
  const tbody = doc.createElement('tbody');
  const row = doc.createElement('tr');
  const cell = doc.createElement('td');
  cell.style.cssText = CODE_CLIPBOARD_CELL_STYLE;
  const rawLineNodes = Array.from(block.querySelectorAll('span.line'));
  const lineNodes = rawLineNodes.length ? rawLineNodes : [block];
  let start = 0;
  let end = lineNodes.length;
  while (start < end && !(lineNodes[start].textContent || '').trim()) {
    start++;
  }
  while (end > start && !(lineNodes[end - 1].textContent || '').trim()) {
    end--;
  }

  cell.style.whiteSpace = 'pre';

  const lineHtmlList: string[] = [];
  for (const lineNode of lineNodes.slice(start, end)) {
    const html = (lineNode as HTMLElement).innerHTML;
    lineHtmlList.push(html || '&nbsp;');
  }
  cell.innerHTML = lineHtmlList.join('\n');

  row.appendChild(cell);
  tbody.appendChild(row);
  table.appendChild(tbody);
  return table;
}

function styleClipboardBlock(root: HTMLElement) {
  root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((heading) => {
    (heading as HTMLElement).style.cssText = 'font-family:Times New Roman,serif;color:#000000;font-weight:700;margin:0 0 12pt 0;line-height:1.2;';
  });
  root.querySelectorAll('p, li').forEach((node) => {
    (node as HTMLElement).style.cssText = 'font-family:Times New Roman,serif;color:#000000;font-size:12pt;line-height:1.45;text-align:left;';
  });
  root.querySelectorAll('ul, ol').forEach((list) => {
    (list as HTMLElement).style.cssText = 'font-family:Times New Roman,serif;color:#000000;font-size:12pt;line-height:1.45;margin:0 0 12pt 0;';
  });
  root.querySelectorAll('pre').forEach((pre) => {
    const codeClone = ((pre.querySelector('code') || pre).cloneNode(true)) as HTMLElement;
    applyInlineCodeTokenStyles(codeClone);
    normalizeCodeClipboardColors(codeClone);
    pre.replaceWith(buildCodeClipboardBlock(codeClone));
  });
  root.querySelectorAll('code').forEach((code) => {
    if (code.closest('pre') || code.closest('table') || code.closest('[data-documine-code-block]')) {
      return;
    }
    (code as HTMLElement).style.cssText = 'font-family:Consolas,monospace;color:#000000;background-color:#eeeeee;padding:0 2pt;font-size:10pt;';
  });
}

export async function copyRenderedPreviewToClipboard(iframe: HTMLIFrameElement | null) {
  const previewDocument = iframe?.contentDocument;
  if (!previewDocument?.body) {
    throw new Error('Print preview is not ready yet.');
  }

  const source = previewDocument.getElementById('documine-preview-source')
    || previewDocument.querySelector('.documine-preview-page-content')
    || previewDocument.body;
  const contentClone = source.cloneNode(true) as HTMLElement;
  contentClone.querySelectorAll('script, style, #documine-preview-pages, .documine-preview-pages, #documine-preview-measure').forEach((node) => node.remove());
  contentClone.removeAttribute('id');
  contentClone.removeAttribute('class');
  contentClone.style.cssText = 'font-family:Times New Roman,serif;color:#000000;font-size:12pt;line-height:1.45;text-align:left;background:#ffffff;';
  styleClipboardBlock(contentClone);

  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>${contentClone.outerHTML}</body></html>`;
  const text = contentClone.innerText || contentClone.textContent || '';

  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      }),
    ]);
    return;
  }

  await navigator.clipboard.writeText(text);
}

function appendInlineStyle(element: HTMLElement, style: string) {
  const existing = element.getAttribute('style')?.trim() || '';
  element.setAttribute('style', `${existing}${existing && !existing.endsWith(';') ? ';' : ''}${style}`);
}

function findPreviewCodeBlock(node: Node | null, root: HTMLElement) {
  let current = node instanceof Element ? node : node?.parentElement || null;
  while (current && root.contains(current)) {
    if (current.matches('pre, code.hljs, code.sourceCode, div.sourceCode pre')) {
      return current.closest('pre') || current;
    }
    current = current.parentElement;
  }
  return null;
}

function stylePreviewCodeClipboardBlock(root: HTMLElement) {
  const elements = [root, ...root.querySelectorAll<HTMLElement>('*')];
  for (const element of elements) {
    if (element.tagName === 'PRE') {
      appendInlineStyle(element, CODE_CLIPBOARD_PRE_STYLE);
    }
    if (element.tagName === 'CODE') {
      appendInlineStyle(element, CODE_CLIPBOARD_CODE_STYLE);
    }
    for (const className of element.classList) {
      const color = TOKEN_COLORS[className];
      if (color) {
        appendInlineStyle(element, color.startsWith('font-') ? color : `color:${color};`);
      }
    }
  }
}

function buildPreviewCodeClipboardHtml(block: Element) {
  const clonedBlock = block.cloneNode(true) as HTMLElement;
  stylePreviewCodeClipboardBlock(clonedBlock);

  return `<!--StartFragment-->${buildCodeClipboardBlock(clonedBlock).outerHTML}<!--EndFragment-->`;
}

export function handlePreviewCodeCopy(event: ClipboardEvent<HTMLDivElement>) {
  const root = event.currentTarget;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
    return;
  }

  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) {
    return;
  }

  const codeBlock = findPreviewCodeBlock(range.commonAncestorContainer, root);
  if (!codeBlock) {
    return;
  }

  event.clipboardData.setData('text/plain', selection.toString());
  event.clipboardData.setData('text/html', buildPreviewCodeClipboardHtml(codeBlock));
  event.preventDefault();
}
