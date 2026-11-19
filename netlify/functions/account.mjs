// XuroMarket Konto: Verknüpfung mit dem Minecraft-Account (/verify <Code>) und privates Inventar.
//
// Ablauf:
//  1. Browser: POST /api/auth/start      -> 6-stelliger Code + geheimer Cookie (xm_pending)
//  2. Spiel:   /verify CODE              -> Plugin ruft POST /api/verify (nur mit API-Key) und trägt UUID + Name am Code ein
//  3. Browser: GET /api/auth/status      -> sobald verifiziert, Session-Cookie (xm_session, httpOnly) wird gesetzt
//  4. Browser: GET /api/me, /api/me/inventory (nur mit gültiger Session, nur die eigenen Daten)
//  Plugin:     POST /api/inventory       -> Inventar/Endertruhe verknüpfter Spieler (nur mit API-Key)
//              POST /api/revoke          -> /verify logout: alle Sessions + Daten des Spielers löschen
//
// Nötig in Netlify: SMPCORE_API_KEY (derselbe Key wie im Plugin).
import { getStore } from "@netlify/blobs";
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

export const config = { path: ["/api/auth/*", "/api/verify", "/api/revoke", "/api/inventory", "/api/me", "/api/me/*"] };

const CODE_TTL = 10 * 60_000;           // Code gilt 10 Minuten
const SESSION_TTL = 7 * 24 * 3600_000;  // Anmeldung gilt 7 Tage
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ohne 0/O/1/I
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_RE = /^[A-Z0-9]{6}$/;

// strong: Codes/Sitzungen müssen sofort nach dem Schreiben lesbar sein (sonst "Code abgelaufen" nach wenigen Sekunden)
const store = () => getStore({ name: "xuromarket", consistency: "strong" });
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const digest = (s) => createHash("sha256").update(String(s)).digest();

function json(data, status = 200, extra = []) {
  const h = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store, private" });
  for (const c of extra) h.append("set-cookie", c);
  return new Response(JSON.stringify(data), { status, headers: h });
}
const cookie = (name, value, maxAge) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

function cookies(req) {
  const out = {};
  for (const part of (req.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function apiKeyOk(req) {
  const key = process.env.SMPCORE_API_KEY || "";
  if (key.length < 16) return false;
  return timingSafeEqual(digest(req.headers.get("x-api-key") || ""), digest(key));
}

// Schutz vor Fremdseiten: POSTs aus dem Browser müssen von dieser Seite selbst kommen.
function sameOrigin(req) {
  const o = req.headers.get("origin");
  if (!o) return false;
  try { return new URL(o).host === new URL(req.url).host; } catch { return false; }
}

async function body(req, max = 4_000_000) {
  const raw = await req.text();
  if (raw.length > max) throw Object.assign(new Error("zu groß"), { status: 413 });
  try { return JSON.parse(raw); } catch { throw Object.assign(new Error("kein JSON"), { status: 400 }); }
}

async function session(req) {
  const tok = cookies(req).xm_session;
  if (!tok || !/^[0-9a-f]{64}$/.test(tok)) return null;
  const s = await store().get("session:" + sha(tok), { type: "json" });
  if (!s || s.exp < Date.now()) return null;
  return { ...s, hash: sha(tok) };
}

// einfaches Rate-Limit pro IP (z. B. gegen Code-Spam)
async function limited(key, max, windowMs) {
  const st = store(), k = "rl:" + sha(key);
  const r = (await st.get(k, { type: "json" })) || { t: Date.now(), n: 0 };
  if (Date.now() - r.t > windowMs) { r.t = Date.now(); r.n = 0; }
  r.n++;
  await st.setJSON(k, r);
  return r.n > max;
}

export default async (req, context) => {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const st = store();
  try {
    // ---------- Browser: Anmeldung starten ----------
    if (path === "/api/auth/start" && req.method === "POST") {
      if (!sameOrigin(req)) return json({ error: "Ungültige Herkunft." }, 403);
      const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
      if (await limited("start:" + ip, 10, 10 * 60_000)) return json({ error: "Zu viele Anfragen. Warte ein paar Minuten." }, 429);
      let code = "";
      for (let i = 0; i < 5; i++) {
        code = Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
        if (!(await st.get("code:" + code, { type: "json" }))) break;
      }
      const secret = randomBytes(32).toString("hex");
      await st.setJSON("code:" + code, { created: Date.now(), secretHash: sha(secret), verified: null });
      await st.setJSON("pend:" + sha(secret), { code, created: Date.now() });
      return json({ code, expiresIn: CODE_TTL / 1000 }, 200, [cookie("xm_pending", secret, CODE_TTL / 1000)]);
    }

    // ---------- Browser: Status abfragen / Session ausstellen ----------
    if (path === "/api/auth/status" && req.method === "GET") {
      const sec = cookies(req).xm_pending;
      if (!sec || !/^[0-9a-f]{64}$/.test(sec)) return json({ state: "none" });
      const pend = await st.get("pend:" + sha(sec), { type: "json" });
      if (!pend) return json({ state: "expired" }, 200, [cookie("xm_pending", "", 0)]);
      const rec = await st.get("code:" + pend.code, { type: "json" });
      if (!rec || rec.secretHash !== sha(sec) || Date.now() - rec.created > CODE_TTL) {
        await st.delete("pend:" + sha(sec)); if (rec) await st.delete("code:" + pend.code);
        return json({ state: "expired" }, 200, [cookie("xm_pending", "", 0)]);
      }
      if (!rec.verified) return json({ state: "waiting", expiresIn: Math.max(0, Math.round((CODE_TTL - (Date.now() - rec.created)) / 1000)) });
      const token = randomBytes(32).toString("hex"), h = sha(token), { uuid, name } = rec.verified;
      await st.setJSON("session:" + h, { uuid, name, exp: Date.now() + SESSION_TTL });
      const user = (await st.get("user:" + uuid, { type: "json" })) || { sessions: [] };
      user.sessions = [...user.sessions, h].slice(-10); // max. 10 Geräte
      await st.setJSON("user:" + uuid, user);
      await st.delete("pend:" + sha(sec)); await st.delete("code:" + pend.code);
      return json({ state: "ok", uuid, name }, 200, [cookie("xm_session", token, SESSION_TTL / 1000), cookie("xm_pending", "", 0)]);
    }

    // ---------- Browser: Abmelden ----------
    if (path === "/api/auth/logout" && req.method === "POST") {
      if (!sameOrigin(req)) return json({ error: "Ungültige Herkunft." }, 403);
      const s = await session(req);
      if (s) await st.delete("session:" + s.hash);
      return json({ ok: true }, 200, [cookie("xm_session", "", 0)]);
    }

    // ---------- Plugin: Code bestätigen ----------
    if (path === "/api/verify" && req.method === "POST") {
      if (!apiKeyOk(req)) return json({ error: "Key ungültig." }, 401);
      const b = await body(req, 10_000);
      const code = String(b.code || "").toUpperCase();
      if (!CODE_RE.test(code) || !UUID_RE.test(String(b.uuid || ""))) return json({ error: "Ungültige Daten." }, 400);
      const rec = await st.get("code:" + code, { type: "json" });
      if (!rec || Date.now() - rec.created > CODE_TTL) return json({ error: "Code unbekannt oder abgelaufen." }, 404);
      if (rec.verified) return json({ error: "Code bereits benutzt." }, 409);
      rec.verified = { uuid: String(b.uuid).toLowerCase(), name: String(b.name || "").slice(0, 40) };
      await st.setJSON("code:" + code, rec);
      return json({ ok: true });
    }

    // ---------- Plugin: Verknüpfung lösen ----------
    if (path === "/api/revoke" && req.method === "POST") {
      if (!apiKeyOk(req)) return json({ error: "Key ungültig." }, 401);
      const b = await body(req, 10_000);
      const uuid = String(b.uuid || "").toLowerCase();
      if (!UUID_RE.test(uuid)) return json({ error: "Ungültige Daten." }, 400);
      const user = await st.get("user:" + uuid, { type: "json" });
      if (user) for (const h of user.sessions) await st.delete("session:" + h);
      await st.delete("user:" + uuid);
      await st.delete("inv:" + uuid);
      return json({ ok: true });
    }

    // ---------- Plugin: Inventare verknüpfter Spieler speichern ----------
    if (path === "/api/inventory" && req.method === "POST") {
      if (!apiKeyOk(req)) return json({ error: "Key ungültig." }, 401);
      const b = await body(req);
      if (!b || !Array.isArray(b.players) || b.players.length > 200) return json({ error: "Unerwartetes Format." }, 400);
      let n = 0;
      for (const p of b.players) {
        const uuid = String(p?.uuid || "").toLowerCase();
        if (!UUID_RE.test(uuid) || !Array.isArray(p.inventory) || !Array.isArray(p.enderchest)) continue;
        await st.setJSON("inv:" + uuid, {
          receivedAt: Date.now(), updated: Number(p.updated) || Date.now(), name: String(p.name || "").slice(0, 40),
          inventory: p.inventory, enderchest: p.enderchest, enderRows: Math.max(1, Math.min(6, Number(p.enderRows) || 3)), stats: p.stats || {},
        });
        n++;
      }
      return json({ ok: true, stored: n });
    }

    // ---------- Browser: eigene Daten ----------
    if (path === "/api/me" && req.method === "GET") {
      const s = await session(req);
      if (!s) return json({ loggedIn: false }, 401);
      return json({ loggedIn: true, uuid: s.uuid, name: s.name });
    }
    if (path === "/api/me/inventory" && req.method === "GET") {
      const s = await session(req);
      if (!s) return json({ loggedIn: false }, 401);
      const inv = await st.get("inv:" + s.uuid, { type: "json" });
      if (!inv) return json({ loggedIn: true, empty: true, name: s.name }, 404);
      return json({ loggedIn: true, uuid: s.uuid, ...inv });
    }

    return json({ error: "Unbekannter Endpoint." }, 404);
  } catch (e) {
    if (e?.status) return json({ error: e.message }, e.status);
    console.error("account:", e);
    return json({ error: "Interner Fehler." }, 500);
  }
};
