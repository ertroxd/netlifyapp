// Gruppenorganisator – API (Netlify Function + Netlify Blobs)
// Alle Routen liegen unter /api/* und brauchen den Header "x-group-password".

import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { MAIN, slugOk, metaStore, groupStore, readAll, listBackups, restore, snapshot, mainGroupName,
  cleanupStories, deleteStory, deleteMedia, STORY_HOURS } from "../shared/store.mjs";
import { notify, subKey, vapidKeys } from "../shared/push.mjs";

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const str = (v, max = 300) => String(v ?? "").trim().slice(0, max);
const nameKey = (n) => str(n, 40).toLowerCase();
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const isTime = (v) => v === "" || /^\d{2}:\d{2}$/.test(v);
const validId = (v) => typeof v === "string" && /^[\w-]{1,64}$/.test(v);
const todayUTC = () => new Date().toISOString().slice(0, 10);

function passwordOk(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
}

async function mutate(store, key, fn) {
  const item = await store.get(key, { type: "json" });
  if (!item) throw new HttpError(404, "Nicht gefunden – evtl. wurde es gelöscht.");
  fn(item);
  item.updatedAt = new Date().toISOString();
  await store.setJSON(key, item);
  return item;
}

function eventFields(b) {
  const title = str(b.title, 120);
  const date = str(b.date, 10);
  const time = str(b.time, 5);
  const endTime = str(b.endTime, 5);
  if (!title) throw new HttpError(400, "Bitte einen Titel angeben.");
  if (!isDate(date)) throw new HttpError(400, "Bitte ein gültiges Datum angeben.");
  if (!isTime(time) || !isTime(endTime)) throw new HttpError(400, "Uhrzeit ungültig.");
  return {
    title,
    date,
    time,
    endTime,
    location: str(b.location, 200),
    description: str(b.description, 3000),
  };
}

function makeOption(o, kind) {
  if (kind === "date") {
    const date = str(o?.date, 10);
    const time = str(o?.time, 5);
    if (!isDate(date)) return null;
    if (!isTime(time)) throw new HttpError(400, "Uhrzeit ungültig.");
    return { id: randomUUID(), date, time };
  }
  const text = str(typeof o === "string" ? o : o?.text, 150);
  return text ? { id: randomUUID(), text } : null;
}

function expenseFields(b) {
  const type = b.type === "transfer" ? "transfer" : "expense";
  const title = str(b.title, 120) || (type === "transfer" ? "Ausgleich" : "");
  if (!title) throw new HttpError(400, "Bitte angeben, wofür.");
  const amount = Math.round(Number(b.amount));
  if (!Number.isFinite(amount) || amount < 1 || amount > 10_000_000) throw new HttpError(400, "Betrag ungültig.");
  const paidBy = str(b.paidBy, 40);
  if (!paidBy) throw new HttpError(400, "Wer hat bezahlt?");
  const seen = new Set();
  const participants = (Array.isArray(b.participants) ? b.participants : [])
    .map((n) => str(n, 40))
    .filter((n) => n && !seen.has(nameKey(n)) && seen.add(nameKey(n)))
    .slice(0, 60);
  if (!participants.length) throw new HttpError(400, "Bitte mindestens eine Person auswählen.");
  const date = str(b.date, 10) || todayUTC();
  if (!isDate(date)) throw new HttpError(400, "Datum ungültig.");
  return {
    type,
    title,
    amount,
    paidBy,
    participants,
    date,
    eventId: validId(b.eventId) ? b.eventId : "",
    note: str(b.note, 300),
  };
}

// ---------- Gruppen ----------
const hashPw = (pw, salt) => scryptSync(String(pw ?? ""), salt, 32).toString("hex");

async function resolveGroup(slug) {
  slug = String(slug || MAIN).toLowerCase();
  if (slug === MAIN) {
    const pw = process.env.GROUP_PASSWORD;
    if (!pw) throw new HttpError(500, "GROUP_PASSWORD ist in Netlify noch nicht gesetzt.");
    return { slug, name: await mainGroupName(), check: (given) => passwordOk(given, pw) };
  }
  const g = slugOk(slug) ? await metaStore().get(`group:${slug}`, { type: "json" }) : null;
  if (!g) throw new HttpError(404, "Gruppe nicht gefunden – bitte den Code prüfen.");
  return { slug, name: g.name, check: (given) => passwordOk(hashPw(given, g.salt), g.hash) };
}

// ---------- Kommentare (Termine & Pinnwand) ----------
function addComment(item, user, text) {
  text = str(text, 1000);
  if (!text) throw new HttpError(400, "Kommentar ist leer.");
  item.comments = item.comments || [];
  item.comments.push({ id: randomUUID(), name: user, text, at: new Date().toISOString() });
  if (item.comments.length > 300) item.comments = item.comments.slice(-300);
}
function deleteComment(item, user, cid, admin = false) {
  const c = (item.comments || []).find((c) => c.id === cid);
  if (!c) throw new HttpError(404, "Kommentar nicht gefunden.");
  if (nameKey(c.name) !== nameKey(user) && !admin) throw new HttpError(403, "Nur eigene Kommentare löschen.");
  item.comments = item.comments.filter((c) => c.id !== cid);
}

// ---------- Reaktionen ----------
const EMOJIS = new Set(["👍", "❤️", "😂", "😮", "😢", "🎉"]);
function toggleReaction(target, user, emoji) {
  if (!EMOJIS.has(emoji)) throw new HttpError(400, "Unbekannte Reaktion.");
  target.reactions = target.reactions || {};
  if (target.likes) { // alte Likes übernehmen
    if (Object.keys(target.likes).length) target.reactions["❤️"] = { ...target.likes, ...(target.reactions["❤️"] || {}) };
    delete target.likes;
  }
  const m = (target.reactions[emoji] = target.reactions[emoji] || {});
  const k = nameKey(user);
  if (m[k]) delete m[k];
  else m[k] = user;
  if (!Object.keys(m).length) delete target.reactions[emoji];
}
function findComment(item, cid) {
  const c = (item.comments || []).find((c) => c.id === cid);
  if (!c) throw new HttpError(404, "Kommentar nicht gefunden.");
  return c;
}

const isAdmin = (req) => {
  const admin = process.env.ADMIN_PASSWORD || process.env.GROUP_PASSWORD;
  return !!admin && passwordOk(req.headers.get("x-admin-password"), admin);
};
// Nur wer etwas erstellt hat (oder ein Admin) darf es ändern/löschen
function assertOwner(item, user, req) {
  if (nameKey(item.createdBy) !== nameKey(user) && !isAdmin(req))
    throw new HttpError(403, `Nur ${item.createdBy || "der Ersteller"} (oder ein Admin) darf das ändern oder löschen.`);
}
async function deleteOwned(store, key, user, req) {
  const item = await store.get(key, { type: "json" });
  if (!item) return; // schon weg
  assertOwner(item, user, req);
  await store.delete(key);
}

const adminOk = (req) => {
  const admin = process.env.ADMIN_PASSWORD || process.env.GROUP_PASSWORD;
  if (!admin) throw new HttpError(500, "ADMIN_PASSWORD ist in Netlify nicht gesetzt.");
  if (!passwordOk(req.headers.get("x-admin-password"), admin)) throw new HttpError(403, "Admin-Passwort ist falsch.");
};
const shortDate = (d) =>
  new Date(d + "T12:00:00Z").toLocaleDateString("de-DE", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const euro = (c) => (c / 100).toLocaleString("de-DE", { style: "currency", currency: "EUR" });
const clip = (t, n = 120) => (t.length > n ? t.slice(0, n - 1) + "…" : t);
const commenters = (item) => [item.createdBy, ...(item.comments || []).map((c) => c.name)];

// ---------- Bilder / Medien ----------
const CHUNK = 3 * 1024 * 1024; // Videos werden in 3-MB-Stücken hochgeladen (Netlify-Limit pro Anfrage: 6 MB)
const MAX_VIDEO = 60 * 1024 * 1024;
const VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm", "video/3gpp", "video/x-m4v"];

async function saveJpeg(store, dataUrl, maxBytes = 2 * 1024 * 1024) {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ""));
  if (!m) throw new HttpError(400, "Bildformat wird nicht unterstützt.");
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > maxBytes) throw new HttpError(413, "Bild ist zu groß.");
  const id = randomUUID();
  await store.set(`img:${id}`, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  return id;
}
async function checkMedia(store, media, user) {
  if (!validId(media?.id)) throw new HttpError(400, "Video fehlt.");
  const meta = await store.get(`mediameta:${media.id}`, { type: "json" });
  if (!meta) throw new HttpError(404, "Video nicht gefunden.");
  const { blobs } = await store.list({ prefix: `media:${media.id}:` });
  if (blobs.length !== meta.chunks) throw new HttpError(400, "Video-Upload ist unvollständig – bitte nochmal versuchen.");
  if (nameKey(meta.createdBy) !== nameKey(user)) throw new HttpError(403, "Fremdes Video.");
  return { id: meta.id, mime: meta.mime, size: meta.size, chunks: meta.chunks, duration: Math.round(Number(media.duration) || 0) };
}

// ---------- Chat ----------
// Nachrichten liegen einzeln unter "msg:<Zeitstempel>-<zufall>" – so kann man "alles nach X" laden.
const newMsgId = (ms = Date.now(), seed = randomUUID()) => `${String(ms).padStart(14, "0")}-${String(seed).replace(/[^\w]/g, "").slice(0, 8)}`;
async function logChange(store, id, deleted = false) {
  try {
    const log = (await store.get("chatlog", { type: "json" })) || { changes: [] };
    log.changes.push({ id, at: new Date().toISOString(), ...(deleted ? { deleted: true } : {}) });
    log.changes = log.changes.slice(-300);
    await store.setJSON("chatlog", log);
  } catch (e) { console.error("chatlog", e); }
}
// Einmalig: alte Pinnwand-Beiträge (inkl. Kommentare) in den Chat übernehmen
async function migrateBoard(store) {
  if (await store.get("chat-migrated")) return;
  const posts = await readAll(store, "post:");
  for (const p of posts) {
    const pid = newMsgId(new Date(p.createdAt).getTime(), p.id);
    const reactions = { ...(p.reactions || {}) };
    if (p.likes && Object.keys(p.likes).length) reactions["❤️"] = { ...p.likes, ...(reactions["❤️"] || {}) };
    await store.setJSON(`msg:${pid}`, { id: pid, text: p.text || "", imageId: p.imageId || "", reactions, pinned: !!p.pinned, createdBy: p.createdBy, createdAt: p.createdAt });
    for (const c of p.comments || []) {
      const cid = newMsgId(new Date(c.at).getTime(), c.id);
      await store.setJSON(`msg:${cid}`, { id: cid, text: c.text, reactions: c.reactions || {}, replyTo: pid, createdBy: c.name, createdAt: c.at });
    }
  }
  await store.setJSON("chat-migrated", { at: new Date().toISOString(), posts: posts.length });
}

// Anteil pro Person (auf den Cent genau, Rest-Cents an die ersten)
function splitCents(amount, n) {
  const base = Math.floor(amount / n), rest = amount - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}
// Zahlung auf einen Anteil buchen – darf die Person selbst, wer bezahlt hat, wer eingetragen hat, oder Admin
function shareOf(x, name, user, admin) {
  if (x.type === "transfer") throw new HttpError(400, "Ungültiger Eintrag.");
  const idx = x.participants.findIndex((p) => nameKey(p) === nameKey(name));
  if (idx < 0 || nameKey(x.paidBy) === nameKey(name)) throw new HttpError(400, "Diese Person ist hier nicht beteiligt.");
  const u = nameKey(user);
  if (![nameKey(name), nameKey(x.paidBy), nameKey(x.createdBy)].includes(u) && !admin)
    throw new HttpError(403, "Das kann nur die Person selbst oder wer bezahlt hat.");
  return { idx, key: nameKey(name), share: splitCents(x.amount, x.participants.length)[idx] };
}

function pollIsOpen(p) {
  return !p.closed && !(p.deadline && p.deadline < todayUTC());
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const [res, id, sub, subId, subAction] = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
    let user = "";
    try {
      user = str(decodeURIComponent(req.headers.get("x-user-name") || ""), 40);
    } catch {}

    // Bilder der Pinnwand: öffentlich über nicht erratbare ID (damit <img> ohne Header funktioniert)
    // Neu: /api/img/<gruppe>/<id>   Alt: /api/img/<id> (Hauptgruppe)
    if (res === "img" && req.method === "GET") {
      const [slug, imgId] = sub ? [id, sub] : [MAIN, id];
      if (!validId(imgId) || !(slug === MAIN || slugOk(slug))) return new Response("Nicht gefunden", { status: 404 });
      const data = await groupStore(slug).get(`img:${imgId}`, { type: "arrayBuffer" });
      if (!data) return new Response("Nicht gefunden", { status: 404 });
      return new Response(data, {
        headers: { "content-type": "image/jpeg", "cache-control": "public, max-age=31536000, immutable" },
      });
    }

    // Video-Stücke: öffentlich über nicht erratbare ID, /api/media/<gruppe>/<id>/<n>
    if (res === "media" && req.method === "GET" && sub !== undefined && subId !== undefined) {
      if (!(id === MAIN || slugOk(id)) || !validId(sub) || !/^\d{1,3}$/.test(subId)) return new Response("Nicht gefunden", { status: 404 });
      const data = await groupStore(id).get(`media:${sub}:${subId}`, { type: "arrayBuffer" });
      if (!data) return new Response("Nicht gefunden", { status: 404 });
      return new Response(data, { headers: { "content-type": "application/octet-stream", "cache-control": "public, max-age=31536000, immutable" } });
    }

    // Neue Gruppe anlegen (braucht das Admin-Passwort)
    if (res === "groups" && !id && req.method === "POST") {
      adminOk(req);
      const b = await req.json().catch(() => ({}));
      const name = str(b.name, 60);
      const slug = str(b.slug, 40).toLowerCase();
      const pw = String(b.password ?? "");
      if (!name) throw new HttpError(400, "Bitte einen Gruppennamen angeben.");
      if (!slugOk(slug) || slug === MAIN) throw new HttpError(400, "Code: 2–40 Zeichen, nur a–z, 0–9 und Bindestrich.");
      if (pw.length < 4) throw new HttpError(400, "Das Gruppen-Passwort braucht mindestens 4 Zeichen.");
      const m = metaStore();
      if (await m.get(`group:${slug}`)) throw new HttpError(409, "Dieser Code ist schon vergeben.");
      const salt = randomBytes(16).toString("hex");
      await m.setJSON(`group:${slug}`, { slug, name, salt, hash: hashPw(pw, salt), createdBy: user, createdAt: new Date().toISOString() });
      return json({ slug, name }, 201);
    }

    const group = await resolveGroup(req.headers.get("x-group") || MAIN);
    if (!group.check(req.headers.get("x-group-password"))) {
      return json({ error: "Falsches Gruppen-Passwort." }, 401);
    }
    const store = groupStore(group.slug);
    const groupName = group.name;
    const method = req.method;
    const rawUpload = res === "media" && method === "PUT";
    const body = !rawUpload && ["POST", "PUT", "PATCH", "DELETE"].includes(method) ? await req.json().catch(() => ({})) : {};

    if (res === "login" && method === "POST") return json({ ok: true, groupName, slug: group.slug });
    if (res === "admin" && id === "check" && method === "POST") { adminOk(req); return json({ ok: true }); }
    if (res === "admin" && id === "rename" && method === "POST") {
      adminOk(req);
      const name = str(body.name, 60);
      if (!name) throw new HttpError(400, "Bitte einen Namen angeben.");
      const m = metaStore();
      if (group.slug === MAIN) await m.setJSON("main-name", { name, updatedAt: new Date().toISOString(), by: user });
      else await mutate(m, `group:${group.slug}`, (g) => { g.name = name; });
      return json({ ok: true, groupName: name });
    }

    if (res === "state" && method === "GET") {
      const [events, polls, expenses, profiles, stories] = await Promise.all([
        readAll(store, "event:"), readAll(store, "poll:"), readAll(store, "expense:"), readAll(store, "profile:"), cleanupStories(store),
      ]);
      return json({ groupName, slug: group.slug, events, polls, expenses, profiles, stories, serverDate: todayUTC() });
    }

    // Link, der in Benachrichtigungen geöffnet wird
    const link = (tab) => `/?g=${encodeURIComponent(group.slug)}&t=${tab}`;
    const push = (opts) => notify(store, { actor: user, ...opts, title: opts.title, tag: opts.tag });

    // ---------- Push-Benachrichtigungen ----------
    if (res === "push") {
      if (id === "key" && method === "GET") return json({ publicKey: (await vapidKeys()).publicKey });
      if (id === "subscribe" && method === "POST") {
        const s = body.subscription;
        if (!s || typeof s.endpoint !== "string" || !/^https:\/\//.test(s.endpoint) || !s.keys?.p256dh || !s.keys?.auth)
          throw new HttpError(400, "Ungültiges Abo.");
        if (!user) throw new HttpError(400, "Bitte zuerst einen Namen eingeben.");
        await store.setJSON(subKey(s.endpoint), {
          subscription: { endpoint: s.endpoint, keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) } },
          name: user,
          level: body.level === "important" ? "important" : "all",
          updatedAt: new Date().toISOString(),
        });
        return json({ ok: true });
      }
      if ((id === "unsubscribe" && method === "POST") || (id === "subscribe" && method === "DELETE")) {
        await store.delete(subKey(body.endpoint));
        return json({ ok: true });
      }
      if (id === "test" && method === "POST") {
        const s = await store.get(subKey(body.endpoint), { type: "json" });
        if (!s) throw new HttpError(404, "Dieses Gerät ist nicht angemeldet.");
        await notify(store, { title: "Test ✔", body: `Benachrichtigungen für „${groupName}“ funktionieren.`, direct: [s.name], url: link("events") });
        return json({ ok: true });
      }
    }

    // ---------- Backups ----------
    if (res === "backup") {
      if (!id && method === "GET") return json({ backups: await listBackups(store) });
      if (id === "restore" && method === "POST") {
        adminOk(req);
        let data = body.data;
        if (body.date) {
          if (!/^[\w-]{1,40}$/.test(body.date)) throw new HttpError(400, "Ungültiges Backup.");
          data = (await store.get(`backup:${body.date}`, { type: "json" }))?.data;
          if (!data) throw new HttpError(404, "Backup nicht gefunden.");
        }
        try { await restore(store, data?.data || data); } catch (e) { throw new HttpError(400, e.message); }
        return json({ ok: true });
      }
      if (id === "now" && method === "POST") {
        await snapshot(store);
        return json({ backups: await listBackups(store) });
      }
      if (id && method === "GET" && /^[\w-]{1,40}$/.test(id)) {
        const b = await store.get(`backup:${id}`, { type: "json" });
        if (!b) throw new HttpError(404, "Backup nicht gefunden.");
        return json({ ...b, group: group.slug, groupName });
      }
    }

    // Ab hier: alles Schreibende braucht einen Namen
    if (method !== "GET" && !user) throw new HttpError(400, "Bitte zuerst einen Namen eingeben.");
    if (id !== undefined && !validId(id)) throw new HttpError(400, "Ungültige ID.");

    // ---------- Termine ----------
    if (res === "events") {
      const key = `event:${id}`;

      if (!id && method === "POST") {
        const item = {
          id: randomUUID(),
          ...eventFields(body),
          createdBy: user,
          createdAt: new Date().toISOString(),
          rsvps: {},
          comments: [],
        };
        await store.setJSON(`event:${item.id}`, item);
        await push({
          title: `Neuer Termin: ${item.title}`,
          body: `${shortDate(item.date)}${item.time ? ", " + item.time + " Uhr" : ""}${item.location ? " · " + item.location : ""} – von ${user}`,
          url: link("events"), tag: "ev-" + item.id, broadcast: true, mentionText: item.description,
        });
        return json(item, 201);
      }
      if (id && !sub && method === "PUT") {
        const fields = eventFields(body);
        return json(await mutate(store, key, (e) => { assertOwner(e, user, req); Object.assign(e, fields); }));
      }
      if (id && !sub && method === "DELETE") {
        await deleteOwned(store, key, user, req);
        return json({ ok: true });
      }
      if (id && sub === "rsvp" && method === "POST") {
        const status = body.status;
        if (![null, "yes", "maybe", "no"].includes(status)) throw new HttpError(400, "Ungültige Antwort.");
        return json(
          await mutate(store, key, (e) => {
            const k = nameKey(user);
            if (status === null) delete e.rsvps[k];
            else e.rsvps[k] = { name: user, status, note: str(body.note, 140), at: new Date().toISOString() };
          })
        );
      }
      if (id && sub === "comments" && !subId && method === "POST") {
        const e = await mutate(store, key, (e) => addComment(e, user, body.text));
        const text = e.comments.at(-1).text;
        await push({
          title: `${user} zu „${clip(e.title, 50)}“`, body: clip(text), url: link("events"), tag: "evc-" + e.id,
          broadcast: true, direct: commenters(e), mentionText: text,
        });
        return json(e);
      }
      if (id && sub === "comments" && subId && subAction === "react" && method === "POST") {
        return json(await mutate(store, key, (e) => toggleReaction(findComment(e, subId), user, body.emoji)));
      }
      if (id && sub === "comments" && subId && method === "DELETE") {
        return json(await mutate(store, key, (e) => deleteComment(e, user, subId, isAdmin(req))));
      }
    }

    // ---------- Abstimmungen ----------
    if (res === "polls") {
      const key = `poll:${id}`;

      if (!id && method === "POST") {
        const title = str(body.title, 150);
        if (!title) throw new HttpError(400, "Bitte eine Frage angeben.");
        const kind = body.kind === "date" ? "date" : "text";
        const options = (Array.isArray(body.options) ? body.options : [])
          .slice(0, 30)
          .map((o) => makeOption(o, kind))
          .filter(Boolean);
        if (options.length < 2) throw new HttpError(400, "Mindestens zwei Antwortmöglichkeiten angeben.");
        const deadline = str(body.deadline, 10);
        if (deadline && !isDate(deadline)) throw new HttpError(400, "Frist ungültig.");
        const item = {
          id: randomUUID(),
          title,
          description: str(body.description, 2000),
          kind,
          multi: !!body.multi,
          allowAdd: !!body.allowAdd,
          deadline,
          closed: false,
          options,
          votes: {},
          createdBy: user,
          createdAt: new Date().toISOString(),
        };
        await store.setJSON(`poll:${item.id}`, item);
        await push({
          title: `Neue Umfrage: ${item.title}`, body: `von ${user}${item.deadline ? " · bis " + shortDate(item.deadline) : ""}`,
          url: link("polls"), tag: "poll-" + item.id, broadcast: true, mentionText: item.description,
        });
        return json(item, 201);
      }
      if (id && !sub && method === "DELETE") {
        await deleteOwned(store, key, user, req);
        return json({ ok: true });
      }
      if (id && sub === "vote" && method === "POST") {
        return json(
          await mutate(store, key, (p) => {
            if (!pollIsOpen(p)) throw new HttpError(409, "Diese Abstimmung ist beendet.");
            const valid = new Set(p.options.map((o) => o.id));
            let ids = [...new Set(Array.isArray(body.optionIds) ? body.optionIds : [])].filter((x) => valid.has(x));
            if (!p.multi) ids = ids.slice(0, 1);
            const k = nameKey(user);
            if (ids.length) p.votes[k] = { name: user, optionIds: ids, at: new Date().toISOString() };
            else delete p.votes[k];
          })
        );
      }
      if (id && sub === "options" && method === "POST") {
        return json(
          await mutate(store, key, (p) => {
            if (!pollIsOpen(p)) throw new HttpError(409, "Diese Abstimmung ist beendet.");
            if (!p.allowAdd && nameKey(p.createdBy) !== nameKey(user))
              throw new HttpError(403, "Hier dürfen keine Optionen ergänzt werden.");
            if (p.options.length >= 40) throw new HttpError(400, "Maximal 40 Optionen.");
            const opt = makeOption(body, p.kind);
            if (!opt) throw new HttpError(400, "Option ist leer.");
            opt.addedBy = user;
            p.options.push(opt);
          })
        );
      }
      if (id && sub === "close" && method === "POST") {
        return json(
          await mutate(store, key, (p) => {
            assertOwner(p, user, req);
            p.closed = !!body.closed;
            if (!p.closed && p.deadline && p.deadline < todayUTC()) p.deadline = "";
          })
        );
      }
    }

    // ---------- Pinnwand ----------
    if (res === "posts") {
      const key = `post:${id}`;

      if (!id && method === "POST") {
        const text = str(body.text, 3000);
        let imageId = "";
        if (body.image) {
          const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(body.image));
          if (!m) throw new HttpError(400, "Bildformat wird nicht unterstützt.");
          const buf = Buffer.from(m[1], "base64");
          if (buf.length > 2 * 1024 * 1024) throw new HttpError(413, "Bild ist zu groß.");
          imageId = randomUUID();
          await store.set(`img:${imageId}`, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
        }
        if (!text && !imageId) throw new HttpError(400, "Beitrag ist leer.");
        const item = {
          id: randomUUID(),
          text,
          imageId,
          pinned: false,
          reactions: {},
          comments: [],
          createdBy: user,
          createdAt: new Date().toISOString(),
        };
        await store.setJSON(`post:${item.id}`, item);
        await push({
          title: `${user} auf der Pinnwand`, body: item.text ? clip(item.text) : "📷 Foto", url: link("board"),
          tag: "post-" + item.id, broadcast: true, mentionText: item.text,
        });
        return json(item, 201);
      }
      if (id && !sub && method === "DELETE") {
        // Foto bleibt gespeichert, damit ein Backup den Beitrag vollständig wiederherstellen kann
        await deleteOwned(store, key, user, req);
        return json({ ok: true });
      }
      if (id && sub === "like" && method === "POST") { // alte App-Version
        return json(await mutate(store, key, (p) => toggleReaction(p, user, "❤️")));
      }
      if (id && sub === "react" && method === "POST") {
        return json(await mutate(store, key, (p) => toggleReaction(p, user, body.emoji)));
      }
      if (id && sub === "comments" && !subId && method === "POST") {
        const p = await mutate(store, key, (p) => addComment(p, user, body.text));
        const text = p.comments.at(-1).text;
        await push({
          title: `${user} hat geantwortet`, body: clip(text), url: link("board"), tag: "postc-" + p.id,
          broadcast: true, direct: commenters(p), mentionText: text,
        });
        return json(p);
      }
      if (id && sub === "comments" && subId && subAction === "react" && method === "POST") {
        return json(await mutate(store, key, (p) => toggleReaction(findComment(p, subId), user, body.emoji)));
      }
      if (id && sub === "comments" && subId && method === "DELETE") {
        return json(await mutate(store, key, (p) => deleteComment(p, user, subId, isAdmin(req))));
      }
      if (id && sub === "pin" && method === "POST") {
        return json(await mutate(store, key, (p) => (p.pinned = !!body.pinned)));
      }
    }

    // ---------- Profile ----------
    if (res === "profile" && !id && method === "PUT") {
      const key = `profile:${nameKey(user)}`;
      const old = (await store.get(key, { type: "json" })) || { createdAt: new Date().toISOString() };
      const p = { ...old, name: user, bio: str(body.bio, 160), status: str(body.status, 40), updatedAt: new Date().toISOString() };
      if (body.avatar) {
        const aid = await saveJpeg(store, body.avatar, 400 * 1024);
        if (old.avatarId) await store.delete(`img:${old.avatarId}`);
        p.avatarId = aid;
      } else if (body.removeAvatar && old.avatarId) {
        await store.delete(`img:${old.avatarId}`);
        p.avatarId = "";
      }
      await store.setJSON(key, p);
      return json(p);
    }

    // ---------- Medien-Upload (Videos) ----------
    if (res === "media") {
      if (!id && method === "POST") {
        const mime = str(body.mime, 40).toLowerCase() || "video/mp4";
        const size = Math.floor(Number(body.size));
        if (!VIDEO_TYPES.includes(mime)) throw new HttpError(400, "Dieses Videoformat wird nicht unterstützt (MP4, MOV oder WebM).");
        if (!(size > 0) || size > MAX_VIDEO) throw new HttpError(413, `Video ist zu groß (max. ${MAX_VIDEO / 1024 / 1024} MB) – bitte kürzer aufnehmen.`);
        const meta = { id: randomUUID(), mime, size, chunks: Math.ceil(size / CHUNK), createdBy: user, createdAt: new Date().toISOString() };
        await store.setJSON(`mediameta:${meta.id}`, meta);
        return json({ id: meta.id, chunkSize: CHUNK, chunks: meta.chunks }, 201);
      }
      if (id && /^\d{1,3}$/.test(sub || "") && method === "PUT") {
        const meta = await store.get(`mediameta:${id}`, { type: "json" });
        if (!meta || nameKey(meta.createdBy) !== nameKey(user)) throw new HttpError(404, "Upload nicht gefunden.");
        const n = Number(sub);
        if (n >= meta.chunks) throw new HttpError(400, "Zu viele Stücke.");
        const buf = await req.arrayBuffer();
        const expected = n === meta.chunks - 1 ? meta.size - n * CHUNK : CHUNK;
        if (buf.byteLength !== expected) throw new HttpError(400, "Upload beschädigt – bitte nochmal versuchen.");
        await store.set(`media:${id}:${n}`, buf);
        return json({ ok: true });
      }
    }

    // ---------- Stories ----------
    if (res === "stories") {
      const key = `story:${id}`;
      if (!id && method === "POST") {
        const now = Date.now();
        const s = {
          id: randomUUID(), type: body.type === "video" ? "video" : "image", caption: str(body.caption, 200),
          createdBy: user, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + STORY_HOURS * 3600e3).toISOString(),
          archived: false, views: {},
        };
        if (s.type === "image") s.imageId = await saveJpeg(store, body.image);
        else {
          s.media = await checkMedia(store, body.media, user);
          if (body.thumb) s.thumbId = await saveJpeg(store, body.thumb, 300 * 1024).catch(() => "");
        }
        await store.setJSON(`story:${s.id}`, s);
        await push({ title: `${user} hat eine Story gepostet`, body: s.caption || (s.type === "video" ? "🎬 Video" : "📷 Foto"), url: link("board"), tag: "story-" + group.slug, broadcast: true, mentionText: s.caption });
        return json(s, 201);
      }
      if (id && sub === "view" && method === "POST") {
        const s = await store.get(key, { type: "json" });
        if (!s) return json({ ok: true });
        if (nameKey(s.createdBy) === nameKey(user) || s.views?.[nameKey(user)]) return json(s);
        return json(await mutate(store, key, (x) => { x.views = x.views || {}; x.views[nameKey(user)] = { name: user, at: new Date().toISOString() }; }));
      }
      if (id && sub === "archive" && method === "POST") {
        return json(await mutate(store, key, (x) => {
          if (body.archived) { x.archived = true; x.archivedBy = user; x.archivedAt = new Date().toISOString(); }
          else { assertOwner(x, user, req); x.archived = false; }
        }));
      }
      if (id && !sub && method === "DELETE") {
        const s = await store.get(key, { type: "json" });
        if (s) { assertOwner(s, user, req); await deleteStory(store, s); }
        return json({ ok: true });
      }
    }

    // ---------- Chat ----------
    if (res === "chat") {
      const key = `msg:${id}`;
      if (!id && method === "GET") {
        await migrateBoard(store);
        const q = url.searchParams;
        const limit = Math.min(Number(q.get("limit")) || 120, 300);
        const { blobs } = await store.list({ prefix: "msg:" });
        const ids = blobs.map((b) => b.key.slice(4)).sort();
        let pick, hasMore = false;
        if (q.get("before")) {
          const end = ids.filter((x) => x < q.get("before")).length;
          pick = ids.slice(Math.max(0, end - limit), end); hasMore = end > limit;
        } else if (q.get("after")) {
          pick = ids.filter((x) => x > q.get("after")).slice(-500);
        } else {
          pick = ids.slice(-limit); hasMore = ids.length > limit;
        }
        const messages = (await Promise.all(pick.map((x) => store.get(`msg:${x}`, { type: "json" })))).filter(Boolean);
        let changed = [], deleted = [];
        if (q.get("since")) {
          const log = (await store.get("chatlog", { type: "json" })) || { changes: [] };
          const recent = log.changes.filter((c) => c.at > q.get("since") && !pick.includes(c.id));
          deleted = [...new Set(recent.filter((c) => c.deleted).map((c) => c.id))];
          const upd = [...new Set(recent.filter((c) => !c.deleted).map((c) => c.id))].filter((x) => !deleted.includes(x));
          changed = (await Promise.all(upd.map((x) => store.get(`msg:${x}`, { type: "json" })))).filter(Boolean);
        }
        return json({ messages, changed, deleted, hasMore, serverTime: new Date().toISOString() });
      }
      if (!id && method === "POST") {
        const m = { id: newMsgId(), text: str(body.text, 4000), reactions: {}, createdBy: user, createdAt: new Date().toISOString() };
        if (validId(body.replyTo)) m.replyTo = body.replyTo;
        if (body.image) m.imageId = await saveJpeg(store, body.image);
        if (body.media) {
          m.media = await checkMedia(store, body.media, user);
          if (body.thumb) m.thumbId = await saveJpeg(store, body.thumb, 300 * 1024).catch(() => "");
        }
        if (!m.text && !m.imageId && !m.media) throw new HttpError(400, "Nachricht ist leer.");
        await store.setJSON(`msg:${m.id}`, m);
        let replyAuthor = [];
        if (m.replyTo) { const r = await store.get(`msg:${m.replyTo}`, { type: "json" }); if (r) replyAuthor = [r.createdBy]; }
        await push({
          title: replyAuthor.length ? `${user} hat dir geantwortet` : `${user} · ${groupName}`,
          body: m.text ? clip(m.text, 160) : m.media ? "🎬 Video" : "📷 Foto",
          url: link("board"), tag: "chat-" + group.slug, broadcast: true, direct: replyAuthor, mentionText: m.text,
        });
        return json(m, 201);
      }
      if (id && sub === "react" && method === "POST") {
        const m = await mutate(store, key, (x) => toggleReaction(x, user, body.emoji));
        await logChange(store, id);
        return json(m);
      }
      if (id && sub === "pin" && method === "POST") {
        const m = await mutate(store, key, (x) => { x.pinned = !!body.pinned; x.pinnedBy = user; });
        await logChange(store, id);
        return json(m);
      }
      if (id && !sub && method === "DELETE") {
        const m = await store.get(key, { type: "json" });
        if (m) {
          assertOwner(m, user, req);
          await store.delete(key);
          if (m.media?.id) await deleteMedia(store, m.media.id);
          await logChange(store, id, true);
        }
        return json({ ok: true });
      }
    }

    // ---------- Kosten ----------
    if (res === "expenses") {
      const key = `expense:${id}`;

      // Zahlungen buchen: items = [{ id, name, amount }], kind = "paid" | "received" | "offset"
      if (id === "pay" && method === "POST") {
        const items = (Array.isArray(body.items) ? body.items : []).slice(0, 200);
        if (!items.length) throw new HttpError(400, "Nichts ausgewählt.");
        const admin = isAdmin(req), sums = new Map(), titles = new Map();
        for (const it of items) {
          if (!validId(it?.id)) continue;
          await mutate(store, `expense:${it.id}`, (x) => {
            const { idx, key: k, share } = shareOf(x, it.name, user, admin);
            x.paid = x.paid || {};
            const prev = x.paid[k]?.amount ?? (x.paid[k] ? share : 0);
            const add = Math.round(Number(it.amount)) || share - prev;
            const amount = Math.max(0, Math.min(share, prev + add));
            x.paid[k] = { name: x.participants[idx], amount, at: new Date().toISOString(), by: user, ...(body.kind === "offset" ? { via: "Verrechnung" } : {}) };
            const other = nameKey(user) === k ? x.paidBy : x.participants[idx];
            // Beim Verrechnen nur die eigene Seite zählen (sonst doppelt)
            if (body.kind !== "offset" || nameKey(user) === k) sums.set(other, (sums.get(other) || 0) + (amount - prev));
            titles.set(other, [...(titles.get(other) || []), x.title]);
          });
        }
        for (const [other, amt] of sums) {
          if (nameKey(other) === nameKey(user) || amt <= 0) continue;
          const what = clip(titles.get(other).join(", "), 80);
          const title = body.kind === "received" ? `${user} hat ${euro(amt)} von dir erhalten ✓`
            : body.kind === "offset" ? `${user} hat ${euro(amt)} mit dir verrechnet` : `${user} hat dir ${euro(amt)} bezahlt`;
          await push({ title, body: what, url: link("costs"), direct: [other] });
        }
        return json({ expenses: await readAll(store, "expense:") });
      }
      if (id && sub === "unpay" && method === "POST") {
        const x = await mutate(store, key, (x) => { const { key: k } = shareOf(x, body.name, user, isAdmin(req)); if (x.paid) delete x.paid[k]; });
        return json(x);
      }
      if (id === "remind" && method === "POST") {
        const to = str(body.to, 40), amount = Math.round(Number(body.amount)) || 0;
        if (!to || amount <= 0) throw new HttpError(400, "Ungültige Erinnerung.");
        await push({ title: `${user} erinnert dich: ${euro(amount)} offen`, body: body.note ? clip(str(body.note, 120)) : "Bitte begleichen – Details unter Kosten.", url: link("costs"), direct: [to] });
        return json({ ok: true });
      }

      if (!id && method === "POST") {
        const item = { id: randomUUID(), ...expenseFields(body), createdBy: user, createdAt: new Date().toISOString() };
        await store.setJSON(`expense:${item.id}`, item);
        const n = item.participants.length;
        if (item.type === "transfer") {
          await push({ title: "Ausgleich eingetragen", body: `${item.paidBy} → ${item.participants[0]}: ${euro(item.amount)}`, url: link("costs"), direct: [item.paidBy, item.participants[0]] });
        } else {
          await push({
            title: `${euro(item.amount)} für ${clip(item.title, 40)}`, url: link("costs"), direct: item.participants,
            body: `${item.paidBy} hat bezahlt – dein Anteil: ca. ${euro(Math.round(item.amount / n))}`, mentionText: item.note,
          });
        }
        return json(item, 201);
      }
      if (id && !sub && method === "PUT") {
        const fields = expenseFields(body);
        return json(await mutate(store, key, (x) => { assertOwner(x, user, req); Object.assign(x, fields); }));
      }
      if (id && !sub && method === "DELETE") {
        await deleteOwned(store, key, user, req);
        return json({ ok: true });
      }
    }

    throw new HttpError(404, "Unbekannte Route.");
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: "Serverfehler – bitte später nochmal versuchen." }, 500);
  }
};

export const config = { path: "/api/*" };
