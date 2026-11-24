import { parseDiffFromFile } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";

// The page asks the review server for its data, and hears from it when jj records an operation.
let SETTINGS = null;

const GIT_STATUS = { added: "added", deleted: "deleted", modified: "modified" };

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
const marksKey = (changeId) => `guided-review:viewed:${SETTINGS.repo}:${changeId}`;
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

const itemOf = (file, collapsed, version) => ({
  id: file.path,
  type: "diff",
  sig: file.sig,
  fileDiff: parseDiffFromFile({ name: file.path, contents: file.old }, { name: file.path, contents: file.new }),
  collapsed,
  version,
});

// The next item list: unchanged files keep their item (and their parsed diff), changed ones are parsed again.
// Returns the current list itself when nothing changed, so an update with the same data renders nothing.
function reconcile(current, change, viewed) {
  const byId = new Map(current.map((item) => [item.id, item]));
  const next = change.files
    .filter((f) => !f.binary)
    .map((f) => {
      const item = byId.get(f.path);
      const collapsed = viewed.has(f.path);
      if (item && item.sig === f.sig) {
        return item.collapsed === collapsed ? item : { ...item, collapsed, version: item.version + 1 };
      }
      return itemOf(f, collapsed, item ? item.version + 1 : 0);
    });
  return next.length === current.length && next.every((item, i) => item === current[i]) ? current : next;
}

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
  '[data-item-section="decoration"] { color: light-dark(#157e3c, #6fdc8c); font-weight: 600; }',
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
  theme: { light: "pierre-light", dark: "pierre-dark" },
  stickyHeaders: true,
  lineDiffType: "word",
  preferredHighlighter: "highlights",
  itemMetrics: { lineHeight: 24 },
  layout: { paddingTop: 16, paddingBottom: 48, gap: 20 },
  lineHoverHighlight: "number",
  // Each file reads as one block: its header is a tinted band with a rule under it (the box is styled on the page).
  unsafeCSS:
    "[data-diffs-header] { background: var(--file-band); box-shadow: inset 0 -1px 0 var(--line); } [data-title] { font-weight: 500; }",
  // A line number opens the file at that line. Removed lines aren't in the file any more, so they open it at the top.
  onLineNumberClick: (props, context) =>
    openInEditor(context.item.id, props.annotationSide === "deletions" ? undefined : props.lineNumber),
};

// One options object per display combination, so CodeView sees the same object until a toggle changes.
const optionsCache = new Map();
function optionsFor({ diffStyle, wrap, expandAll }) {
  const key = `${diffStyle}:${wrap}:${expandAll}`;
  if (!optionsCache.has(key)) {
    optionsCache.set(key, { ...baseOptions, diffStyle, overflow: wrap ? "wrap" : "scroll", expandUnchanged: expandAll });
  }
  return optionsCache.get(key);
}

function Diffs({ change, viewerRef, display, viewed, onToggleViewed }) {
  const [items, setItems] = useState(() => reconcile([], change, viewed));
  useEffect(() => {
    setItems((current) => reconcile(current, change, viewed));
  }, [change, viewed]);
  return (
    <CodeView
      ref={viewerRef}
      items={items}
      className="diffs"
      options={optionsFor(display)}
      renderHeaderMetadata={(item) => (
        <span className="file-actions">
          <button
            type="button"
            className="viewed"
            aria-pressed={viewed.has(item.id)}
            title={viewed.has(item.id) ? "Mark as not viewed" : "Mark as viewed and fold the file"}
            onClick={() => onToggleViewed(item.id)}
          >
            <span className="box" aria-hidden="true">
              <svg viewBox="0 0 16 16">
                <path d="m4 8.5 2.5 2.5 5.5-6" />
              </svg>
            </span>
            Viewed
          </button>
          <a className="open" href={editorUrl(item.id)} title={`Open ${item.id} in ${SETTINGS.editorName}`}>
            Open in {SETTINGS.editorName}
          </a>
        </span>
      )}
    />
  );
}

function Toggle({ label, pressed, onChange }) {
  return (
    <button type="button" aria-pressed={pressed} onClick={() => onChange(!pressed)}>
      {label}
    </button>
  );
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
    stored("guided-review:display", { diffStyle: "unified", wrap: false, expandAll: false })
  );
  const viewerRef = useRef(null);
  const layout = useDefaultLayout({ id: "review-layout", storage: localStorage, onlySaveAfterUserInteractions: true });

  const change = data.changes.find((c) => c.change === selected) ?? data.changes.at(-1);
  const show = (next) => {
    const merged = { ...display, ...next };
    setDisplay(merged);
    store("guided-review:display", merged);
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
  const open = (path) => viewerRef.current?.scrollTo({ type: "item", id: path, align: "start" });
  const adds = change.files.reduce((n, f) => n + f.adds, 0);
  const dels = change.files.reduce((n, f) => n + f.dels, 0);

  return (
    <Group className="page" orientation="horizontal" id="review-layout" {...layout}>
      <Panel id="side" defaultSize="320px" minSize="220px" maxSize="60%" className="side-panel">
        <aside className="side">
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
          <ol className="chain" aria-label="Changes, newest first">
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
          <Tree key={change.change} change={change} viewed={viewed} onOpen={open} />
          <p className="viewed-count">
            {viewed.size} of {change.files.length} files viewed
          </p>
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
