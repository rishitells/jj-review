// Highlights files for the build with Shiki, in a light and a dark theme at once.
//
// Reads {"items": [{"id", "lang", "text"}]} on stdin and writes {"lines": {id: [html per line]}, "css": "..."} on
// stdout. Each distinct colouring becomes one short class (h0, h1, ...), so a page with thousands of lines carries its
// colours once, in CSS, instead of on every token.
import { bundledLanguages, createHighlighter } from "shiki";

const THEMES = { light: "github-light-default", dark: "github-dark-default" };

const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { items } = JSON.parse(Buffer.concat(chunks).toString("utf8"));

const langOf = (lang) => (lang in bundledLanguages ? lang : "text");
const langs = [...new Set(items.map(({ lang }) => langOf(lang)).filter((l) => l !== "text"))];
const highlighter = await createHighlighter({ themes: Object.values(THEMES), langs });

const classes = new Map();
const classFor = ({ light, dark }) => {
  const key = `${light.color}|${dark.color}|${light.fontStyle}`;
  if (!classes.has(key)) classes.set(key, { name: `h${classes.size}`, light, dark });
  return classes.get(key).name;
};

const lines = {};
for (const { id, lang, text } of items) {
  const tokens = highlighter.codeToTokensWithThemes(text, { lang: langOf(lang), themes: THEMES });
  lines[id] = tokens.map((line) => {
    let html = "", open = null, buffer = "";
    const flush = () => { if (buffer) html += open ? `<span class="${open}">${esc(buffer)}</span>` : esc(buffer); buffer = ""; };
    for (const token of line) {
      const name = classFor(token.variants);
      if (name !== open) { flush(); open = name; }
      buffer += token.content;
    }
    flush();
    return html;
  });
}

// Fresh's theme switch: light on bare :root, dark under the system preference unless the page is set to light, and
// under an explicit dark choice.
const style = (v) => `color:${v.color}` + (v.fontStyle & 1 ? ";font-style:italic" : "") + (v.fontStyle & 2 ? ";font-weight:600" : "");
const rules = (scope, side) => [...classes.values()].map((c) => `${scope}.cn-ln .${c.name}{${style(c[side])}}`).join("\n");
const css = [
  rules("", "light"),
  `@media (prefers-color-scheme: dark) {\n${rules(':root:not([data-theme="light"]) ', "dark")}\n}`,
  rules(':root[data-theme="dark"] ', "dark"),
].join("\n");

process.stdout.write(JSON.stringify({ lines, css }));
