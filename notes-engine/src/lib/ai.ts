// AI provider adapter for the studio's /api/convert endpoint.
// Gemini is the default (free tier); set AI_PROVIDER=anthropic to switch back.
// Students never touch AI (standing rule) — only this module spends keys,
// and only from the author-gated convert route.
const MAX_TOKENS = 8192;

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

function geminiChain(): string[] {
  const primary = process.env.GEMINI_MODEL || "gemini-3.6-flash";
  const extra = (process.env.GEMINI_MODELS || "gemini-2.0-flash,gemini-1.5-flash")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [primary, ...extra.filter((m) => m !== primary)];
}

function isRateLimit(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  if (status === 429) return true;
  const msg = e instanceof Error ? e.message : String(e);
  return /RESOURCE_EXHAUSTED|quota|rate.?limit|429/i.test(msg);
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
    let lastErr: unknown = null;
    for (const model of geminiChain()) {
      try {
        const text = await gemini(args.system, args.user, model, apiKey);
        return { text, provider, model };
      } catch (e) {
        lastErr = e;
        if (!isRateLimit(e)) throw e;
        console.warn(`Gemini ${model} rate-limited, trying next model`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("All Gemini models rate-limited");
  }
  const apiKey = args.apiKeyOverride || process.env.ANTHROPIC_API_KEY || "";
  if (!apiKey) {
    throw Object.assign(new Error("Missing Anthropic API Key. Set ANTHROPIC_API_KEY."), { status: 400 });
  }
  const model = process.env.CLAUDE_MODEL || "claude-3-7-sonnet-20250219";
  return { text: await anthropic(args.system, args.user, model, apiKey), provider, model };
}
