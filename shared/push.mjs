// Web-Push: Schlüssel (VAPID) werden beim ersten Mal automatisch erzeugt und in Netlify Blobs gespeichert.
import webpush from "web-push";
import { createHash, generateKeyPairSync } from "node:crypto";
import { metaStore } from "./store.mjs";

let cached;
export async function vapidKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY)
    return { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
  if (cached) return cached;
  const m = metaStore();
  let k = await m.get("vapid", { type: "json" });
  if (!k) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const jwk = privateKey.export({ format: "jwk" });
    const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]);
    k = { publicKey: pub.toString("base64url"), privateKey: jwk.d };
    await m.setJSON("vapid", k);
  }
  return (cached = k);
}

export const subKey = (endpoint) => "sub:" + createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 40);
const nk = (n) => String(n ?? "").trim().toLowerCase();
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const mentions = (text, name) =>
  !!text && !!name && new RegExp("@" + escRe(name) + "(?![\\p{L}\\p{N}_])", "iu").test(text);

/**
 * Benachrichtigung an Gruppenmitglieder schicken.
 *  actor      – Name der Person, die etwas getan hat (bekommt nichts)
 *  title/body – Text; url – wohin ein Tipp führt; tag – gleiche Tags ersetzen sich
 *  broadcast  – an alle mit Einstellung „Alles“
 *  direct     – Namen, die es auf jeden Fall bekommen (auch bei „Nur Wichtiges“)
 *  mentionText– Text, in dem @Erwähnungen gesucht werden
 */
export async function notify(store, { actor = "", title, body = "", url = "/", tag, broadcast = false, direct = [], mentionText = "", perPerson }) {
  try {
    const { blobs } = await store.list({ prefix: "sub:" });
    if (!blobs.length) return;
    const subs = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })))).filter(Boolean);
    const keys = await vapidKeys();
    webpush.setVapidDetails(process.env.URL || "mailto:gruppenorganisator@example.com", keys.publicKey, keys.privateKey);
    const directKeys = new Set(direct.map(nk));
    const jobs = [];
    for (const s of subs) {
      if (!s.name || nk(s.name) === nk(actor)) continue;
      let msg = null;
      if (mentions(mentionText, s.name)) msg = { title: `${actor} hat dich erwähnt`, body: mentionText.slice(0, 180) };
      else if (directKeys.has(nk(s.name))) msg = { title, body: perPerson?.(s.name) ?? body };
      else if (broadcast && s.level !== "important") msg = { title, body };
      if (!msg) continue;
      const payload = JSON.stringify({ ...msg, url, tag });
      jobs.push(
        webpush.sendNotification(s.subscription, payload, { TTL: 60 * 60 * 24, timeout: 6000 }).catch(async (e) => {
          if (e?.statusCode === 404 || e?.statusCode === 410) await store.delete(subKey(s.subscription.endpoint));
          else console.error("push", e?.statusCode, e?.body || e?.message);
        })
      );
    }
    await Promise.allSettled(jobs);
  } catch (e) {
    console.error("notify", e); // Push-Fehler dürfen nie das Speichern verhindern
  }
}
