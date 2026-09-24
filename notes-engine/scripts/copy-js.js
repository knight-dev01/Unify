// Copies plain .js sources (schema.js, renderer.js) into dist/ so the tsc
// build output stays runnable on Render. Cross-platform (no shell cp).
const fs = require("fs");
const path = require("path");

const srcDir = path.join(__dirname, "..", "src");
const distDir = path.join(__dirname, "..", "dist", "src");

function copyJs(dir, rel) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      copyJs(path.join(dir, e.name), path.join(rel, e.name));
    } else if (e.name.endsWith(".js")) {
      const dest = path.join(distDir, rel, e.name);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(dir, e.name), dest);
    }
  }
}

copyJs(srcDir, "");
console.log("copied src js -> dist/src");

// Runtime data the server reads from disk (tsc never emits these, so copy
// them or /api/sample + AI convert run rule-less in production).
const runtimeFiles = [
  ["samples/hand_authored_note.json", "samples/hand_authored_note.json"],
  ["foundation for Unify notes Engine/UNIFY_RULES.md", "UNIFY_RULES.md"],
  ["foundation for Unify notes Engine/UNIFY_MATHJAX_RULE.md", "UNIFY_MATHJAX_RULE.md"],
];
for (const [from, to] of runtimeFiles) {
  const src = path.join(__dirname, "..", from);
  if (!fs.existsSync(src)) {
    console.log("missing (skipped): " + from);
    continue;
  }
  const dest = path.join(__dirname, "..", "dist", to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log("copied " + from + " -> dist/" + to);
}
