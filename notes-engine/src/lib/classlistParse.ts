import { inflateRawSync } from "node:zlib";

// Turns whatever a class rep has (CSV, Excel, Word, PDF, pasted text) into
// rows of { name, matric }. Nothing is saved here: the HOC reviews the result
// first. Photos are not accepted (no OCR): the review says so too.

export type ParsedRow = {
  line: number;
  name: string;
  matric: string;
  issue?: "duplicate" | "no_name" | "odd_matric";
};
export type ParseProblem = { line: number; text: string; issue: "no_matric" };
export type ParseResult = { rows: ParsedRow[]; problems: ParseProblem[]; skipped: number; source: string };

export class ParseError extends Error {}

// ---------- Containers ----------

// Minimal ZIP reader (xlsx and docx are zip files). Stored and deflated entries only.
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ParseError("That file looks damaged. Save it again and re-upload, or paste the list instead.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    try {
      if (method === 0) out.set(name, raw);
      else if (method === 8) out.set(name, inflateRawSync(raw));
    } catch {
      // skip an unreadable entry; the parts we need are checked below
    }
  }
  return out;
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

const textOf = (xml: string, tag: string) => {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  let s = "";
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) s += m[1];
  return decodeXml(s.replace(/<[^>]+>/g, ""));
};

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/i.exec(ref)?.[0].toUpperCase() || "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xlsxRows(buf: Buffer): string[][] {
  const files = unzip(buf);
  const shared: string[] = [];
  const ss = files.get("xl/sharedStrings.xml")?.toString("utf8");
  if (ss) {
    const re = /<si>([\s\S]*?)<\/si>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ss))) shared.push(textOf(m[1], "t"));
  }
  const sheets = [...files.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k))
    .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1]) - Number(/(\d+)\.xml$/.exec(b)?.[1]));
  if (!sheets.length) throw new ParseError("No sheet found in that Excel file.");
  const rows: string[][] = [];
  for (const name of sheets) {
    const xml = files.get(name)!.toString("utf8");
    const rowRe = /<row[\s>][\s\S]*?<\/row>/g;
    let r: RegExpExecArray | null;
    while ((r = rowRe.exec(xml))) {
      const cells: string[] = [];
      const cellRe = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
      let c: RegExpExecArray | null;
      while ((c = cellRe.exec(r[0]))) {
        const attrs = c[1];
        const body = c[2] || "";
        const ref = /\br="([A-Z]+)\d*"/i.exec(attrs)?.[1];
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1] || "n";
        let v = "";
        if (type === "s") v = shared[Number(textOf(body, "v"))] ?? "";
        else if (type === "inlineStr") v = textOf(body, "t");
        else v = textOf(body, "v");
        // Long matric numbers saved as numbers can come back as 1.90591001E8.
        if (type === "n" && /e\+?\d+$/i.test(v) && Number.isFinite(Number(v))) v = BigInt(Math.round(Number(v))).toString();
        const idx = ref ? colIndex(ref) : cells.length;
        while (cells.length < idx) cells.push("");
        cells[idx] = v.trim();
      }
      if (cells.some((x) => x)) rows.push(cells);
    }
  }
  return rows;
}

function docxRows(buf: Buffer): string[][] {
  const files = unzip(buf);
  const xml = files.get("word/document.xml")?.toString("utf8");
  if (!xml) throw new ParseError("That Word file has no text we can read.");
  const rows: string[][] = [];
  // Table rows become rows of cells; other paragraphs become one-cell rows.
  const blockRe = /<w:tr[\s>][\s\S]*?<\/w:tr>|<w:p[\s>][\s\S]*?<\/w:p>/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(xml))) {
    if (m[0].startsWith("<w:tr")) {
      const cells: string[] = [];
      const cellRe = /<w:tc[\s>][\s\S]*?<\/w:tc>/g;
      let c: RegExpExecArray | null;
      while ((c = cellRe.exec(m[0]))) cells.push(textOf(c[0].replace(/<w:tab\/>/g, "<w:t> </w:t>"), "w:t").trim());
      if (cells.some((x) => x)) rows.push(cells);
    } else {
      const t = textOf(m[0].replace(/<w:tab\/>/g, "<w:t>\t</w:t>"), "w:t");
      if (t.trim()) rows.push(...linesToRows(t));
    }
  }
  return rows;
}

async function pdfRows(buf: Buffer): Promise<string[][]> {
  // unpdf is ESM-only; the API compiles to CommonJS, so load it with a real import().
  const load = new Function("s", "return import(s)") as (s: string) => Promise<typeof import("unpdf")>;
  const { getDocumentProxy, extractText } = await load("unpdf");
  let text: string[];
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    text = (await extractText(pdf, { mergePages: false })).text as string[];
  } catch {
    throw new ParseError("We couldn't open that PDF. Try the Excel or Word version, or paste the list.");
  }
  const rows = text.flatMap((page) => linesToRows(page));
  if (!rows.length) throw new ParseError("That PDF has no text in it (probably a scan). Use the Excel or Word version, or paste the list.");
  return rows;
}

function csvRows(text: string): string[][] {
  const delim = (text.split(/\r?\n/, 5).join("\n").match(/;/g)?.length || 0) > (text.split(/\r?\n/, 5).join("\n").match(/,/g)?.length || 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === delim || ch === "\t") {
      row.push(cell.trim());
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(cell.trim());
      if (row.some((x) => x)) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell.trim());
  if (row.some((x) => x)) rows.push(row);
  return rows;
}

// Pasted text / PDF / Word paragraphs: split on tabs, pipes, or runs of 2+ spaces.
function linesToRows(text: string): string[][] {
  return text
    .split(/\r?\n/)
    .map((l) => l.split(/\t|\s*\|\s*|\s{2,}/).map((c) => c.trim()).filter(Boolean))
    .filter((cells) => cells.length);
}

// ---------- Rows -> entries ----------

// LASU matric numbers are digits (e.g. 190591046); some schools use ENG/19/1234.
const MATRIC_RE = /\b(?:[A-Z]{2,5}\/)?\d{2,4}\/\d{3,6}\b|\b\d{7,12}\b/i;
const PHONE_RE = /^(?:\+?234|0)[789][01]\d{8}$/;
const HEADER_WORDS = new Set(
  "s/n sn s.n no no. name names full fullname surname firstname first other othernames middle matric matriculation number num reg registration dept department level gender sex male female m f email phone sign signature remark remarks".split(" ")
);

const isMatricCell = (s: string) => {
  const m = MATRIC_RE.exec(s.replace(/\s+/g, ""));
  return !!m && !PHONE_RE.test(m[0]);
};
const findMatric = (s: string): string => {
  const re = new RegExp(MATRIC_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) if (!PHONE_RE.test(m[0])) return m[0].toUpperCase();
  return "";
};
const nameTokens = (s: string) => (s.match(/[A-Za-z][A-Za-z'’.\-]*/g) || []).filter((t) => !HEADER_WORDS.has(t.toLowerCase().replace(/[.:]$/, "")));
const isNameCell = (s: string) => nameTokens(s).length > 0 && !/\d/.test(s) && !/@/.test(s) && s.replace(/[^A-Za-z]/g, "").length >= 2;

export function normalizeMatric(raw: string): string {
  return String(raw || "").toUpperCase().replace(/\s+/g, "");
}

export function tidyName(raw: string): string {
  let s = raw.replace(/[,;]+/g, " ").replace(/\s+/g, " ").trim();
  // ALL CAPS lists read better in Title Case on registers.
  if (s && s === s.toUpperCase()) s = s.toLowerCase().replace(/(^|[\s'’\-])([a-z])/g, (_, a, b) => a + b.toUpperCase());
  return s.slice(0, 100);
}

type Plan = { matricCol: number; nameCols: number[] } | null;

// Find the matric and name columns from a header row, or from what the columns hold.
function planColumns(rows: string[][]): Plan {
  for (const row of rows.slice(0, 15)) {
    const lower = row.map((c) => c.toLowerCase());
    const matricCol = lower.findIndex((c) => /matric|reg(istration)?\.?\s*(no|num)|^reg/.test(c));
    const nameCols = lower.map((c, i) => (/name/.test(c) && i !== matricCol ? i : -1)).filter((i) => i >= 0);
    if (matricCol >= 0 && nameCols.length) return { matricCol, nameCols };
  }
  const width = Math.max(...rows.map((r) => r.length));
  if (width < 2) return null;
  const data = rows.filter((r) => r.some(isMatricCell));
  if (data.length < 2) return null;
  let matricCol = -1;
  let best = 0;
  for (let c = 0; c < width; c++) {
    const hits = data.filter((r) => r[c] && isMatricCell(r[c])).length;
    if (hits > best) {
      best = hits;
      matricCol = c;
    }
  }
  if (best < data.length * 0.6) return null;
  const nameCols: number[] = [];
  for (let c = 0; c < width; c++) {
    if (c === matricCol) continue;
    const vals = data.map((r) => r[c] || "").filter(Boolean);
    const named = vals.filter(isNameCell);
    if (named.length < data.length * 0.6) continue;
    // A column with the same value on most rows is a department or level, not a name.
    const distinct = new Set(named.map((v) => v.toLowerCase())).size;
    if (data.length >= 5 && distinct < named.length * 0.5) continue;
    // Gender (M/F) and similar one-letter columns.
    if (named.every((v) => v.replace(/[^A-Za-z]/g, "").length <= 1)) continue;
    nameCols.push(c);
  }
  return nameCols.length ? { matricCol, nameCols } : null;
}

export function rowsToEntries(rows: string[][], source: string): ParseResult {
  const plan = planColumns(rows);
  const out: ParsedRow[] = [];
  const problems: ParseProblem[] = [];
  let skipped = 0;
  let seenData = false;

  rows.forEach((cells, i) => {
    const line = i + 1;
    let matric = "";
    let name = "";
    if (plan && cells.length > plan.matricCol) {
      matric = findMatric((cells[plan.matricCol] || "").replace(/\s+/g, ""));
      name = plan.nameCols.map((c) => cells[c] || "").join(" ");
      if (!matric) {
        // Rows that don't fit the columns (a pasted line in the middle) get the loose read.
        matric = findMatric(cells.join(" "));
        if (matric) name = cells.join(" ").replace(new RegExp(matric.replace(/\//g, "\\/"), "i"), " ");
      }
    } else {
      const joined = cells.join(" ");
      matric = findMatric(joined);
      name = matric ? joined.replace(new RegExp(matric.replace(/\//g, "\\/"), "i"), " ") : joined;
    }
    // Drop a leading serial number ("1.", "12)") and anything that isn't a name word.
    name = nameTokens(name.replace(/^\s*\d{1,4}[.)]?\s+/, " ")).join(" ");
    if (matric) {
      seenData = true;
      out.push({ line, name, matric: normalizeMatric(matric) });
    } else if (seenData && nameTokens(cells.join(" ")).length >= 2 && !/\d{3,}/.test(cells.join(" "))) {
      problems.push({ line, text: cells.join(" ").slice(0, 120), issue: "no_matric" });
    } else skipped++;
  });

  // Words on more than half the rows (a department or level printed on every
  // line of a PDF) are not part of anyone's name.
  if (out.length >= 5) {
    const freq = new Map<string, number>();
    for (const r of out) for (const t of new Set(r.name.toLowerCase().split(" ").filter(Boolean))) freq.set(t, (freq.get(t) || 0) + 1);
    const common = new Set([...freq].filter(([, n]) => n > out.length * 0.5).map(([t]) => t));
    if (common.size) for (const r of out) r.name = r.name.split(" ").filter((t) => !common.has(t.toLowerCase())).join(" ");
  }

  // Flag shapes that differ from most of the list (a typo'd digit count).
  const shape = (m: string) => m.replace(/\d/g, "9").replace(/[A-Z]/g, "A");
  const shapes = new Map<string, number>();
  for (const r of out) shapes.set(shape(r.matric), (shapes.get(shape(r.matric)) || 0) + 1);
  const common = [...shapes].sort((a, b) => b[1] - a[1])[0]?.[0];
  const seen = new Map<string, number>();
  for (const r of out) {
    r.name = tidyName(r.name);
    seen.set(r.matric, (seen.get(r.matric) || 0) + 1);
  }
  for (const r of out) {
    if (!r.name) r.issue = "no_name";
    else if ((seen.get(r.matric) || 0) > 1) r.issue = "duplicate";
    else if (out.length >= 5 && common && shape(r.matric) !== common) r.issue = "odd_matric";
  }
  return { rows: out, problems, skipped, source };
}

export async function parseClassList(input: { text?: string; filename?: string; data?: Buffer }): Promise<ParseResult> {
  if (input.text != null) {
    const t = input.text;
    return rowsToEntries(/[,;]/.test(t) && !/\t/.test(t) && t.split(/\r?\n/).filter(Boolean).every((l) => /[,;]/.test(l)) ? csvRows(t) : linesToRows(t), "text");
  }
  const buf = input.data;
  const name = (input.filename || "").toLowerCase();
  if (!buf || !buf.length) throw new ParseError("That file is empty.");
  if (/\.(png|jpe?g|heic|webp|gif)$/.test(name)) throw new ParseError("Photos of a list can't be read. Upload the Excel, Word or PDF file, or paste the names.");
  const isZip = buf.readUInt32LE(0) === 0x04034b50;
  if (name.endsWith(".xlsx") || (isZip && !name.endsWith(".docx") && unzip(buf).has("xl/workbook.xml"))) return rowsToEntries(xlsxRows(buf), "excel");
  if (name.endsWith(".docx") || (isZip && unzip(buf).has("word/document.xml"))) return rowsToEntries(docxRows(buf), "word");
  if (name.endsWith(".pdf") || buf.subarray(0, 5).toString("latin1") === "%PDF-") return rowsToEntries(await pdfRows(buf), "pdf");
  if (name.endsWith(".xls") || name.endsWith(".doc")) throw new ParseError("That's an old Office format. Save it as .xlsx or .docx (File → Save As) and upload again.");
  const text = buf.toString("utf8").replace(/^﻿/, "");
  if (/[\x00-\x08]/.test(text.slice(0, 2000))) throw new ParseError("We can't read that file type. Use CSV, Excel (.xlsx), Word (.docx), PDF, or paste the list.");
  return rowsToEntries(name.endsWith(".csv") ? csvRows(text) : linesToRows(text), name.endsWith(".csv") ? "csv" : "text");
}
