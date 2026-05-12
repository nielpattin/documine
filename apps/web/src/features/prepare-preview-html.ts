export function preparePreviewHtml(html: string) {
  if (!html || typeof window === 'undefined' || typeof DOMParser === 'undefined') {
    return html;
  }

  const document = new DOMParser().parseFromString(html, 'text/html');
  const images = Array.from(document.querySelectorAll('img'));
  for (const image of images) {
    let sibling: ChildNode | null = image.nextSibling;
    while (sibling && sibling.nodeType === Node.TEXT_NODE) {
      const text = sibling.textContent || '';
      const match = text.match(/^\s*\{([^{}]+)\}(.*)$/s);
      if (!match) {
        break;
      }
      const hint = match[1]?.trim();
      if (hint && !image.getAttribute('title')) {
        image.setAttribute('title', hint);
      }
      const rest = match[2] || '';
      if (rest.trim()) {
        sibling.textContent = rest;
        break;
      }
      const nextSibling = sibling.nextSibling;
      sibling.parentNode?.removeChild(sibling);
      sibling = nextSibling;
    }
  }

  return document.body.innerHTML;
}
