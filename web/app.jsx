import { parseDiffFromFile } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "@pierre/words/react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";

import { THEME_GROUPS, THEMES, themeOf } from "./themes/themes.js";

// The page asks the review server for its data, and hears from it when jj records an operation.
let SETTINGS = null;

const GIT_STATUS = { added: "added", deleted: "deleted", modified: "modified", renamed: "renamed", copied: "added" };

// Browser storage can be missing or refuse writes (private windows, blocked site data): the page works without it.
const stored = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
};
const store = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};

// Viewed marks are kept per change id as { path: diff signature }: a file stays viewed until its diff changes, even
// when the change is rewritten around it.
const marksCache = new Map();
const marksKey = (changeId) => `jj-review:viewed:${SETTINGS.repo}:${changeId}`;
const marksOf = (changeId) => {
  if (!marksCache.has(changeId)) marksCache.set(changeId, stored(marksKey(changeId), {}));
  return marksCache.get(changeId);
};
const viewedIn = (change) => new Set(change.files.filter((f) => marksOf(change.change)[f.path] === f.sig).map((f) => f.path));

const editorUrl = (path, line) =>
  SETTINGS.editor.replace("{path}", encodeURI(`${SETTINGS.workspace}/${path}`).replace(/^\//, "")) +
  (line ? `:${line}` : "");

const openInEditor = (path, line) => {
  const link = document.createElement("a");
  link.href = editorUrl(path, line);
  link.click();
};

// A file's parsed diff, kept while its diff stays the same (its signature), so a live update parses only what changed.
const parsedCache = new Map();
function parsedDiff(file) {
  let parsed = parsedCache.get(file.sig);
  if (!parsed) {
    parsed = parseDiffFromFile({ name: file.oldPath ?? file.path, contents: file.old }, { name: file.path, contents: file.new });
    parsedCache.set(file.sig, parsed);
  }
  return parsed;
}

const isMarkdown = (path) => /\.(md|markdown)$/i.test(path);

function ChangeId({ change }) {
  return (
    <span className="cid">
      <b>{change.prefix}</b>
      {change.change.slice(change.prefix.length)}
    </span>
  );
}

const TREE_CSS = [
  "button { font-weight: inherit; }",
  '[data-item-section="decoration"] { color: var(--green); font-weight: 600; }',
  // Names read in the page's ink; the status letter beside them carries the colour.
  '[data-item-section="content"] { color: var(--trees-fg); }',
  "[data-file-tree-search-container] { padding: 2px 8px 10px; }",
  "[data-file-tree-search-input] { height: 30px; box-sizing: border-box; padding: 0 10px; border: 1px solid var(--line);",
  "  border-radius: 6px; background: var(--bg); color: var(--text); font: 450 13px/1 var(--font); box-shadow: none; }",
  "[data-file-tree-search-input]::placeholder { color: var(--text-3); }",
  "[data-file-tree-search-input]:is(:focus, :focus-visible) { outline: none !important; border-color: var(--bar);",
  "  box-shadow: 0 0 0 1px var(--bar) !important; }",
].join("\n");

function Tree({ change, viewed, onOpen }) {
  // The tree reads the viewed set when it draws a row.
  const viewedNow = useRef(viewed);
  viewedNow.current = viewed;
  const filesNow = useRef(change.files);
  filesNow.current = change.files;
  const paths = change.files.map((f) => f.path).join("\n");
  const statuses = change.files.map((f) => GIT_STATUS[f.status] ?? "modified").join("\n");
  const viewedPaths = [...viewed].sort().join("\n");
  const { model } = useFileTree({
    paths: change.files.map((f) => f.path),
    gitStatus: change.files.map((f) => ({ path: f.path, status: GIT_STATUS[f.status] ?? "modified" })),
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    search: true,
    unsafeCSS: TREE_CSS,
    renderRowDecoration: ({ item }) =>
      item.kind === "file" && viewedNow.current.has(item.path) ? { text: "✓", title: "Viewed" } : null,
    onSelectionChange: (selected) => {
      const file = selected.find((p) => filesNow.current.some((f) => f.path === p));
      if (file) onOpen(file);
    },
  });
  const shownPaths = useRef(paths);
  useEffect(() => {
    const list = paths.split("\n");
    if (shownPaths.current !== paths) {
      shownPaths.current = paths;
      model.resetPaths(list);
    }
    // Setting identical git status doesn't redraw rows, so it's cleared and set again (viewed ticks follow).
    const kinds = statuses.split("\n");
    model.setGitStatus([]);
    model.setGitStatus(list.map((path, i) => ({ path, status: kinds[i] })));
  }, [model, paths, statuses, viewedPaths]);
  return <FileTree model={model} className="tree" />;
}

const paragraphs = (text) => text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);

const baseOptions = {
  stickyHeader: true,
  lineDiffType: "word",
  preferredHighlighter: "highlights",
  lineHoverHighlight: "number",
  // Each file reads as one block: its header is a tinted band with a rule under it (the box is styled on the page).
  unsafeCSS:
    "[data-diffs-header] { background: var(--file-band); box-shadow: inset 0 -1px 0 var(--line); } [data-title] { font-weight: 500; }",
};

// One options object per file and display combination, so a file's diff sees the same object until something changes.
const optionsCache = new Map();
function optionsFor(path, collapsed, { diffStyle, wrap, expandAll }, themeId, mode) {
  const key = `${path}\n${collapsed}:${diffStyle}:${wrap}:${expandAll}:${themeId}:${mode}`;
  if (!optionsCache.has(key)) {
    const { light, dark } = themeOf(themeId);
    optionsCache.set(key, {
      ...baseOptions,
      theme: { light: light.theme, dark: dark.theme },
      themeType: mode,
      diffStyle,
      overflow: wrap ? "wrap" : "scroll",
      expandUnchanged: expandAll,
      collapsed,
      // A line number opens the file at that line. Removed lines aren't in the file any more, so they open it at the top.
      onLineNumberClick: (props) => openInEditor(path, props.annotationSide === "deletions" ? undefined : props.lineNumber),
    });
  }
  return optionsCache.get(key);
}

// About how tall a file's diff draws (header, rows of 24px, a separator per hunk), held until it is drawn.
function estimatedHeight(fileDiff, folded, diffStyle) {
  if (folded) return 42;
  const rows = fileDiff.hunks.reduce((n, h) => n + (diffStyle === "split" ? h.splitLineCount : h.unifiedLineCount), 0);
  return 42 + rows * 24 + fileDiff.hunks.length * 32;
}

// A file is drawn once it comes near the screen, and stays drawn: a long change doesn't draw every file up front.
function useNearScreen() {
  const [near, setNear] = useState(false);
  const ref = (el) => {
    if (!el || near) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "1200px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  };
  return [near, ref];
}

function FileBlock({ file, display, themeId, mode, viewed, previewed, onToggleViewed, onTogglePreview }) {
  const [near, ref] = useNearScreen();
  // A file folds when it's viewed; the chevron overrides that either way until Viewed is toggled again.
  const [fold, setFold] = useState(null);
  useEffect(() => setFold(null), [viewed]);
  const folded = fold ?? viewed;
  const fileDiff = parsedDiff(file);
  const markdown = isMarkdown(file.path);
  const showPreview = markdown && previewed && !folded;
  return (
    <section className="file" data-path={file.path} data-preview={showPreview || undefined} data-folded={folded || undefined} ref={ref}>
      {near ? (
        <FileDiff
          fileDiff={fileDiff}
          options={optionsFor(file.path, folded || showPreview, display, themeId, mode)}
          renderHeaderPrefix={() => (
            <button
              type="button"
              className="fold"
              aria-expanded={!folded}
              aria-label={folded ? `Expand ${file.path}` : `Collapse ${file.path}`}
              title={folded ? "Expand file" : "Collapse file"}
              onClick={() => setFold(!folded)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m6 4 4 4-4 4" />
              </svg>
            </button>
          )}
          renderHeaderMetadata={() => (
            <span className="file-actions">
              {markdown && (
                <span className="show" role="group" aria-label="Show">
                  <Toggle label="Diff" pressed={!previewed} onChange={() => onTogglePreview(file.path, false)} />
                  <Toggle label="Preview" pressed={previewed} onChange={() => onTogglePreview(file.path, true)} />
                </span>
              )}
              <button
                type="button"
                className="viewed"
                aria-pressed={viewed}
                title={viewed ? "Mark as not viewed" : "Mark as viewed and fold the file"}
                onClick={() => onToggleViewed(file.path)}
              >
                <span className="box" aria-hidden="true">
                  <svg viewBox="0 0 16 16">
                    <path d="m4 8.5 2.5 2.5 5.5-6" />
                  </svg>
                </span>
                Viewed
              </button>
              <a className="open" href={editorUrl(file.path)} title={`Open ${file.path} in ${SETTINGS.editorName}`}>
                Open in {SETTINGS.editorName}
              </a>
            </span>
          )}
        />
      ) : (
        <div style={{ height: estimatedHeight(fileDiff, folded, display.diffStyle) }} />
      )}
      {near && showPreview && (
        <Markdown className="preview" mode="static">
          {file.status === "deleted" ? file.old : file.new}
        </Markdown>
      )}
    </section>
  );
}

// Only the open change's files keep a parsed diff and options: the caches follow the change on screen.
function forgetOthers(files) {
  const sigs = new Set(files.map((f) => f.sig));
  for (const sig of parsedCache.keys()) if (!sigs.has(sig)) parsedCache.delete(sig);
  const paths = new Set(files.map((f) => f.path));
  for (const key of optionsCache.keys()) if (!paths.has(key.slice(0, key.indexOf("\n")))) optionsCache.delete(key);
}

function Diffs({ change, viewerRef, display, themeId, mode, viewed, onToggleViewed }) {
  useEffect(() => forgetOthers(change.files), [change]);
  // Markdown files open in Preview; these are the ones switched to Diff.
  const [diffed, setDiffed] = useState(() => new Set());
  const togglePreview = (path, on) =>
    setDiffed((current) => {
      const next = new Set(current);
      if (on) next.delete(path);
      else next.add(path);
      return next;
    });
  return (
    <div className="diffs" ref={viewerRef}>
      {change.files
        .filter((f) => !f.binary)
        .map((f) => (
          <FileBlock
            key={f.path}
            file={f}
            display={display}
            themeId={themeId}
            mode={mode}
            viewed={viewed.has(f.path)}
            previewed={!diffed.has(f.path)}
            onToggleViewed={onToggleViewed}
            onTogglePreview={togglePreview}
          />
        ))}
    </div>
  );
}

function Toggle({ label, pressed, onChange }) {
  return (
    <button type="button" aria-pressed={pressed} onClick={() => onChange(!pressed)}>
      {label}
    </button>
  );
}

// A theme's look in a few lines of code: its background with a keyword, a string and a function in its colours.
function Swatch({ side }) {
  return (
    <span className="swatch" style={{ background: side.bg }} aria-hidden="true">
      <i style={{ background: side.kw, width: "45%" }} />
      <i style={{ background: side.str, width: "75%" }} />
      <i style={{ background: side.fn, width: "60%" }} />
    </span>
  );
}

function ThemePair({ theme }) {
  return (
    <span className="pair">
      <Swatch side={theme.light} />
      <Swatch side={theme.dark} />
    </span>
  );
}

const MODES = [
  { id: "system", label: "System", icon: <path d="M2.5 3.5h11v7h-11zM6 13.5h4M8 10.5v3" /> },
  { id: "light", label: "Light", icon: <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" /> },
  { id: "dark", label: "Dark", icon: <path d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5z" /> },
];

const chevron = (
  <svg className="chevron" viewBox="0 0 16 16" aria-hidden="true">
    <path d="m5 6.5 3-3 3 3M5 9.5l3 3 3-3" />
  </svg>
);

// The theme dropdown at the foot of the sidebar: it opens upwards, with the mode (System, Light, Dark) on top and the
// themes grouped by feel, each with its light and dark preview. In the list, arrow keys, Home and End move, a letter
// jumps to the next theme starting with it, Enter picks; Escape closes, and so does focus leaving the picker. A mouse
// press inside the picker never moves focus (the list keeps it, as in a native menu), so every browser agrees on
// where focus is and a click outside is focus leaving.
function ThemePicker({ value, onChange, mode, onMode }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(value);
  const root = useRef(null);
  const trigger = useRef(null);
  const list = useRef(null);
  const current = themeOf(value);

  const show = () => {
    setActive(current.id);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  const pick = (id) => {
    onChange(id);
    close();
  };
  const moveTo = (id) => {
    setActive(id);
    list.current?.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: "nearest" });
  };

  useEffect(() => {
    if (!open) return;
    list.current?.focus();
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "center" });
  }, [open]);

  const onListKey = (event) => {
    const at = THEMES.findIndex((t) => t.id === active);
    const go = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: THEMES.length - 1 }[event.key];
    if (go !== undefined) {
      event.preventDefault();
      moveTo(THEMES[Math.max(0, Math.min(THEMES.length - 1, go))].id);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      pick(active);
    } else if (event.key.length === 1 && /\S/.test(event.key)) {
      const letter = event.key.toLowerCase();
      const next = [...THEMES.slice(at + 1), ...THEMES.slice(0, at + 1)].find((t) => t.name.toLowerCase().startsWith(letter));
      if (next) moveTo(next.id);
    }
  };

  return (
    <div
      className="theme-picker"
      ref={root}
      onMouseDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (open && event.key === "Escape") {
          event.preventDefault();
          close();
        }
      }}
      onBlur={(event) => {
        if (open && !root.current?.contains(event.relatedTarget)) setOpen(false);
      }}
    >
      {open && (
        <div className="theme-pop">
          <div className="theme-panel">
            <div className="mode" role="group" aria-label="Mode">
              {MODES.map((m) => (
                <button key={m.id} type="button" aria-pressed={mode === m.id} onClick={() => onMode(m.id)}>
                  <svg viewBox="0 0 16 16" aria-hidden="true">
                    {m.icon}
                  </svg>
                  {m.label}
                </button>
              ))}
            </div>
            <ul
              ref={list}
              id="theme-list"
              role="listbox"
              tabIndex={-1}
              aria-label="Theme"
              aria-activedescendant={`theme-${active}`}
              onKeyDown={onListKey}
            >
              {THEME_GROUPS.map((group) => (
                <li key={group.name} role="presentation">
                  <p className="theme-group" id={`theme-group-${group.name}`}>
                    {group.name}
                  </p>
                  <ul role="group" aria-labelledby={`theme-group-${group.name}`}>
                    {group.themes.map((theme) => (
                      <li
                        key={theme.id}
                        id={`theme-${theme.id}`}
                        data-id={theme.id}
                        role="option"
                        aria-selected={theme.id === value}
                        data-active={theme.id === active || undefined}
                        onPointerMove={() => setActive(theme.id)}
                        onClick={() => pick(theme.id)}
                      >
                        <ThemePair theme={theme} />
                        <span className="theme-name">{theme.name}</span>
                        <svg className="tick" viewBox="0 0 16 16" aria-hidden="true">
                          <path d="m4 8.5 2.5 2.5 5.5-6" />
                        </svg>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
      <button
        ref={trigger}
        type="button"
        className="theme-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? "theme-list" : undefined}
        aria-label={`Theme: ${current.name}`}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            show();
          }
        }}
      >
        <ThemePair theme={current} />
        <span className="theme-name">{current.name}</span>
        <span className="theme-kicker">Theme</span>
        {chevron}
      </button>
    </div>
  );
}

// The page takes the picked theme's background for both modes; Pierre keeps the page's own colours.
function usePageTheme(themeId, mode) {
  useEffect(() => {
    if (mode === "system") delete document.documentElement.dataset.mode;
    else document.documentElement.dataset.mode = mode;
  }, [mode]);
  useEffect(() => {
    const root = document.documentElement;
    const theme = themeOf(themeId);
    const own = theme.id === THEMES[0].id;
    for (const [mode, side] of [["l", theme.light], ["d", theme.dark]]) {
      if (own) root.style.removeProperty(`--fam-${mode}-bg`);
      else root.style.setProperty(`--fam-${mode}-bg`, side.bg);
    }
    if (own) delete root.dataset.family;
    else root.dataset.family = theme.id;
  }, [themeId]);
}

// Follows the server's change stream, re-reading the data when jj records an operation.
function useLiveData(initial) {
  const [data, setData] = useState(initial);
  const [status, setStatus] = useState("live");
  useEffect(() => {
    let seen = initial.op;
    let abort = null;
    const events = new EventSource("/events");
    events.addEventListener("change", (event) => {
      if (event.data === seen) return;
      abort?.abort();
      abort = new AbortController();
      fetch("/data", { signal: abort.signal })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
        .then((next) => {
          seen = next.op;
          SETTINGS = next;
          setData(next);
        })
        .catch(() => {});
    });
    events.onopen = () => setStatus("live");
    events.onerror = () => setStatus("reconnecting");
    return () => {
      abort?.abort();
      events.close();
    };
  }, [initial]);
  return [data, status];
}

function App({ initial }) {
  const [data, status] = useLiveData(initial);
  const [selected, setSelected] = useState(initial.changes.at(-1)?.change);
  const [, setMarksTick] = useState(0);
  const [display, setDisplay] = useState(() =>
    stored("jj-review:display", { diffStyle: "unified", wrap: false, expandAll: false })
  );
  const [themeId, setThemeId] = useState(() => themeOf(stored("jj-review:theme", THEMES[0].id)).id);
  const [mode, setMode] = useState(() => {
    const saved = stored("jj-review:mode", "system");
    return MODES.some((m) => m.id === saved) ? saved : "system";
  });
  usePageTheme(themeId, mode);
  const viewerRef = useRef(null);
  const layout = useDefaultLayout({ id: "review-layout", storage: localStorage, onlySaveAfterUserInteractions: true });
  const sideLayout = useDefaultLayout({ id: "side-layout", storage: localStorage, onlySaveAfterUserInteractions: true });
  const chainRef = useRef(null);

  const change = data.changes.find((c) => c.change === selected) ?? data.changes.at(-1);
  // The open change stays in view in its pane, however long the chain.
  useEffect(() => {
    chainRef.current?.querySelector(".is-open")?.scrollIntoView({ block: "nearest" });
  }, [change?.change]);
  const pickTheme = (id) => {
    setThemeId(id);
    store("jj-review:theme", id);
  };
  const pickMode = (next) => {
    setMode(next);
    store("jj-review:mode", next);
  };
  const show = (next) => {
    const merged = { ...display, ...next };
    setDisplay(merged);
    store("jj-review:display", merged);
  };

  if (!change) {
    return (
      <main className="empty">
        <p className="eyebrow">{data.repo}</p>
        <h1>No changes with a diff in {data.revset}</h1>
        <p>The page updates when there are some.</p>
      </main>
    );
  }

  const viewed = viewedIn(change);
  const toggleViewed = (path) => {
    const file = change.files.find((f) => f.path === path);
    const marks = { ...marksOf(change.change) };
    if (viewed.has(path)) delete marks[path];
    else marks[path] = file.sig;
    marksCache.set(change.change, marks);
    store(marksKey(change.change), marks);
    setMarksTick((n) => n + 1);
  };
  const open = (path) =>
    viewerRef.current?.querySelector(`[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: "start" });
  const adds = change.files.reduce((n, f) => n + f.adds, 0);
  const dels = change.files.reduce((n, f) => n + f.dels, 0);

  return (
    <Group className="page" orientation="horizontal" id="review-layout" {...layout}>
      <Panel id="side" defaultSize="320px" minSize="220px" maxSize="60%" className="side-panel">
        <aside className="side" data-op={data.op}>
          <p className="eyebrow">
            {data.repo} · {data.changes.length} {data.changes.length === 1 ? "change" : "changes"}
            <span
              className={`live ${status}`}
              title={
                status !== "live"
                  ? "Reconnecting to the review server"
                  : data.snapshotsOnSave
                    ? "Follows jj as it changes, and your files as you save them"
                    : "Follows jj as it changes; saved edits show after the next jj command (turn on jj's watchman snapshot trigger to follow saves)"
              }
            >
              {status === "live" ? "Live" : "Reconnecting"}
            </span>
          </p>
          {/* Files above, changes below, each scrolling in its own pane; the divider between them is remembered. */}
          <Group className="side-split" orientation="vertical" id="side-layout" {...sideLayout}>
            <Panel id="files" defaultSize="60%" minSize={120} className="files-pane">
              <Tree key={change.change} change={change} viewed={viewed} onOpen={open} />
              <p className="viewed-count">
                {viewed.size} of {change.files.length} files viewed
              </p>
            </Panel>
            <Separator className="resizer resizer-row" />
            <Panel id="changes" defaultSize="40%" minSize={90} className="changes-pane">
            <ol className="chain" ref={chainRef} aria-label="Changes, newest first">
              {[...data.changes].reverse().map((c) => {
                const open = c.change === change.change;
                const cAdds = c.files.reduce((n, f) => n + f.adds, 0);
                const cDels = c.files.reduce((n, f) => n + f.dels, 0);
                return (
                  <li key={c.change} className={open ? "is-open" : undefined}>
                    <span className="node" aria-hidden="true" />
                    <button type="button" className="row" aria-expanded={open} onClick={() => setSelected(c.change)}>
                      <ChangeId change={c} />
                      <span className="subject">{c.subject}</span>
                    </button>
                    {open && (
                      <div className="detail">
                        <p className="meta">
                          commit <code>{c.commit.slice(0, 8)}</code> · <span className="add">+{cAdds}</span>{" "}
                          <span className="del">−{cDels}</span> · {c.files.length} {c.files.length === 1 ? "file" : "files"}
                        </p>
                        {paragraphs(c.body).map((p, i) => (
                          <p key={i}>{p}</p>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            </Panel>
          </Group>
          <footer className="side-foot">
            <ThemePicker value={themeId} onChange={pickTheme} mode={mode} onMode={pickMode} />
          </footer>
        </aside>
      </Panel>
      <Separator className="resizer" />
      <Panel id="main" className="main-panel">
        <main className="main">
          <header className="head">
            <p className="eyebrow">
              <ChangeId change={change} /> · commit <code>{change.commit.slice(0, 8)}</code> ·{" "}
              <span className="add">+{adds}</span> <span className="del">−{dels}</span> · {change.files.length} files
            </p>
            <div className="controls">
              <div className="layout" role="group" aria-label="Diff layout">
                <Toggle label="Single" pressed={display.diffStyle === "unified"} onChange={() => show({ diffStyle: "unified" })} />
                <Toggle label="Split" pressed={display.diffStyle === "split"} onChange={() => show({ diffStyle: "split" })} />
              </div>
              <div className="layout" role="group" aria-label="Display">
                <Toggle label="Wrap lines" pressed={display.wrap} onChange={(wrap) => show({ wrap })} />
                <Toggle label="Expand all" pressed={display.expandAll} onChange={(expandAll) => show({ expandAll })} />
              </div>
            </div>
          </header>
          <Diffs
            key={change.change}
            change={change}
            viewerRef={viewerRef}
            display={display}
            themeId={themeId}
            mode={mode}
            viewed={viewed}
            onToggleViewed={toggleViewed}
          />
        </main>
      </Panel>
    </Group>
  );
}

fetch("/data")
  .then((r) => (r.ok ? r.json() : r.text().then((t) => Promise.reject(new Error(t)))))
  .then((data) => {
    SETTINGS = data;
    createRoot(document.getElementById("root")).render(<App initial={data} />);
  })
  .catch((err) => {
    document.getElementById("root").textContent = `The review server didn't answer: ${err.message}`;
  });
