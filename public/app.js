/* ---------- Helfer ---------- */
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const keyOf = (n) => String(n || "").trim().toLowerCase();
const todayISO = () => new Date().toLocaleDateString("sv-SE");
const parseDate = (d) => { const [y, m, day] = d.split("-").map(Number); return new Date(y, m - 1, day); };
const daysUntil = (d) => Math.round((parseDate(d) - parseDate(todayISO())) / 86400000);
const fmt = (d, o) => parseDate(d).toLocaleDateString("de-DE", o);
const fmtLong = (d) => fmt(d, { weekday: "short", day: "numeric", month: "short", year: parseDate(d).getFullYear() !== new Date().getFullYear() ? "numeric" : undefined });
const relDay = (d) => {
  const n = daysUntil(d);
  if (n === 0) return "Heute";
  if (n === 1) return "Morgen";
  if (n === -1) return "Gestern";
  if (n > 1 && n < 7) return `in ${n} Tagen`;
  if (n >= 7 && n < 14) return "nächste Woche";
  return "";
};
const timeRange = (e) => (e.time ? e.time + (e.endTime ? "–" + e.endTime : "") + " Uhr" : "");
const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return "gerade eben";
  if (s < 3600) return `vor ${Math.floor(s / 60)} Min.`;
  if (s < 86400) return `vor ${Math.floor(s / 3600)} Std.`;
  return new Date(iso).toLocaleDateString("de-DE", { day: "numeric", month: "short" });
};
const optLabel = (p, o) => (p.kind === "date" ? fmtLong(o.date) + (o.time ? `, ${o.time} Uhr` : "") : o.text);

const I = {
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>',
  user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  chev: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 9l6 6 6-6"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  cal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="4" y="5" width="16" height="15" rx="3"/><path d="M4 10h16M9 3v4M15 3v4"/></svg>',
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
};

/* ---------- Zustand ---------- */
let auth = store.get("go-auth"); // { name, pw }
let state = { events: [], polls: [], posts: [], expenses: [], groupName: "" };
let loaded = false;
const TABS = ["events", "polls", "board", "costs"];
let tab = TABS.includes(store.get("go-tab")) ? store.get("go-tab") : "events";
const expanded = new Set();
let showPast = false, showClosed = false, showAllExpenses = false;
let editingEventId = null;
let pollKind = "text";
let boardSeen = store.get("go-board-seen") || "";
let composerImage = null; // dataURL des verkleinerten Fotos
const euro = new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" });
const money = (cents) => euro.format(cents / 100);

/* ---------- API ---------- */
async function api(method, path, body) {
  const r = await fetch("/api/" + path, {
    method,
    headers: {
      "content-type": "application/json",
      "x-group-password": auth?.pw || "",
      "x-user-name": encodeURIComponent(auth?.name || ""),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).catch(() => { throw new Error("Keine Verbindung – bitte später nochmal versuchen."); });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401) { logout(data.error); throw new Error(data.error || "Nicht angemeldet"); }
  if (!r.ok) throw new Error(data.error || "Fehler " + r.status);
  return data;
}

function upsert(list, item) {
  const i = state[list].findIndex((x) => x.id === item.id);
  if (i >= 0) state[list][i] = item; else state[list].push(item);
}

async function run(fn) {
  try { await fn(); render(); }
  catch (e) { toast(e.message); }
}

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

async function refresh() {
  try {
    const data = await api("GET", "state");
    state = { posts: [], expenses: [], ...data };
    loaded = true;
    if (!boardSeen) { boardSeen = state.posts.reduce((m, p) => (p.createdAt > m ? p.createdAt : m), "") || new Date().toISOString(); store.set("go-board-seen", boardSeen); }
    $("#group-name").textContent = data.groupName;
    document.title = data.groupName + " · Gruppenorganisator";
    render();
  } catch (e) { if (auth) toast(e.message); }
}

/* ---------- Login ---------- */
function showLogin(err) {
  $("#app").hidden = true;
  $("#login").hidden = false;
  const f = $("#login-form");
  if (auth?.name) f.name.value = auth.name;
  $("#login-err").hidden = !err;
  $("#login-err").textContent = err || "";
}
function logout(err) {
  auth = auth ? { name: auth.name } : null;
  store.set("go-auth", auth);
  showLogin(err);
}
$("#login-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const name = f.name.value.trim(), pw = f.pw.value;
  if (!name) return;
  auth = { name, pw };
  const btn = f.querySelector("button");
  btn.disabled = true;
  try {
    await api("POST", "login");
    store.set("go-auth", auth);
    f.pw.value = "";
    startApp();
  } catch (e) {
    $("#login-err").textContent = e.message; $("#login-err").hidden = false;
  } finally { btn.disabled = false; }
});
$("#logout").onclick = () => { store.del("go-auth"); auth = null; try { caches.delete("go-data"); } catch {} showLogin(); };

function startApp() {
  $("#login").hidden = true;
  $("#app").hidden = false;
  $("#me-name").textContent = auth.name;
  updateInstallBanner();
  render();
  refresh();
}

/* ---------- Rendering ---------- */
function knownPeople() {
  const m = new Map();
  const add = (n) => n && !m.has(keyOf(n)) && m.set(keyOf(n), n);
  for (const e of state.events) { add(e.createdBy); Object.values(e.rsvps || {}).forEach((r) => add(r.name)); (e.comments || []).forEach((c) => add(c.name)); }
  for (const p of state.polls) { add(p.createdBy); Object.values(p.votes || {}).forEach((v) => add(v.name)); }
  for (const p of state.posts || []) { add(p.createdBy); Object.values(p.likes || {}).forEach(add); }
  for (const x of state.expenses || []) { add(x.paidBy); x.participants.forEach(add); }
  add(auth?.name);
  return m;
}

/* ---------- Kosten-Berechnung ---------- */
function splitCents(amount, n) {
  const base = Math.floor(amount / n), rest = amount - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < rest ? 1 : 0));
}
function balances() {
  const b = new Map(); // key -> { name, bal, paid, share }
  const acc = (name) => { const k = keyOf(name); if (!b.has(k)) b.set(k, { name, bal: 0, paid: 0, share: 0 }); return b.get(k); };
  for (const x of state.expenses || []) {
    const payer = acc(x.paidBy);
    payer.bal += x.amount;
    if (x.type !== "transfer") payer.paid += x.amount;
    splitCents(x.amount, x.participants.length).forEach((s, i) => {
      const p = acc(x.participants[i]);
      p.bal -= s;
      if (x.type !== "transfer") p.share += s;
    });
  }
  return [...b.values()];
}
function settleUp(list) {
  const cred = list.filter((p) => p.bal > 0).map((p) => ({ ...p })).sort((a, b) => b.bal - a.bal);
  const debt = list.filter((p) => p.bal < 0).map((p) => ({ ...p, bal: -p.bal })).sort((a, b) => b.bal - a.bal);
  const out = [];
  let i = 0, j = 0;
  while (i < debt.length && j < cred.length) {
    const amt = Math.min(debt[i].bal, cred[j].bal);
    if (amt > 0) out.push({ from: debt[i].name, to: cred[j].name, amount: amt });
    debt[i].bal -= amt; cred[j].bal -= amt;
    if (debt[i].bal === 0) i++;
    if (cred[j].bal === 0) j++;
  }
  return out;
}
const hue = (name) => [...keyOf(name)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
const avatar = (name) => `<span class="avatar" style="background:hsl(${hue(name)} 55% 50%)">${esc((name || "?").trim()[0]?.toUpperCase() || "?")}</span>`;
const linkify = (s) => esc(s).replace(/(https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
const pollOpen = (p) => !p.closed && !(p.deadline && p.deadline < todayISO());

function render() {
  if (!auth) return;
  const me = keyOf(auth.name);
  const today = todayISO();
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", t.dataset.tab === tab));
  $("#fab").innerHTML = I.plus + { events: "Termin", polls: "Abstimmung", costs: "Ausgabe", board: "" }[tab];
  $("#fab").hidden = tab === "board";
  if (tab === "board" && loaded) {
    const newest = (state.posts || []).reduce((m, p) => (p.createdAt > m ? p.createdAt : m), "");
    if (newest > boardSeen) { boardSeen = newest; store.set("go-board-seen", boardSeen); }
  }
  const boardNew = boardSeen ? (state.posts || []).filter((p) => p.createdAt > boardSeen && keyOf(p.createdBy) !== me).length : 0;
  const myBal = balances().find((b) => keyOf(b.name) === me)?.bal || 0;
  $("#badge-board").hidden = !boardNew; $("#badge-board").textContent = boardNew;
  $("#badge-costs").hidden = myBal >= 0; $("#badge-costs").textContent = "€";

  const upcoming = state.events.filter((e) => e.date >= today).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const past = state.events.filter((e) => e.date < today).sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  const openPolls = state.polls.filter(pollOpen).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const closedPolls = state.polls.filter((p) => !pollOpen(p)).sort((a, b) => (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt));

  const evTodo = upcoming.filter((e) => !e.rsvps?.[me]).length;
  const pollTodo = openPolls.filter((p) => !p.votes?.[me]).length;
  $("#badge-events").hidden = !evTodo; $("#badge-events").textContent = evTodo;
  $("#badge-polls").hidden = !pollTodo; $("#badge-polls").textContent = pollTodo;

  if (!loaded) { $("#main").innerHTML = '<div class="loading">Lade…</div>'; return; }

  let html = "";
  if (tab === "events") {
    html += upcoming.length
      ? `<div class="list">${upcoming.map((e) => eventCard(e, false)).join("")}</div>`
      : `<div class="empty"><p>Noch keine anstehenden Termine.</p><button class="btn primary" data-action="new-event">${I.plus}Ersten Termin anlegen</button></div>`;
    if (past.length) {
      html += `<div class="section-title">Vergangen (${past.length}) <button class="btn small ghost" data-action="toggle-past">${showPast ? "Ausblenden" : "Anzeigen"}</button></div>`;
      if (showPast) html += `<div class="list">${past.map((e) => eventCard(e, true)).join("")}</div>`;
    }
  } else if (tab === "board") {
    html += renderBoard();
  } else if (tab === "costs") {
    html += renderCosts();
  } else {
    html += openPolls.length
      ? `<div class="list">${openPolls.map(pollCard).join("")}</div>`
      : `<div class="empty"><p>Gerade läuft keine Abstimmung.</p><button class="btn primary" data-action="new-poll">${I.plus}Abstimmung starten</button></div>`;
    if (closedPolls.length) {
      html += `<div class="section-title">Beendet (${closedPolls.length}) <button class="btn small ghost" data-action="toggle-closed">${showClosed ? "Ausblenden" : "Anzeigen"}</button></div>`;
      if (showClosed) html += `<div class="list">${closedPolls.map(pollCard).join("")}</div>`;
    }
  }

  // Eingaben in Kommentarfeldern beim Neuzeichnen erhalten
  const drafts = {};
  document.querySelectorAll("#main [data-draft]").forEach((i) => (drafts[i.dataset.draft] = i.value));
  $("#main").innerHTML = html;
  for (const [k, v] of Object.entries(drafts)) { const i = document.querySelector(`#main [data-draft="${k}"]`); if (i) i.value = v; }
}

function eventCard(e, isPast) {
  const me = keyOf(auth.name);
  const rs = Object.values(e.rsvps || {});
  const by = (s) => rs.filter((r) => r.status === s);
  const mine = e.rsvps?.[me]?.status;
  const open = expanded.has(e.id);
  const rel = relDay(e.date);
  const d = parseDate(e.date);
  const btn = (s, label) => `<button data-action="rsvp" data-s="${s}" aria-pressed="${mine === s}">${label} <span class="n">${by(s).length || ""}</span></button>`;
  const chips = (list) => list.length
    ? `<span class="chips">${list.map((r) => `<span class="chip ${keyOf(r.name) === me ? "me-chip" : ""}">${esc(r.name)}${r.note ? ` <small>· ${esc(r.note)}</small>` : ""}</span>`).join("")}</span>`
    : '<span class="muted">–</span>';
  const pending = [...knownPeople().entries()].filter(([k]) => !e.rsvps?.[k]).map(([, n]) => n);

  return `<article class="card ev ${isPast ? "past" : ""}" data-type="event" data-id="${e.id}">
    <div class="datebox"><span class="dow">${d.toLocaleDateString("de-DE", { weekday: "short" }).replace(".", "")}</span><span class="day">${d.getDate()}</span><span class="mon">${d.toLocaleDateString("de-DE", { month: "short" }).replace(".", "")}${d.getFullYear() !== new Date().getFullYear() ? " " + String(d.getFullYear()).slice(2) : ""}</span></div>
    <div style="min-width:0">
      ${rel && !isPast ? `<div class="when">${rel}</div>` : ""}
      <h3>${esc(e.title)}</h3>
      <div class="meta">
        ${e.time ? `<span>${I.clock}${timeRange(e)}</span>` : ""}
        ${e.location ? `<span>${I.pin}${esc(e.location)}</span>` : ""}
        ${e.comments?.length ? `<span>${I.chat}${e.comments.length}</span>` : ""}
      </div>
      ${isPast ? `<div class="meta" style="margin-top:8px"><span>${by("yes").length} waren dabei</span></div>` : `<div class="rsvp">${btn("yes", "Dabei")}${btn("maybe", "Vielleicht")}${btn("no", "Nein")}</div>`}
      <button class="more" data-action="expand" aria-expanded="${open}">${open ? "Weniger" : "Details & Kommentare"} ${I.chev}</button>
      ${open ? `<div class="details">
        ${e.description ? `<p class="desc">${esc(e.description)}</p>` : ""}
        <div class="people">
          <div><span class="lbl">Dabei</span>${chips(by("yes"))}</div>
          <div><span class="lbl">Vielleicht</span>${chips(by("maybe"))}</div>
          <div><span class="lbl">Nein</span>${chips(by("no"))}</div>
          ${!isPast && pending.length ? `<div><span class="lbl">Offen</span><span class="muted">${pending.map(esc).join(", ")}</span></div>` : ""}
        </div>
        ${!isPast && mine ? `<form class="inline-form" data-action="note"><input type="text" name="note" maxlength="140" data-draft="note-${e.id}" placeholder="Notiz zu deiner Antwort, z. B. „komme später“" value="${esc(e.rsvps[me].note || "")}"><button class="btn small">Speichern</button></form>` : ""}
        <div class="comments">
          ${(e.comments || []).map((c) => `<div class="comment"><div class="head"><b>${esc(c.name)}</b>${ago(c.at)}${keyOf(c.name) === me ? `<button data-action="del-comment" data-cid="${c.id}">löschen</button>` : ""}</div><p>${esc(c.text)}</p></div>`).join("")}
          <form class="inline-form" data-action="comment"><input type="text" name="text" maxlength="1000" data-draft="c-${e.id}" placeholder="Kommentar schreiben…" required><button class="btn small primary">Senden</button></form>
        </div>
        ${eventCostLine(e)}
        <div class="actions">
          <button class="btn small" data-action="ics">${I.cal}In Kalender</button>
          <button class="btn small" data-action="share">Teilen</button>
          <button class="btn small" data-action="edit-event">Bearbeiten</button>
          <button class="btn small ghost danger" data-action="del-event">Löschen</button>
        </div>
        <div class="muted" style="font-size:12.5px">Erstellt von ${esc(e.createdBy)} · ${ago(e.createdAt)}</div>
      </div>` : ""}
    </div>
  </article>`;
}

function pollCard(p) {
  const me = keyOf(auth.name);
  const isOpen = pollOpen(p);
  const votes = Object.values(p.votes || {});
  const mine = new Set(p.votes?.[me]?.optionIds || []);
  const counts = Object.fromEntries(p.options.map((o) => [o.id, votes.filter((v) => v.optionIds.includes(o.id))]));
  const max = Math.max(0, ...Object.values(counts).map((l) => l.length));
  const opts = p.kind === "date" ? [...p.options].sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)) : p.options;
  const winners = max > 0 ? opts.filter((o) => counts[o.id].length === max) : [];
  const pending = [...knownPeople().entries()].filter(([k]) => !p.votes?.[k]).map(([, n]) => n);
  const canAdd = isOpen && (p.allowAdd || keyOf(p.createdBy) === me);

  return `<article class="card poll" data-type="poll" data-id="${p.id}">
    <div class="poll-head"><div style="min-width:0">
      <h3>${esc(p.title)}</h3>
      <div class="tags">
        ${isOpen ? '<span class="tag open">Offen</span>' : '<span class="tag closed">Beendet</span>'}
        ${isOpen && !mine.size ? '<span class="tag todo">Deine Stimme fehlt</span>' : ""}
        ${p.kind === "date" ? '<span class="tag">Terminfindung</span>' : ""}
        ${p.multi ? '<span class="tag">Mehrfachauswahl</span>' : ""}
        ${p.deadline ? `<span class="tag">bis ${fmt(p.deadline, { day: "numeric", month: "short" })}</span>` : ""}
      </div>
    </div></div>
    ${p.description ? `<p class="desc" style="margin-top:8px">${esc(p.description)}</p>` : ""}
    <ul class="opts">
      ${opts.map((o) => {
        const list = counts[o.id];
        const pct = votes.length ? Math.round((list.length / votes.length) * 100) : 0;
        const win = !isOpen && winners.includes(o);
        return `<li>
          <button class="opt ${p.multi ? "multi" : ""} ${win ? "win" : ""}" data-action="vote" data-opt="${o.id}" aria-pressed="${mine.has(o.id)}" ${isOpen ? "" : "disabled"}>
            <span class="bar" style="width:${pct}%"></span>
            <span class="check"></span>
            <span class="label">${esc(optLabel(p, o))}${win ? ' <span class="crown">★ Gewinner</span>' : ""}</span>
            <span class="count">${list.length}</span>
          </button>
          ${list.length ? `<div class="voters">${list.map((v) => esc(v.name)).join(", ")}</div>` : ""}
        </li>`;
      }).join("")}
    </ul>
    ${canAdd ? `<form class="inline-form" data-action="add-option" style="margin-top:10px">
      ${p.kind === "date"
        ? `<input type="date" name="date" required><input type="time" name="time" style="flex:0 0 110px">`
        : `<input type="text" name="text" maxlength="150" data-draft="o-${p.id}" placeholder="Eigene Option hinzufügen…" required>`}
      <button class="btn small">Hinzufügen</button></form>` : ""}
    ${isOpen && pending.length ? `<div class="hint">Noch nicht abgestimmt: ${pending.map(esc).join(", ")}</div>` : ""}
    <div class="poll-foot">
      <span>${votes.length} ${votes.length === 1 ? "Stimme" : "Stimmen"} · von ${esc(p.createdBy)} · ${ago(p.createdAt)}</span>
      <span class="actions">
        ${p.kind === "date" && winners.length ? `<button class="btn small" data-action="poll-to-event">${I.cal}Als Termin anlegen</button>` : ""}
        <button class="btn small" data-action="share">Teilen</button>
        <button class="btn small" data-action="toggle-close">${isOpen ? "Beenden" : "Wieder öffnen"}</button>
        <button class="btn small ghost danger" data-action="del-poll">Löschen</button>
      </span>
    </div>
  </article>`;
}

/* ---------- Aktionen ---------- */
document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => { tab = t.dataset.tab; store.set("go-tab", tab); render(); window.scrollTo({ top: 0 }); }));
$("#fab").onclick = () => (tab === "events" ? openEventDialog() : tab === "costs" ? openExpenseDialog() : openPollDialog());

$("#main").addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-action]");
  if (!el || el.tagName === "FORM") return;
  const card = el.closest("[data-id]");
  const id = card?.dataset.id;
  const e = state.events.find((x) => x.id === id);
  const p = state.polls.find((x) => x.id === id);
  const me = keyOf(auth.name);

  switch (el.dataset.action) {
    case "new-event": return openEventDialog();
    case "new-poll": return openPollDialog();
    case "toggle-past": showPast = !showPast; return render();
    case "toggle-closed": showClosed = !showClosed; return render();
    case "expand": expanded.has(id) ? expanded.delete(id) : expanded.add(id); return render();
    case "rsvp": {
      const s = el.dataset.s;
      const next = e.rsvps?.[me]?.status === s ? null : s;
      return run(async () => upsert("events", await api("POST", `events/${id}/rsvp`, { status: next, note: e.rsvps?.[me]?.note || "" })));
    }
    case "del-comment":
      return run(async () => upsert("events", await api("DELETE", `events/${id}/comments/${el.dataset.cid}`)));
    case "ics": return downloadIcs(e);
    case "share": return share(e ? eventText(e) : pollText(p));
    case "edit-event": return openEventDialog(e);
    case "del-event":
      if (!confirm(`Termin „${e.title}“ wirklich löschen?`)) return;
      return run(async () => { await api("DELETE", `events/${id}`); state.events = state.events.filter((x) => x.id !== id); });
    case "vote": {
      const cur = new Set(p.votes?.[me]?.optionIds || []);
      const o = el.dataset.opt;
      let next;
      if (p.multi) { cur.has(o) ? cur.delete(o) : cur.add(o); next = [...cur]; }
      else next = cur.has(o) ? [] : [o];
      return run(async () => upsert("polls", await api("POST", `polls/${id}/vote`, { optionIds: next })));
    }
    case "toggle-close":
      return run(async () => upsert("polls", await api("POST", `polls/${id}/close`, { closed: pollOpen(p) })));
    case "del-poll":
      if (!confirm(`Abstimmung „${p.title}“ wirklich löschen?`)) return;
      return run(async () => { await api("DELETE", `polls/${id}`); state.polls = state.polls.filter((x) => x.id !== id); });
    case "poll-to-event": {
      const votes = Object.values(p.votes || {});
      const best = [...p.options].sort((a, b) => votes.filter((v) => v.optionIds.includes(b.id)).length - votes.filter((v) => v.optionIds.includes(a.id)).length)[0];
      return openEventDialog(null, { title: p.title, date: best.date, time: best.time || "", description: p.description || "" });
    }
  }
});

$("#main").addEventListener("submit", (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const id = f.closest("[data-id]")?.dataset.id;
  if (!id) return;
  const e = state.events.find((x) => x.id === id);
  const action = f.dataset.action;
  const clear = () => { f.reset(); f.querySelectorAll("[data-draft]").forEach((i) => (i.value = "")); };
  if (action === "comment") {
    const text = f.text.value.trim(); if (!text) return;
    run(async () => { upsert("events", await api("POST", `events/${id}/comments`, { text })); clear(); });
  } else if (action === "note") {
    run(async () => { upsert("events", await api("POST", `events/${id}/rsvp`, { status: e.rsvps[keyOf(auth.name)].status, note: f.note.value })); toast("Notiz gespeichert"); });
  } else if (action === "add-option") {
    const body = f.text ? { text: f.text.value } : { date: f.date.value, time: f.time.value };
    run(async () => { upsert("polls", await api("POST", `polls/${id}/options`, body)); clear(); });
  }
});

/* ---------- Termin-Dialog ---------- */
function openEventDialog(e = null, prefill = null) {
  editingEventId = e?.id || null;
  const f = $("#event-form");
  f.reset();
  $("#event-dlg-title").textContent = e ? "Termin bearbeiten" : "Neuer Termin";
  const src = e || prefill || {};
  for (const k of ["title", "date", "time", "endTime", "location", "description"]) f[k].value = src[k] || "";
  f.querySelector(".form-err").hidden = true;
  $("#event-dlg").showModal();
  f.title.focus();
}
$("#event-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const body = Object.fromEntries(["title", "date", "time", "endTime", "location", "description"].map((k) => [k, f[k].value]));
  const err = f.querySelector(".form-err");
  try {
    const item = editingEventId ? await api("PUT", `events/${editingEventId}`, body) : await api("POST", "events", body);
    upsert("events", item);
    $("#event-dlg").close();
    tab = "events"; store.set("go-tab", tab);
    render();
    toast(editingEventId ? "Termin aktualisiert" : "Termin angelegt");
  } catch (e) { err.textContent = e.message; err.hidden = false; }
});

/* ---------- Abstimmungs-Dialog ---------- */
function optRow(kind) {
  const div = document.createElement("div");
  div.className = "opt-row";
  div.innerHTML = (kind === "date"
    ? `<input type="date" data-f="date"><input type="time" data-f="time">`
    : `<input type="text" data-f="text" maxlength="150" placeholder="Option">`) +
    `<button type="button" class="icon-btn" aria-label="Option entfernen">${I.x}</button>`;
  div.querySelector("button").onclick = () => { if ($("#opt-rows").children.length > 2) div.remove(); };
  return div;
}
function setPollKind(kind) {
  pollKind = kind;
  document.querySelectorAll("#poll-kind button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.kind === kind));
  const rows = $("#opt-rows");
  rows.innerHTML = "";
  for (let i = 0; i < 3; i++) rows.append(optRow(kind));
  const f = $("#poll-form");
  if (kind === "date") { f.multi.checked = true; if (!f.title.value) f.title.placeholder = "z. B. Wann passt euch der Spieleabend?"; }
  else f.title.placeholder = "z. B. Wohin geht der Ausflug?";
}
document.querySelectorAll("#poll-kind button").forEach((b) => (b.onclick = () => setPollKind(b.dataset.kind)));
$("#add-opt-row").onclick = () => { $("#opt-rows").append(optRow(pollKind)); $("#opt-rows").lastChild.querySelector("input").focus(); };
function openPollDialog() {
  const f = $("#poll-form");
  f.reset();
  setPollKind("text");
  f.querySelector(".form-err").hidden = true;
  $("#poll-dlg").showModal();
  f.title.focus();
}
$("#poll-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const options = [...$("#opt-rows").children].map((row) => {
    const o = {}; row.querySelectorAll("[data-f]").forEach((i) => (o[i.dataset.f] = i.value.trim())); return o;
  }).filter((o) => (pollKind === "date" ? o.date : o.text));
  const err = f.querySelector(".form-err");
  if (options.length < 2) { err.textContent = "Bitte mindestens zwei Optionen ausfüllen."; err.hidden = false; return; }
  try {
    const item = await api("POST", "polls", {
      title: f.title.value, description: f.description.value, kind: pollKind, options,
      multi: f.multi.checked, allowAdd: f.allowAdd.checked, deadline: f.deadline.value,
    });
    upsert("polls", item);
    $("#poll-dlg").close();
    tab = "polls"; store.set("go-tab", tab);
    render();
    toast("Abstimmung erstellt");
  } catch (e) { err.textContent = e.message; err.hidden = false; }
});
document.querySelectorAll("[data-close]").forEach((b) => (b.onclick = () => b.closest("dialog").close()));

/* ---------- Kalender & Teilen ---------- */
function downloadIcs(e) {
  const pad = (n) => String(n).padStart(2, "0");
  const d = e.date.replace(/-/g, "");
  const icsEsc = (s) => String(s || "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (c) => "\\" + c);
  let start, end;
  if (e.time) {
    start = `DTSTART;TZID=Europe/Berlin:${d}T${e.time.replace(":", "")}00`;
    let endT = e.endTime;
    if (!endT) { const [h, m] = e.time.split(":").map(Number); endT = `${pad(Math.min(h + 2, 23))}:${pad(m)}`; }
    end = `DTEND;TZID=Europe/Berlin:${d}T${endT.replace(":", "")}00`;
  } else {
    const n = parseDate(e.date); n.setDate(n.getDate() + 1);
    start = `DTSTART;VALUE=DATE:${d}`;
    end = `DTEND;VALUE=DATE:${n.getFullYear()}${pad(n.getMonth() + 1)}${pad(n.getDate())}`;
  }
  const ics = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Gruppenorganisator//DE", "BEGIN:VEVENT",
    `UID:${e.id}@gruppenorganisator`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
    start, end, `SUMMARY:${icsEsc(e.title)}`, e.location ? `LOCATION:${icsEsc(e.location)}` : "",
    e.description ? `DESCRIPTION:${icsEsc(e.description)}` : "", "END:VEVENT", "END:VCALENDAR"].filter(Boolean).join("\r\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = e.title.replace(/[^\w\-äöüÄÖÜß ]+/g, "").trim().replace(/\s+/g, "_") + ".ics";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const eventText = (e) => `📅 ${e.title}\n${fmtLong(e.date)}${e.time ? ", " + timeRange(e) : ""}${e.location ? "\n📍 " + e.location : ""}\n\nBitte zu- oder absagen: ${location.origin}`;
const pollText = (p) => `🗳️ Abstimmung: ${p.title}\n\nJetzt abstimmen: ${location.origin}`;
async function share(text) {
  if (navigator.share) { try { await navigator.share({ text }); return; } catch (e) { if (e.name === "AbortError") return; } }
  try { await navigator.clipboard.writeText(text); toast("In die Zwischenablage kopiert – z. B. in WhatsApp einfügen"); }
  catch { toast("Kopieren nicht möglich"); }
}

/* ---------- Pinnwand ---------- */
function renderBoard() {
  const posts = [...state.posts].sort((a, b) => (b.pinned - a.pinned) || b.createdAt.localeCompare(a.createdAt));
  let h = `<form class="card composer" id="composer">
    <textarea name="text" maxlength="3000" data-draft="composer" placeholder="Was gibt's Neues? Idee, Link, Foto …"></textarea>
    ${composerImage ? `<div class="thumb"><img src="${composerImage}" alt="Vorschau"><button type="button" data-action="rm-image" aria-label="Foto entfernen">${I.x}</button></div>` : ""}
    <div class="composer-row">
      <label class="btn small">${I.camera}Foto<input type="file" accept="image/*" id="photo-input" hidden></label>
      <span class="grow"></span>
      <button class="btn primary small">Posten</button>
    </div>
  </form>`;
  h += posts.length
    ? `<div class="list" style="margin-top:12px">${posts.map(postCard).join("")}</div>`
    : `<div class="empty" style="margin-top:12px"><p>Noch nichts an der Pinnwand. Teilt Ideen, Links oder Fotos mit der Gruppe.</p></div>`;
  return h;
}

function postCard(p) {
  const me = keyOf(auth.name);
  const likes = Object.values(p.likes || {});
  return `<article class="card post ${p.pinned ? "pinned" : ""}" data-type="post" data-id="${p.id}">
    <div class="head">${avatar(p.createdBy)}<div class="who"><b>${esc(p.createdBy)}</b><span>${ago(p.createdAt)}</span></div>${p.pinned ? '<span class="tag todo">Angepinnt</span>' : ""}</div>
    ${p.text ? `<p class="text">${linkify(p.text)}</p>` : ""}
    ${p.imageId ? `<a class="photo" href="/api/img/${p.imageId}" target="_blank" rel="noopener"><img src="/api/img/${p.imageId}" alt="Foto von ${esc(p.createdBy)}" loading="lazy"></a>` : ""}
    <div class="post-foot">
      <button class="btn small like" data-action="like" aria-pressed="${!!p.likes?.[me]}" aria-label="Gefällt mir">${I.heart}${likes.length || ""}</button>
      <span class="likers">${likes.length ? esc(likes.join(", ")) + " gefällt das" : ""}</span>
      <button class="btn small ghost" data-action="pin-post">${p.pinned ? "Lösen" : "Anpinnen"}</button>
      <button class="btn small ghost danger" data-action="del-post">Löschen</button>
    </div>
  </article>`;
}

async function resizeImage(file, max = 1600) {
  let src = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!src) {
    src = await new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error("Bild konnte nicht gelesen werden.")); img.src = URL.createObjectURL(file); });
  }
  const s = Math.min(1, max / Math.max(src.width, src.height));
  const c = document.createElement("canvas");
  c.width = Math.round(src.width * s); c.height = Math.round(src.height * s);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, 0, 0, c.width, c.height);
  let q = 0.82, url = c.toDataURL("image/jpeg", q);
  while (url.length * 0.75 > 1.8 * 1024 * 1024 && q > 0.4) { q -= 0.12; url = c.toDataURL("image/jpeg", q); }
  return url;
}

$("#main").addEventListener("change", async (ev) => {
  if (ev.target.id !== "photo-input" || !ev.target.files[0]) return;
  try { composerImage = await resizeImage(ev.target.files[0]); render(); }
  catch (e) { toast(e.message); }
});

$("#main").addEventListener("submit", async (ev) => {
  if (ev.target.id !== "composer") return;
  ev.preventDefault();
  const f = ev.target;
  const text = f.text.value.trim();
  if (!text && !composerImage) return toast("Schreib etwas oder füge ein Foto hinzu.");
  const btn = f.querySelector("button.primary");
  btn.disabled = true; btn.textContent = "Wird gepostet…";
  try {
    upsert("posts", await api("POST", "posts", { text, image: composerImage }));
    composerImage = null; f.text.value = "";
    render();
  } catch (e) { toast(e.message); btn.disabled = false; btn.textContent = "Posten"; }
});

/* ---------- Kosten ---------- */
function renderCosts() {
  const me = keyOf(auth.name);
  const exps = [...state.expenses].sort((a, b) => (b.date + b.createdAt).localeCompare(a.date + a.createdAt));
  if (!exps.length) {
    return `<div class="empty"><p>Noch keine Ausgaben. Wer etwas für die Gruppe bezahlt hat, trägt es hier ein – die App rechnet aus, wer wem was schuldet.</p><button class="btn primary" data-action="new-expense">${I.plus}Erste Ausgabe eintragen</button></div>`;
  }
  const bals = balances().filter((b) => b.bal || b.paid || b.share).sort((a, b) => b.bal - a.bal);
  const myBal = bals.find((b) => keyOf(b.name) === me)?.bal || 0;
  const transfers = settleUp(bals);
  const total = exps.filter((x) => x.type !== "transfer").reduce((s, x) => s + x.amount, 0);
  const sign = (c) => (c > 0 ? "+" : "") + money(c);
  const cls = (c) => (c > 0 ? "pos" : c < 0 ? "neg" : "");

  let h = `<div class="card summary">
    <span class="lbl">Dein Stand</span>
    <span class="big ${cls(myBal)}">${sign(myBal)}</span>
    <span class="sub">${myBal > 0 ? "Du bekommst noch Geld." : myBal < 0 ? "Du musst noch etwas zahlen." : "Du bist quitt."} · Gesamt ausgegeben: ${money(total)}</span>
  </div>`;

  h += `<div class="section-title">So wird ausgeglichen</div>`;
  h += transfers.length
    ? `<div class="card rows">${transfers.map((t) => `<div class="row">
        <div class="transfer"><b>${esc(t.from)}</b><span class="arrow">→</span><b>${esc(t.to)}</b></div>
        <span class="amt">${money(t.amount)}</span>
        <button class="btn small" data-action="settle" data-from="${esc(t.from)}" data-to="${esc(t.to)}" data-amount="${t.amount}">Bezahlt</button>
      </div>`).join("")}</div>`
    : `<div class="card muted" style="text-align:center">Alle sind quitt.</div>`;

  h += `<div class="section-title">Salden</div><div class="card rows">${bals.map((b) => `<div class="row">
      ${avatar(b.name)}<div class="grow"><b>${esc(b.name)}${keyOf(b.name) === me ? " (du)" : ""}</b><span>bezahlt ${money(b.paid)} · Anteil ${money(b.share)}</span></div>
      <span class="amt ${cls(b.bal)}">${sign(b.bal)}</span></div>`).join("")}</div>`;

  const shown = showAllExpenses ? exps : exps.slice(0, 15);
  h += `<div class="section-title">Ausgaben (${exps.length})</div><div class="card rows">${shown.map(expenseRow).join("")}</div>`;
  if (exps.length > 15) h += `<div style="text-align:center;margin-top:8px"><button class="btn small ghost" data-action="toggle-expenses">${showAllExpenses ? "Weniger anzeigen" : "Alle anzeigen"}</button></div>`;
  return h;
}

function expenseRow(x) {
  const ev = x.eventId && state.events.find((e) => e.id === x.eventId);
  const n = x.participants.length;
  const isT = x.type === "transfer";
  const sub = isT
    ? `${esc(x.paidBy)} → ${esc(x.participants[0])} · ${fmtLong(x.date)}`
    : [`${esc(x.paidBy)} hat bezahlt`, n === 1 ? `für ${esc(x.participants[0])}` : `${n} Pers. à ${money(Math.round(x.amount / n))}`, fmtLong(x.date), ev ? esc(ev.title) : "", x.note ? esc(x.note) : ""].filter(Boolean).join(" · ");
  return `<div class="row" data-type="expense" data-id="${x.id}">
    ${isT ? `<span class="avatar" style="background:var(--yes)">✓</span>` : avatar(x.paidBy)}
    <div class="grow"><b>${esc(x.title)}</b><span>${sub}</span></div>
    <span class="amt">${money(x.amount)}</span>
    ${isT ? "" : `<button class="icon-btn" data-action="edit-expense" aria-label="Bearbeiten">${I.edit}</button>`}
    <button class="icon-btn" data-action="del-expense" aria-label="Löschen">${I.trash}</button>
  </div>`;
}

function eventCostLine(e) {
  const xs = state.expenses.filter((x) => x.eventId === e.id && x.type !== "transfer");
  const sum = xs.reduce((s, x) => s + x.amount, 0);
  return `<div class="event-cost"><span class="muted">${xs.length ? `Kosten: <b style="color:var(--text)">${money(sum)}</b> (${xs.length} ${xs.length === 1 ? "Ausgabe" : "Ausgaben"})` : "Noch keine Kosten erfasst"}</span><button class="btn small" data-action="event-expense">${I.plus}Ausgabe</button></div>`;
}

const parseAmount = (v) => {
  const s = String(v).trim().replace(/[\s€]/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
};

let editingExpenseId = null, splitSel = new Set(), splitExtra = [];
function peopleList() {
  const m = knownPeople();
  splitExtra.forEach((n) => n && !m.has(keyOf(n)) && m.set(keyOf(n), n));
  return [...m.values()].sort((a, b) => a.localeCompare(b, "de"));
}
function renderSplit(payer) {
  const people = peopleList();
  const f = $("#expense-form");
  const cur = payer || f.paidBy.value || auth.name;
  f.paidBy.innerHTML = people.map((n) => `<option>${esc(n)}</option>`).join("");
  f.paidBy.value = people.find((n) => keyOf(n) === keyOf(cur)) || auth.name;
  $("#split-people").innerHTML = people.map((n) => `<button type="button" data-n="${esc(n)}" aria-pressed="${splitSel.has(keyOf(n))}">${esc(n)}</button>`).join("");
  updateSplitInfo();
}
function updateSplitInfo() {
  const cents = parseAmount($("#expense-form").amount.value);
  const n = splitSel.size;
  $("#split-info").textContent = n ? `${n} ${n === 1 ? "Person" : "Personen"}${cents ? " · je " + money(Math.round(cents / n)) : ""}` : "Niemand ausgewählt";
}
function openExpenseDialog(x = null, prefill = {}) {
  editingExpenseId = x?.id || null;
  const f = $("#expense-form");
  f.reset();
  $("#expense-dlg-title").textContent = x ? "Ausgabe bearbeiten" : "Neue Ausgabe";
  const src = x || prefill;
  splitExtra = [...(src.participants || []), src.paidBy].filter(Boolean);
  splitSel = new Set((src.participants || [...knownPeople().values()]).map(keyOf));
  f.title.value = src.title || "";
  f.amount.value = src.amount ? (src.amount / 100).toFixed(2).replace(".", ",") : "";
  f.date.value = src.date || todayISO();
  f.note.value = src.note || "";
  const evs = [...state.events].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40);
  f.eventId.innerHTML = `<option value="">– keiner –</option>` + evs.map((e) => `<option value="${e.id}">${esc(fmt(e.date, { day: "numeric", month: "short" }))} · ${esc(e.title)}</option>`).join("");
  f.eventId.value = src.eventId || "";
  renderSplit(src.paidBy || auth.name);
  f.querySelector(".form-err").hidden = true;
  $("#expense-dlg").showModal();
  if (!x) f.title.focus();
}
$("#split-people").addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-n]"); if (!b) return;
  const k = keyOf(b.dataset.n);
  splitSel.has(k) ? splitSel.delete(k) : splitSel.add(k);
  b.setAttribute("aria-pressed", splitSel.has(k));
  updateSplitInfo();
});
$("#split-all").onclick = () => { splitSel = new Set(peopleList().map(keyOf)); renderSplit(); };
$("#split-none").onclick = () => { splitSel = new Set(); renderSplit(); };
const addSplitPerson = () => {
  const i = $("#split-new"); const n = i.value.trim(); if (!n) return;
  splitExtra.push(n); splitSel.add(keyOf(n)); i.value = ""; renderSplit();
};
$("#split-add").onclick = addSplitPerson;
$("#split-new").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); addSplitPerson(); } });
$("#expense-form").amount.addEventListener("input", updateSplitInfo);
$("#expense-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  const err = f.querySelector(".form-err");
  const body = {
    title: f.title.value, amount: parseAmount(f.amount.value), paidBy: f.paidBy.value,
    participants: peopleList().filter((n) => splitSel.has(keyOf(n))),
    date: f.date.value, eventId: f.eventId.value, note: f.note.value,
  };
  if (!body.amount) { err.textContent = "Bitte einen gültigen Betrag eingeben, z. B. 12,50."; err.hidden = false; return; }
  if (!body.participants.length) { err.textContent = "Bitte mindestens eine Person auswählen."; err.hidden = false; return; }
  try {
    const item = editingExpenseId ? await api("PUT", `expenses/${editingExpenseId}`, body) : await api("POST", "expenses", body);
    upsert("expenses", item);
    $("#expense-dlg").close();
    render();
    toast(editingExpenseId ? "Ausgabe aktualisiert" : "Ausgabe gespeichert");
  } catch (e) { err.textContent = e.message; err.hidden = false; }
});

/* ---------- Aktionen für Pinnwand & Kosten ---------- */
$("#main").addEventListener("click", (ev) => {
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  const id = el.closest("[data-id]")?.dataset.id;
  const post = state.posts.find((x) => x.id === id);
  const x = state.expenses.find((y) => y.id === id);
  switch (el.dataset.action) {
    case "rm-image": composerImage = null; return render();
    case "like": return run(async () => upsert("posts", await api("POST", `posts/${id}/like`)));
    case "pin-post": return run(async () => upsert("posts", await api("POST", `posts/${id}/pin`, { pinned: !post.pinned })));
    case "del-post":
      if (!confirm("Beitrag wirklich löschen?")) return;
      return run(async () => { await api("DELETE", `posts/${id}`); state.posts = state.posts.filter((p) => p.id !== id); });
    case "new-expense": return openExpenseDialog();
    case "edit-expense": return openExpenseDialog(x);
    case "toggle-expenses": showAllExpenses = !showAllExpenses; return render();
    case "del-expense":
      if (!confirm(`„${x.title}“ (${money(x.amount)}) wirklich löschen?`)) return;
      return run(async () => { await api("DELETE", `expenses/${id}`); state.expenses = state.expenses.filter((y) => y.id !== id); });
    case "settle": {
      const { from, to, amount } = el.dataset;
      if (!confirm(`Bestätigen: ${from} hat ${to} ${money(+amount)} gezahlt?`)) return;
      return run(async () => {
        upsert("expenses", await api("POST", "expenses", { type: "transfer", title: "Ausgleich", amount: +amount, paidBy: from, participants: [to], date: todayISO() }));
        toast("Ausgleich eingetragen");
      });
    }
    case "event-expense": {
      const e = state.events.find((y) => y.id === id);
      const going = Object.values(e.rsvps || {}).filter((r) => r.status === "yes").map((r) => r.name);
      return openExpenseDialog(null, { eventId: e.id, title: e.title, date: e.date <= todayISO() ? e.date : todayISO(), participants: going.length ? going : undefined });
    }
  }
});

/* ---------- App-Installation (PWA) ---------- */
let installEvt = null;
const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
function updateInstallBanner() {
  $("#install").hidden = isStandalone() || !!store.get("go-install-dismissed") || !(installEvt || isIOS);
  if (isIOS) $("#install-text").textContent = "Über „Teilen → Zum Home-Bildschirm“ – öffnet dann wie eine App.";
}
addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); installEvt = e; updateInstallBanner(); });
addEventListener("appinstalled", () => { installEvt = null; $("#install").hidden = true; toast("App installiert"); });
$("#install-btn").onclick = async () => {
  if (installEvt) { installEvt.prompt(); await installEvt.userChoice.catch(() => {}); installEvt = null; updateInstallBanner(); }
  else $("#ios-dlg").showModal();
};
$("#install-close").onclick = () => { store.set("go-install-dismissed", true); $("#install").hidden = true; };
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));

/* ---------- Auto-Aktualisierung ---------- */
setInterval(() => {
  if (!auth?.pw || document.hidden || document.querySelector("dialog[open]")) return;
  const a = document.activeElement;
  if (a && ["INPUT", "TEXTAREA"].includes(a.tagName) && a.value) return;
  refresh();
}, 20000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && auth?.pw) refresh(); });

/* ---------- Start ---------- */
if (auth?.pw) startApp(); else showLogin();
