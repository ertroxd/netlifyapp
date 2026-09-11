// Gemeinsame Speicher-Helfer für API und tägliche Aufgaben
import { getStore } from "@netlify/blobs";

// "main" = ursprüngliche Gruppe (Passwort/Name aus GROUP_PASSWORD / GROUP_NAME, Daten im alten Store)
export const MAIN = "main";
export const slugOk = (s) => typeof s === "string" && /^[a-z0-9][a-z0-9-]{1,39}$/.test(s);
export const metaStore = () => getStore({ name: "gruppenorganisator-meta", consistency: "strong" });
export const groupStore = (slug) =>
  getStore({ name: slug === MAIN ? "gruppenorganisator" : `gruppe-${slug}`, consistency: "strong" });

export const DATA_PREFIXES = ["event:", "poll:", "post:", "expense:"];

export async function readAll(store, prefix) {
  const { blobs } = await store.list({ prefix });
  const items = await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" })));
  return items.filter(Boolean);
}

// Alle Gruppen (inkl. Hauptgruppe, falls konfiguriert)
export async function allGroups() {
  const groups = [];
  if (process.env.GROUP_PASSWORD) groups.push({ slug: MAIN, name: process.env.GROUP_NAME || "Unsere Gruppe" });
  const extra = await readAll(metaStore(), "group:");
  for (const g of extra) groups.push({ slug: g.slug, name: g.name });
  return groups;
}

// Datum in deutscher Zeit (für Erinnerungen / Backups)
export const berlinDate = (offsetDays = 0) =>
  new Date(Date.now() + offsetDays * 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });

// ---------- Backups ----------
const KEEP_BACKUPS = 14;

export async function snapshot(store, label = berlinDate()) {
  const [events, polls, posts, expenses] = await Promise.all(DATA_PREFIXES.map((p) => readAll(store, p)));
  await store.setJSON(`backup:${label}`, { version: 1, createdAt: new Date().toISOString(), data: { events, polls, posts, expenses } });
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
  const lists = { "event:": data?.events, "poll:": data?.polls, "post:": data?.posts, "expense:": data?.expenses };
  for (const v of Object.values(lists)) if (!Array.isArray(v)) throw new Error("Backup-Datei ist ungültig.");
  const ts = new Date().toISOString().slice(0, 16).replace(":", "");
  await snapshot(store, `${ts}-vor-restore`);
  for (const prefix of DATA_PREFIXES) {
    const { blobs } = await store.list({ prefix });
    await Promise.all(blobs.map((b) => store.delete(b.key)));
    await Promise.all(
      lists[prefix].filter((x) => x && typeof x.id === "string" && /^[\w-]{1,64}$/.test(x.id)).map((x) => store.setJSON(prefix + x.id, x))
    );
  }
}
