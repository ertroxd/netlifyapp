// Läuft täglich um 16:00 UTC (18:00 Sommerzeit / 17:00 Winterzeit in Deutschland):
// 1) automatisches Backup jeder Gruppe (14 Tage aufbewahrt)
// 2) Erinnerungen an Termine von morgen und an Umfragen, die morgen enden
import { allGroups, berlinDate, groupStore, readAll, snapshot } from "../shared/store.mjs";
import { notify } from "../shared/push.mjs";

const nk = (n) => String(n ?? "").trim().toLowerCase();

export default async () => {
  const tomorrow = berlinDate(1);
  for (const g of await allGroups()) {
    const store = groupStore(g.slug);
    try { await snapshot(store); } catch (e) { console.error("backup", g.slug, e); }

    const subs = await readAll(store, "sub:");
    if (!subs.length) continue;
    const members = [...new Set(subs.map((s) => s.name).filter(Boolean))];
    const base = g.slug === "main" ? "/?g=main" : `/?g=${encodeURIComponent(g.slug)}`;

    for (const e of (await readAll(store, "event:")).filter((e) => e.date === tomorrow)) {
      const going = members.filter((m) => ["yes", "maybe"].includes(e.rsvps?.[nk(m)]?.status));
      const open = members.filter((m) => !e.rsvps?.[nk(m)]);
      const when = e.time ? ` um ${e.time} Uhr` : "";
      if (going.length) await notify(store, { title: `Morgen: ${e.title}`, body: `${g.name}${when}${e.location ? " · " + e.location : ""}`, url: base + "&t=events", tag: "rem-" + e.id, direct: going });
      if (open.length) await notify(store, { title: `Morgen: ${e.title} – bist du dabei?`, body: `Du hast noch nicht geantwortet (${g.name}).`, url: base + "&t=events", tag: "rem-" + e.id, direct: open });
    }
    for (const p of (await readAll(store, "poll:")).filter((p) => !p.closed && p.deadline === tomorrow)) {
      const open = members.filter((m) => !p.votes?.[nk(m)]);
      if (open.length) await notify(store, { title: `Umfrage endet morgen: ${p.title}`, body: `Du hast noch nicht abgestimmt (${g.name}).`, url: base + "&t=polls", tag: "poll-" + p.id, direct: open });
    }
  }
  return new Response("ok");
};

export const config = { schedule: "0 16 * * *" };
