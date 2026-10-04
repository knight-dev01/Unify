// WhatsApp Cloud API (Meta) sender — the support + announcement channel
// for low-end Androids where browser push is unreliable. Needs on Render:
//   WHATSAPP_TOKEN (permanent system-user token), WHATSAPP_PHONE_ID,
//   WHATSAPP_SUPPORT_NUMBER (digits only, e.g. 2348012345678, shown in app).
// Without creds everything logs and skips — safe until wired. Meta rules
// apply on their side: 24h customer-service window for free text, approved
// templates outside it; opt-in/opt-out is recorded by the app before use.

const GRAPH = "https://graph.facebook.com/v21.0";

function creds(): { token: string; phoneId: string } | null {
  const token = process.env.WHATSAPP_TOKEN || "";
  const phoneId = process.env.WHATSAPP_PHONE_ID || "";
  return token && phoneId ? { token, phoneId } : null;
}

export function supportNumber(): string {
  return (process.env.WHATSAPP_SUPPORT_NUMBER || "").replace(/\D/g, "");
}

// Free-text message (works inside Meta's 24h window, or to opted-in users
// per template rules). Returns true when Meta accepted it.
export async function sendWhatsApp(to: string, text: string): Promise<boolean> {
  const c = creds();
  const dest = (to || "").replace(/\D/g, "");
  if (!c || !dest || !text) return false;
  try {
    const res = await fetch(`${GRAPH}/${c.phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: dest,
        type: "text",
        text: { body: text.slice(0, 4000), preview_url: false },
      }),
    });
    if (!res.ok) {
      console.warn("whatsapp send failed", res.status);
      return false;
    }
    return true;
  } catch (e) {
    console.warn("whatsapp send error", (e as Error)?.message || e);
    return false;
  }
}

// Public config for the app (support button): number only, never the token.
export function whatsappPublic(): { supported: boolean; supportNumber: string } {
  const n = supportNumber();
  return { supported: Boolean(creds() && n), supportNumber: n };
}
