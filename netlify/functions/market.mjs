// Liefert die gespeicherten Markt-Daten an die Website (nur lesen, kein Key nötig – es sind öffentliche Spielstatistiken).
import { getStore } from "@netlify/blobs";

export const config = { path: ["/api/market"] };

const STALE = 15 * 60_000;

export default async (req) => {
  if (req.method !== "GET") return new Response("Nur GET erlaubt.", { status: 405 });
  let snap = null;
  try { snap = await getStore("xuromarket").get("market-snapshot", { type: "json" }); } catch { /* Blobs nicht verfügbar */ }
  const body = snap
    ? { ...snap, stale: Date.now() - snap.receivedAt > STALE }
    : { empty: true };
  return new Response(JSON.stringify(body), {
    status: snap ? 200 : 503,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": snap ? "public, max-age=20" : "no-store" },
  });
};
