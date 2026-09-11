/* Gruppenorganisator – Chat, Stories, Gruppenarchiv & Profile
   Nutzt Helfer aus app.js ($, esc, api, auth, state, render, avatar, …). */

/* ---------- Zustand ---------- */
const chat = { messages: [], loaded: false, loading: false, hasMore: false, since: "", replyTo: null, attach: null, menu: null, sending: false, firstRender: true, stickBottom: true };
const CHUNK = 3 * 1024 * 1024;
const MAX_VIDEO = 60 * 1024 * 1024;
const chatSeenKey = () => "go-chat-seen:" + auth.slug;
const imgUrl = (id) => `/api/img/${encodeURIComponent(auth.slug)}/${id}`;
const fmtClock = (iso) => new Date(iso).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit" });
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const mb = (b) => (b / 1048576).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " MB";
const localDay = (iso) => new Date(iso).toLocaleDateString("sv-SE");
const I2 = {
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h18v4H3zM5 11v9h14v-9M10 15h4"/></svg>',
  dl: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
};

function chatReset() {
  Object.assign(chat, { messages: [], loaded: false, hasMore: false, since: "", replyTo: null, attach: null, menu: null, firstRender: true, stickBottom: true });
  updateReplyBar(); updateAttachBar();
}

/* ---------- Laden & Abgleichen ---------- */
function mergeMessages(list) {
  const map = new Map(chat.messages.map((m) => [m.id, m]));
  let changed = false;
  for (const m of list) {
    const old = map.get(m.id);
    if (!old || JSON.stringify(old) !== JSON.stringify(m)) { map.set(m.id, m); changed = true; }
  }
  if (changed) chat.messages = [...map.values()].sort((a, b) => a.id.localeCompare(b.id));
  return changed;
}

async function chatLoad({ older = false } = {}) {
  if (!auth?.pw || chat.loading) return;
  chat.loading = true;
  const slug = auth.slug;
  try {
    let q;
    if (older) q = "before=" + encodeURIComponent(chat.messages.find((m) => !m.pending)?.id || "");
    else if (chat.loaded) {
      // 15 s Überlappung, damit gleichzeitig gesendete Nachrichten nicht verloren gehen
      const last = [...chat.messages].reverse().find((m) => !m.pending);
      const lastMs = last ? parseInt(last.id.slice(0, 14), 10) : 0;
      q = "after=" + String(Math.max(0, lastMs - 15000)).padStart(14, "0") + "&since=" + encodeURIComponent(chat.since);
    } else q = "limit=120";
    const r = await api("GET", "chat?" + q);
    if (auth?.slug !== slug) return;
    let changed = mergeMessages([...r.messages, ...(r.changed || [])]);
    if (r.deleted?.length) {
      const n = chat.messages.length;
      chat.messages = chat.messages.filter((m) => !r.deleted.includes(m.id));
      changed ||= n !== chat.messages.length;
    }
    if (older || !chat.loaded) chat.hasMore = r.hasMore;
    chat.since = r.serverTime;
    const first = !chat.loaded;
    chat.loaded = true;
    if (first && !store.get(chatSeenKey())) chatMarkSeen(true);
    if (first || changed || older) {
      if (older) keepScroll(() => render()); else render();
    }
  } catch (e) {
    if (!chat.loaded) toast(e.message);
  } finally { chat.loading = false; }
}

function chatStart() { chatLoad(); }

let chatTick = 0;
setInterval(() => {
  if (!auth?.pw || document.hidden || $("#app").hidden) return;
  chatTick++;
  // Im Chat alle 5 s, sonst alle 30 s (für die Zahl am Chat-Symbol)
  if (tab === "board" || chatTick % 6 === 0) chatLoad();
}, 5000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && auth?.pw) chatLoad(); });

/* ---------- Ungelesen ---------- */
function chatMarkSeen(force = false) {
  if (!auth || (!force && (document.hidden || tab !== "board"))) return;
  const last = [...chat.messages].reverse().find((m) => !m.pending);
  if (last && last.id > (store.get(chatSeenKey()) || "")) store.set(chatSeenKey(), last.id);
}
function chatUnread() {
  const seen = store.get(chatSeenKey()) || "";
  const me = keyOf(auth.name);
  return seen ? chat.messages.filter((m) => !m.pending && m.id > seen && keyOf(m.createdBy) !== me).length : 0;
}

/* ---------- Scrollen ---------- */
const chatAtBottom = () => innerHeight + scrollY >= document.documentElement.scrollHeight - 140;
const scrollBottom = () => scrollTo(0, document.documentElement.scrollHeight);
function keepScroll(fn) {
  const h = document.documentElement.scrollHeight, y = scrollY;
  fn();
  scrollTo(0, y + document.documentElement.scrollHeight - h);
}
addEventListener("scroll", () => { if (tab === "board") chat.stickBottom = chatAtBottom(); }, { passive: true });
function chatAfterRender(wasAtBottom) {
  if (!chat.loaded) return;
  if (chat.firstRender || wasAtBottom) { scrollBottom(); chat.stickBottom = true; }
  chat.firstRender = false;
  // Bilder laden nach – dann unten bleiben
  document.querySelectorAll("#msgs img").forEach((img) => {
    if (!img.complete) img.addEventListener("load", () => { if (chat.stickBottom) scrollBottom(); }, { once: true });
  });
  measureBars();
}
function jumpTo(id) {
  const el = document.getElementById("m-" + id);
  if (!el) return toast(chat.hasMore ? "Nachricht ist älter – lade ältere Nachrichten." : "Nachricht nicht gefunden.");
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash");
}

/* ---------- Darstellung ---------- */
function dayLabel(iso) {
  const d = localDay(iso);
  if (d === todayISO()) return "Heute";
  if (d === new Date(Date.now() - 864e5).toLocaleDateString("sv-SE")) return "Gestern";
  return fmtLong(d);
}
const msgPreview = (m) => (m?.text || (m?.media ? "🎬 Video" : m?.imageId || m?.localImg ? "📷 Foto" : "")).slice(0, 120);

function renderChat() {
  let h = storiesBar();
  const pinned = chat.messages.filter((m) => m.pinned);
  if (pinned.length) {
    const p = pinned.at(-1);
    h += `<button class="pinned-bar" data-action="c-jump" data-mid="${p.id}">${I.tack}<span><b>${esc(p.createdBy)}:</b> ${esc(msgPreview(p))}</span>${pinned.length > 1 ? `<em>+${pinned.length - 1}</em>` : ""}</button>`;
  }
  if (!chat.loaded) return h + '<div class="loading">Lade Chat…</div>';
  const me = keyOf(auth.name);
  h += '<div class="msgs" id="msgs">';
  if (chat.hasMore) h += `<div class="older"><button class="btn small ghost" data-action="c-older">Ältere Nachrichten laden</button></div>`;
  if (!chat.messages.length) h += `<div class="empty chat-empty"><p>Noch keine Nachrichten – sag Hallo! 👋</p></div>`;
  let prev = null;
  for (const m of chat.messages) { h += msgHtml(m, prev, me); prev = m; }
  return h + "</div>";
}

function msgHtml(m, prev, me) {
  let h = "";
  const newDay = !prev || localDay(prev.createdAt) !== localDay(m.createdAt);
  if (newDay) h += `<div class="day-sep"><span>${dayLabel(m.createdAt)}</span></div>`;
  const mine = keyOf(m.createdBy) === me;
  const cont = !newDay && prev && keyOf(prev.createdBy) === keyOf(m.createdBy) && new Date(m.createdAt) - new Date(prev.createdAt) < 5 * 60e3;
  const reply = m.replyTo ? chat.messages.find((x) => x.id === m.replyTo) : null;
  const hasMedia = m.imageId || m.media || m.localImg;
  const onlyMedia = !m.text && hasMedia && !m.replyTo;
  const r = reactionsOf(m);
  const chips = EMOJIS.filter((e) => r[e] && Object.keys(r[e]).length).map((e) => {
    const who = Object.values(r[e]);
    return `<button class="react ${r[e][me] ? "on" : ""}" data-action="c-react" data-mid="${m.id}" data-emoji="${e}" title="${esc(who.join(", "))}" aria-label="${e} von ${esc(who.join(", "))}">${e}<span>${who.length}</span></button>`;
  }).join("");
  const nameColor = `hsl(${hue(m.createdBy)} 55% 45%)`;
  h += `<div class="msg ${mine ? "mine" : ""} ${cont ? "cont" : ""} ${m.pinned ? "is-pinned" : ""} ${m.pending ? "pending" : ""}" id="m-${m.id}">
    ${mine ? "" : cont ? '<span class="avatar-gap"></span>' : `<button class="msg-av" data-action="profile" data-name="${esc(m.createdBy)}" aria-label="Profil von ${esc(m.createdBy)}">${avatar(m.createdBy)}</button>`}
    <div class="msg-col">
      ${!mine && !cont ? `<button class="msg-name" style="color:${nameColor}" data-action="profile" data-name="${esc(m.createdBy)}">${esc(m.createdBy)}</button>` : ""}
      <div class="bubble ${onlyMedia ? "media-only" : ""}" data-action="c-menu" data-mid="${m.id}">
        ${m.replyTo ? `<button class="quote" data-action="c-jump" data-mid="${m.replyTo}"><b>${esc(reply?.createdBy || "Nachricht")}</b><span>${esc(reply ? msgPreview(reply) : "ältere Nachricht")}</span></button>` : ""}
        ${m.localImg ? `<span class="msg-media"><img src="${m.localImg}" alt=""></span>` : ""}
        ${m.imageId ? `<button class="msg-media" data-action="open-media" data-mid="${m.id}"><img src="${imgUrl(m.imageId)}" alt="Foto von ${esc(m.createdBy)}" loading="lazy"></button>` : ""}
        ${m.media ? `<button class="msg-media video" data-action="open-media" data-mid="${m.id}">${m.thumbId ? `<img src="${imgUrl(m.thumbId)}" alt="" loading="lazy">` : '<span class="vid-ph"></span>'}<span class="play">▶</span>${m.media.duration ? `<span class="dur">${fmtDur(m.media.duration)}</span>` : ""}</button>` : ""}
        ${m.localVideo ? `<span class="msg-media video"><span class="vid-ph"></span><span class="play">⏳</span></span>` : ""}
        ${m.text ? `<p>${linkify(m.text)}</p>` : ""}
        <span class="meta">${m.pinned ? "📌 " : ""}${m.pending ? `sendet…${m.progress ? " " + Math.round(m.progress * 100) + " %" : ""}` : fmtClock(m.createdAt)}</span>
      </div>
      ${chips ? `<div class="reacts small">${chips}</div>` : ""}
      ${chat.menu === m.id && !m.pending ? msgMenu(m) : ""}
    </div>
  </div>`;
  return h;
}

function msgMenu(m) {
  return `<div class="msg-menu">
    <div class="quick">${EMOJIS.map((e) => `<button data-action="c-react" data-mid="${m.id}" data-emoji="${e}" aria-label="${e}">${e}</button>`).join("")}</div>
    <div class="acts">
      <button data-action="c-reply" data-mid="${m.id}">↩ Antworten</button>
      <button data-action="c-pin" data-mid="${m.id}">${I.tack}${m.pinned ? "Lösen" : "Anpinnen"}</button>
      ${m.text ? `<button data-action="c-copy" data-mid="${m.id}">Kopieren</button>` : ""}
      ${m.imageId || m.media ? `<button data-action="c-dl" data-mid="${m.id}">${I2.dl}Speichern</button>` : ""}
      ${canManage(m) ? `<button class="danger" data-action="c-del" data-mid="${m.id}">Löschen</button>` : ""}
    </div>
  </div>`;
}

/* ---------- Eingabe ---------- */
const chatInput = $("#chat-input");
function autoGrow() {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight + 2, 140) + "px";
  measureBars();
}
chatInput.addEventListener("input", autoGrow);
chatInput.addEventListener("keydown", (e) => {
  // Am Computer: Enter sendet, Shift+Enter = neue Zeile. Am Handy: Senden-Knopf.
  if (e.key === "Enter" && !e.shiftKey && matchMedia("(pointer: fine)").matches && $("#mention-box").hidden) {
    e.preventDefault(); sendChat();
  }
});
$("#chat-composer").addEventListener("submit", (e) => { e.preventDefault(); sendChat(); });
$("#reply-cancel").onclick = () => { chat.replyTo = null; updateReplyBar(); };

function updateReplyBar() {
  const r = chat.replyTo;
  $("#reply-bar").hidden = !r;
  if (r) { $("#reply-name").textContent = "Antwort an " + r.createdBy; $("#reply-text").textContent = msgPreview(r); }
  measureBars();
}
function updateAttachBar() {
  const a = chat.attach, bar = $("#attach-bar");
  bar.hidden = !a;
  if (a) {
    bar.innerHTML = `${a.kind === "image" ? `<img src="${a.dataUrl}" alt="">` : a.thumb ? `<img src="${a.thumb}" alt="">` : '<span class="vid-ph small"></span>'}
      <span>${a.kind === "image" ? "Foto" : `Video · ${mb(a.size)}${a.duration ? " · " + fmtDur(a.duration) : ""}`}</span>
      <button type="button" class="icon-btn" id="attach-remove" aria-label="Anhang entfernen">✕</button>`;
    $("#attach-remove").onclick = () => { chat.attach = null; updateAttachBar(); };
  }
  measureBars();
}
$("#chat-file").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; ev.target.value = "";
  if (!f) return;
  try { chat.attach = await prepareMedia(f); updateAttachBar(); chatInput.focus(); }
  catch (e) { toast(e.message); }
});

async function sendChat() {
  const text = chatInput.value.trim();
  const att = chat.attach;
  if ((!text && !att) || chat.sending) return;
  chat.sending = true;
  const replyTo = chat.replyTo;
  const tmp = { id: "99999999999999-p" + Math.random().toString(36).slice(2, 8), text, createdBy: auth.name, createdAt: new Date().toISOString(), pending: true, replyTo: replyTo?.id, reactions: {} };
  if (att?.kind === "image") tmp.localImg = att.dataUrl;
  if (att?.kind === "video") tmp.localVideo = true;
  chatInput.value = ""; autoGrow();
  chat.replyTo = null; chat.attach = null; updateReplyBar(); updateAttachBar();
  chat.messages.push(tmp);
  render(); scrollBottom();
  try {
    const body = { text, replyTo: replyTo?.id };
    if (att?.kind === "image") body.image = att.dataUrl;
    if (att?.kind === "video") {
      const up = await uploadVideo(att.file, (p) => {
        tmp.progress = p;
        const meta = document.querySelector(`#m-${tmp.id} .meta`);
        if (meta) meta.textContent = `lädt hoch… ${Math.round(p * 100)} %`;
      });
      body.media = { id: up.id, duration: att.duration };
      body.thumb = att.thumb;
    }
    const m = await api("POST", "chat", body);
    chat.messages = chat.messages.filter((x) => x !== tmp);
    mergeMessages([m]);
    chatMarkSeen();
    render(); scrollBottom();
  } catch (e) {
    chat.messages = chat.messages.filter((x) => x !== tmp);
    render();
    chatInput.value = text; autoGrow();
    chat.attach = att; chat.replyTo = replyTo; updateAttachBar(); updateReplyBar();
    toast(e.message);
  } finally { chat.sending = false; }
}

/* ---------- Aktionen im Chat ---------- */
async function chatAct(id, action, body) {
  chat.menu = null;
  await run(async () => mergeMessages([await api("POST", `chat/${id}/${action}`, body)]));
}
$("#main").addEventListener("click", (ev) => {
  if (ev.target.closest("a")) return; // Links normal öffnen
  const el = ev.target.closest("[data-action]");
  if (!el) return;
  const id = el.dataset.mid;
  const m = id && chat.messages.find((x) => x.id === id);
  switch (el.dataset.action) {
    case "c-menu": if (m?.pending) return; chat.menu = chat.menu === id ? null : id; return render();
    case "c-react": return chatAct(id, "react", { emoji: el.dataset.emoji });
    case "c-reply": chat.menu = null; chat.replyTo = m; updateReplyBar(); render(); chatInput.focus(); return;
    case "c-pin": return chatAct(id, "pin", { pinned: !m.pinned });
    case "c-copy":
      chat.menu = null; render();
      return navigator.clipboard?.writeText(m.text).then(() => toast("Kopiert")).catch(() => toast("Kopieren nicht möglich"));
    case "c-dl": chat.menu = null; render(); return downloadItem(msgItem(m));
    case "c-del":
      if (!confirm("Nachricht für alle löschen?")) return;
      chat.menu = null;
      return run(async () => { await api("DELETE", `chat/${id}`); chat.messages = chat.messages.filter((x) => x.id !== id); });
    case "c-jump": return jumpTo(id);
    case "c-older": return chatLoad({ older: true });
    case "open-media": {
      const items = chat.messages.filter((x) => (x.imageId || x.media) && !x.pending).map(msgItem);
      return openViewer(items, Math.max(0, items.findIndex((x) => x.msg.id === id)), "media");
    }
    case "profile": return openProfile(el.dataset.name);
    case "story-add": return $("#story-file").click();
    case "story-open": return openStories(el.dataset.name);
    case "archive-open": return openArchive();
  }
});

/* ---------- Medien vorbereiten & hochladen ---------- */
const isVideoFile = (f) => f.type.startsWith("video/") || /\.(mp4|mov|webm|m4v|3gp)$/i.test(f.name);
const mimeOf = (f) => f.type || ({ mov: "video/quicktime", webm: "video/webm", m4v: "video/x-m4v", "3gp": "video/3gpp" }[f.name.split(".").pop().toLowerCase()] || "video/mp4");

async function prepareMedia(file, maxImg = 1600) {
  if (isVideoFile(file)) {
    if (file.size > MAX_VIDEO) throw new Error(`Video ist zu groß (${mb(file.size)}). Maximal ${MAX_VIDEO / 1048576} MB – bitte kürzer aufnehmen oder zuschneiden.`);
    const { thumb, duration } = await videoInfo(file);
    return { kind: "video", file, thumb, duration, size: file.size, url: URL.createObjectURL(file) };
  }
  if (!file.type.startsWith("image/") && !/\.(jpe?g|png|gif|webp|heic|heif)$/i.test(file.name)) throw new Error("Bitte ein Foto oder Video auswählen.");
  return { kind: "image", dataUrl: await resizeImage(file, maxImg) };
}

function videoInfo(file) {
  return new Promise((resolve) => {
    const v = document.createElement("video");
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (thumb) => {
      if (done) return;
      done = true;
      const duration = isFinite(v.duration) ? v.duration : 0;
      URL.revokeObjectURL(url);
      resolve({ thumb, duration });
    };
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = url;
    v.onloadedmetadata = () => { try { v.currentTime = Math.min(0.3, (v.duration || 1) / 3); } catch { finish(null); } };
    v.onseeked = () => {
      try {
        const s = Math.min(1, 480 / Math.max(v.videoWidth, v.videoHeight));
        const c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(v.videoWidth * s)); c.height = Math.max(1, Math.round(v.videoHeight * s));
        c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
        finish(c.toDataURL("image/jpeg", 0.72));
      } catch { finish(null); }
    };
    v.onerror = () => finish(null);
    setTimeout(() => finish(null), 8000);
  });
}

async function apiRaw(method, path, blob) {
  const r = await fetch("/api/" + path, {
    method,
    headers: { "content-type": "application/octet-stream", "x-group": auth.slug, "x-group-password": auth.pw, "x-user-name": encodeURIComponent(auth.name) },
    body: blob,
  }).catch(() => { throw new Error("Upload unterbrochen – bitte Verbindung prüfen."); });
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || "Upload-Fehler " + r.status); }
}

async function uploadVideo(file, onProgress) {
  const { id, chunks } = await api("POST", "media", { mime: mimeOf(file), size: file.size });
  let next = 0, done = 0;
  const put = async (i) => {
    for (let attempt = 0; ; attempt++) {
      try { await apiRaw("PUT", `media/${id}/${i}`, file.slice(i * CHUNK, Math.min(file.size, (i + 1) * CHUNK))); break; }
      catch (e) { if (attempt >= 2) throw e; await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); }
    }
    onProgress?.(++done / chunks);
  };
  const worker = async () => { while (next < chunks) await put(next++); };
  await Promise.all([worker(), worker()]);
  return { id };
}

// Videos werden in Stücken geladen und im Browser zusammengesetzt
const videoCache = new Map();
async function videoBlob(media, onProgress) {
  if (videoCache.has(media.id)) return videoCache.get(media.id);
  const parts = new Array(media.chunks);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < media.chunks) {
      const i = next++;
      const r = await fetch(`/api/media/${encodeURIComponent(auth.slug)}/${media.id}/${i}`);
      if (!r.ok) throw new Error("Video ist nicht mehr verfügbar.");
      parts[i] = await r.blob();
      onProgress?.(++done / media.chunks);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  const blob = new Blob(parts, { type: media.mime || "video/mp4" });
  const entry = { blob, url: URL.createObjectURL(blob) };
  videoCache.set(media.id, entry);
  if (videoCache.size > 6) { const [k, v] = videoCache.entries().next().value; URL.revokeObjectURL(v.url); videoCache.delete(k); }
  return entry;
}

/* ---------- Einheitliche Medien-Einträge (für Ansicht, Archiv, Profil) ---------- */
const msgItem = (m) => ({ kind: m.media ? "video" : "image", imageId: m.imageId, media: m.media, thumbId: m.thumbId, caption: m.text, createdBy: m.createdBy, createdAt: m.createdAt, msg: m });
const storyItem = (s) => ({ kind: s.type, imageId: s.imageId, media: s.media, thumbId: s.thumbId, caption: s.caption, createdBy: s.createdBy, createdAt: s.createdAt, story: s });
const thumbOf = (it) => (it.kind === "image" ? imgUrl(it.imageId) : it.thumbId ? imgUrl(it.thumbId) : "");
const extOf = (mime) => ({ "video/quicktime": "mov", "video/webm": "webm", "video/3gpp": "3gp" }[mime] || "mp4");

async function downloadItem(it) {
  try {
    toast("Wird gespeichert…");
    const blob = it.kind === "image" ? await (await fetch(imgUrl(it.imageId))).blob() : (await videoBlob(it.media)).blob;
    const ext = it.kind === "image" ? "jpg" : extOf(it.media.mime);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${slugify(auth.groupName || auth.slug)}-${slugify(it.createdBy)}-${localDay(it.createdAt)}.${ext}`;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  } catch (e) { toast(e.message || "Speichern fehlgeschlagen"); }
}

/* ---------- Stories ---------- */
const localSeen = new Set();
function storyGroups() {
  const now = new Date().toISOString(), me = keyOf(auth.name);
  const active = (state.stories || []).filter((s) => s.expiresAt > now).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const seen = (s) => keyOf(s.createdBy) === me || !!s.views?.[me] || localSeen.has(s.id);
  const by = new Map();
  for (const s of active) {
    const k = keyOf(s.createdBy);
    if (!by.has(k)) by.set(k, { name: s.createdBy, items: [] });
    by.get(k).items.push(s);
  }
  const groups = [...by.values()].map((g) => ({ ...g, unseen: g.items.some((s) => !seen(s)), latest: g.items.at(-1).createdAt }));
  const mine = groups.find((g) => keyOf(g.name) === me);
  const others = groups.filter((g) => g !== mine).sort((a, b) => b.unseen - a.unseen || b.latest.localeCompare(a.latest));
  return { mine, others, seen };
}
function storiesBar() {
  const { mine, others } = storyGroups();
  const archived = (state.stories || []).filter((s) => s.archived).length;
  return `<div class="stories" role="list">
    <button class="story-circle" data-action="${mine ? "story-open" : "story-add"}" data-name="${esc(auth.name)}" role="listitem">
      <span class="ring ${mine ? "seen" : "none"}">${avatar(auth.name, "lg")}</span>${mine ? "" : '<i class="plus">+</i>'}<small>${mine ? "Du" : "Story +"}</small></button>
    ${mine ? `<button class="story-circle" data-action="story-add" role="listitem" aria-label="Weitere Story"><span class="ring none"><span class="avatar lg soft">${I.plus}</span></span><small>Neu</small></button>` : ""}
    ${others.map((g) => `<button class="story-circle" data-action="story-open" data-name="${esc(g.name)}" role="listitem"><span class="ring ${g.unseen ? "new" : "seen"}">${avatar(g.name, "lg")}</span><small>${esc(g.name)}</small></button>`).join("")}
    <button class="story-circle" data-action="archive-open" role="listitem"><span class="ring none"><span class="avatar lg soft">${I2.box}</span></span><small>Archiv${archived ? ` (${archived})` : ""}</small></button>
  </div>`;
}
function openStories(name) {
  const { mine, others, seen } = storyGroups();
  const g = [mine, ...others].find((x) => x && keyOf(x.name) === keyOf(name));
  if (!g) return;
  const start = Math.max(0, g.items.findIndex((s) => !seen(s)));
  openViewer(g.items.map(storyItem), start, "story");
}

let storyDraft = null;
$("#story-file").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; ev.target.value = "";
  if (!f) return;
  try { storyDraft = await prepareMedia(f, 1440); } catch (e) { return toast(e.message); }
  $("#story-preview").innerHTML = storyDraft.kind === "image"
    ? `<img src="${storyDraft.dataUrl}" alt="Vorschau">`
    : `<video src="${storyDraft.url}" controls playsinline muted></video>`;
  const form = $("#story-form");
  form.reset();
  form.querySelector(".form-err").hidden = true;
  $("#story-progress").hidden = true;
  form.querySelector("button.primary").disabled = false;
  $("#story-dlg").showModal();
});
$("#story-dlg").addEventListener("close", () => { if (storyDraft?.url) URL.revokeObjectURL(storyDraft.url); });
$("#story-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const f = ev.target, err = f.querySelector(".form-err"), btn = f.querySelector("button.primary");
  if (!storyDraft) return;
  btn.disabled = true; err.hidden = true;
  const bar = $("#story-progress");
  try {
    let s;
    if (storyDraft.kind === "image") {
      s = await api("POST", "stories", { type: "image", image: storyDraft.dataUrl, caption: f.caption.value });
    } else {
      bar.hidden = false; bar.firstElementChild.style.width = "0%";
      const up = await uploadVideo(storyDraft.file, (p) => (bar.firstElementChild.style.width = Math.round(p * 100) + "%"));
      s = await api("POST", "stories", { type: "video", media: { id: up.id, duration: storyDraft.duration }, thumb: storyDraft.thumb, caption: f.caption.value });
    }
    state.stories = [...(state.stories || []), s];
    $("#story-dlg").close();
    storyDraft = null;
    render();
    toast("Story geteilt – 24 Stunden sichtbar");
  } catch (e) { err.textContent = e.message; err.hidden = false; btn.disabled = false; }
});

/* ---------- Vollbild-Ansicht ---------- */
const viewer = { items: [], index: 0, mode: "media", timer: null, dlg: $("#viewer") };
function openViewer(items, index, mode) {
  if (!items.length) return;
  Object.assign(viewer, { items, index, mode });
  viewer.dlg.classList.toggle("zones", mode === "story");
  if (!viewer.dlg.open) viewer.dlg.showModal();
  showItem();
}
function closeViewer() {
  clearTimeout(viewer.timer);
  viewer.dlg.querySelector("video")?.pause();
  $("#v-stage").innerHTML = "";
  if (viewer.dlg.open) viewer.dlg.close();
}
viewer.dlg.addEventListener("close", () => { clearTimeout(viewer.timer); $("#v-stage").innerHTML = ""; render(); if ($("#archive-dlg").open) renderArchive(); if ($("#profile-dlg").open) renderProfile(); });
function stepViewer(d) {
  const i = viewer.index + d;
  if (i < 0) return;
  if (i >= viewer.items.length) return closeViewer();
  viewer.index = i; showItem();
}
$("#v-next").onclick = () => stepViewer(1);
$("#v-prev").onclick = () => stepViewer(-1);
$("#v-close").onclick = closeViewer;
viewer.dlg.addEventListener("keydown", (e) => { if (e.key === "ArrowRight") stepViewer(1); if (e.key === "ArrowLeft") stepViewer(-1); });
$("#v-who").onclick = () => { const n = viewer.items[viewer.index]?.createdBy; closeViewer(); if (n) openProfile(n); };

function showItem() {
  clearTimeout(viewer.timer);
  const it = viewer.items[viewer.index];
  if (!it) return closeViewer();
  const me = keyOf(auth.name), story = it.story, mine = keyOf(it.createdBy) === me;
  const isStory = viewer.mode === "story";
  const dur = it.kind === "video" ? Math.max(3, it.media?.duration || 15) : 6;
  $("#v-bars").innerHTML = isStory ? viewer.items.map((_, i) => `<i class="${i < viewer.index ? "done" : i === viewer.index ? "cur" : ""}" style="--dur:${dur}s"><b></b></i>`).join("") : "";
  $("#v-bars").classList.remove("paused");
  $("#v-who").innerHTML = `${avatar(it.createdBy)}<span>${esc(it.createdBy)}<small> · ${ago(it.createdAt)}</small></span>`;
  $("#v-caption").innerHTML = it.caption ? linkify(it.caption) : "";
  $("#v-prev").hidden = viewer.index === 0 && !isStory;
  $("#v-next").hidden = viewer.index === viewer.items.length - 1 && !isStory;
  const stage = $("#v-stage");
  if (it.kind === "image") {
    stage.innerHTML = `<img src="${imgUrl(it.imageId)}" alt="Foto von ${esc(it.createdBy)}">`;
    if (isStory) viewer.timer = setTimeout(() => stepViewer(1), dur * 1000);
  } else {
    stage.innerHTML = `${it.thumbId ? `<img class="v-poster" src="${imgUrl(it.thumbId)}" alt="">` : ""}<div class="v-loading">Video lädt… <span>0 %</span></div>`;
    $("#v-bars").classList.add("paused");
    const idx = viewer.index;
    videoBlob(it.media, (p) => { const s = stage.querySelector(".v-loading span"); if (s) s.textContent = Math.round(p * 100) + " %"; })
      .then(({ url }) => {
        if (viewer.index !== idx || !viewer.dlg.open) return;
        stage.innerHTML = `<video src="${url}" playsinline ${isStory ? "" : "controls"} autoplay></video>`;
        const v = stage.querySelector("video");
        v.play().catch(() => { v.muted = true; v.controls = true; v.play().catch(() => {}); });
        if (isStory) {
          v.addEventListener("playing", () => { const b = $("#v-bars .cur"); if (b) b.style.setProperty("--dur", (v.duration || dur) + "s"); $("#v-bars").classList.remove("paused"); }, { once: true });
          v.addEventListener("ended", () => stepViewer(1));
        }
      })
      .catch((e) => { stage.innerHTML = `<div class="v-loading">${esc(e.message)}</div>`; });
  }
  // Aktionen
  const acts = [`<button data-v="dl">${I2.dl} Speichern</button>`];
  if (story) {
    acts.push(story.archived
      ? `<button data-v="unarchive" class="on" ${canManage(story) ? "" : "disabled"}>✓ Im Archiv</button>`
      : `<button data-v="archive">${I2.box} Ins Archiv</button>`);
    if (mine) acts.push(`<button data-v="views">${I2.eye} ${Object.keys(story.views || {}).length}</button>`);
    if (canManage(story)) acts.push(`<button data-v="del">${I.trash}</button>`);
    if (!mine && !story.views?.[me] && !localSeen.has(story.id)) {
      localSeen.add(story.id);
      api("POST", `stories/${story.id}/view`).then((s) => updateStory(s)).catch(() => {});
    }
  } else if (it.msg && canManage(it.msg)) acts.push(`<button data-v="del">${I.trash}</button>`);
  $("#v-actions").innerHTML = acts.join("") + '<div class="v-views" id="v-views" hidden></div>';
}
function updateStory(s) {
  const i = (state.stories || []).findIndex((x) => x.id === s.id);
  if (i >= 0) state.stories[i] = s; else state.stories.push(s);
  viewer.items.forEach((it) => { if (it.story?.id === s.id) it.story = s; });
}
$("#v-actions").addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-v]"); if (!b) return;
  const it = viewer.items[viewer.index];
  const story = it.story;
  switch (b.dataset.v) {
    case "dl": return downloadItem(it);
    case "archive":
    case "unarchive": {
      const archive = b.dataset.v === "archive";
      if (!archive && !confirm(new Date(story.expiresAt) < new Date() ? "Aus dem Archiv nehmen? Die Story ist abgelaufen und wird dann gelöscht." : "Aus dem Archiv nehmen?")) return;
      try { updateStory(await api("POST", `stories/${story.id}/archive`, { archived: archive })); toast(archive ? "Im Gruppenarchiv gespeichert" : "Aus dem Archiv entfernt"); showItem(); }
      catch (e) { toast(e.message); }
      return;
    }
    case "views": {
      const v = Object.values(story.views || {});
      const box = $("#v-views");
      box.hidden = !box.hidden;
      box.textContent = v.length ? "Gesehen von: " + v.map((x) => x.name).join(", ") : "Noch von niemandem gesehen.";
      return;
    }
    case "del": {
      if (!confirm(story ? "Story löschen?" : "Nachricht mit diesem Medium löschen?")) return;
      try {
        if (story) { await api("DELETE", `stories/${story.id}`); state.stories = state.stories.filter((x) => x.id !== story.id); }
        else { await api("DELETE", `chat/${it.msg.id}`); chat.messages = chat.messages.filter((x) => x.id !== it.msg.id); }
        viewer.items.splice(viewer.index, 1);
        if (!viewer.items.length) return closeViewer();
        viewer.index = Math.min(viewer.index, viewer.items.length - 1); showItem();
      } catch (e) { toast(e.message); }
    }
  }
});

/* ---------- Gruppenarchiv ---------- */
let archiveFilter = "";
function openArchive(name = "") { archiveFilter = name; renderArchive(); if (!$("#archive-dlg").open) $("#archive-dlg").showModal(); }
const archivedStories = () => (state.stories || []).filter((s) => s.archived).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
function tileHtml(it, i, attr) {
  const t = thumbOf(it);
  return `<button type="button" class="tile" ${attr}="${i}" aria-label="${it.kind === "video" ? "Video" : "Foto"} von ${esc(it.createdBy)}">${t ? `<img src="${t}" alt="" loading="lazy">` : '<span class="vid-ph"></span>'}${it.kind === "video" ? '<span class="play">▶</span>' : ""}</button>`;
}
function renderArchive() {
  const all = archivedStories();
  const people = [...new Map(all.map((s) => [keyOf(s.createdBy), s.createdBy])).values()];
  $("#archive-filter").innerHTML = people.length > 1
    ? [`<button type="button" class="chip ${!archiveFilter ? "on" : ""}" data-af="">Alle (${all.length})</button>`,
       ...people.map((n) => `<button type="button" class="chip ${keyOf(n) === keyOf(archiveFilter) ? "on" : ""}" data-af="${esc(n)}">${esc(n)}</button>`)].join("")
    : "";
  const items = all.filter((s) => !archiveFilter || keyOf(s.createdBy) === keyOf(archiveFilter)).map(storyItem);
  $("#archive-grid").innerHTML = items.length
    ? items.map((it, i) => tileHtml(it, i, "data-ai")).join("")
    : '<p class="hint">Noch nichts im Archiv. Öffne eine Story und tippe auf „Ins Archiv“ – dann bleibt sie dauerhaft hier.</p>';
  $("#archive-grid").items = items;
}
$("#archive-filter").addEventListener("click", (e) => { const b = e.target.closest("[data-af]"); if (b) { archiveFilter = b.dataset.af; renderArchive(); } });
$("#archive-grid").addEventListener("click", (e) => { const b = e.target.closest("[data-ai]"); if (b) openViewer($("#archive-grid").items, +b.dataset.ai, "archive"); });

/* ---------- Profile ---------- */
const profileView = { name: "", editing: false, avatarDraft: null, removeAvatar: false };
function openProfile(name) {
  Object.assign(profileView, { name, editing: false, avatarDraft: null, removeAvatar: false });
  renderProfile();
  if (!$("#profile-dlg").open) $("#profile-dlg").showModal();
}
function profileMedia(name) {
  const k = keyOf(name);
  const st = (state.stories || []).filter((s) => s.archived && keyOf(s.createdBy) === k).map(storyItem);
  const ph = chat.messages.filter((m) => keyOf(m.createdBy) === k && (m.imageId || m.media) && !m.pending).map(msgItem);
  return [...st, ...ph].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function renderProfile() {
  const name = profileView.name, k = keyOf(name), p = profileMap.get(k) || {};
  const own = k === keyOf(auth.name);
  const body = $("#profile-body");
  if (profileView.editing) {
    const img = profileView.avatarDraft || (!profileView.removeAvatar && p.avatarId ? imgUrl(p.avatarId) : "");
    body.innerHTML = `<div class="profile-head">
        ${img ? `<span class="avatar xl"><img src="${img}" alt=""></span>` : `<span class="avatar xl" style="background:hsl(${hue(name)} 55% 50%)">${esc(name[0]?.toUpperCase() || "?")}</span>`}
        <div class="actions" style="justify-content:center">
          <button type="button" class="btn small" data-p="pick">${I.camera} Foto wählen</button>
          ${img ? '<button type="button" class="btn small ghost danger" data-p="rm">Entfernen</button>' : ""}
        </div>
      </div>
      <label>Status<input type="text" id="p-status" maxlength="40" placeholder="z. B. 🏖️ im Urlaub" value="${esc(p.status || "")}"></label>
      <label>Über mich<textarea id="p-bio" maxlength="160" placeholder="Ein paar Worte über dich…">${esc(p.bio || "")}</textarea></label>
      <p class="form-err" hidden></p>
      <div class="dlg-foot"><button type="button" class="btn ghost" data-p="cancel">Abbrechen</button><button type="button" class="btn primary" data-p="save">Speichern</button></div>`;
    return;
  }
  const k2 = k;
  const events = state.events.filter((e) => e.rsvps?.[k2]?.status === "yes").length;
  const msgs = chat.messages.filter((m) => keyOf(m.createdBy) === k2 && !m.pending).length;
  const media = profileMedia(name);
  body.innerHTML = `<div class="profile-head">
      ${p.avatarId ? `<button type="button" class="avatar-btn" data-p="bigav"><span class="avatar xl"><img src="${imgUrl(p.avatarId)}" alt="Profilbild von ${esc(name)}"></span></button>` : avatar(name, "xl")}
      <h2>${esc(name)}</h2>
      ${p.status ? `<div class="p-status">${esc(p.status)}</div>` : ""}
      ${p.bio ? `<p class="p-bio">${linkify(p.bio)}</p>` : own ? '<p class="hint">Noch keine Bio – erzähl der Gruppe was über dich.</p>' : ""}
      <div class="p-stats">
        <div><b>${events}</b><span>Termine dabei</span></div>
        <div><b>${msgs}${chat.hasMore ? "+" : ""}</b><span>Nachrichten</span></div>
        <div><b>${media.length}</b><span>Fotos & Videos</span></div>
      </div>
      ${own ? '<button type="button" class="btn small" data-p="edit">Profil bearbeiten</button>' : ""}
    </div>
    <div class="media-grid">${media.map((it, i) => tileHtml(it, i, "data-pi")).join("")}</div>
    ${media.length ? "" : '<p class="hint" style="text-align:center">Noch keine Fotos oder Videos.</p>'}`;
  body.querySelector(".media-grid").items = media;
}
$("#profile-body").addEventListener("click", async (e) => {
  const tile = e.target.closest("[data-pi]");
  if (tile) return openViewer(e.currentTarget.querySelector(".media-grid").items, +tile.dataset.pi, "archive");
  const b = e.target.closest("[data-p]"); if (!b) return;
  const p = profileMap.get(keyOf(profileView.name)) || {};
  switch (b.dataset.p) {
    case "edit": profileView.editing = true; return renderProfile();
    case "cancel": Object.assign(profileView, { editing: false, avatarDraft: null, removeAvatar: false }); return renderProfile();
    case "pick": return $("#avatar-file").click();
    case "rm": profileView.avatarDraft = null; profileView.removeAvatar = true; return renderProfile();
    case "bigav": return openViewer([{ kind: "image", imageId: p.avatarId, createdBy: profileView.name, createdAt: p.updatedAt || new Date().toISOString(), caption: "" }], 0, "archive");
    case "save": {
      const err = $("#profile-body .form-err");
      try {
        const saved = await api("PUT", "profile", {
          bio: $("#p-bio").value, status: $("#p-status").value,
          avatar: profileView.avatarDraft || undefined, removeAvatar: profileView.removeAvatar && !profileView.avatarDraft,
        });
        state.profiles = [...(state.profiles || []).filter((x) => keyOf(x.name) !== keyOf(saved.name)), saved];
        profileMap.set(keyOf(saved.name), saved);
        Object.assign(profileView, { editing: false, avatarDraft: null, removeAvatar: false });
        renderProfile(); render(); toast("Profil gespeichert");
      } catch (x) { err.textContent = x.message; err.hidden = false; }
    }
  }
});
$("#avatar-file").addEventListener("change", async (ev) => {
  const f = ev.target.files[0]; ev.target.value = "";
  if (!f) return;
  try { profileView.avatarDraft = await cropSquare(f, 400); profileView.removeAvatar = false; renderProfile(); }
  catch (e) { toast(e.message); }
});
async function cropSquare(file, size) {
  let src = await createImageBitmap(file, { imageOrientation: "from-image" }).catch(() => null);
  if (!src) src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("Bild konnte nicht gelesen werden.")); i.src = URL.createObjectURL(file); });
  const side = Math.min(src.width, src.height);
  const c = document.createElement("canvas");
  c.width = c.height = Math.min(size, side);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(src, (src.width - side) / 2, (src.height - side) / 2, side, side, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.85);
}
$("#me-name").onclick = () => openProfile(auth.name);
$("#profile-form").addEventListener("submit", (e) => e.preventDefault());

// Mitgliederliste im Gruppen-Dialog
function renderMembers() {
  const people = [...knownPeople().values()].sort((a, b) => a.localeCompare(b, "de"));
  $("#member-count").textContent = `· ${people.length}`;
  $("#member-list").innerHTML = people.map((n) => `<button type="button" class="member" data-name="${esc(n)}">${avatar(n)}<span>${esc(n)}</span></button>`).join("");
}
$("#member-list").addEventListener("click", (e) => { const b = e.target.closest("[data-name]"); if (b) openProfile(b.dataset.name); });

/* ---------- Höhe von Leiste & Eingabe messen (damit nichts verdeckt wird) ---------- */
function measureBars() {
  const root = document.documentElement.style;
  root.setProperty("--nav-h", ($(".bottom-nav")?.offsetHeight || 64) + "px");
  const comp = $("#chat-composer");
  root.setProperty("--composer-h", (comp && !comp.hidden ? comp.offsetHeight : 0) + "px");
}
addEventListener("resize", measureBars);
if (window.ResizeObserver) new ResizeObserver(measureBars).observe($(".bottom-nav"));
measureBars();
