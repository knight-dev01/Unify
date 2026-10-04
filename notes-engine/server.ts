// @ts-nocheck — legacy JS-style server; new app code lives in typed src/ modules.
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { validateUnifyNote } = require("./src/schema");
const { renderUnifyNote } = require("./src/renderer");
const { requestLogger, logger } = require("./src/middleware/logger");

// Sentry (free tier): crash + 500 visibility. Env-gated — no SENTRY_DSN,
// no-op, zero behavior change. DSN lives in Render env, never in code.
try {
  const Sentry = require("@sentry/node");
  if (process.env.SENTRY_DSN) {
    Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });
  }
} catch {
  // sentry not installed/configured — API runs without it
}

const app = express();
const PORT = process.env.PORT || 3000;
// Behind Render's proxy: trust one hop so rate limiters see real client IPs.
app.set("trust proxy", 1);

const CORS_ORIGINS = (process.env.CORS_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: CORS_ORIGINS.length ? CORS_ORIGINS : true }));
app.use(express.json({ limit: "50mb" }));
// NOTE: the legacy public/ playground was removed; authoring lives in the
// web Studio now. /uploads stays (authored figure images).
app.use("/uploads", express.static("uploads"));
app.use(requestLogger);

// Storage directories
const STORAGE_DIR = path.join(__dirname, "storage/notes");
const UPLOADS_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Multer storage for uploaded figure images
const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const basename = path.basename(file.originalname, ext).replace(/[^a-z0-9_-]/gi, "_");
    cb(null, `${basename}_${Date.now()}${ext}`);
  }
});
const upload = multer({ storage: uploadStorage });

// Load system prompt rules files safely
let rulesPath = path.join(__dirname, "UNIFY_RULES.md");
if (!fs.existsSync(rulesPath)) {
  rulesPath = path.join(__dirname, "foundation for Unify notes Engine", "UNIFY_RULES.md");
}
let mathRulesPath = path.join(__dirname, "UNIFY_MATHJAX_RULE.md");
if (!fs.existsSync(mathRulesPath)) {
  mathRulesPath = path.join(__dirname, "foundation for Unify notes Engine", "UNIFY_MATHJAX_RULE.md");
}

const unifyRules = fs.existsSync(rulesPath) ? fs.readFileSync(rulesPath, "utf-8") : "";
const unifyMathRules = fs.existsSync(mathRulesPath) ? fs.readFileSync(mathRulesPath, "utf-8") : "";

const SCHEMA_SPEC = `
{
  "course": "string (e.g. CVE 214)",
  "week": number (e.g. 6),
  "title": "string",
  "subtitle": "string",
  "learningOutcome": "string",
  "metaChips": ["string", "..."],
  "tags": ["string", "..."],
  "topics": [
    {
      "number": 1,
      "lecture": 1,
      "title": "string",
      "abbr": "short-slug",
      "subtopics": [
        {
          "number": "1.1",
          "abbr": "short-slug",
          "title": "string",
          "content": [
            { "type": "paragraph", "text": "string" },
            { "type": "bullets", "items": ["string", "..."] },
            { "type": "formula", "label": "string", "equation": "\\[ LaTeX \\]", "note": "string" },
            { "type": "symbol", "symbol": "string", "name": "string", "desc": "string" },
            { "type": "insight", "text": "string" },
            { "type": "analogy", "text": "string" },
            { "type": "workedExample", "eyebrow": "string", "title": "string", "given": ["string"], "steps": [{ "label": "Step 1", "title": "string", "body": "string", "math": "\\[ LaTeX \\]" }], "result": "string" },
            { "type": "diagram", "caption": "string", "description": "string", "imageRef": "string | null" }
          ],
          "miniCheck": {
            "questions": [
              { "type": "mcq", "question": "string", "options": ["A", "B", "C", "D"], "correctIndex": 0 },
              { "type": "fitb", "question": "string with ________ blank", "acceptedAnswers": ["string", "..."] },
              { "type": "reveal", "question": "string", "answer": "string with <strong>key terms</strong>" }
            ]
          }
        }
      ],
      "activeRecall": [
        { "badge": "Definition | Mechanism | Comparison | Application", "question": "string", "answer": "string" }
      ],
      "pulseCheck": {
        "number": 1,
        "questions": [
          { "type": "mcq", "question": "string", "options": ["A", "B", "C", "D"], "correctIndex": 0 },
          { "type": "mcq", "question": "string", "options": ["A", "B", "C", "D"], "correctIndex": 0 },
          { "type": "fitb", "question": "string with ________ blank", "acceptedAnswers": ["string", "..."] }
        ]
      }
    }
  ],
  "eoq": {
    "questions": [
      {
        "number": 1,
        "type": "mcq",
        "question": "string",
        "options": ["A", "B", "C", "D"],
        "correct": "A",
        "feedback": { "correct": "string", "wrong": "string" },
        "topicRef": "string (which topic this maps to, for topics to review list)"
      }
    ]
  }
}
`;

const SYSTEM_PROMPT = `${unifyRules}

---

${unifyMathRules}

---

OUTPUT FORMAT OVERRIDE:
Everything above describes the Unify note format and how to structure content — follow all of it exactly (Golden Rule, Mini Check density, question-type rotation, Pulse Check structure, EOQ rules, content style, diagram handling).

However, you do NOT output HTML. Output ONLY valid JSON matching the schema below, no preamble, no markdown fences, no commentary:

${SCHEMA_SPEC}

Where the rules describe an HTML structure to copy (Mini Check divs, recall-card, pulse-check, eoq-question), instead populate the corresponding JSON fields — the app's template handles all markup and styling.

Where the raw notes contain a figure/diagram reference, and the admin has NOT tagged it with a [FIGURE: id | caption: ...] placeholder, generate a "diagram" content block with your best caption/description from context but leave "imageRef" null. If the admin HAS tagged it, carry the id through as "imageRef" and never invent, describe, or alter the image itself.

LECTURE SPLITTING (BUG-009 — a week is Lecture 1/2/3, never one long topic list):
Every topic carries "lecture" (1, 2 or 3). When the raw notes clearly contain separate taught sessions (headings like Lecture 1 / Lecture 2, Part A/B, Day 1/2, or distinct class dates), group the topics under the matching lecture and number topics from 1 within EACH lecture. When the input is a single session with no such split, put every topic in lecture 1. The week EOQ stays one bank for the whole week (it is shown after the final lecture).
`;

// Health check (Render healthCheckPath + client warmup ping)
app.get("/healthz", (req, res) => res.json({ ok: true, service: "unify-api" }));

// v1 app API (Supabase-backed). Compiled to dist/src/routes/v1.js by tsc.
const v1 = require("./src/routes/v1");
app.use("/v1", v1.default || v1);

// Authoring guard: lecturers/collaborators only (students get 403).
// convert costs Claude money; save/upload cost disk. validate/render/sample
// stay public (pure functions, no secrets, no side effects).
const { requireAuth } = require("./src/middleware/requireAuth");
const { requireAuthor } = require("./src/middleware/requireAuthor");
const authorWriteLimit = require("express-rate-limit")({ windowMs: 60 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
const convertLimit = require("express-rate-limit")({ windowMs: 60 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
app.use("/api/convert", requireAuth, requireAuthor, convertLimit);
app.use("/api/save", requireAuth, requireAuthor, authorWriteLimit);
app.use("/api/upload", requireAuth, requireAuthor, authorWriteLimit);
app.use("/api/notes", requireAuth, requireAuthor);

// Author-only: live Gemini models supporting generateContent (picker/debug).
app.get("/api/models", requireAuth, requireAuthor, async (req, res) => {
  try {
    const { listLiveModels } = require("./src/lib/ai");
    const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
    if (provider !== "gemini") {
      return res.json({
        provider,
        default: process.env.CLAUDE_MODEL || "claude-3-7-sonnet-20250219",
        models: [],
      });
    }
    const apiKey = process.env.GEMINI_API_KEY || "";
    if (!apiKey) return res.status(400).json({ error: "Set GEMINI_API_KEY first." });
    if (req.query.refresh) {
      const { syncModelsOnce } = require("./src/lib/ai");
      await syncModelsOnce();
    }
    const models = await listLiveModels(apiKey);
    res.json({ provider, default: process.env.GEMINI_MODEL || "gemini-3.6-flash", models });
  } catch (err) {
    res.status(500).json({ error: "Failed to list models", message: err.message });
  }
});

// API Routes

// 1. Get preloaded hand-authored sample note
app.get("/api/sample", (req, res) => {
  const samplePath = path.join(__dirname, "samples/hand_authored_note.json");
  if (fs.existsSync(samplePath)) {
    const data = JSON.parse(fs.readFileSync(samplePath, "utf-8"));
    return res.json(data);
  }
  res.status(404).json({ error: "Sample note not found." });
});

// 1b. Copy-paste prompt pack for EXTERNAL AI (lecturer's own ChatGPT /
// Claude / Gemini app). Same schema + hard rules as the built-in converter,
// so pasted-back JSON imports identically while spending zero server AI
// tokens. Public like /api/sample (no secrets, no side effects).
const FORMAT_PACK = `You turn messy lecture notes into Unify study JSON.

HOW TO USE
1. Paste this whole prompt AND your raw lecture notes into the chat below.
2. The AI replies with JSON only. Copy that JSON (nothing else).
3. In Unify Studio choose "External AI", paste it, Import, Review, Publish.

HARD RULES (the app validates every one of these — break one and import warns):
- Top-level fields, all required: course (string), week (integer), title,
  subtitle, learningOutcome, metaChips (string[]), tags (string[]),
  topics (array, at least 1), eoq (object with questions array).
- Every topic: number (integer), title, abbr (short slug), subtopics
  (at least 1), activeRecall (at least 1 card), pulseCheck (EXACTLY 3
  questions in this order: MCQ, MCQ, FITB).
- Every subtopic: number (string like "1.1"), abbr, title, content
  (array, may be empty), miniCheck.questions (at least 1).
- Mini-check question types: mcq {question, options[2..4], correctIndex},
  fitb {question with ________ blank, acceptedAnswers (at least 1)},
  reveal {question, answer}. Never put the same type twice in a row.
- Active recall card: {badge, question, answer}. Badge is one of:
  Definition | Mechanism | Comparison | Application.
- EOQ (end-of-week quiz): EXACTLY 10 questions — 8 mcq + 2 fitb. Every
  question needs: number, question, feedback {correct, wrong}, topicRef
  (topic number as string, e.g. "2"). MCQ needs options + correct (letter
  "A"/"B"/"C"/"D"); FITB needs acceptedAnswers.
- Math goes in LaTeX inside \\\\[ ... \\\\] (display) or \\\\( ... \\\\) (inline).
- Output ONLY valid JSON matching the schema below. No preamble, no
  markdown fences, no commentary.

SCHEMA:
${SCHEMA_SPEC}

MINI EXAMPLE (shape reference — your note must still satisfy every rule above,
including exactly-3 pulse checks and exactly-10 EOQ):
{
  "course": "CVE 214",
  "week": 6,
  "title": "Averaging Precipitation over an Area",
  "subtitle": "Three methods engineers use",
  "learningOutcome": "Describe the three averaging methods and their limits.",
  "metaChips": ["CVE 214", "Week 6"],
  "tags": ["Thiessen", "Isohyetal"],
  "topics": [
    {
      "number": 1,
      "title": "Three Methods",
      "abbr": "METHODS",
      "subtopics": [
        {
          "number": "1.1",
          "abbr": "METHODS",
          "title": "Arithmetic Average",
          "content": [
            { "type": "paragraph", "text": "Averages every gauge equally." },
            { "type": "bullets", "items": ["Simple", "Fails on hilly terrain"] }
          ],
          "miniCheck": {
            "questions": [
              { "type": "mcq", "question": "Which method averages gauges equally?", "options": ["Arithmetic", "Thiessen"], "correctIndex": 0 },
              { "type": "fitb", "question": "Thiessen weights gauges by ________.", "acceptedAnswers": ["area", "polygon area"] }
            ]
          }
        }
      ],
      "activeRecall": [
        { "badge": "Definition", "question": "What is the arithmetic average method?", "answer": "Mean of all gauge readings." }
      ],
      "pulseCheck": {
        "number": 1,
        "questions": [
          { "type": "mcq", "question": "Q1?", "options": ["A", "B"], "correctIndex": 0 },
          { "type": "mcq", "question": "Q2?", "options": ["A", "B"], "correctIndex": 1 },
          { "type": "fitb", "question": "Q3 ________?", "acceptedAnswers": ["x"] }
        ]
      }
    }
  ],
  "eoq": { "questions": [ { "number": 1, "type": "mcq", "question": "Q?", "options": ["A", "B"], "correct": "A", "feedback": { "correct": "Well done.", "wrong": "Review topic 1." }, "topicRef": "1" } ] }
}
(Reminder: a real note needs all 10 EOQ questions, not the 1 shown here.)
`;

app.get("/api/format", (req, res) => {
  res.json({ prompt: FORMAT_PACK });
});

// 2. Validate JSON note
app.post("/api/validate", (req, res) => {
  const result = validateUnifyNote(req.body);
  res.json(result);
});

// 3. Render JSON note to HTML
app.post("/api/render", (req, res) => {
  try {
    const validation = validateUnifyNote(req.body);
    if (!validation.valid) {
      return res.status(400).json({ error: "Schema Validation Failed", details: validation.errors });
    }
    const html = renderUnifyNote(req.body);
    res.type("text/html").send(html);
  } catch (err) {
    res.status(500).json({ error: "Rendering Error", message: err.message });
  }
});

// 4. Image Upload Route
app.post("/api/upload", upload.single("figureImage"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No image file uploaded." });
  }
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({
    id: req.body.figureId || req.file.filename,
    url: fileUrl,
    filename: req.file.filename
  });
});

// 5. Save Note Route
app.post("/api/save", (req, res) => {
  try {
    const note = req.body;
    const filename = `${(note.course || "NOTE").toLowerCase().replace(/[^a-z0-9]/gi, "_")}_week${note.week || 1}_${Date.now()}.json`;
    const filePath = path.join(STORAGE_DIR, filename);
    fs.writeFileSync(filePath, JSON.stringify(note, null, 2), "utf-8");
    res.json({ success: true, filename, path: filePath });
  } catch (err) {
    res.status(500).json({ error: "Failed to save note", message: err.message });
  }
});

// 6. List Saved Notes
app.get("/api/notes", (req, res) => {
  try {
    const files = fs.readdirSync(STORAGE_DIR).filter(f => f.endsWith(".json"));
    const notes = files.map(f => {
      const content = JSON.parse(fs.readFileSync(path.join(STORAGE_DIR, f), "utf-8"));
      return {
        filename: f,
        course: content.course,
        week: content.week,
        title: content.title,
        updatedAt: fs.statSync(path.join(STORAGE_DIR, f)).mtime
      };
    });
    res.json(notes);
  } catch (err) {
    res.status(500).json({ error: "Failed to list notes", message: err.message });
  }
});

// 7. Claude API Conversion Endpoint
app.post("/api/convert", async (req, res) => {
  const headerKey = req.headers["x-api-key"];

  const { course, week, segmentationMode, rawNotesText, title, subtitle, learningOutcome, tags } = req.body;

  if (!rawNotesText || !rawNotesText.trim()) {
    return res.status(400).json({ error: "Raw notes text cannot be empty." });
  }

  let modeInstruction = "";
  if (segmentationMode === "per-topic") {
    modeInstruction = "Segmentation Mode: Per-Topic. Treat the provided text as one single topic and strictly respect all existing section headers.";
  } else if (segmentationMode === "whole-week-headers") {
    modeInstruction = "Segmentation Mode: Whole Week, My Headers. Split topics and subtopics strictly along the admin's existing headings and section titles.";
  } else {
    modeInstruction = "Segmentation Mode: Whole Week, AI Decides. You have authority to identify logical topic and subtopic break points from unstructured text.";
  }

  const userPromptForPart = (chunkText: string) => `Course Code: ${course || "Unspecified"}
Week Number: ${week || 1}
${title ? `Title: ${title}` : ""}
${subtitle ? `Subtitle: ${subtitle}` : ""}
${learningOutcome ? `Learning Outcome: ${learningOutcome}` : ""}
${tags ? `Tags: ${tags.join(", ")}` : ""}
${modeInstruction}

RAW LECTURE NOTES TO STRUCTURE:
${chunkText}
`;

  const { generateStructuredNote, convertPart, splitInput, toConvertError, CONVERT_PART_CHARS, CONVERT_HARD_CHARS } = require("./src/lib/ai");
  try {
    // BUG-004: large inputs split automatically (sequential parts, merged
    // below). Small inputs take the exact same single-shot path as before.
    // Long jobs run ASYNC (see below): this only plans the split.
    const parts = splitInput(rawNotesText);
    if (!parts) {
      return res.status(413).json({
        error: "Notes too large to convert reliably",
        message: `This input is ~${rawNotesText.length.toLocaleString()} characters; the limit is ~${CONVERT_HARD_CHARS.toLocaleString()}.`,
        hint: "Split into 2–3 classes and generate each separately, or use per-topic mode for one class at a time.",
        code: "INPUT_TOO_LARGE",
      });
    }
    const job = createConvertJob(parts.length);
    // Kick off without awaiting: the client polls GET /api/convert/:jobId.
    // The request returns in ms no matter how many parts follow.
    void runConvertJob(job, {
      system: SYSTEM_PROMPT,
      userPromptForPart,
      parts,
      headerKey: typeof headerKey === "string" ? headerKey : undefined,
      meta: {
        course: course || "Unspecified",
        week: Number(week) || 1,
        title: title || "",
        subtitle: subtitle || "",
        learningOutcome: learningOutcome || "",
        tags: Array.isArray(tags) ? tags : [],
      },
    }).catch((err) => {
      console.error("Conversion job failed:", job.id, err);
      job.status = "error";
      const mapped = decodeJobError(err);
      job.error = { message: mapped.message, hint: mapped.hint, code: mapped.code };
      job.updatedAt = Date.now();
    });
    res.status(202).json({ jobId: job.id, parts: parts.length, split: parts.length > 1 });
  } catch (err) {
    console.error("Conversion error:", err);
    const mapped = toConvertError(err);
    res.status(mapped.status).json({ error: mapped.message, message: mapped.message, hint: mapped.hint, code: mapped.code });
  }
});

// Async conversion jobs (BUG-004 speed concern): multi-part generations
// take minutes, far past safe request timeouts. The POST above returns
// instantly; this worker runs detached while the client polls status.
// Single-instance assumption (Render free/starter): jobs live in memory and
// are evicted an hour after finishing. Multi-instance would need a table.
type ConvertJob = {
  id: string;
  status: "working" | "done" | "error";
  partsTotal: number;
  partsDone: number;
  currentModel: string;
  result?: {
    note: unknown;
    validation: unknown;
    provider: string;
    model: string;
    split: boolean;
    parts: { index: number; topics: number; model: string; attempts: number }[];
    warnings: string[];
  };
  error?: { message: string; hint: string; code: string };
  updatedAt: number;
};
const convertJobs = new Map<string, ConvertJob>();

function createConvertJob(partsTotal: number): ConvertJob {
  // Evict finished jobs older than an hour; cap the map.
  const now = Date.now();
  for (const [id, j] of convertJobs) {
    if (j.updatedAt < now - 3600000) convertJobs.delete(id);
  }
  while (convertJobs.size > 50) {
    const oldest = [...convertJobs.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
    if (!oldest) break;
    convertJobs.delete(oldest[0]);
  }
  const { randomUUID } = require("node:crypto");
  const job: ConvertJob = {
    id: randomUUID(),
    status: "working",
    partsTotal,
    partsDone: 0,
    currentModel: "",
    updatedAt: now,
  };
  convertJobs.set(job.id, job);
  return job;
}

async function runConvertJob(
  job: ConvertJob,
  ctx: {
    system: string;
    userPromptForPart: (chunk: string) => string;
    parts: string[];
    headerKey?: string;
    meta: { course: string; week: number; title: string; subtitle: string; learningOutcome: string; tags: unknown[] };
  }
): Promise<void> {
  const { convertPart, toConvertError } = require("./src/lib/ai");
  const { validateUnifyNote } = require("./src/schema");
  const multi = ctx.parts.length > 1;
  const merged = {
    course: ctx.meta.course,
    week: ctx.meta.week,
    title: ctx.meta.title,
    subtitle: ctx.meta.subtitle,
    learningOutcome: ctx.meta.learningOutcome,
    metaChips: [],
    tags: ctx.meta.tags,
    topics: [] as unknown[],
    eoq: { questions: [] as unknown[] },
  };
  const partReports: { index: number; topics: number; model: string; attempts: number }[] = [];
  const warnings: string[] = [];
  let provider = "";
  // Earlier parts' outlines ride into the final part so its 10-question
  // EOQ can reference the whole week, not just the last chunk.
  const outlines: string[] = [];
  for (let pi = 0; pi < ctx.parts.length; pi++) {
    const isLast = pi === ctx.parts.length - 1;
    const offset = merged.topics.length;
    const partSuffix = multi
      ? isLast
        ? `PART ${pi + 1} OF ${ctx.parts.length} (FINAL). Earlier parts covered: ${outlines.join(" | ") || "nothing yet"}. Output topics for THIS part only, continuing numbering after topic ${offset}. Then output the full end-of-week quiz: EXACTLY 10 questions (8 mcq + 2 fitb) covering the WHOLE week, with topicRef pointing at the final merged numbering (1..${offset}+yours).`
        : `PART ${pi + 1} OF ${ctx.parts.length}. Output topics for THIS part only, numbered from 1. Set eoq.questions to an EMPTY array (the final part writes the one week quiz).`
      : "";
    let text: string;
    let model = "";
    try {
      const r = await convertPart({
        system: ctx.system,
        user: ctx.userPromptForPart(ctx.parts[pi]),
        apiKeyOverride: ctx.headerKey,
        partSuffix,
      });
      text = r.text;
      model = r.model;
      provider = r.provider;
      partReports.push({ index: pi + 1, topics: 0, model, attempts: r.attempts });
    } catch (e) {
      const mapped = toConvertError(e);
      throw Object.assign(new Error(`${mapped.message} (part ${pi + 1} of ${ctx.parts.length})|${mapped.hint}|${mapped.code}|${mapped.status}`), {
        status: mapped.status,
      });
    }

    // Clean any accidental markdown fences ```json ... ```
    const jsonText = text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

    let noteJson: Record<string, unknown>;
    try {
      noteJson = JSON.parse(jsonText);
    } catch {
      throw Object.assign(
        new Error(
          `Part ${pi + 1} of ${ctx.parts.length} came back unparseable after automatic retries.|Press Generate again. If it persists, split the input smaller or simplify formatting.|BAD_OUTPUT|502`
        ),
        { status: 502 }
      );
    }
    const partTopics = Array.isArray(noteJson.topics) ? (noteJson.topics as unknown[]) : [];
    // Renumber sequentially across parts; clamp out-of-range EOQ refs + warn.
    partTopics.forEach((t, i) => {
      (t as { number?: unknown }).number = offset + i + 1;
    });
    merged.topics.push(...partTopics);
    partReports[partReports.length - 1].topics = partTopics.length;
    outlines.push(
      partTopics
        .map((t) => {
          const tt = t as { number?: unknown; title?: unknown };
          return `T${tt.number}: ${String(tt.title || "").slice(0, 80)}`;
        })
        .join("; ")
    );
    const partEoq = (noteJson.eoq as { questions?: unknown[] } | undefined)?.questions;
    if (isLast && Array.isArray(partEoq)) {
      merged.eoq.questions = (partEoq as { topicRef?: unknown }[]).map((q, qi) => {
        const ref = Number((q as { topicRef?: unknown }).topicRef);
        if (!Number.isInteger(ref) || ref < 1 || ref > merged.topics.length) {
          const clamped = Math.min(Math.max(Number.isInteger(ref) ? (ref as number) : 1, 1), Math.max(merged.topics.length, 1));
          warnings.push(`Quiz Q${qi + 1} pointed at missing topic ${String((q as { topicRef?: unknown }).topicRef)} — moved to topic ${clamped}. Verify in review.`);
          return { ...(q as object), topicRef: String(clamped) };
        }
        return q;
      });
      // BUG-010: the week quiz must be exactly 10 questions (8 MCQ + 2
      // FITB). Models often return 5–8. One automatic repair pass asks for
      // a fresh full bank instead of shipping a short quiz to review.
      const bank = merged.eoq.questions as { type?: unknown }[];
      const mcq = bank.filter((q) => q.type === "mcq").length;
      const fitb = bank.filter((q) => q.type === "fitb").length;
      if (bank.length !== 10 || mcq !== 8 || fitb !== 2) {
        warnings.push(`Quiz came back with ${bank.length} questions (${mcq} MCQ + ${fitb} FITB) — requesting a full 10-question bank automatically.`);
        try {
          const repair = await convertPart({
            system: ctx.system,
            user: `The week covered these topics:\n${outlines.join("\n")}\n\nThe quiz you just wrote had ${bank.length} questions. FORGET it. Output ONLY a JSON array (no fences, no commentary) of EXACTLY 10 end-of-week quiz questions for the topics above: 8 with "type": "mcq" (options ["A","B","C","D"], "correct" letter, feedback {correct, wrong}) followed by 2 with "type": "fitb" (question with ________ blank, acceptedAnswers, feedback {correct, wrong}). Every item needs "number" (1..10), "question", "feedback" and "topicRef" (the topic number string it tests, 1..${merged.topics.length}).`,
            apiKeyOverride: ctx.headerKey,
          });
          const cleaned = repair.text.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
          const fresh = JSON.parse(cleaned);
          const arr = Array.isArray(fresh) ? fresh : (fresh as { questions?: unknown }).questions;
          if (Array.isArray(arr) && arr.length === 10) {
            const fmcq = (arr as { type?: unknown }[]).filter((q) => q.type === "mcq").length;
            const ffitb = (arr as { type?: unknown }[]).filter((q) => q.type === "fitb").length;
            if (fmcq === 8 && ffitb === 2) {
              merged.eoq.questions = (arr as { topicRef?: unknown }[]).map((q, qi) => {
                const ref = Number((q as { topicRef?: unknown }).topicRef);
                const clamped = Math.min(Math.max(Number.isInteger(ref) ? (ref as number) : 1, 1), Math.max(merged.topics.length, 1));
                return { ...(q as object), number: qi + 1, topicRef: String(clamped) };
              });
              warnings.push("Quiz repaired automatically to 10 questions (8 MCQ + 2 FITB). Skim it in review.");
            } else {
              warnings.push(`Quiz repair returned the wrong mix (${fmcq} MCQ + ${ffitb} FITB) — kept the original bank. Regenerate or top up in Edit content.`);
            }
          } else {
            warnings.push("Quiz repair did not return 10 questions — kept the original bank. Regenerate or top up in Edit content.");
          }
        } catch {
          warnings.push("Quiz repair call failed — kept the original bank. Regenerate or top up in Edit content.");
        }
      }
    }
    if (isLast) {
      if (typeof noteJson.title === "string" && noteJson.title && !merged.title) merged.title = noteJson.title;
      if (typeof noteJson.subtitle === "string" && noteJson.subtitle && !merged.subtitle) merged.subtitle = noteJson.subtitle;
      if (typeof noteJson.learningOutcome === "string" && noteJson.learningOutcome && !merged.learningOutcome)
        merged.learningOutcome = noteJson.learningOutcome;
    }
    job.partsDone = pi + 1;
    job.currentModel = model;
    job.updatedAt = Date.now();
  }

  // Validate quality rules
  const validation = validateUnifyNote(merged);
  if (!validation.valid) {
    console.warn("AI output failed validation warnings:", validation.errors);
  }

  job.result = {
    note: merged,
    validation,
    provider,
    model: partReports.length ? partReports[partReports.length - 1].model : "",
    split: multi,
    parts: partReports,
    warnings,
  };
  job.status = "done";
  job.updatedAt = Date.now();
}

// Job errors thrown above encode mapped fields after a "|" separator.
function decodeJobError(e: unknown): { message: string; hint: string; code: string; status: number } {
  const { toConvertError } = require("./src/lib/ai");
  if (e instanceof Error && e.message.includes("|")) {
    const [message, hint, code, status] = e.message.split("|");
    const s = Number(status);
    if (message && hint && code && Number.isInteger(s)) return { message, hint, code, status: s };
  }
  const mapped = toConvertError(e);
  return { message: mapped.message, hint: mapped.hint, code: mapped.code, status: mapped.status };
}

app.get("/api/convert/:jobId", async (req, res) => {
  const job = convertJobs.get(String(req.params.jobId || ""));
  if (!job) {
    return res.status(404).json({ error: "Unknown or expired job. Press Generate again." });
  }
  if (job.status === "working") {
    return res.json({
      status: "working",
      partsTotal: job.partsTotal,
      partsDone: job.partsDone,
      currentModel: job.currentModel,
    });
  }
  if (job.status === "error") {
    const err = job.error || { message: "Conversion failed.", hint: "Press Generate again.", code: "CONVERT_FAILED" };
    return res.status(400).json({ error: err.message, message: err.message, hint: err.hint, code: err.code });
  }
  return res.json({ status: "done", ...(job.result || {}) });
});

// Unknown routes -> JSON (not HTML) so API clients get a clean 404.
app.use((req, res) => res.status(404).json({ error: "Not found" }));

// Sentry express error hook (only active when SENTRY_DSN is set).
try {
  const Sentry = require("@sentry/node");
  if (process.env.SENTRY_DSN && Sentry.setupExpressErrorHandler) {
    Sentry.setupExpressErrorHandler(app);
  }
} catch {
  // ignore
}

app.listen(PORT, () => {
  logger.info("unify-api listening", {
    port: PORT,
    env: {
      supabaseUrl: Boolean(process.env.SUPABASE_URL),
      publishableKey: Boolean(process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY),
      secretKey: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY),
      databaseUrl: Boolean(process.env.DATABASE_URL),
      directUrl: Boolean(process.env.DIRECT_URL),
      cors: process.env.CORS_ORIGIN || "open (dev only)",
      aiProvider: process.env.AI_PROVIDER || "gemini",
      anthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
      geminiKey: Boolean(process.env.GEMINI_API_KEY),
    },
  });
  console.log(`Unify API running at http://localhost:${PORT}`);
});

// Reference seed + default admin (both idempotent). Retried because the
// first attempt can hit transient faults (e.g. DB clock skew at deploy).
// Never blocks boot; failures land in the logs.
function bootJob(label, fn, delays) {
  const attempt = (left) => {
    Promise.resolve()
      .then(() => fn())
      .then(() => logger.info(label + " done"))
      .catch((e) => {
        if (!left.length) return logger.warn(label + " skipped", { message: e && e.message });
        setTimeout(() => attempt(left.slice(1)), left[0]);
      });
  };
  try {
    attempt(delays || [5000, 15000]);
  } catch (e) {
    logger.warn(label + " skipped", { message: e && e.message });
  }
}

try {
  const seed = require("./src/lib/seed");
  // Seed carries ~90 files / hundreds of rows on first boot: give slow
  // free-tier boots a long retry tail before giving up for this boot.
  bootJob("seed check", () => seed.ensureSeeded(), [5000, 15000, 60000, 300000]);
  bootJob("default admin check", () => seed.ensureDefaultAdmin());
} catch (e) {
  logger.warn("seed skipped", { message: e && e.message });
}

// Model registry sync (idempotent). Never blocks boot.
try {
  require("./src/lib/ai").startModelSync();
} catch (e) {
  logger.warn("model sync skipped", { message: e && e.message });
}
