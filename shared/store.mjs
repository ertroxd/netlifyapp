// Gemeinsame Speicher-Helfer für API und tägliche Aufgaben
import { getStore } from "@netlify/blobs";

// "main" = ursprüngliche Gruppe (Passwort/Name aus GROUP_PASSWORD / GROUP_NAME, Daten im alten Store)
export const MAIN = "main";
export const slugOk = (s) => typeof s === "string" && /^[a-z0-9][a-z0-9-]{1,39}$/.test(s);
export const metaStore = () => getStore({ name: "gruppenorganisator-meta", consistency: "strong" });
export const groupStore = (slug) =>
  getStore({ name: slug === MAIN ? "gruppenorganisator" : `gruppe-${slug}`, consistency: "strong" });

export const DATA_PREFIXES = ["event:", "poll:", "expense:"];

export async function readAll(store, prefix) {
  const { blobs } = await store.list({ prefix });
  const items = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return items.filter(Boolean);
}

// Name der Hauptgruppe: per Admin umbenannt (gespeichert) > GROUP_NAME > Standard
export async function mainGroupName() {
  const o = await metaStore().get("main-name", { type: "json" });
  return o?.name || process.env.GROUP_NAME || "Unsere Gruppe";
}

// Alle Gruppen (inkl. Hauptgruppe, falls konfiguriert)
export async function allGroups() {
  const groups = [];
  if (process.env.GROUP_PASSWORD) groups.push({ slug: MAIN, name: await mainGroupName() });
  const extra = await readAll(metaStore(), "group:");
  for (const g of extra) groups.push({ slug: g.slug, name: g.name });
  return groups;
}

// Datum in deutscher Zeit (für Erinnerungen / Backups)
export const berlinDate = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });

// ---------- Medien (Videos in Stücken) & Stories ----------
export const STORY_HOURS = 24;

export async function deleteMedia(store, id) {
  if (!id) return;
  const { blobs } = await store.list({ prefix: `media:${id}:` });
  await Promise.all(blobs.map((b) => store.delete(b.key)));
  await store.delete(`mediameta:${id}`);
}
async function deleteStoryFiles(store, s) {
  if (s.imageId) await store.delete(`img:${s.imageId}`);
  if (s.thumbId) await store.delete(`img:${s.thumbId}`);
  if (s.media?.id) await deleteMedia(store, s.media.id);
}
export async function deleteStory(store, s) {
  await deleteStoryFiles(store, s);
  await store.delete(`story:${s.id}`);
}
// Liefert alle noch sichtbaren Stories (aktiv oder im Archiv) und löscht abgelaufene
export async function cleanupStories(store) {
  const all = await readAll(store, "story:");
  const now = new Date().toISOString();
  const keep = [];
  for (const s of all) {
    if (!s.archived && s.expiresAt < now) await deleteStory(store, s).catch(() => {});
    else keep.push(s);
  }
  return keep;
}

// ---------- Backups ----------
const KEEP_BACKUPS = 14;
// Welche Daten ins Backup kommen (Prefix -> Feld in der Backup-Datei)
const BACKUP_PARTS = {
  "event:": "events", "poll:": "polls", "expense:": "expenses",
  "msg:": "messages", "story:": "stories", "profile:": "profiles", "post:": "posts",
};
const keyFor = (prefix, x) => prefix + (prefix === "profile:" ? String(x.name || "").trim().toLowerCase() : x.id);

export async function snapshot(store, label = berlinDate()) {
  const data = {};
  for (const [prefix, field] of Object.entries(BACKUP_PARTS)) data[field] = await readAll(store, prefix);
  data.stories = data.stories.filter((s) => s.archived); // abgelaufene Stories braucht kein Backup
  await store.setJSON(`backup:${label}`, { version: 2, createdAt: new Date().toISOString(), data });
  // Alte automatische Backups aufräumen (nur die täglichen, JJJJ-MM-TT)
  const { blobs } = await store.list({ prefix: "backup:" });
  const daily = blobs.map((b) => b.key).filter((k) => /^backup:\d{4}-\d{2}-\d{2}$/.test(k)).sort();
  for (const k of daily.slice(0, Math.max(0, daily.length - KEEP_BACKUPS))) await store.delete(k);
  // Sicherungen vor Wiederherstellungen: nur die letzten 5 behalten
  const pre = blobs.map((b) => b.key).filter((k) => k.includes("vor-restore")).sort();
  for (const k of pre.slice(0, Math.max(0, pre.length - 5))) await store.delete(k);
}

export async function listBackups(store) {
  const { blobs } = await store.list({ prefix: "backup:" });
  return blobs.map((b) => b.key.slice(7)).sort().reverse();
}

export async function restore(store, data) {
  for (const f of ["events", "polls", "expenses"]) if (!Array.isArray(data?.[f])) throw new Error("Backup-Datei ist ungültig.");
  const ts = new Date().toISOString().slice(0, 16).replace(":", "");
  await snapshot(store, `${ts}-vor-restore`);
  // Altes Backup (vor dem Chat): Pinnwand-Beiträge neu in den Chat übernehmen lassen
  const oldFormat = !Array.isArray(data.messages) && Array.isArray(data.posts);
  if (oldFormat) data = { ...data, messages: [] };
  for (const [prefix, field] of Object.entries(BACKUP_PARTS)) {
    const list = data[field];
    if (!Array.isArray(list)) continue;
    const { blobs } = await store.list({ prefix });
    await Promise.all(blobs.map((b) => store.delete(b.key)));
    await Promise.all(
      list.filter((x) => x && (prefix === "profile:" ? x.name : typeof x.id === "string" && /^[\w-]{1,64}$/.test(x.id)))
        .map((x) => store.setJSON(keyFor(prefix, x), x))
    );
  }
  if (oldFormat) await store.delete("chat-migrated");
}
