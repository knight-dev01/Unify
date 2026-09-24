import { supabaseAdmin } from "./supabase";

// AI provider adapter for the studio's /api/convert endpoint.
// Gemini is the default (free tier); set AI_PROVIDER=anthropic to switch back.
// A model registry (ai_models table) tracks what the key can call and each
// model's health, so generation rotates across everything accessible.
//
// Students never touch AI (standing rule) — only this module spends keys,
// and only from the author-gated convert route.
const MAX_TOKENS = 8192;
const MAX_FAILURES = 3;
const CHAIN_CAP = 8;

async function anthropic(system: string, user: string, model: string, apiKey: string): Promise<string> {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    const err = new Error(`Anthropic API Error: ${response.status} ${errText}`);
    (err as { status?: number }).status = response.status;
    throw err;
  }
  const data = (await response.json()) as { content?: { type?: string; text?: string }[] };
  const text = (data.content || []).find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Anthropic returned no text");
  return text;
}

async function gemini(system: string, user: string, model: string, apiKey: string): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ parts: [{ text: user }] }],
      generationConfig: {
        responseMimeType: "application/json",
        maxOutputTokens: MAX_TOKENS,
        temperature: 0.7,
      },
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    const err = new Error(`Gemini API Error: ${response.status} ${errText}`);
    (err as { status?: number }).status = response.status;
    throw err;
  }
  const data = (await response.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
  };
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
  if (!text) throw new Error("Gemini returned no text");
  return text;
}

let liveCache: { at: number; models: string[] } | null = null;
const LIVE_TTL = 60 * 60 * 1000;

// Live discovery: what this key can actually call right now (no stale
// hardcodes). Cached an hour; failures fall back to configured names.
export async function listLiveModels(apiKey: string): Promise<string[]> {
  if (liveCache && Date.now() - liveCache.at < LIVE_TTL) return liveCache.models;
  const res = await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
    headers: { "x-goog-api-key": apiKey },
  });
  if (!res.ok) throw new Error(`Gemini listModels failed: ${res.status}`);
  const data = (await res.json()) as {
    models?: { name?: string; supportedGenerationMethods?: string[] }[];
  };
  const models = (data.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
    .map((m) => (m.name || "").replace(/^models\//, ""))
    .filter(Boolean);
  liveCache = { at: Date.now(), models };
  return models;
}

type RegistryRow = { model: string; failures: number; last_ok: string | null };

async function readRegistry(): Promise<RegistryRow[]> {
  try {
    const { data, error } = await supabaseAdmin().from("ai_models").select("model,failures,last_ok");
    if (error) return [];
    return ((data ?? []) as RegistryRow[]);
  } catch {
    return [];
  }
}

// Pull the live list with the env key and store it. Safe to run often;
// upserts never duplicate. Throws when the key/network is unusable.
export async function syncModelsOnce(): Promise<string[]> {
  const apiKey = process.env.GEMINI_API_KEY || "";
  if (!apiKey) throw new Error("Set GEMINI_API_KEY first.");
  liveCache = null;
  const live = await listLiveModels(apiKey);
  try {
    await supabaseAdmin()
      .from("ai_models")
      .upsert(
        live.map((model) => ({ model })),
        { onConflict: "model", ignoreDuplicates: true }
      );
  } catch {
    // registry is advisory: discovery still succeeded
  }
  return live;
}

export function startModelSync(intervalMs = 30 * 60 * 1000): void {
  const run = async () => {
    try {
      const live = await syncModelsOnce();
      console.log(`model registry synced (${live.length} models)`);
    } catch (e) {
      console.warn("model sync skipped", e instanceof Error ? e.message : String(e));
    }
  };
  void run();
  setInterval(() => {
    void run();
  }, intervalMs);
}

async function recordModel(model: string, ok: boolean): Promise<void> {
  try {
    const sb = supabaseAdmin();
    if (ok) {
      await sb
        .from("ai_models")
        .upsert({ model, failures: 0, last_ok: new Date().toISOString() }, { onConflict: "model" });
    } else {
      const rows = await readRegistry();
      const cur = rows.find((r) => r.model === model)?.failures ?? 0;
      await sb.from("ai_models").upsert({ model, failures: cur + 1 }, { onConflict: "model" });
    }
  } catch {
    // registry is advisory only
  }
}

function isRateLimit(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  // 429/RESOURCE_EXHAUSTED (quota) and 404 (unknown model id) both fall through.
  if (status === 429 || status === 404) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /RESOURCE_EXHAUSTED|quota|rate.?limit|429|not.?found/i.test(msg);
}

export async function generateStructuredNote(args: {
  system: string;
  user: string;
  apiKeyOverride?: string;
}): Promise<{ text: string; provider: string; model: string }> {
  const provider = (process.env.AI_PROVIDER || "gemini").toLowerCase();
  if (provider === "gemini") {
    const apiKey = args.apiKeyOverride || process.env.GEMINI_API_KEY || "";
    if (!apiKey) {
      throw Object.assign(new Error("Missing Gemini API Key. Set GEMINI_API_KEY."), { status: 400 });
    }
    const primary = process.env.GEMINI_MODEL || "gemini-3.6-flash";
    const configured = (process.env.GEMINI_MODELS || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((m) => m !== primary);
    // Healthiest accessible models first (failures < cap, fewest first).
    // AI_ROTATION=off restricts to primary + explicitly configured models.
    const rotate = (process.env.AI_ROTATION || "on").toLowerCase() !== "off";
    const rows = rotate ? await readRegistry() : [];
    const healthy = rows
      .filter((r) => r.failures < MAX_FAILURES)
      .sort((a, b) => a.failures - b.failures || (a.model < b.model ? -1 : 1))
      .map((r) => r.model);
    const seen = new Set<string>([primary]);
    const chain = [primary, ...configured, ...healthy]
      .filter((m) => {
        if (seen.has(m)) return false;
        seen.add(m);
        return true;
      })
      .slice(0, CHAIN_CAP);
    let lastErr: unknown = null;
    for (const model of chain) {
      try {
        const text = await gemini(args.system, args.user, model, apiKey);
        await recordModel(model, true);
        return { text, provider, model };
      } catch (e) {
        lastErr = e;
        if (!isRateLimit(e)) {
          await recordModel(model, false);
          throw e;
        }
        await recordModel(model, false);
        console.warn(`Gemini ${model} unavailable or rate-limited, trying next model`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("All Gemini models unavailable");
  }
  const apiKey = args.apiKeyOverride || process.env.ANTHROPIC_API_KEY || "";
  if (!apiKey) {
    throw Object.assign(new Error("Missing Anthropic API Key. Set ANTHROPIC_API_KEY."), { status: 400 });
  }
  const model = process.env.CLAUDE_MODEL || "claude-3-7-sonnet-20250219";
  return { text: await anthropic(args.system, args.user, model, apiKey), provider, model };
}
