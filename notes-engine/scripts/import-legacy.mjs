#!/usr/bin/env node
/**
 * Legacy HTML -> UnifyNote JSON importer (one-off, stdlib only).
 *
 * Reads the archived Coursecontents week pages (UTF-16LE files extracted from
 * git history) and emits one UnifyNote JSON per week into ../seed-content/.
 *
 *   node scripts/import-legacy.mjs <legacy-dir> [out-dir]
 *
 * Mapping (structure found across all 8 courses):
 *   .week-title / .wh-title      -> note.title
 *   .week-summary / .wh-subtitle -> note.subtitle
 *   .wh-hook (or summary)        -> note.learningOutcome
 *   .tag                         -> note.tags
 *   .exam-box li                 -> "Exam focus" bullets on the first topic
 *   .topic-block (in order)      -> topics[0..n]
 *     p                          -> paragraph (inner HTML kept)
 *     ul / ol                    -> bullets
 *     .exam-def                  -> paragraph + reveal Q (answer IS the def)
 *     .realworld-box             -> analogy
 *     .formula-block             -> label paragraph + bullets + vars paragraph
 *     .mistake-box               -> insight
 *     .quick-check .qc-item      -> reveal Q (no source answer; honest note)
 *     .accordion-item            -> activeRecall {badge, question, answer}
 *     .diagram-wrap              -> diagram placeholder (caption + svg text)
 *   .quiz-zone.mid               -> pulseCheck on nearest preceding topic
 *   .quiz-zone#week-quiz         -> eoq (answers from weekAnswers JS map)
 *
 * Files skipped (reported): non W{n}.html pages (e.g. "ECE 204 - Complete",
 * practice-questions for codes outside the catalog).
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const LEGACY_DIR = process.argv[2] || join(HERE, "..", "..", ".legacy");
const OUT_DIR = process.argv[3] || join(HERE, "..", "seed-content");

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…",
  rsquo: "’", lsquo: "‘",
  rdquo: "”", ldquo: "“",
  laquo: "«", raquo: "»",
  times: "×", minus: "−",
  bull: "•", copy: "©", reg: "®",
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => {
      try { return String.fromCodePoint(Number(n)); } catch { return _; }
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return _; }
    })
    .replace(/&([a-zA-Z]+);/g, (m, n) => (n in ENTITIES ? ENTITIES[n] : m));
}

// ---- mojibake reversal ----
// The archive went through UTF-8 bytes decoded as CP437 (OEM): every
// original multi-byte chars became mojibake runs; each table pair is
// Runs decode only with a marker present + strict UTF-8 validity.
// Runs decode only with a marker present + strict UTF-8 validity.
// Runs decode only with a marker present + strict UTF-8 validity, so clean
// Clean Unicode stays intact (single chars never match multi-char runs).
const CP437 = {
  "Γ": 0xe2,
  "Ç": 0x80,
  "ö": 0x94,
  "ò": 0x95,
  "É": 0x90,
  "å": 0x86,
  "Æ": 0x92,
  "ê": 0x88,
  "é": 0x82,
  "ü": 0x81,
  "â": 0x83,
  "ä": 0x84,
  "Ö": 0x99,
  "ù": 0x97,
  "├": 0xc3,
  "Ü": 0x9a,
  "ë": 0x89,
  "á": 0xa0,
  "ÿ": 0x98,
  "╛": 0xbe,
  "£": 0x9c,
  "ô": 0x93,
  "┬": 0xc2,
  "╖": 0xb7,
  "▓": 0xb2,
  "│": 0xb3,
  "░": 0xb0,
  "╜": 0xbd,
  "╝": 0xbc,
  "▒": 0xb1,
  "ß": 0xe1,
  "╡": 0xb5,
  "ó": 0xa2,
  "╬": 0xce,
  "╧": 0xcf,
  "┤": 0xb4,
  "╕": 0xb8,
  "╣": 0xb9,
  "║": 0xba,
  "╗": 0xbb,
  "┐": 0xaf,
  "⌐": 0xa9,
  "╠": 0xcc,
  "ú": 0xa3,
  "¢": 0x9b,
  "¥": 0x9d,
  "ƒ": 0x9f,
  "í": 0xa1,
  "æ": 0x91,
  "╢": 0xb6,
  "Ñ": 0xa5,
  "¬": 0xaa,
  "à": 0x85,
  "¢": 0x9b,
  "ª": 0xa6,
  "ç": 0x87,
  "î": 0x8c,
  "º": 0xa7,
  "₧": 0x9e,
  "≡": 0xf0,
  "┼": 0xc5,
};
const MARKERS = new Set([
  "Γ", "ß", "┬", "╖", "╬", "╧", "├", "╡", "╢", "╕", "╣", "║", "╗", "╝", "╜", "░", "▒", "▓", "│", "┤", "╛", "╞", "╟", "╚", "╔", "╠", "╩", "╪", "╫", "╮", "╯", "╰", "╱", "╲", "╳", "╨", "╤", "╥", "╙", "╘", "▐", "█", "▄", "▌", "▐", "▀", "≡", "⌠", "⌡", "≈", "∙", "ⁿ", "⌐",
]);
// Source-corrupt tokens no byte-decode can recover (verified in context):
// Source-corrupt tokens no byte-decode can recover (verified): a-sub-t,
// broken icon before Why This Matters (label kept), combining macron for
// Miller indices, E_g EMF equation, ellipsis spots. Explicit table above.
// (ellipsis positions like [v1|v2|...], "Your answer...").
const EXPLICIT = [
  ["E╔í", "E_g"],
  ["ß╡ù", "ₜ"],
  ["Γÿà", ""],
  ["╠ä", "̄"],
  ["ΓÇª", "…"],
  ["╦ó", "″"],
  ["Γü┐", "ₙ"], // a-sub-n (normal accel; source has sup-n)
  ["ΓèÑ", "⊥"], // perp (tangential diagram label)
  ["ß╡ç", "ʰ"], // hours (LST answers; source mangles h)
  ["Γ¼å", ""], // corrupt step marker - drop
  ["Γû║", ""], // corrupt matrix corner - drop
  ["ΓùÅ", "◅"], // same slot as rain-cloud file sep
  ["\u202A", ""], // literal bidi marks (invisible) - drop
];
const _td = new TextDecoder("utf-8", { fatal: true });
const _bad = /\p{Cc}|\p{Cf}/u;

function demojibake(src) {
  for (const [k, v] of EXPLICIT) src = src.split(k).join(v);
  src = src.split(String.fromCharCode(0xfeff)).join(""); // stray BOMs
  return src.replace(/[^\x00-\x7F\s]{2,}/g, (run) => demojibakeRun(run));
}

function demojibakeRun(run) {
  let out = "";
  let i = 0;
  while (i < run.length) {
    let matched = false;
    for (let j = Math.min(run.length, i + 5); j > i + 1; j--) {
      const chunk = run.slice(i, j);
      if (![...chunk].some((c) => MARKERS.has(c))) continue;
      const bytes = [];
      let ok = true;
      for (const c of chunk) {
        const b = CP437[c];
        if (b === undefined) { ok = false; break; }
        bytes.push(b);
      }
      if (!ok) continue;
      try {
        const decoded = _td.decode(new Uint8Array(bytes));
        if (!decoded || _bad.test(decoded)) continue;
        out += decoded;
        i = j;
        matched = true;
        break;
      } catch {
        // not valid UTF-8 — try shorter
      }
    }
    if (!matched) {
      out += run[i];
      i++;
    }
  }
  return out;
}

// ---- tiny DOM ----
function parseHTML(src) {
  const root = { tag: "root", attrs: {}, children: [], parent: null };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\/?[a-zA-Z][^>]*>|[^<]+/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const tok = m[0];
    if (tok.startsWith("<!--")) continue;
    if (tok.startsWith("</")) {
      const name = tok.slice(2, -1).trim().split(/\s+/)[0].toLowerCase();
      while (stack.length > 1 && stack[stack.length - 1].tag !== name) stack.pop();
      if (stack.length > 1) stack.pop();
      continue;
    }
    if (tok.startsWith("<")) {
      const inner = tok.slice(1, tok.endsWith("/>") ? -2 : -1).trim();
      const sp = inner.search(/\s/);
      const tag = (sp === -1 ? inner : inner.slice(0, sp)).toLowerCase();
      const attrs = {};
      const ar = /([a-zA-Z_:][\w:.-]*)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;
      let am;
      while ((am = ar.exec(sp === -1 ? "" : inner.slice(sp))) !== null) {
        let v = am[2] || "";
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        attrs[am[1].toLowerCase()] = decodeEntities(v);
      }
      const node = { tag, attrs, children: [], parent: stack[stack.length - 1] };
      stack[stack.length - 1].children.push(node);
      const selfClose = tok.endsWith("/>") || VOID.has(tag);
      if (!selfClose) stack.push(node);
      continue;
    }
    const parent = stack[stack.length - 1];
    if (parent.tag === "script" || parent.tag === "style") {
      parent.children.push({ text: tok, parent, raw: true });
    } else {
      parent.children.push({ text: decodeEntities(tok), parent });
    }
  }
  return root;
}

function classes(n) {
  return (n.attrs && n.attrs.class ? n.attrs.class : "").split(/\s+/).filter(Boolean);
}
function walk(node, out = []) {
  out.push(node);
  for (const c of node.children || []) if (c.tag) walk(c, out);
  return out;
}
function byClass(root, cls) {
  return walk(root).filter((n) => classes(n).includes(cls));
}
function firstByClass(root, ...clss) {
  for (const c of clss) {
    const hit = byClass(root, c)[0];
    if (hit) return hit;
  }
  return null;
}
function textOf(n) {
  if (!n) return "";
  if (n.text !== undefined) return n.text;
  return (n.children || []).map(textOf).join(" ");
}
function clean(s) {
  return String(s).replace(/\s+/g, " ").trim();
}
// Serialize inner HTML for reader display (dangerouslySetInnerHTML-safe):
// keep semantic tags/text, unwrap links to text, images to alt placeholders,
// drop classes/styles/ids/handlers (legacy CSS must never leak into the app).
function innerHTML(n) {
  if (!n) return "";
  if (n.text !== undefined) return n.raw ? "" : n.text;
  if (n.tag === "a") return (n.children || []).map(innerHTML).join("");
  if (n.tag === "img") return n.attrs && n.attrs.alt ? `[Image: ${n.attrs.alt}]` : "";
  if (n.tag === "button" || n.tag === "input" || n.tag === "script" || n.tag === "style" || n.tag === "svg") return "";
  if (n.tag === "br") return "\n";
  const kids = (n.children || []).map(innerHTML).join("");
  const keep = [];
  if (n.attrs) {
    for (const [k, v] of Object.entries(n.attrs)) {
      const kl = k.toLowerCase();
      if (kl === "class" || kl === "style" || kl === "id" || kl.startsWith("on") || kl.startsWith("data-")) continue;
      if (["colspan", "rowspan", "start", "title", "alt"].includes(kl)) keep.push(`${kl}="${v}"`);
    }
  }
  const at = keep.length ? " " + keep.join(" ") : "";
  return `<${n.tag}${at}>${kids}</${n.tag}>`;
}

// Plain code text preserving line breaks (for .code-block / .step-math).
function codeText(n) {
  if (!n) return "";
  if (n.text !== undefined) return n.raw ? "" : n.text;
  if (n.tag === "br") return "\n";
  if (n.tag === "script" || n.tag === "style" || n.tag === "svg") return "";
  return (n.children || []).map(codeText).join("");
}
function escHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function readLegacyFile(path) {
  const buf = readFileSync(path);
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le");
  return buf.toString("utf8");
}

export { parseHTML, walk, byClass, firstByClass, textOf, clean, innerHTML, evalConstMap, readLegacyFile };

function evalConstMap(scripts, name) {
  const m = scripts.match(new RegExp("const\\s+" + name + "\\s*=\\s*(\\{[\\s\\S]*?\\});"));
  if (!m) return null;
  try {
    return new Function(`return (${m[1]});`)();
  } catch {
    return null;
  }
}

const NO_ANSWER = "No written answer in the source note — work it from the topic above.";

function convertFile(path, course, week) {
  const warnings = [];
  // Scrub mojibake BEFORE parsing so text, titles, attrs and quiz JS all
  // decode cleanly (tags/attrs are ASCII and pass through untouched).
  const src = demojibake(readLegacyFile(path));
  const dom = parseHTML(src);
  const scriptTexts = walk(dom)
    .filter((n) => n.tag === "script")
    .map((n) => (n.children || []).filter((c) => c.text !== undefined).map((c) => c.text).join("\n"))
    .join("\n");

  const titleEl = firstByClass(dom, "week-title", "wh-title");
  let title = titleEl ? clean(textOf(titleEl)) : "";
  if (!title) {
    const t = src.match(/<title>([\s\S]*?)<\/title>/i);
    title = t ? clean(decodeEntities(t[1])).split("|")[0].split(":").slice(-1)[0].trim() : `Week ${week}`;
  }
  const summaryEl = firstByClass(dom, "week-summary", "wh-subtitle");
  const subtitle = summaryEl ? clean(textOf(summaryEl)) : "";
  const hookEl = firstByClass(dom, "wh-hook");
  const learningOutcome = hookEl ? clean(textOf(hookEl)) : subtitle;
  const tags = [
    ...byClass(dom, "tag"),
    ...byClass(dom, "term-pill"),
    ...byClass(dom, "key-term"),
  ]
    .map((n) => clean(textOf(n)))
    .filter(Boolean)
    .slice(0, 12);

  const examBox = firstByClass(dom, "exam-box");
  const examFocus = examBox
    ? [
        ...walk(examBox)
          .filter((n) => n.tag === "li")
          .map((n) => clean(innerHTML(n))),
        ...byClass(examBox, "exam-item").map((n) =>
          clean(textOf(n)).replace(/\bPast Q\b/g, "").replace(/\s+/g, " ").trim()
        ),
        ...byClass(examBox, "exam-q").map((n) =>
          clean(textOf(n)).replace(/\bPast Q\b/g, "").replace(/\s+/g, " ").trim()
        ),
      ].filter(Boolean)
    : [];
  const keyTerms = byClass(dom, "term-pill")
    .map((n) => clean(textOf(n)))
    .filter(Boolean);

  const prefix = (course.split(" ")[0] || course).toUpperCase();
  const topics = [];
  const topicBlocks = byClass(dom, "topic-block");
  const quizZones = byClass(dom, "quiz-zone");

  // position map:Pulse attaches to nearest preceding topic
  const order = walk(dom);
  const posOf = new Map(order.map((n, i) => [n, i]));

  const pulseMaps = evalConstMap(scriptTexts, "pulseAnswers");
  const weekMaps = evalConstMap(scriptTexts, "weekAnswers");

  function convertTopicBody(body, tIdx) {
    const content = [];
    const reveals = [];
    const recalls = [];
    const pushKids = (kids) => {
      for (const k of kids || []) {
        if (k.text !== undefined) continue;
        const cls = classes(k);
        if (k.tag === "p") {
          const html = clean(innerHTML(k));
          if (html) content.push({ type: "paragraph", text: html });
        } else if (k.tag === "ul" || k.tag === "ol") {
          const items = (k.children || [])
            .filter((c) => c.tag === "li")
            .map((li) => clean(innerHTML(li)))
            .filter(Boolean);
          if (items.length) content.push({ type: "bullets", items });
        } else if (cls.includes("exam-def")) {
          const label = clean(textOf(firstByClass(k, "def-label") || { children: [] }));
          const defEl = firstByClass(k, "def-text");
          const defHTML = defEl ? clean(innerHTML(defEl)) : "";
          if (defHTML) {
            content.push({ type: "paragraph", text: `<strong>${label || "Definition"}:</strong> ${defHTML}` });
            reveals.push({
              type: "reveal",
              question: `State the textbook definition — ${label || "this term"}.`,
              answer: defHTML,
            });
          }
        } else if (cls.includes("realworld-box") || cls.includes("analogy-box")) {
          const t = clean(textOf(k)).replace(/^(Real-world example|Real world example|Analogy)\s*/i, "");
          if (t) content.push({ type: "analogy", text: t });
        } else if (cls.includes("worked-example")) {
        } else if (cls.includes("worked-example")) {
          // Worked examples: label + problem <p> + .worked-step/.step-box + .result-box
          const stepEls = (k.children || []).filter(
            (c) => c.tag && (classes(c).includes("worked-step") || classes(c).includes("step-box"))
          );
          const resEl = firstByClass(k, "result-box");
          const labelEl = (k.children || []).find(
            (c) =>
              c.tag === "div" &&
              !classes(c).includes("worked-step") &&
              !classes(c).includes("step-box") &&
              !classes(c).includes("result-box")
          );
          const given = (k.children || [])
            .filter((c) => c.tag === "p")
            .map((p) => clean(innerHTML(p)))
            .filter(Boolean);
          const steps = stepEls.map((s, si) => {
            const num = clean(textOf(firstByClass(s, "step-num") || { children: [] }));
            const rest = (s.children || [])
              .filter((c) => !(c.tag && classes(c).includes("step-num")))
              .map((c) => (c.text !== undefined ? clean(c.text) : clean(textOf(c))))
              .filter(Boolean)
              .join(" ");
            const body = [num, rest].filter(Boolean).join(" — ") || clean(textOf(s));
            return { label: `Step ${si + 1}`, title: "", body, math: "" };
          });
          const result = resEl ? clean(textOf(resEl)) : "";
          const wtitle = labelEl ? clean(textOf(labelEl)) : "Worked example";
          if (steps.length || result || given.length) {
            content.push({ type: "workedExample", eyebrow: "Worked Example", title: wtitle, given, steps, result });
          }
        } else if (cls.includes("formula-block") || cls.includes("formula-box")) {
          const label = clean(textOf(firstByClass(k, "formula-label") || { children: [] }));
          const eqs = byClass(k, "formula-eq").map((e) => clean(innerHTML(e))).filter(Boolean);
          const vars = firstByClass(k, "formula-vars");
          if (label) content.push({ type: "paragraph", text: `<strong>${label}</strong>` });
          if (eqs.length) content.push({ type: "bullets", items: eqs });
          if (vars) {
            const vt = clean(textOf(vars));
            if (vt) content.push({ type: "paragraph", text: vt });
          }
          if (!label && !eqs.length && !vars) pushKids(k.children);
        } else if (cls.includes("formula-eq")) {
          // Standalone equation outside a formula block (MEE formula-box
          // children are consumed by query above; anything reaching here
          // stands alone).
          const t = clean(innerHTML(k));
          if (t) content.push({ type: "bullets", items: [t] });
        } else if (cls.includes("formula-vars")) {
          const t = clean(textOf(k));
          if (t) content.push({ type: "paragraph", text: t });
        } else if (cls.includes("step-note") || cls.includes("step-result")) {
          const t = clean(innerHTML(k));
          if (t) content.push({ type: "paragraph", text: t });
        } else if (cls.includes("why-box")) {
          const t = clean(textOf(k)).replace(/^(Why This Matters)\s*/i, "");
          if (t) content.push({ type: "insight", text: t });
        } else if (cls.includes("mistake-box")) {
          const t = clean(textOf(k)).replace(/^(Common mistake)\s*/i, "");
          if (t) content.push({ type: "insight", text: `Common mistake — ${t}` });
        } else if (cls.includes("def-box")) {
          // IPE definition boxes: formatted paragraph + recall card (the
          // box itself holds the answer).
          const html = clean(innerHTML(k));
          if (html) {
            content.push({ type: "paragraph", text: html });
            const strongEl = walk(k).find((n) => n.tag === "strong");
            const term = strongEl ? clean(textOf(strongEl)).replace(/:$/, "") : "this term";
            reveals.push({ type: "reveal", question: `Define: ${term}.`, answer: html });
          }
        } else if (cls.includes("rw-box")) {
          const t = clean(textOf(k)).replace(/^(Real-World Example|Real World Example)\s*/i, "");
          if (t) content.push({ type: "analogy", text: t });
        } else if (cls.includes("step-box") || cls.includes("worked-step")) {
          // Standalone procedure steps (inside .worked-example they are
          // consumed by that handler instead).
          const num = clean(textOf(firstByClass(k, "step-num") || { children: [] }));
          const rest = clean(textOf(k)).replace(num, "").trim();
          const html = [num && `<strong>${num}</strong>`, rest].filter(Boolean).join(" ");
          if (html) content.push({ type: "paragraph", text: html });
        } else if (cls.includes("step")) {
          // Row-operation / procedure step containers (.step-num + .step-content).
          const num = clean(textOf(firstByClass(k, "step-num") || { children: [] }));
          if (num) content.push({ type: "paragraph", text: `<strong>${num}</strong>` });
          const body = firstByClass(k, "step-content");
          pushKids(((body || k).children || []).filter((c) => !(c.tag && classes(c).includes("step-num"))));
        } else if (cls.includes("step-label")) {
          const t = clean(textOf(k));
          if (t) content.push({ type: "paragraph", text: `<strong>${t}</strong>` });
        } else if (cls.includes("step-desc")) {
          const t = clean(textOf(k));
          if (t) content.push({ type: "paragraph", text: t });
        } else if (cls.includes("step-math") || cls.includes("code-block")) {
          const t = clean(codeText(k));
          if (t) content.push({ type: "paragraph", text: `<pre>${escHtml(t)}</pre>` });
        } else if (cls.includes("def-row")) {
          const term = clean(textOf(firstByClass(k, "def-term") || { children: [] }));
          const mean = clean(textOf(firstByClass(k, "def-meaning") || { children: [] }));
          if (term || mean) {
            content.push({ type: "paragraph", text: `<strong>${term}</strong> — ${mean}` });
          }
        } else if (cls.includes("simple-box")) {
          const t = clean(textOf(k)).replace(/^(Think of it this way|Common Mistake|Why This Matters)\s*/i, "");
          if (t) {
            content.push(
              cls.includes("analogy")
                ? { type: "analogy", text: t }
                : { type: "insight", text: t }
            );
          }
        } else if (cls.includes("exam-q")) {
          const q = clean(textOf(k)).replace(/\bPast Q\b/g, "").replace(/\s+/g, " ").trim();
          if (q) reveals.push({ type: "reveal", question: q, answer: NO_ANSWER });
        } else if (cls.includes("exam-meta")) {
          // exam-paper chrome (course/session/duration) — not learning content
        } else if (cls.includes("pq-item")) {
          const num = clean(textOf(firstByClass(k, "pq-num") || { children: [] }));
          const marks = clean(textOf(firstByClass(k, "pq-marks") || { children: [] }));
          const ansBox = firstByClass(k, "answer-box");
          const answer = ansBox ? clean(innerHTML(ansBox)) : "";
          let q = clean(textOf(firstByClass(k, "pq-text") || { children: [] }));
          if (!q) {
            // Bare items (badge + raw text, no .pq-text wrapper).
            q = clean(textOf(k));
            for (const strip of [num, marks, answer].filter(Boolean)) q = q.replace(strip, "").trim();
          }
          if (q) {
            reveals.push({
              type: "reveal",
              question: `[${[num, marks].filter(Boolean).join(" · ")}] ${q}`,
              answer: answer || NO_ANSWER,
            });
          }
        } else if (
          cls.some((c) =>
            [
              "topic-number",
              "topic-title",
              "topic-num",
              "topic-header",
              "accordion-section-label",
              "rw-label",
              "mistake-label",
              "def-label",
              "formula-label",
              "exam-box-label",
              "key-terms-label",
              "why-label",
              "q-type",
              "pq-label",
            ].includes(c)
          )
        ) {
          // Already-extracted headers/labels — skip silently.
        } else if (k.tag === "br" || k.tag === "hr") {
          // line breaks carry no content
        } else if (cls.includes("quick-check")) {
          for (const item of byClass(k, "qc-item")) {
            const badge = clean(textOf(firstByClass(item, "qc-badge") || { children: [] }));
            const q = clean(textOf(item)).replace(badge, "").trim();
            if (q) reveals.push({ type: "reveal", question: badge ? `[${badge}] ${q}` : q, answer: NO_ANSWER });
          }
        } else if (cls.includes("accordion-item")) {
          const btnText = firstByClass(k, "accordion-btn-text");
          const qtype = clean(textOf(firstByClass(k, "q-type") || { children: [] })) || "Recall";
          let question = btnText ? clean(textOf(btnText)) : "";
          question = question.replace(qtype, "").trim();
          const ansEl = firstByClass(k, "answer-inner");
          const answer = ansEl ? clean(innerHTML(ansEl)) : "";
          if (question && answer) recalls.push({ badge: qtype, question, answer });
        } else if (cls.includes("diagram-wrap") || cls.includes("diagram-container")) {
          const cap1 = clean(
            textOf(firstByClass(k, "diagram-titlebar") || firstByClass(k, "diagram-label") || { children: [] })
          );
          const svgTexts = [];
          for (const t of walk(k).filter((n) => n.tag === "text")) {
            const s = clean(textOf(t));
            if (s) svgTexts.push(s);
          }
          content.push({
            type: "diagram",
            caption: cap1 || "Figure",
            description: svgTexts.join(" · ").slice(0, 300),
            imageRef: null,
          });
        } else if (cls.includes("quiz-zone") || cls.includes("topic-block") || cls.includes("topic-body")) {
          // handled at week level / already inside — skip to avoid dupes
        } else if (k.tag === "div" || k.tag === "section" || k.tag === "article") {
          if (cls.includes("box-label") || cls.includes("sec-eye")) {
            const t = clean(textOf(k));
            if (t) content.push({ type: "paragraph", text: `<strong>${t}</strong>` });
          } else if (cls.some((c) => ["past-q", "qc-badge", "q-type", "opt-letter"].includes(c))) {
            // badges with no content value — skip silently
          } else {
            const before = content.length;
            const r0 = reveals.length;
            const c0 = recalls.length;
            pushKids(k.children);
            if (content.length === before && reveals.length === r0 && recalls.length === c0) {
              const leftover = clean(textOf(k));
              if (leftover) warnings.push(`unhandled div.${cls.join(".") || "(no-class)"} in topic ${tIdx + 1}`);
            }
          }
        } else if (["span", "strong", "em", "b", "i", "u", "small", "code", "sup", "sub", "font"].includes(k.tag)) {
          if (cls.some((c) => ["past-q", "qc-badge", "q-type", "opt-letter", "opt-text", "term-pill", "key-term", "tag", "hi"].includes(c))) {
            // badges + highlights + header pills (their text lives in tags) — skip silently
          } else {
            const html = clean(innerHTML(k));
            if (html) content.push({ type: "paragraph", text: html });
          }
        } else if (["h1", "h2", "h3", "h4", "h5", "h6"].includes(k.tag)) {
          const t = clean(textOf(k));
          if (t) content.push({ type: "paragraph", text: `<strong>${t}</strong>` });
        } else if (k.tag === "table") {
          const cells = walk(k).filter((c) => c.tag === "td" || c.tag === "th").map((c) => clean(textOf(c))).filter(Boolean);
          if (cells.length) content.push({ type: "bullets", items: cells });
        } else {
          warnings.push(`unhandled <${k.tag}>.${cls.join(".")} in topic ${tIdx + 1}`);
        }
      }
    };
    const bodyEl = firstByClass(body, "topic-body") || body;
    // Sibling sweep: some files keep boxes/tables/diagrams as DIRECT
    // topic-block children next to (or without) .topic-body. Walking only
    // .topic-body would silently drop them, so iterate direct children in
    // document order instead.
    const HEADER_SKIP = ["topic-header", "topic-number", "topic-title", "topic-num"];
    const inner = bodyEl !== body ? bodyEl : null;
    if (inner && inner.parent === body) {
      for (const k of body.children || []) {
        if (k.text !== undefined) continue;
        if (k === inner) {
          pushKids(k.children);
          continue;
        }
        if (HEADER_SKIP.some((c) => classes(k).includes(c))) continue;
        pushKids([k]);
      }
    } else {
      pushKids((inner || body).children);
      if (inner) {
        for (const k of body.children || []) {
          if (k.text !== undefined || k === inner) continue;
          if (HEADER_SKIP.some((c) => classes(k).includes(c))) continue;
          if (walk(k).includes(inner)) continue; // ancestor: already covered
          pushKids([k]);
        }
      }
    }
    return { content, reveals, recalls };
  }

  // quiz-zone parsing (shared for pulse + week quiz)
  function parseQuiz(zone, answers) {
    const qs = [];
    const blocks = byClass(zone, "q-block");
    blocks.forEach((b, i) => {
      const qtext = clean(textOf(firstByClass(b, "q-text") || { children: [] }));
      const badge = clean(textOf(firstByClass(b, "q-type-badge") || { children: [] })).toLowerCase();
      const opts = byClass(b, "opt-text").map((o) => clean(textOf(o))).filter(Boolean);
      const hint = clean(textOf(firstByClass(b, "fitb-hint") || { children: [] }));
      const id = (b.attrs && b.attrs.id) || `q${i + 1}`;
      const rawAns = answers ? answers[id] : undefined;
      // Answer maps come in two shapes: bare (pulse: 'C' | [...]) and
      // object (week: {type, correct, explanation}).
      let ans = rawAns;
      let expl = null;
      if (rawAns && typeof rawAns === "object" && !Array.isArray(rawAns)) {
        ans = rawAns.correct;
        if (typeof rawAns.explanation === "string") expl = rawAns.explanation;
      }
      const isMcq = badge.includes("mcq") || opts.length > 0;
      if (!qtext) return;
      if (isMcq && opts.length) {
        const letter = typeof ans === "string" ? ans.trim().toUpperCase() : null;
        const idx = letter ? letter.charCodeAt(0) - 65 : -1;
        if (idx < 0 || idx >= opts.length) return; // no valid key: skip
        qs.push({ kind: "mcq", question: qtext, options: opts, letter, expl });
      } else {
        const accepted = Array.isArray(ans) ? ans : typeof ans === "string" ? [ans] : [];
        if (!accepted.length) return; // ungradeable: skip
        qs.push({ kind: "fitb", question: hint ? `${qtext} (Hint: ${hint})` : qtext, accepted, expl });
      }
    });
    return qs;
  }

  // week quiz answers live in page JS
  const weekQuizZone = quizZones.find((z) => !classes(z).includes("mid") && (z.attrs.id === "week-quiz" || byClass(z, "q-block").length > 0));
  const pulseZone = quizZones.find((z) => classes(z).includes("mid"));

  topicBlocks.forEach((tb, tIdx) => {
    const ttitleEl = firstByClass(tb, "topic-title");
    const ttitle = ttitleEl ? clean(textOf(ttitleEl)) : `Topic ${tIdx + 1}`;
    const { content, reveals, recalls } = convertTopicBody(tb, tIdx);
    if (!reveals.length) {
      reveals.push({
        type: "reveal",
        question: `In your own words, explain "${ttitle}".`,
        answer: NO_ANSWER,
      });
    }
    const topic = {
      number: tIdx + 1,
      title: ttitle,
      abbr: prefix,
      subtopics: [
        {
          number: `${tIdx + 1}.1`,
          title: ttitle,
          abbr: prefix,
          content,
          miniCheck: { questions: reveals },
        },
      ],
    };
    if (recalls.length) topic.activeRecall = recalls;
    topics.push(topic);
  });

  // Non-standard week pages (no .topic-block):
  //  - .pq-section exam-practice weeks -> one topic per section, model
  //    answers become reveal cards.
  //  - review weeks (key terms + exam items) -> single summary topic.
  if (!topics.length) {
    const sections = byClass(dom, "pq-section");
    sections.forEach((sec, si) => {
      const label = clean(textOf(firstByClass(sec, "pq-label") || { children: [] })) || `Practice ${si + 1}`;
      const reveals = byClass(sec, "pq-item")
        .map((item) => {
          const num = clean(textOf(firstByClass(item, "pq-num") || { children: [] }));
          const marks = clean(textOf(firstByClass(item, "pq-marks") || { children: [] }));
          const q = clean(textOf(firstByClass(item, "pq-text") || { children: [] }));
          const ansBox = firstByClass(item, "answer-box");
          const answer = ansBox ? clean(innerHTML(ansBox)) : "";
          if (!q) return null;
          return {
            type: "reveal",
            question: `[${[num, marks].filter(Boolean).join(" · ")}] ${q}`,
            answer: answer || NO_ANSWER,
          };
        })
        .filter(Boolean);
      if (!reveals.length) return;
      topics.push({
        number: si + 1,
        title: label,
        abbr: prefix,
        subtopics: [{ number: `${si + 1}.1`, title: label, abbr: prefix, content: [], miniCheck: { questions: reveals } }],
      });
    });
    if (!topics.length && (examFocus.length || keyTerms.length)) {
      const content = [];
      if (keyTerms.length) {
        content.push({ type: "paragraph", text: "<strong>Key terms:</strong>" });
        content.push({ type: "bullets", items: keyTerms });
      }
      topics.push({
        number: 1,
        title,
        abbr: prefix,
        subtopics: [
          {
            number: "1.1",
            title,
            abbr: prefix,
            content,
            miniCheck: { questions: [{ type: "reveal", question: `In your own words, explain "${title}".`, answer: NO_ANSWER }] },
          },
        ],
      });
    }
  }

  // Exam focus lands on the first topic whatever page shape built it.
  if (topics.length && examFocus.length) {
    const first = topics[0].subtopics[0];
    first.content.push({ type: "paragraph", text: "<strong>Exam focus:</strong>" });
    first.content.push({ type: "bullets", items: examFocus });
  }
  for (const kt of keyTerms) {
    if (tags.length < 12 && !tags.includes(kt)) tags.push(kt);
  }

  // Footer carries the real course title ("CVE 214 — Engineering Hydrology").
  let courseTitle = null;
  const footerEl = walk(dom).find((n) => n.tag === "footer");
  if (footerEl) {
    const strongs = walk(footerEl).filter((n) => n.tag === "strong");
    const ft = strongs.length ? clean(textOf(strongs[0])) : "";
    const fm = ft.match(/^([A-Z]{2,4} \d{3})\s*[—–-]\s*(.+)$/);
    if (fm && fm[1].toUpperCase() === course) courseTitle = fm[2].trim();
  }

  // pulse -> nearest preceding topic (else first)
  if (pulseZone) {
    const pqs = parseQuiz(pulseZone, pulseMaps);
    if (pqs.length) {
      const zp = posOf.get(pulseZone) ?? Number.MAX_SAFE_INTEGER;
      let attach = 0;
      topicBlocks.forEach((tb, i) => {
        if ((posOf.get(tb) ?? 0) < zp) attach = i;
      });
      const host = topics[attach] || topics[0];
      if (host) {
        host.pulseCheck = {
          number: host.number,
          questions: pqs.slice(0, 3).map((q) =>
            q.kind === "mcq"
              ? {
                  type: "mcq",
                  question: q.question,
                  options: q.options,
                  ...(q.letter ? { correctIndex: q.letter.charCodeAt(0) - 65 } : {}),
                }
      : { type: "fitb", question: q.question, acceptedAnswers: q.accepted.length ? q.accepted : ["?"] }
          ),
        };
      }
    }
  }

  // week quiz -> eoq
  let eoqQuestions = [];
  if (weekQuizZone) {
    const wqs = parseQuiz(weekQuizZone, weekMaps);
    const n = Math.max(topics.length, 1);
    eoqQuestions = wqs
      .map((q, i) => {
        const fb = q.expl
          ? { correct: `✓ ${q.expl}`, wrong: `✗ ${q.expl}` }
          : { correct: "Well done.", wrong: "Not quite — review the topic and try again." };
        const base = { number: i + 1, question: q.question, feedback: fb, topicRef: String((i % n) + 1) };
        if (q.kind === "mcq") return { ...base, type: "mcq", options: q.options, correct: q.letter };
        return { ...base, type: "fitb", acceptedAnswers: q.accepted };
      })
      .filter(Boolean);
  }

  return {
    note: {
      course,
      week,
      title,
      subtitle,
      learningOutcome,
      metaChips: [course, `Week ${week}`],
      tags,
      topics,
      eoq: { questions: eoqQuestions },
      ...(courseTitle ? { courseTitle } : {}),
    },
    warnings,
  };
}

// ---- driver (only when run directly, not when imported for debug) ----
if (process.argv[1] && process.argv[1].replace(/\\/g, "/") === fileURLToPath(import.meta.url).replace(/\\/g, "/")) {
run();
}

function run() {
mkdirSync(OUT_DIR, { recursive: true });

function* walkFiles(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p);
    else yield p;
  }
}

const report = { files: [], skipped: [], totals: { notes: 0, topics: 0, miniQs: 0, recalls: 0, pulses: 0, eoqs: 0 } };

for (const file of walkFiles(LEGACY_DIR)) {
  if (!file.toLowerCase().endsWith(".html")) continue;
  const dirName = basename(dirname(file));
  const base = basename(file);
  const wm = base.match(/^W(\d+)\.html$/i);
  if (!wm || !/^[A-Z]{2,4} \d{3}$/i.test(dirName)) {
    report.skipped.push(`${dirName}/${base}`);
    continue;
  }
  const course = dirName.toUpperCase();
  const week = Number(wm[1]);
  try {
    const { note, warnings } = convertFile(file, course, week);
    if (!note.topics.length && !note.eoq.questions.length) {
      report.skipped.push(`${dirName}/${base} (no topics, no quiz)`);
      continue;
    }
    const outName = `${course.replace(/\s+/g, "")}-W${week}.json`;
    writeFileSync(join(OUT_DIR, outName), JSON.stringify(note, null, 2), "utf8");
    const miniQs = note.topics.reduce((s, t) => s + t.subtopics[0].miniCheck.questions.length, 0);
    const recalls = note.topics.reduce((s, t) => s + (t.activeRecall ? t.activeRecall.length : 0), 0);
    report.files.push({
      file: `${dirName}/${base}`,
      out: outName,
      topics: note.topics.length,
      miniQs,
      recalls,
      pulse: note.topics.some((t) => t.pulseCheck) ? 1 : 0,
      eoq: note.eoq.questions.length,
      emptyMini: note.topics.filter((t) => t.subtopics[0].miniCheck.questions.length === 0).map((t) => t.number),
      warnings,
    });
    report.totals.notes += 1;
    report.totals.topics += note.topics.length;
    report.totals.miniQs += miniQs;
    report.totals.recalls += recalls;
    if (note.topics.some((t) => t.pulseCheck)) report.totals.pulses += 1;
    report.totals.eoqs += note.eoq.questions.length;
  } catch (e) {
    report.skipped.push(`${dirName}/${base} (ERROR: ${e instanceof Error ? e.message : String(e)})`);
  }
}

writeFileSync(join(OUT_DIR, "_report.json"), JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ totals: report.totals, skipped: report.skipped }, null, 2));
const warnFiles = report.files.filter((f) => f.warnings.length || f.emptyMini.length);
console.log(`files with warnings/empty-minicheck: ${warnFiles.length}`);
for (const f of warnFiles.slice(0, 20)) {
  console.log(`- ${f.file}: emptyMini=[${f.emptyMini}] warnings=${JSON.stringify(f.warnings.slice(0, 3))}`);
}
}
