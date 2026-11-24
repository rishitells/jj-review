/* Review notes: a changed range of a file with notes beside the lines they explain.

   Adapted from the code notes framework (a listing with notes beside its lines). Each line of the <pre> starts with
   <span class="ln" data-k="add|del|ctx">12</span>: its kind and its number in the new file (empty for a removed line).
   Notes name lines by their position in the listing, as data-lines="3-5,9".

   Each note starts level with the first line it names, and its row runs to the last line it names (unless another
   note starts first). When a note runs longer than its lines, the code leaves a gap under them, so the next note can
   line up. A faint bar marks every line a note names; hovering the note or its lines lights them together, and a click
   (or Enter on a focused note) keeps them lit until the next click. Runs of more than four removed lines fold behind
   a row that shows them.

   The lines arrive already highlighted, by the build. A figure that names its file (data-file, data-from,
   data-to, data-total) can grow: rows above and below show 20 more lines, and "Whole file" shows all of it. The
   file's text comes from the page's #gr-files JSON, read the first time a step grows.

   A step can show several ranges of its file. Between them a gap row stands for the lines in between, and opens from
   either side or all at once, so a far-apart change reads in one block without repeating a line.

   A figure built with an editor link (data-open) gets an icon after its step's line range that opens the file, in a
   new browsing context, so a page shown inside another site's frame isn't replaced by a blocked navigation. */
(() => {
  const FOLD_AFTER = 4;
  const MORE = 20;

  const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const OPEN_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2.5h4v4"/><path d="M13.5 2.5 8 8"/><path d="M11.5 9.5v4h-9v-9h4"/></svg>';

  let files = null;
  const fileText = (key) => {
    if (!files) {
      try { files = JSON.parse(document.getElementById("gr-files")?.textContent || "{}"); } catch (e) { files = {}; }
    }
    return files[key];
  };

  // Long runs of removed lines fold behind a row that shows them. `rows` are siblings, in order.
  const fold = (rows) => {
    let run = [];
    const flush = () => {
      if (run.length > FOLD_AFTER) {
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = run[0].classList.contains("cn-more") ? "cn-fold cn-more" : "cn-fold";
        toggle.textContent = `Show ${run.length} removed lines`;
        const hidden = run;
        hidden.forEach((r) => (r.hidden = true));
        toggle.addEventListener("click", () => {
          const show = hidden[0].hidden;
          hidden.forEach((r) => (r.hidden = !show));
          toggle.textContent = show ? `Hide ${hidden.length} removed lines` : `Show ${hidden.length} removed lines`;
        });
        hidden[0].before(toggle);
      }
      run = [];
    };
    rows.forEach((r) => (r.classList.contains("cn-del") ? run.push(r) : flush()));
    flush();
  };

  const parseLines = (spec, max) => {
    const out = [];
    for (const part of spec.split(",")) {
      const m = part.trim().match(/^(\d+)(?:\s*[-–]\s*(\d+))?$/);
      if (!m) continue;
      const a = +m[1], b = m[2] ? +m[2] : a;
      out.push([Math.max(1, a), Math.min(max, b)]);
    }
    return out;
  };

  const LN = /^<span class="ln" data-k="(add|del|ctx|gap)">([^<]*)<\/span>/;

  // One pinned pair on the page at a time; a click anywhere else lets it go.
  let unpin = null;
  document.addEventListener("click", (e) => {
    if (unpin && !e.target.closest(".cn-note.cn-has, .cn-ln[data-notes]")) { unpin(); unpin = null; }
  });

  const mount = (fig) => {
    if (fig.dataset.rnMounted) return;
    const pre = fig.querySelector("pre"), list = fig.querySelector(".codenotes-notes");
    if (!pre || !list) return;
    const lines = pre.innerHTML.replace(/\n$/, "").split("\n").map((l) => {
      const m = l.match(LN);
      return m ? { kind: m[1], num: m[2], html: l.slice(m[0].length) } : { kind: "ctx", num: "", html: l };
    });
    const total = lines.length;

    const notes = [];
    for (const li of list.children) {
      const ranges = parseLines((li.dataset.lines || "").trim(), total);
      if (ranges.length) notes.push({ ranges, html: li.innerHTML });
    }
    notes.sort((x, y) => x.ranges[0][0] - y.ranges[0][0]);

    const owners = Array.from({ length: total + 1 }, () => []);
    notes.forEach((n, i) => n.ranges.forEach(([a, b]) => { for (let k = a; k <= b; k++) owners[k].push(i); }));

    const chunks = [];
    let at = 1;
    notes.forEach((n, i) => {
      const from = Math.max(at, n.ranges[0][0]);
      const next = notes[i + 1] ? notes[i + 1].ranges[0][0] - 1 : total;
      const last = Math.max(...n.ranges.map((r) => r[1]));
      const to = Math.min(last, next);
      if (from > at) chunks.push({ from: at, to: from - 1 });
      if (to >= from) { chunks.push({ from, to, note: i }); at = to + 1; }
    });
    if (at <= total) chunks.push({ from: at, to: total });

    const row = (k) => {
      const l = lines[k - 1];
      if (l.kind === "gap") return `<div class="cn-gap" data-gap="${l.num}"></div>`;
      const marked = owners[k].length;
      return `<div class="cn-ln cn-${l.kind}${marked ? " cn-mark" : ""}" data-n="${k}"${marked ? ` data-notes="${owners[k].join(" ")}"` : ""}><i aria-hidden="true">${l.num}</i><b aria-hidden="true"></b><span>${l.html || " "}</span></div>`;
    };
    const grid = document.createElement("div");
    grid.className = "cn" + (notes.length ? "" : " cn-bare");
    grid.innerHTML = chunks.map((c, i) => {
      const cls = ["cn-code", i === 0 ? "cn-first" : "", i === chunks.length - 1 ? "cn-last" : ""].join(" ").trim();
      const body = Array.from({ length: c.to - c.from + 1 }, (_, j) => row(c.from + j)).join("");
      const note = !notes.length ? "" : c.note === undefined ? `<div class="cn-note"></div>` : `<div class="cn-note cn-has" data-note="${c.note}">${notes[c.note].html}</div>`;
      return `<div class="${cls}">${body}</div>${note}`;
    }).join("");

    grid.querySelectorAll(".cn-code").forEach((code) => fold([...code.children]));

    let pinned = null;
    const paint = (i, cls, on) => {
      grid.querySelectorAll(".cn-ln[data-notes]").forEach((r) => { if (r.dataset.notes.split(" ").includes(String(i))) r.classList.toggle(cls, on); });
      grid.querySelector(`.cn-note[data-note="${i}"]`)?.classList.toggle(cls, on);
    };
    const light = (i, on) => { if (on || pinned !== String(i)) paint(i, "cn-lit", on); };
    const pin = (i) => {
      const was = pinned;
      if (unpin) { unpin(); unpin = null; }
      if (was === i) return;
      pinned = i;
      paint(i, "cn-lit", true);
      paint(i, "cn-pin", true);
      unpin = () => { pinned = null; paint(i, "cn-pin", false); paint(i, "cn-lit", false); };
    };
    grid.querySelectorAll(".cn-note.cn-has").forEach((n) => {
      const i = n.dataset.note;
      n.tabIndex = 0;
      n.addEventListener("mouseenter", () => light(i, true));
      n.addEventListener("mouseleave", () => light(i, false));
      n.addEventListener("focus", () => light(i, true));
      n.addEventListener("blur", () => light(i, false));
      n.addEventListener("click", (e) => { if (!e.target.closest("a")) pin(i); });
      n.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pin(i); } });
    });
    grid.querySelectorAll(".cn-ln[data-notes]").forEach((r) => {
      const ids = r.dataset.notes.split(" ");
      r.addEventListener("mouseenter", () => ids.forEach((i) => light(i, true)));
      r.addEventListener("mouseleave", () => ids.forEach((i) => light(i, false)));
      r.addEventListener("click", () => { if (!getSelection().toString()) pin(ids[0]); });
    });

    pre.replaceWith(grid);
    list.remove();
    if (fig.dataset.open) {
      const name = esc(fig.dataset.openName || "your editor");
      fig.closest(".step")?.querySelector(".step-head .lines")?.insertAdjacentHTML(
        "afterend",
        `<a class="cn-open-file" href="${esc(fig.dataset.open)}" target="_blank" rel="noopener" title="Open in ${name}" aria-label="Open the file in ${name}">${OPEN_ICON}</a>`
      );
    }
    if (fig.dataset.file && +fig.dataset.total) grow(fig, grid);
    fig.dataset.rnMounted = "1";
  };

  // The rows for new lines a..b of a file, with the removed lines among them: those just before line a when `lead` is
  // set, and those just after line b when `tail` is. Whichever side borders lines already shown leaves its removed
  // lines out, as they're shown there.
  const rowsFor = (file, a, b, lead, tail) => {
    const added = new Set(file.added), byAfter = new Map();
    file.dels.forEach(([after, text]) => byAfter.set(after, [...(byAfter.get(after) || []), text]));
    const out = [];
    const del = (line) => out.push(`<div class="cn-ln cn-del cn-more"><i aria-hidden="true"></i><b aria-hidden="true"></b><span>${line || " "}</span></div>`);
    if (lead) (byAfter.get(a - 1) || []).forEach(del);
    for (let n = a; n <= b; n++) {
      const kind = added.has(n) ? "add" : "ctx";
      out.push(`<div class="cn-ln cn-${kind} cn-more"><i aria-hidden="true">${n}</i><b aria-hidden="true"></b><span>${file.lines[n - 1] || " "}</span></div>`);
      if (n < b || tail) (byAfter.get(n) || []).forEach(del);
    }
    const holder = document.createElement("div");
    holder.innerHTML = out.join("");
    return [...holder.children];
  };

  // Rows above and below a step that show more of its file, and "Whole file" beside its path.
  const grow = (fig, grid) => {
    const key = fig.dataset.file, total = +fig.dataset.total;
    let from = +fig.dataset.from, to = +fig.dataset.to;
    const codes = grid.querySelectorAll(".cn-code");
    const first = codes[0], last = codes[codes.length - 1];
    const button = (dir) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `cn-expand cn-expand-${dir}`;
      b.innerHTML = `<i aria-hidden="true">${dir === "up" ? "\u2191" : "\u2193"}</i><span></span>`;
      return b;
    };
    const up = button("up"), down = button("down");
    first.prepend(up);
    last.append(down);
    const step = fig.closest(".step"), head = step?.querySelector(".step-head");
    const collapse = document.createElement("button");
    collapse.type = "button";
    collapse.className = "cn-whole";
    collapse.textContent = "Collapse";
    const whole = document.createElement("button");
    whole.type = "button";
    whole.className = "cn-whole";
    whole.textContent = "Whole file";
    head?.append(collapse, whole);
    const start = { from, to };

    // The lines between a step's ranges: shown from the top (continuing the range above), from the bottom (leading
    // into the range below), or all at once. lo..hi are the new lines still hidden.
    const gaps = [...grid.querySelectorAll(".cn-gap")].map((el) => {
      const [lo, hi] = el.dataset.gap.split("-").map(Number);
      el.innerHTML = `<span class="cn-gap-arrows"><button type="button" data-side="top">\u2193</button><button type="button" data-side="bottom">\u2191</button></span><button type="button" class="cn-gap-all"></button>`;
      return { el, lo, hi, start: { lo, hi } };
    });
    const openGap = (g, side, count) => {
      const file = fileText(key);
      if (!file || g.lo > g.hi) return;
      if (side === "top") {
        const b = Math.min(g.hi, g.lo + count - 1);
        const rows = rowsFor(file, g.lo, b, false, b < g.hi);
        g.el.before(...rows);
        fold(rows);
        g.lo = b + 1;
      } else {
        const a = Math.max(g.lo, g.hi - count + 1);
        const rows = rowsFor(file, a, g.hi, a > g.lo, false);
        g.el.after(...rows);
        fold(rows);
        g.hi = a - 1;
      }
    };
    gaps.forEach((g) => {
      g.el.querySelectorAll("[data-side]").forEach((b) => b.addEventListener("click", () => { openGap(g, b.dataset.side, MORE); refresh(); }));
      g.el.querySelector(".cn-gap-all").addEventListener("click", () => { openGap(g, "top", Infinity); refresh(); });
    });

    const refresh = () => {
      up.hidden = from <= 1;
      down.hidden = to >= total;
      up.querySelector("span").textContent = `${Math.min(MORE, from - 1)} more lines`;
      down.querySelector("span").textContent = `${Math.min(MORE, total - to)} more lines`;
      up.setAttribute("aria-label", `Show ${Math.min(MORE, from - 1)} more lines above`);
      down.setAttribute("aria-label", `Show ${Math.min(MORE, total - to)} more lines below`);
      gaps.forEach((g) => {
        const left = g.hi - g.lo + 1;
        g.el.hidden = left <= 0;
        const [down, upward] = g.el.querySelectorAll("[data-side]");
        down.hidden = upward.hidden = left <= MORE;
        down.setAttribute("aria-label", `Show ${Math.min(MORE, left)} more lines below line ${g.lo - 1}`);
        upward.setAttribute("aria-label", `Show ${Math.min(MORE, left)} more lines above line ${g.hi + 1}`);
        g.el.querySelector(".cn-gap-all").textContent = left === 1 ? "Show 1 line" : left <= MORE ? `Show ${left} lines` : `${left} lines between \u00b7 show all`;
      });
      const gapsOpen = gaps.every((g) => g.lo > g.hi);
      const gapsMoved = gaps.some((g) => g.lo !== g.start.lo || g.hi !== g.start.hi);
      whole.hidden = from <= 1 && to >= total && gapsOpen;
      collapse.hidden = from === start.from && to === start.to && !gapsMoved;
    };
    const more = (dir, count) => {
      const file = fileText(key);
      if (!file) return;
      if (dir === "up" && from > 1) {
        const a = Math.max(1, from - count);
        const rows = rowsFor(file, a, from - 1, true, false);
        up.after(...rows);
        fold(rows);
        from = a;
      }
      if (dir === "down" && to < total) {
        const b = Math.min(total, to + count);
        const rows = rowsFor(file, to + 1, b, false, true);
        down.before(...rows);
        fold(rows);
        to = b;
      }
      refresh();
    };
    up.addEventListener("click", () => more("up", MORE));
    down.addEventListener("click", () => more("down", MORE));
    whole.addEventListener("click", () => { gaps.forEach((g) => openGap(g, "top", Infinity)); more("up", total); more("down", total); });
    // Back to the step's own lines, and back to the step if the page has moved past it.
    collapse.addEventListener("click", () => {
      grid.querySelectorAll(".cn-more").forEach((n) => n.remove());
      ({ from, to } = start);
      gaps.forEach((g) => Object.assign(g, g.start));
      refresh();
      const box = (step || fig).getBoundingClientRect();
      if (box.top < 64 || box.top > innerHeight) scrollTo({ top: scrollY + box.top - 72 });
      whole.focus();
    });
    refresh();
  };

  const mountAll = (root = document) => root.querySelectorAll("figure.codenotes.rv").forEach(mount);
  window.ReviewNotes = { mount, mountAll };
})();
