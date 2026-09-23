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

const app = express();
const PORT = process.env.PORT || 3000;
// Behind Render's proxy: trust one hop so rate limiters see real client IPs.
app.set("trust proxy", 1);

const CORS_ORIGINS = (process.env.CORS_ORIGIN || "").split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: CORS_ORIGINS.length ? CORS_ORIGINS : true }));
app.use(express.json({ limit: "50mb" }));
app.use(express.static("public"));
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
  "course": "string (e.g. MEE 352)",
  "week": number (e.g. 6),
  "title": "string",
  "subtitle": "string",
  "learningOutcome": "string",
  "metaChips": ["string", "..."],
  "tags": ["string", "..."],
  "topics": [
    {
      "number": 1,
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

  const userPrompt = `Course Code: ${course || "MEE 352"}
Week Number: ${week || 1}
${title ? `Title: ${title}` : ""}
${subtitle ? `Subtitle: ${subtitle}` : ""}
${learningOutcome ? `Learning Outcome: ${learningOutcome}` : ""}
${tags ? `Tags: ${tags.join(", ")}` : ""}
${modeInstruction}

RAW LECTURE NOTES TO STRUCTURE:
${rawNotesText}
`;

  const { generateStructuredNote } = require("./src/lib/ai");
  try {
    const { text: rawJson, provider, model } = await generateStructuredNote({
      system: SYSTEM_PROMPT,
      user: userPrompt,
      apiKeyOverride: typeof headerKey === "string" ? headerKey : undefined,
    });

    // Clean any accidental markdown fences ```json ... ```
    const jsonText = rawJson.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

    const noteJson = JSON.parse(jsonText);

    // Validate quality rules
    const validation = validateUnifyNote(noteJson);
    if (!validation.valid) {
      console.warn("AI output failed validation warnings:", validation.errors);
    }

    res.json({
      success: true,
      note: noteJson,
      validation,
      provider,
      model
    });
  } catch (err) {
    console.error("Conversion error:", err);
    const status = (err && err.status) || 500;
    res.status(status).json({ error: "Failed to convert raw notes", message: err.message });
  }
});

// Unknown routes -> JSON (not HTML) so API clients get a clean 404.
app.use((req, res) => res.status(404).json({ error: "Not found" }));

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
      aiProvider: process.env.AI_PROVIDER || "anthropic",
      anthropicKey: Boolean(process.env.ANTHROPIC_API_KEY),
      geminiKey: Boolean(process.env.GEMINI_API_KEY),
    },
  });
  console.log(`Unify API running at http://localhost:${PORT}`);
});

// Reference seed + default admin (both idempotent). Never blocks boot;
// failures land in the logs.
try {
  const seed = require("./src/lib/seed");
  seed.ensureSeeded()
    .then(() => logger.info("seed check done"))
    .catch((e) => logger.warn("seed skipped", { message: e && e.message }));
  seed.ensureDefaultAdmin()
    .then(() => logger.info("default admin check done"))
    .catch((e) => logger.warn("default admin skipped", { message: e && e.message }));
} catch (e) {
  logger.warn("seed skipped", { message: e && e.message });
}
