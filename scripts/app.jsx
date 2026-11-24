import { parseDiffFromFile } from "@pierre/diffs";
import { CodeView } from "@pierre/diffs/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";

const DATA = JSON.parse(document.getElementById("review-data").textContent);

const GIT_STATUS = { added: "added", deleted: "deleted", modified: "modified" };

function itemsOf(change) {
  return change.files
    .filter((f) => !f.binary)
    .map((f) => ({
      id: f.path,
      type: "diff",
      fileDiff: parseDiffFromFile({ name: f.path, contents: f.old }, { name: f.path, contents: f.new }),
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

function Tree({ change, onOpen }) {
  const { model } = useFileTree({
    paths: change.files.map((f) => f.path),
    gitStatus: change.files.map((f) => ({ path: f.path, status: GIT_STATUS[f.status] ?? "modified" })),
    initialExpansion: "open",
    flattenEmptyDirectories: true,
    search: true,
    unsafeCSS: "button { font-weight: inherit; }",
    onSelectionChange: (paths) => {
      const file = paths.find((p) => change.files.some((f) => f.path === p));
      if (file) onOpen(file);
    },
  });
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
};
const OPTIONS = {
  unified: { ...baseOptions, diffStyle: "unified" },
  split: { ...baseOptions, diffStyle: "split" },
};

const editorUrl = (path) => DATA.editor.replace("{path}", encodeURI(`${DATA.workspace}/${path}`).replace(/^\//, ""));

function openInEditor(item) {
  return (
    <a className="open" href={editorUrl(item.id)} title={`Open ${item.id} in ${DATA.editorName}`}>
      Open in {DATA.editorName}
    </a>
  );
}

function Diffs({ change, viewerRef, diffStyle }) {
  const [items] = useState(() => itemsOf(change));
  return (
    <CodeView
      ref={viewerRef}
      items={items}
      className="diffs"
      options={OPTIONS[diffStyle]}
      renderHeaderMetadata={openInEditor}
    />
  );
}

function App() {
  const [index, setIndex] = useState(DATA.changes.length - 1);
  const [diffStyle, setDiffStyle] = useState("unified");
  const viewerRef = useRef(null);
  const layout = useDefaultLayout({ id: "review-layout", storage: localStorage, onlySaveAfterUserInteractions: true });
  const change = DATA.changes[index];
  const open = (path) => viewerRef.current?.scrollTo({ type: "item", id: path, align: "start" });
  const adds = change.files.reduce((n, f) => n + f.adds, 0);
  const dels = change.files.reduce((n, f) => n + f.dels, 0);
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
              <button type="button" aria-current={i === index} onClick={() => setIndex(i)}>
                <ChangeId change={c} />
                <span className="subject">{c.subject}</span>
              </button>
            </li>
          ))}
        </ol>
        <Tree key={change.change} change={change} onOpen={open} />
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
          <div className="layout" role="group" aria-label="Diff layout">
            {["unified", "split"].map((s) => (
              <button key={s} type="button" aria-pressed={diffStyle === s} onClick={() => setDiffStyle(s)}>
                {s === "split" ? "Split" : "Single"}
              </button>
            ))}
          </div>
        </header>
        <Diffs key={change.change} change={change} viewerRef={viewerRef} diffStyle={diffStyle} />
      </main>
      </Panel>
    </Group>
  );
}

createRoot(document.getElementById("root")).render(<App />);
