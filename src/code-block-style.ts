/**
 * Single source of truth for DocuMine code block styling.
 * Used by PDF export, preview HTML, and clipboard copy.
 */

// Shared token color mapping.
// Matches Shiki's `dark-plus` theme colors for Pandoc (`.sourceCode .kw`, etc.)
// and Highlight.js (`.hljs-keyword`, etc.) classes.
export const TOKEN_COLORS: Record<string, string> = {
  // Keywords / Storage / Selector
  kw: "#569cd6",
  st: "#ce9178",
  co: "#6a9955",
  fu: "#dcdcaa",
  ot: "#9cdcfe",
  dt: "#4ec9b0",
  dv: "#b5cea8",
  bn: "#b5cea8",
  fl: "#b5cea8",
  ch: "#ce9178",
  va: "#9cdcfe",
  ss: "#ce9178",
  op: "#d4d4d4",
  er: "#f44747",
  an: "#6a9955",
  al: "#ce9178",
  at: "#4fc1ff",
  cf: "#c586c0",
  sc: "#ce9178",
  vs: "#ce9178",
  sh: "#ce9178",

  // Highlight.js equivalents
  "hljs-keyword": "#569cd6",
  "hljs-selector-tag": "#569cd6",
  "hljs-built_in": "#569cd6",
  "hljs-name": "#569cd6",
  "hljs-literal": "#569cd6",
  "hljs-string": "#ce9178",
  "hljs-title": "#dcdcaa",
  "hljs-section": "#dcdcaa",
  "hljs-attribute": "#dcdcaa",
  "hljs-comment": "#6a9955",
  "hljs-quote": "#6a9955",
  "hljs-number": "#b5cea8",
  "hljs-symbol": "#b5cea8",
  "hljs-bullet": "#b5cea8",
  "hljs-type": "#4ec9b0",
  "hljs-variable": "#9cdcfe",
  "hljs-template-variable": "#9cdcfe",

  // Misc
  "hljs-emphasis": "font-style: italic",
  "hljs-strong": "font-weight: 700",
};

// Common code block "chrome" styles.
export const CODE_CHROME = {
  fontFamily: "Consolas, monospace",
  fontSize: "10pt",
  lineHeight: "1.45",
  backgroundColor: "#1e1e1e",
  color: "#d4d4d4",
  borderRadius: "0", // Removed as requested
  padding: "0", // Removed as requested
  webkitPrintColorAdjust: "exact",
  printColorAdjust: "exact",
};

// Generates inline style string for pre elements.
export function codePreStyle(wrap: "pre" | "pre-wrap" = "pre"): string {
  const wrapStyles =
    wrap === "pre-wrap"
      ? ["overflow-x:hidden", "overflow-wrap:anywhere", "word-break:break-word"]
      : ["overflow-x:auto"];

  return [
    `white-space:${wrap}`,
    ...wrapStyles,
    `border-radius:${CODE_CHROME.borderRadius}`,
    `padding:${CODE_CHROME.padding}`,
    `font-family:${CODE_CHROME.fontFamily}`,
    `font-size:${CODE_CHROME.fontSize}`,
    `line-height:${CODE_CHROME.lineHeight}`,
    `-webkit-print-color-adjust:${CODE_CHROME.webkitPrintColorAdjust}`,
    `print-color-adjust:${CODE_CHROME.printColorAdjust}`,
    `background-color:${CODE_CHROME.backgroundColor}`,
    `color:${CODE_CHROME.color}`,
  ].join(";");
}

// Generates inline style string for code elements inside pre.
export function codeCodeStyle(): string {
  return "font-family:inherit;font-size:inherit;background:transparent;color:inherit;";
}
