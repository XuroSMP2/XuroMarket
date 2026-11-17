// Nimmt die Markt-Daten vom SMPCore-Plugin entgegen (Push) und speichert sie in Netlify Blobs.
// Nötig in Netlify: SMPCORE_API_KEY (derselbe Key wie web-api.api-key im Plugin)
import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/ingest" };

const out = (d, s = 200) =>
  new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const digest = (s) => createHash("sha256").update(String(s)).digest();

export default async (req) => {
  if (req.method !== "POST") return out({ error: "POST erwartet." }, 405);
  const key = process.env.SMPCORE_API_KEY || "";
  if (key.length < 16) return out({ error: "SMPCORE_API_KEY ist in Netlify nicht gesetzt." }, 503);
  if (!timingSafeEqual(digest(req.headers.get("x-api-key") || ""), digest(key))) return out({ error: "Ungültiger Key." }, 401);

  const raw = await req.text();
  if (raw.length > 5_500_000) return out({ error: "Zu groß." }, 413);
  let d;
  try { d = JSON.parse(raw); } catch { return out({ error: "Kein gültiges JSON." }, 400); }
  const m = d && d.market;
  if (!m || typeof m !== "object" || !Array.isArray(m.ah) || !Array.isArray(m.orders) || !Array.isArray(m.prices) ||
      !Array.isArray(m.wealth) || !Array.isArray(m.trades) || !m.rtp || !m.totals)
    return out({ error: "Unerwartetes Format." }, 400);

  await getStore("xuromarket").setJSON("market-snapshot", { receivedAt: Date.now(), status: d.status || {}, online: d.online || [], market: m });
  return out({ ok: true });
};
