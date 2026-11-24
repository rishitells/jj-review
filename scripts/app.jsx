import { parseDiffFromFile } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";

const DATA = JSON.parse(document.getElementById("review-data").textContent);

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

// Viewed files are kept per commit, so a change that moves on starts unviewed again.
const viewedKey = (change) => `guided-review:viewed:${change.commit}`;
const loadViewed = (change) => new Set(stored(viewedKey(change), []));

const editorUrl = (path, line) =>
  DATA.editor.replace("{path}", encodeURI(`${DATA.workspace}/${path}`).replace(/^\//, "")) + (line ? `:${line}` : "");

const openInEditor = (path, line) => {
  const link = document.createElement("a");
  link.href = editorUrl(path, line);
  link.click();
};

function itemsOf(change, viewed) {
  return change.files
    .filter((f) => !f.binary)
    .map((f) => ({
      id: f.path,
      type: "diff",
      fileDiff: parseDiffFromFile({ name: f.path, contents: f.old }, { name: f.path, contents: f.new }),
      collapsed: viewed.has(f.path),
      version: 0,
    }));
}

function ChangeId({ change }) {
  return (
    <span className="cid">
      <b>{change.prefix}</b>
      {change.change.slice(change.prefix.length)}
    </span>
  );
}

function Tree({ change, viewed, onOpen }) {
  // The tree reads the viewed set when it draws a row. Setting identical git status doesn't redraw, so it's cleared
  // and set again.
  const viewedNow = useRef(viewed);
  viewedNow.current = viewed;
  const gitStatus = change.files.map((f) => ({ path: f.path, status: GIT_STATUS[f.status] ?? "modified" }));
  const { model } = useFileTree({
    paths: change.files.map((f) => f.path),
    gitStatus,
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    search: true,
    unsafeCSS:
      'button { font-weight: inherit; } [data-item-section="decoration"] { color: light-dark(#157e3c, #6fdc8c); font-weight: 600; }',
    renderRowDecoration: ({ item }) =>
      item.kind === "file" && viewedNow.current.has(item.path) ? { text: "✓", title: "Viewed" } : null,
    onSelectionChange: (paths) => {
      const file = paths.find((p) => change.files.some((f) => f.path === p));
      if (file) onOpen(file);
    },
  });
  useEffect(() => {
    model.setGitStatus([]);
    model.setGitStatus(gitStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- redraw only when the viewed set changes
  }, [viewed]);
  return <FileTree model={model} className="tree" />;
}

const paragraphs = (text) => text.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);

const baseOptions = {
  theme: { light: "pierre-light", dark: "pierre-dark" },
  stickyHeaders: true,
  lineDiffType: "word",
  preferredHighlighter: "highlights",
  itemMetrics: { lineHeight: 24 },
  layout: { paddingTop: 16, paddingBottom: 48, gap: 16 },
  lineHoverHighlight: "number",
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
  const [items, setItems] = useState(() => itemsOf(change, viewed));
  useEffect(() => {
    setItems((current) =>
      current.some((item) => item.collapsed !== viewed.has(item.id))
        ? current.map((item) =>
            item.collapsed === viewed.has(item.id)
              ? item
              : { ...item, collapsed: viewed.has(item.id), version: (item.version ?? 0) + 1 }
          )
        : current
    );
  }, [viewed]);
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
          <a className="open" href={editorUrl(item.id)} title={`Open ${item.id} in ${DATA.editorName}`}>
            Open in {DATA.editorName}
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

function App() {
  const [index, setIndex] = useState(DATA.changes.length - 1);
  const [viewedByCommit, setViewedByCommit] = useState(() => {
    const first = DATA.changes[DATA.changes.length - 1];
    return { [first.commit]: loadViewed(first) };
  });
  const [display, setDisplay] = useState(() =>
    stored("guided-review:display", { diffStyle: "unified", wrap: false, expandAll: false })
  );
  const change = DATA.changes[index];
  const viewed = viewedByCommit[change.commit];
  const viewerRef = useRef(null);
  const layout = useDefaultLayout({ id: "review-layout", storage: localStorage, onlySaveAfterUserInteractions: true });

  const select = (i) => {
    const next = DATA.changes[i];
    setViewedByCommit((all) => (all[next.commit] ? all : { ...all, [next.commit]: loadViewed(next) }));
    setIndex(i);
  };
  const show = (next) => {
    const merged = { ...display, ...next };
    setDisplay(merged);
    store("guided-review:display", merged);
  };
  const toggleViewed = (path) => {
    const next = new Set(viewed);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    store(viewedKey(change), [...next]);
    setViewedByCommit((all) => ({ ...all, [change.commit]: next }));
  };
  const open = (path) => viewerRef.current?.scrollTo({ type: "item", id: path, align: "start" });
  const adds = change.files.reduce((n, f) => n + f.adds, 0);
  const dels = change.files.reduce((n, f) => n + f.dels, 0);
  const viewedCount = change.files.filter((f) => viewed.has(f.path)).length;

  return (
    <Group className="page" orientation="horizontal" id="review-layout" {...layout}>
      <Panel id="side" defaultSize="320px" minSize="220px" maxSize="60%" className="side-panel">
        <aside className="side">
          <p className="eyebrow">
            {DATA.repo} · {DATA.changes.length} {DATA.changes.length === 1 ? "change" : "changes"}
          </p>
          <ol className="changes">
            {DATA.changes.map((c, i) => (
              <li key={c.change}>
                <button type="button" aria-current={i === index} onClick={() => select(i)}>
                  <ChangeId change={c} />
                  <span className="subject">{c.subject}</span>
                </button>
              </li>
            ))}
          </ol>
          <Tree key={change.change} change={change} viewed={viewed} onOpen={open} />
          <p className="viewed-count">
            {viewedCount} of {change.files.length} files viewed
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
            <h1>{change.subject}</h1>
            {paragraphs(change.body).map((p, i) => (
              <p key={i} className="body">
                {p}
              </p>
            ))}
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

createRoot(document.getElementById("root")).render(<App />);
