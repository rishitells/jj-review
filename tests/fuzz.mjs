// Fuzz test for the live review page.
//
//   node tests/fuzz.mjs [--cases 300] [--seed 1234] [--keep]
//
// Builds a scratch jj repository, starts review.py on it, opens the page in headless Chromium, then applies random jj
// operations (new, insert before/after, describe, file edits inside any change, squash, abandon, reorder, bookmark
// moves, undo) with awkward file contents and paths. After every operation it checks:
//   1. the server's data against a ground truth read independently with jj and git: changes, order, files, statuses,
//      line counts and byte-exact contents;
//   2. the open page, live and without a reload: the chain in order, the picked change kept (or the top one when it's
//      gone), the viewed count, and no page errors;
//   3. Viewed: random clicks mark files, which stay viewed until their diff changes, across reloads too.
// The run is seeded: a failure prints its seed and case, and --seed replays it exactly. --keep leaves the repository.
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync, mkdirSync, chmodSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const { chromium } = createRequire(join(ROOT, "package.json"))("playwright");

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const CASES = Number(arg("cases", 300));
const SEED = Number(arg("seed", Math.floor(Math.random() * 1e9)));
const KEEP = args.includes("--keep");
const PYTHON = process.env.PYTHON || "python3";
const REVSET = "heads(::@- & (trunk() | bookmarks()))..descendants(@)";

// ---------------------------------------------------------------- random

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const random = rng(SEED);
const int = (n) => Math.floor(random() * n);
const pick = (list) => list[int(list.length)];
const chance = (p) => random() < p;

const WORDS = ["const", "value", "return", "export", "function", "Ärger", "naïve", "中文", "🚀", "</script>", "<b>", "&amp;", "\t", "x", "y"];
const DIRS = ["", "src/", "src/app/", "src/app/chat/", "docs/", "dir with space/", "a b/", "a b/c d/", "deep/er/est/"];
// Names git has to quote in a diff header (a double quote, a backslash, a tab), and ones that trip a naive " b/" split.
const NAMES = ["a.ts", "b.tsx", "notes.md", "data.json", "readme.txt", "weird name.ts", "b/odd.ts", "ünïcode.ts", "x.py",
  "empty.txt", 'q"uote.ts', "back\\slash.txt", "tab\there.md", "x b/y.ts"];

function text() {
  const shape = int(10);
  if (shape === 0) return ""; // empty file
  if (shape === 1) return Array.from({ length: 2 + int(4) }, () => pick(WORDS).repeat(1 + int(300))).join("\n") + "\n"; // long lines
  const lines = Array.from({ length: 1 + int(40) }, () => Array.from({ length: 1 + int(8) }, () => pick(WORDS)).join(" "));
  let out = lines.join(shape === 2 ? "\r\n" : "\n");
  if (shape !== 3) out += shape === 2 ? "\r\n" : "\n"; // shape 3: no final newline
  return out;
}

function binary() {
  return Buffer.from(Array.from({ length: 16 + int(200) }, () => int(256)).concat([0, 0, 255]));
}

// ---------------------------------------------------------------- the repository

const REPO = mkdtempSync(join(tmpdir(), "jj-review-fuzz-"));

function jj(...a) {
  return execFileSync("jj", ["--no-pager", "--color=never", ...a], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function jjQuiet(...a) {
  try {
    return jj(...a);
  } catch (err) {
    return null; // an operation jj refuses (say, squashing the root) is fine: nothing happened
  }
}
let GITDIR;
function git(...a) {
  return execFileSync("git", [`--git-dir=${GITDIR}`, ...a], { encoding: "buffer", maxBuffer: 1 << 28 });
}

function filesOnDisk(dir = REPO, prefix = "") {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === ".jj" || name === ".git") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...filesOnDisk(p, `${prefix}${name}/`));
    else out.push(`${prefix}${name}`);
  }
  return out;
}

function writeFile(path, content) {
  mkdirSync(dirname(join(REPO, path)), { recursive: true });
  writeFileSync(join(REPO, path), content);
}

// Edits the working copy: adds, changes, deletes, renames and chmods a few files.
function editFiles() {
  const n = 1 + int(3);
  for (let i = 0; i < n; i++) {
    const files = filesOnDisk();
    const kind = files.length === 0 ? 0 : int(6);
    if (kind === 0) writeFile(pick(DIRS) + pick(NAMES), chance(0.1) ? binary() : text());
    else if (kind === 1 || kind === 2) writeFile(pick(files), chance(0.08) ? binary() : text());
    else if (kind === 3) unlinkSync(join(REPO, pick(files)));
    else if (kind === 4) {
      const from = pick(files);
      const content = readFileSync(join(REPO, from));
      unlinkSync(join(REPO, from));
      writeFile(pick(DIRS) + pick(NAMES), content);
    } else chmodSync(join(REPO, pick(files)), chance(0.5) ? 0o755 : 0o644);
  }
}

function stack() {
  const out = jj("log", "--no-graph", "--reversed", "-r", REVSET, "-T", 'change_id.short(8) ++ "\\n"', "--ignore-working-copy");
  return out.split("\n").filter(Boolean);
}
function allMutable() {
  const out = jj("log", "--no-graph", "-r", "mutable()", "-T", 'change_id.short(8) ++ "\\n"', "--ignore-working-copy");
  return out.split("\n").filter(Boolean);
}
const message = () => `${pick(["Add", "Fix", "Move", "Rework", "Drop"])} ${pick(WORDS)} ${int(1000)}\n\n${chance(0.5) ? text() : ""}`;

// One random operation, by name.
const OPERATIONS = [
  ["new on top", 3, () => { jj("new", "-m", message()); editFiles(); jj("status"); }],
  ["insert after", 2, () => { jj("new", "-A", pick(stack().concat(["@"])), "-m", message()); editFiles(); jj("status"); }],
  ["insert before", 2, () => { const s = stack(); if (s.length) { jj("new", "-B", pick(s), "-m", message()); editFiles(); jj("status"); } }],
  ["describe", 2, () => { const s = stack(); if (s.length) jj("describe", "-r", pick(s), "-m", message()); }],
  ["edit a change", 4, () => { const s = stack(); if (s.length) { jj("edit", pick(s)); editFiles(); jj("status"); } }],
  ["edit the working copy", 3, () => { editFiles(); jj("status"); }],
  ["squash into parent", 1, () => { const s = stack(); if (s.length > 1) jjQuiet("squash", "-r", pick(s.slice(1))); }],
  ["abandon", 1, () => { const s = stack(); if (s.length > 1) jjQuiet("abandon", pick(s)); }],
  ["reorder", 2, () => { const s = stack(); if (s.length > 2) { const a = pick(s); const b = pick(s.filter((x) => x !== a)); jjQuiet("rebase", "-r", a, chance(0.5) ? "-A" : "-B", b); } }],
  ["move the base bookmark", 1, () => { const m = allMutable(); if (m.length) jjQuiet("bookmark", "set", "base", "-r", pick(m), "--allow-backwards"); }],
  ["empty change", 1, () => { jj("new"); }],
  ["undo", 1, () => { jjQuiet("undo"); }],
];
const WEIGHTED = OPERATIONS.flatMap((op) => Array(op[1]).fill(op));

// ---------------------------------------------------------------- ground truth

const ROOT_COMMIT = "0".repeat(40);
const STATUS = { A: "added", M: "modified", D: "deleted", R: "renamed", C: "copied" };
const fileset = (path) => `root-file:"${path.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
const norm = (s) => s.replace(/\r\n/g, "\n").replace(/\r(?=\n|$)/g, "").replace(/\n$/, "");

function show(rev, path) {
  if (!rev || rev === ROOT_COMMIT) return Buffer.alloc(0);
  try {
    return execFileSync("jj", ["--no-pager", "file", "show", "-r", rev, fileset(path), "--ignore-working-copy"], { cwd: REPO, maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    return Buffer.alloc(0);
  }
}

// The truth, read without the code under test: changes and order from jj log, files and statuses from jj's summary
// (another command than the server's diff), contents from jj file show and, for changes without conflicts, git.
function truth() {
  const tpl = 'change_id.short(8) ++ "\\t" ++ commit_id ++ "\\t" ++ parents.map(|c| c.commit_id()).join(",") ++ "\\t" ++ if(empty, "1", "0") ++ "\\t" ++ if(conflict, "1", "0") ++ "\\t" ++ parents.map(|c| if(c.conflict(), "1", "0")).join("") ++ "\\n"';
  const rows = jj("log", "--no-graph", "--reversed", "-r", REVSET, "-T", tpl, "--ignore-working-copy").split("\n").filter(Boolean);
  return rows
    .map((row) => row.split("\t"))
    .filter(([, , , empty]) => empty === "0")
    .map(([change, commit, parents, , conflict, parentConflicts]) => {
      const parent = parents.split(",")[0];
      const files = new Map();
      for (const line of jj("diff", "--summary", "-r", commit, "--ignore-working-copy").split("\n").filter(Boolean)) {
        const code = line[0];
        const rest = line.slice(2);
        let path = rest;
        let oldPath = null;
        const m = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(rest);
        if ((code === "R" || code === "C") && m) {
          const join = (x) => (m[1] + x + m[4]).replace(/\/{2,}/g, "/").replace(/^\//, "");
          oldPath = join(m[2]);
          path = join(m[3]);
        }
        const status = STATUS[code] ?? "modified";
        const oldBuf = status === "added" ? null : show(parent, oldPath ?? path);
        const newBuf = status === "deleted" ? null : show(commit, path);
        const binary = [oldBuf, newBuf].some((b) => b && b.subarray(0, 8000).includes(0));
        files.set(path, { status, oldPath, binary, old: oldBuf, new: newBuf });
      }
      // Line counts from git, where git and jj agree on the file: no rename, and no conflict in the change or its
      // parent (jj shows a conflicted file with its markers; git sees the raw tree underneath).
      if (conflict === "0" && !parentConflicts.includes("1")) {
        const base = !parent || parent === ROOT_COMMIT ? "4b825dc642cb6eb9a060e54bf8d69288fbee4904" : parent;
        for (const entry of git("diff", "--numstat", "-z", "--no-renames", base, commit).toString("utf8").split("\0").filter(Boolean)) {
          const [adds, dels, ...rest] = entry.split("\t");
          const f = files.get(rest.join("\t"));
          if (f && (f.status === "added" || f.status === "modified" || f.status === "deleted") && adds !== "-") {
            f.adds = Number(adds);
            f.dels = Number(dels);
          }
        }
      }
      return { change, commit, conflict: conflict === "1", files };
    });
}

// The server's data, compared with the truth. Returns problems as text.
function compareData(data, expected) {
  const problems = [];
  const got = data.changes.map((c) => c.change).join(" ");
  const want = expected.map((c) => c.change).join(" ");
  if (got !== want) return [`changes: server [${got}] vs truth [${want}]`];
  expected.forEach((e, i) => {
    const c = data.changes[i];
    const label = `${e.change}${e.conflict ? " (conflicted)" : ""}`;
    if (c.commit !== e.commit) problems.push(`${label}: commit ${c.commit} vs ${e.commit}`);
    const paths = new Set(c.files.map((f) => f.path));
    for (const path of e.files.keys()) if (!paths.has(path)) problems.push(`${label}: missing file ${JSON.stringify(path)}`);
    for (const f of c.files) {
      const t = e.files.get(f.path);
      if (!t) { problems.push(`${label}: extra file ${JSON.stringify(f.path)}`); continue; }
      if (t.status !== f.status) problems.push(`${label} ${f.path}: status ${f.status} vs ${t.status}`);
      if ((t.oldPath ?? null) !== (f.oldPath ?? null)) problems.push(`${label} ${f.path}: from ${f.oldPath} vs ${t.oldPath}`);
      if (t.binary !== f.binary) problems.push(`${label} ${f.path}: binary ${f.binary} vs ${t.binary}`);
      if (t.adds !== undefined && (t.adds !== f.adds || t.dels !== f.dels)) problems.push(`${label} ${f.path}: +${f.adds}-${f.dels} vs +${t.adds}-${t.dels}`);
      if (!t.binary) {
        // Line endings and a final newline aside, as the diff reader drops them.
        if (norm(f.new) !== norm(t.new ? t.new.toString("utf8") : "")) problems.push(`${label} ${f.path}: new contents differ`);
        if (norm(f.old) !== norm(t.old ? t.old.toString("utf8") : "")) problems.push(`${label} ${f.path}: old contents differ`);
        if (!e.conflict && t.new && f.status !== "deleted") {
          const fromGit = norm(git("show", `${e.commit}:${f.path}`).toString("utf8"));
          if (norm(f.new) !== fromGit) problems.push(`${label} ${f.path}: new contents differ from git`);
        }
      }
    }
  });
  return problems;
}

// ---------------------------------------------------------------- server and page

async function main() {
  console.log(`seed ${SEED}, ${CASES} cases, repo ${REPO}`);
  jj("git", "init");
  jj("config", "set", "--repo", "user.name", "Fuzz");
  jj("config", "set", "--repo", "user.email", "fuzz@example.test");
  GITDIR = jj("git", "root").trim();
  writeFile("src/a.ts", "export const a = 1;\n");
  writeFile("README.md", "base\n");
  jj("describe", "-m", "Base");
  jj("bookmark", "create", "base", "-r", "@");
  for (let i = 0; i < 3; i++) { jj("new", "-m", message()); editFiles(); jj("status"); }

  const port = 20000 + int(20000);
  const server = spawn(PYTHON, [join(ROOT, "server", "review.py"), "--no-open"], {
    cwd: REPO, env: { ...process.env, JJ_REVIEW_PORT: String(port) }, stdio: ["ignore", "ignore", "pipe"],
  });
  let serverLog = "";
  server.stderr.on("data", (d) => (serverLog += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`${base}/data`)).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
  const pageErrors = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));
  page.on("console", (msg) => { if (msg.type() === "error") pageErrors.push(msg.text()); });
  await page.goto(base);

  // The page pins the change it shows: the top one when it loads, then whichever is clicked. If that change leaves the
  // range, the page shows the top one until it comes back.
  const topNow = () => truth().at(-1)?.change ?? null;
  let selected = topNow();
  const marks = new Map(); // change id -> Map(path -> sig): what Viewed clicks recorded
  const counts = {};
  let failures = 0;

  const fail = async (n, op, problems) => {
    failures++;
    console.log(`\nFAIL case ${n} (${op}), seed ${SEED}:\n  ${problems.slice(0, 12).join("\n  ")}`);
    if (!args.includes("--keep-going")) throw new Error("stop");
  };

  const ui = () =>
    page.evaluate(() => ({
      op: document.querySelector(".side")?.dataset.op ?? null,
      chain: [...document.querySelectorAll(".chain li")].map((li) => li.querySelector(".cid")?.textContent),
      open: document.querySelector(".chain li.is-open .cid")?.textContent ?? null,
      count: document.querySelector(".viewed-count")?.textContent ?? null,
      empty: !!document.querySelector(".empty"),
    }));

  try {
    for (let n = 1; n <= CASES; n++) {
      const [name, , run] = pick(WEIGHTED);
      counts[name] = (counts[name] ?? 0) + 1;
      try { run(); } catch (err) { counts[`${name} (refused)`] = (counts[`${name} (refused)`] ?? 0) + 1; }

      // 1. The server's data against the truth. An error anywhere here is a failing case, never a crash.
      let expected, data;
      try {
        expected = truth();
        const res = await fetch(`${base}/data`);
        if (!res.ok) throw new Error(`server answered ${res.status}: ${await res.text()}`);
        data = await res.json();
      } catch (err) {
        await fail(n, name, [String(err.message ?? err).split("\n")[0]]);
        continue;
      }
      const dataProblems = compareData(data, expected);
      if (dataProblems.length) await fail(n, name, dataProblems);

      // 2. The page follows, live.
      const ids = expected.map((c) => c.change);
      // The page must show exactly the data checked above: the latest operation, not just a matching chain.
      const latestOp = jj("op", "log", "-n1", "--no-graph", "-T", "id.short(16)", "--ignore-working-copy").trim();
      const shown = selected && ids.includes(selected) ? selected : ids.at(-1) ?? null;
      const viewedWanted = () => {
        const c = data.changes.find((x) => x.change === shown);
        if (!c) return null;
        const m = marks.get(shown) ?? new Map();
        return `${c.files.filter((f) => m.get(f.path) === f.sig).length} of ${c.files.length} files viewed`;
      };
      let state;
      const deadline = Date.now() + 6000;
      for (;;) {
        state = await ui();
        const chainOk = state.chain.join(" ") === [...ids].reverse().join(" ") && (ids.length > 0 || state.empty);
        const current = ids.length === 0 || state.op === latestOp;
        if (current && chainOk && state.open === shown && (shown === null || state.count === viewedWanted())) break;
        if (Date.now() > deadline) {
          const stored = await page.evaluate(() => Object.fromEntries(Object.keys(localStorage).filter((k) => k.includes(":viewed:")).map((k) => [k.split(":").pop(), localStorage.getItem(k)])));
          const c = data.changes.find((x) => x.change === shown);
          await fail(n, name, [
            `test marks ${JSON.stringify(Object.fromEntries([...(marks.get(shown) ?? new Map())]))}`,
            `page stored ${stored[shown] ?? "nothing"} for ${shown}`,
            `current sigs ${JSON.stringify(Object.fromEntries((c?.files ?? []).map((f) => [f.path, f.sig])))}`,
            `page chain [${state.chain.join(" ")}] vs [${[...ids].reverse().join(" ")}]`,
            `open ${state.open} vs ${shown}`,
            `page op ${state.op} vs ${latestOp}`,
            `count "${state.count}" vs "${viewedWanted()}"`,
          ]);
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      if (pageErrors.length) await fail(n, name, pageErrors.splice(0));

      // 3. Now and then: pick another change, toggle Viewed on a file, or reload.
      if (ids.length && chance(0.25)) {
        selected = pick(ids);
        await page.locator(".chain li", { has: page.locator(".cid", { hasText: selected }) }).locator(".row").click();
      }
      if (shown && chance(0.3)) {
        const buttons = page.locator("diffs-container button.viewed");
        const count = await buttons.count();
        if (count) {
          const i = int(count);
          const path = await buttons.nth(i).evaluate((b) => b.closest("diffs-container").shadowRoot.querySelector("[data-title]").textContent);
          const c = data.changes.find((x) => x.change === (selected && ids.includes(selected) ? selected : ids.at(-1)));
          // The header shows the full path, or its end after "…" when it's too long: match exactly, and by the end only
          // when the path is cut and one file alone fits.
          const cut = path.startsWith("…") ? path.slice(1) : null;
          const fits = c?.files.filter((f) => (cut ? f.path.endsWith(cut) : f.path === path)) ?? [];
          const file = fits.length === 1 ? fits[0] : null;
          if (file) {
            await buttons.nth(i).click();
            const m = marks.get(c.change) ?? new Map();
            if (m.get(file.path) === file.sig) m.delete(file.path); else m.set(file.path, file.sig);
            marks.set(c.change, m);
          }
        }
      }
      if (chance(0.03)) { await page.reload(); selected = topNow(); }
      if (n % 25 === 0) process.stdout.write(` ${n}`);
    }
  } catch (err) {
    if (err.message !== "stop") {
      failures++;
      console.log(`\nFAIL: the test itself stopped, seed ${SEED}: ${err.stack ?? err}`);
    }
  } finally {
    await browser.close();
    server.kill();
    console.log(`\n${failures ? `${failures} failing case(s)` : "all cases passed"}; operations: ${JSON.stringify(counts)}`);
    if (serverLog.includes("Traceback")) console.log(`server log:\n${serverLog}`);
    if (KEEP || failures) console.log(`repository kept at ${REPO}`);
    else rmSync(REPO, { recursive: true, force: true });
    process.exitCode = failures ? 1 : 0;
  }
}

main();
