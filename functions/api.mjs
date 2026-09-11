// Gruppenorganisator – API (Netlify Function + Netlify Blobs)
// Alle Routen liegen unter /api/* und brauchen den Header "x-group-password".

import { getStore } from "@netlify/blobs";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";

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

async function readAll(store, prefix) {
  const { blobs } = await store.list({ prefix });
  const items = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return items.filter(Boolean);
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
// "main" = ursprüngliche Gruppe (Passwort/Name aus GROUP_PASSWORD / GROUP_NAME, Daten im alten Store)
const MAIN = "main";
const slugOk = (s) => typeof s === "string" && /^[a-z0-9][a-z0-9-]{1,39}$/.test(s);
const metaStore = () => getStore({ name: "gruppenorganisator-meta", consistency: "strong" });
const groupStore = (slug) =>
  getStore({ name: slug === MAIN ? "gruppenorganisator" : `gruppe-${slug}`, consistency: "strong" });
const hashPw = (pw, salt) => scryptSync(String(pw ?? ""), salt, 32).toString("hex");

async function resolveGroup(slug) {
  slug = String(slug || MAIN).toLowerCase();
  if (slug === MAIN) {
    const pw = process.env.GROUP_PASSWORD;
    if (!pw) throw new HttpError(500, "GROUP_PASSWORD ist in Netlify noch nicht gesetzt.");
    return { slug, name: process.env.GROUP_NAME || "Unsere Gruppe", check: (given) => passwordOk(given, pw) };
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
function deleteComment(item, user, cid) {
  const c = (item.comments || []).find((c) => c.id === cid);
  if (!c) throw new HttpError(404, "Kommentar nicht gefunden.");
  if (nameKey(c.name) !== nameKey(user)) throw new HttpError(403, "Nur eigene Kommentare löschen.");
  item.comments = item.comments.filter((c) => c.id !== cid);
}

function pollIsOpen(p) {
  return !p.closed && !(p.deadline && p.deadline < todayUTC());
}

export default async (req) => {
  try {
    const url = new URL(req.url);
    const [res, id, sub, subId] = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
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

    // Neue Gruppe anlegen (braucht das Admin-Passwort)
    if (res === "groups" && !id && req.method === "POST") {
      const admin = process.env.ADMIN_PASSWORD || process.env.GROUP_PASSWORD;
      if (!admin) throw new HttpError(500, "ADMIN_PASSWORD ist in Netlify nicht gesetzt.");
      if (!passwordOk(req.headers.get("x-admin-password"), admin)) throw new HttpError(403, "Admin-Passwort ist falsch.");
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
    const body = ["POST", "PUT", "PATCH"].includes(method) ? await req.json().catch(() => ({})) : {};

    if (res === "login" && method === "POST") return json({ ok: true, groupName, slug: group.slug });

    if (res === "state" && method === "GET") {
      const [events, polls, posts, expenses] = await Promise.all(
        ["event:", "poll:", "post:", "expense:"].map((p) => readAll(store, p))
      );
      return json({ groupName, slug: group.slug, events, polls, posts, expenses, serverDate: todayUTC() });
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
        return json(item, 201);
      }
      if (id && !sub && method === "PUT") {
        return json(await mutate(store, key, (e) => Object.assign(e, eventFields(body))));
      }
      if (id && !sub && method === "DELETE") {
        await store.delete(key);
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
      if (id && sub === "comments" && method === "POST") {
        return json(await mutate(store, key, (e) => addComment(e, user, body.text)));
      }
      if (id && sub === "comments" && subId && method === "DELETE") {
        return json(await mutate(store, key, (e) => deleteComment(e, user, subId)));
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
        return json(item, 201);
      }
      if (id && !sub && method === "DELETE") {
        await store.delete(key);
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
          likes: {},
          comments: [],
          createdBy: user,
          createdAt: new Date().toISOString(),
        };
        await store.setJSON(`post:${item.id}`, item);
        return json(item, 201);
      }
      if (id && !sub && method === "DELETE") {
        const post = await store.get(key, { type: "json" });
        if (post?.imageId) await store.delete(`img:${post.imageId}`);
        await store.delete(key);
        return json({ ok: true });
      }
      if (id && sub === "like" && method === "POST") {
        return json(
          await mutate(store, key, (p) => {
            const k = nameKey(user);
            if (p.likes[k]) delete p.likes[k];
            else p.likes[k] = user;
          })
        );
      }
      if (id && sub === "comments" && method === "POST") {
        return json(await mutate(store, key, (p) => addComment(p, user, body.text)));
      }
      if (id && sub === "comments" && subId && method === "DELETE") {
        return json(await mutate(store, key, (p) => deleteComment(p, user, subId)));
      }
      if (id && sub === "pin" && method === "POST") {
        return json(await mutate(store, key, (p) => (p.pinned = !!body.pinned)));
      }
    }

    // ---------- Kosten ----------
    if (res === "expenses") {
      const key = `expense:${id}`;

      if (!id && method === "POST") {
        const item = { id: randomUUID(), ...expenseFields(body), createdBy: user, createdAt: new Date().toISOString() };
        await store.setJSON(`expense:${item.id}`, item);
        return json(item, 201);
      }
      if (id && !sub && method === "PUT") {
        return json(await mutate(store, key, (x) => Object.assign(x, expenseFields(body))));
      }
      if (id && !sub && method === "DELETE") {
        await store.delete(key);
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
