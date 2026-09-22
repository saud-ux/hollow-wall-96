// ============================================================================
// Hollow — TV wall (screen.html)
//
// Realtime: exactly ONE onSnapshot listener —
//   messages, orderBy('createdAt','desc'), limit(12)
// so reads stay flat no matter how big the crowd gets.
//
// The total counter is a server-side count aggregation (billed at 1 read per
// 1,000 messages), run only at startup, after a reconnect, and after a
// deletion is seen. Between those it is advanced locally from the listener's
// own changes — never polled, never one call per message.
//
// Query strings:
//   ?kiosk=1   hide the cursor
//   ?debug=1   verbose SDK logs + window.hollow test hooks
// ============================================================================

import { firebaseConfig, FIREBASE_SDK_BASE } from "./firebase-config.js";
import { renderQr, visitorUrl } from "./qr.js";

const LIMIT = 12;

const MOVE_MS = 760;
const ENTER_MS = 720;
const ENTER_DELAY_MS = 170;
const EXIT_MS = 480;
const STAGGER_MS = 16;
const INITIAL_STAGGER_MS = 45;
const EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";
const EASE_OUT = "cubic-bezier(0.16, 1, 0.3, 1)";

const LINE_HEIGHT = 1.32; // keep in sync with .card__text in screen.css
const BADGE_GRACE_MS = 2000;
const FONT_WAIT_MS = 2500;
const COUNT_TIMEOUT_MS = 15_000;
const RESYNC_AFTER_DELETE_MS = 1200;
const MAX_BACKOFF_MS = 60_000;

const params = new URLSearchParams(location.search);
const KIOSK = params.get("kiosk") === "1";
const DEBUG = params.get("debug") === "1";

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const numberFormat = new Intl.NumberFormat("ar-SA");

const el = {
  wall: document.getElementById("wall"),
  grid: document.getElementById("grid"),
  ghosts: document.getElementById("ghosts"),
  empty: document.getElementById("empty"),
  total: document.getElementById("total"),
  qr: document.getElementById("qr"),
  badge: document.getElementById("badge"),
};

// ---------------------------------------------------------------------------
// State — everything here is bounded: at most LIMIT cards, LIMIT ghosts,
// and a fixed set of timers that are always cleared before being re-armed.
// ---------------------------------------------------------------------------

const cards = new Map(); // doc id → card element
const moveAnimations = new WeakMap();

let fs = null;
let db = null;

let unsubscribe = null;
let listenRetryTimer = null;
let listenBackoffMs = 2000;

let serverConnected = false;
let serverSeen = false;
let badgeTimer = null;

let fontsReady = false;
let pendingViews = null;
let firstPaint = true;

let total = null;
let lastWindow = null; // { newest } of the previous server snapshot
let resyncTimer = null;
let resyncInFlight = false;
let resyncQueued = false;
let resyncBackoffMs = 10_000;

// ---------------------------------------------------------------------------
// Card DOM
// ---------------------------------------------------------------------------

function createCard({ id, text, name }) {
  const card = document.createElement("article");
  card.className = "card";
  card.dataset.id = id;

  const inner = document.createElement("div");
  inner.className = "card__inner";

  const body = document.createElement("div");
  body.className = "card__body";

  const message = document.createElement("p");
  message.className = "card__text";
  message.textContent = text;

  const sender = document.createElement("p");
  sender.className = "card__name";
  sender.textContent = name;

  body.append(message);
  // Three stacked Sadu diamonds on the side. Appended last: fitCard()
  // expects the body to stay the inner's first child.
  const deco = document.createElement("span");
  deco.className = "card__deco";
  deco.setAttribute("aria-hidden", "true");

  inner.append(body, sender, deco);
  card.append(inner);
  return card;
}

function toView(doc) {
  const data = doc.data();
  const text = typeof data.text === "string" ? data.text.trim() : "";
  if (!text) return null;
  const name =
    data.anonymous !== true && typeof data.name === "string" && data.name.trim()
      ? data.name.trim()
      : "زائر";
  return { id: doc.id, text, name };
}

// ---------------------------------------------------------------------------
// Auto-fit typography
// Binary-search the largest font size at which the text's real rendered box
// fits inside the card body. .card__body has size containment, so each trial
// reflows only that box.
// ---------------------------------------------------------------------------

/** Mirrors the CSS custom property --u: min(1vmax, 1.778vmin). */
function unitPx() {
  const w = document.documentElement.clientWidth;
  const h = document.documentElement.clientHeight;
  return Math.min(Math.max(w, h), Math.min(w, h) * 1.778) / 100;
}

function fitCard(card) {
  const body = card.firstElementChild.firstElementChild;
  const text = body.firstElementChild;
  const height = body.clientHeight;
  const width = body.clientWidth;
  if (height === 0 || width === 0) return;

  const u = unitPx();
  const min = Math.max(11, u * 0.62);
  const max = Math.max(min, Math.min(height / LINE_HEIGHT, u * 3.6));

  const fits = (size) => {
    text.style.fontSize = `${size}px`;
    return text.scrollHeight <= height + 0.5 && text.scrollWidth <= width + 0.5;
  };

  if (fits(max)) return;

  let lo = min;
  let hi = max;
  for (let i = 0; i < 12 && hi - lo > 0.25; i++) {
    const mid = (lo + hi) / 2;
    if (fits(mid)) lo = mid;
    else hi = mid;
  }
  text.style.fontSize = `${lo}px`;
}

function refitAll() {
  for (const card of cards.values()) fitCard(card);
}

let refitFrame = 0;
function scheduleRefit() {
  if (refitFrame) return;
  refitFrame = requestAnimationFrame(() => {
    refitFrame = 0;
    refitAll();
  });
}

// ---------------------------------------------------------------------------
// Rendering with FLIP
//   First:  measure every existing card's on-screen box (mid-flight included)
//   Last:   reorder the DOM to match the snapshot
//   Invert: translate each card back to where it was
//   Play:   animate the translation to zero
// ---------------------------------------------------------------------------

function showViews(views) {
  if (!fontsReady) {
    pendingViews = views;
    return;
  }
  render(views);
}

function render(views) {
  const animate = !reducedMotion.matches;
  const initial = firstPaint;
  const wallBox = el.wall.getBoundingClientRect();

  const before = new Map();
  for (const [id, card] of cards) before.set(id, card.getBoundingClientRect());
  for (const card of cards.values()) moveAnimations.get(card)?.cancel();

  const keep = new Set(views.map((view) => view.id));
  for (const [id, card] of cards) {
    if (keep.has(id)) continue;
    cards.delete(id);
    exitCard(card, animate ? before.get(id) : null, wallBox);
  }

  const entering = [];
  views.forEach((view, index) => {
    let card = cards.get(view.id);
    if (!card) {
      card = createCard(view);
      cards.set(view.id, card);
      entering.push(card);
    }
    const occupant = el.grid.children[index];
    if (occupant !== card) el.grid.insertBefore(card, occupant ?? null);
  });

  for (const card of entering) fitCard(card);

  if (animate && !initial) {
    const moves = [];
    views.forEach((view, index) => {
      const from = before.get(view.id);
      if (!from) return;
      const card = cards.get(view.id);
      const to = card.getBoundingClientRect();
      moves.push({ card, index, dx: from.left - to.left, dy: from.top - to.top });
    });

    for (const { card, index, dx, dy } of moves) {
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      moveAnimations.set(
        card,
        card.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
          { duration: MOVE_MS, easing: EASE, delay: index * STAGGER_MS, fill: "backwards" }
        )
      );
    }
  }

  entering.forEach((card, order) => enterCard(card, { animate, initial, order }));

  if (views.length > 0) firstPaint = false;
  updateEmptyState();
}

function enterCard(card, { animate, initial, order }) {
  const inner = card.firstElementChild;

  if (!initial) {
    inner.classList.add("is-fresh");
    inner.addEventListener("animationend", () => inner.classList.remove("is-fresh"), {
      once: true,
    });
  }

  if (!animate) {
    inner.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: "linear" });
    return;
  }

  inner.animate(
    [
      { opacity: 0, transform: "translateY(-10%) scale(0.94)" },
      { opacity: 1, transform: "translateY(0) scale(1)" },
    ],
    {
      duration: ENTER_MS,
      easing: EASE_OUT,
      delay: initial ? order * INITIAL_STAGGER_MS : ENTER_DELAY_MS,
      fill: "backwards",
    }
  );
}

function exitCard(card, rect, wallBox) {
  card.firstElementChild.classList.remove("is-fresh");

  if (!rect) {
    card.remove();
    return;
  }

  // Lift the card out of the grid into the ghost layer at its exact on-screen
  // box, so the grid can reflow immediately while this one fades in place.
  card.classList.add("is-leaving");
  card.style.left = `${rect.left - wallBox.left}px`;
  card.style.top = `${rect.top - wallBox.top}px`;
  card.style.width = `${rect.width}px`;
  card.style.height = `${rect.height}px`;
  el.ghosts.append(card);

  while (el.ghosts.childElementCount > LIMIT) el.ghosts.firstElementChild.remove();

  const fade = card.animate(
    [
      { opacity: 1, transform: "scale(1)" },
      { opacity: 0, transform: "scale(0.94)" },
    ],
    { duration: EXIT_MS, easing: EASE, fill: "forwards" }
  );
  fade.onfinish = fade.oncancel = () => card.remove();
}

function updateEmptyState() {
  el.empty.hidden = !(serverSeen && cards.size === 0);
}

// ---------------------------------------------------------------------------
// Total counter
// ---------------------------------------------------------------------------

function setTotal(next) {
  const grew = total !== null && next > total;
  total = Math.max(0, next);
  if (!el.total) return; // the counter was removed from the purple design
  el.total.textContent = numberFormat.format(total);

  if (grew && !reducedMotion.matches) {
    el.total.animate(
      [
        { transform: "scale(1)", color: "#F2F5F3" },
        { transform: "scale(1.14)", color: "#D9B26A", offset: 0.35 },
        { transform: "scale(1)", color: "#F2F5F3" },
      ],
      { duration: 900, easing: EASE_OUT }
    );
  }
}

/** Server timestamps as integer microseconds — safe for ordering comparisons. */
function orderKey(doc) {
  const ts = doc.get("createdAt", { serverTimestamps: "estimate" });
  return ts ? ts.seconds * 1e6 + Math.floor(ts.nanoseconds / 1e3) : Number.MAX_SAFE_INTEGER;
}

/**
 * Advance the counter from one server snapshot to the next.
 *   added   newer than the previous newest → a genuinely new message
 *   added   older                          → a backfill after a deletion
 *   removed older than the whole full window → pushed out by a new message
 *   any other removal                      → a deletion → resync from server
 */
function applyCountDelta(changes, docs) {
  const windowFull = docs.length === LIMIT;
  const oldest = docs.length ? orderKey(docs[docs.length - 1]) : Infinity;
  let arrivals = 0;
  let deletion = false;

  for (const change of changes) {
    const key = orderKey(change.doc);
    if (change.type === "added") {
      if (key > lastWindow.newest) arrivals++;
    } else if (change.type === "removed") {
      if (!(windowFull && key <= oldest)) deletion = true;
    }
  }

  if (arrivals > 0 && total !== null) setTotal(total + arrivals);
  if (deletion) scheduleResync(RESYNC_AFTER_DELETE_MS);
}

function scheduleResync(delay) {
  clearTimeout(resyncTimer);
  resyncTimer = setTimeout(resyncTotal, delay);
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function resyncTotal() {
  resyncTimer = null;
  if (resyncInFlight) {
    resyncQueued = true;
    return;
  }

  resyncInFlight = true;
  try {
    const snapshot = await withTimeout(
      fs.getCountFromServer(fs.collection(db, "messages")),
      COUNT_TIMEOUT_MS
    );
    setTotal(snapshot.data().count);
    resyncBackoffMs = 10_000;
  } catch {
    // Offline: the reconnect path schedules a fresh resync. Online but failing:
    // back off rather than hammer the backend.
    if (serverConnected) {
      scheduleResync(resyncBackoffMs);
      resyncBackoffMs = Math.min(resyncBackoffMs * 2, 5 * MAX_BACKOFF_MS);
    }
  } finally {
    resyncInFlight = false;
    if (resyncQueued) {
      resyncQueued = false;
      scheduleResync(0);
    }
  }
}

// ---------------------------------------------------------------------------
// Connection state + badge
// ---------------------------------------------------------------------------

function setServerConnected(value) {
  serverConnected = value;
  syncBadge();
}

function syncBadge() {
  const down = !serverConnected || !navigator.onLine;

  if (!down) {
    clearTimeout(badgeTimer);
    badgeTimer = null;
    el.badge.hidden = true;
    return;
  }

  if (!el.badge.hidden || badgeTimer) return;
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    if (!serverConnected || !navigator.onLine) el.badge.hidden = false;
  }, BADGE_GRACE_MS);
}

// ---------------------------------------------------------------------------
// The single realtime listener
// ---------------------------------------------------------------------------

function listen() {
  clearTimeout(listenRetryTimer);
  listenRetryTimer = null;
  unsubscribe?.();

  const latest = fs.query(
    fs.collection(db, "messages"),
    fs.orderBy("createdAt", "desc"),
    fs.limit(LIMIT)
  );

  unsubscribe = fs.onSnapshot(
    latest,
    { includeMetadataChanges: true },
    handleSnapshot,
    handleListenError
  );
}

function handleSnapshot(snapshot) {
  const fromCache = snapshot.metadata.fromCache;
  const changes = snapshot.docChanges();

  setServerConnected(!fromCache);

  if (fromCache) {
    // Anything seen while disconnected can't be trusted for counting.
    lastWindow = null;
  } else {
    listenBackoffMs = 2000;
    if (lastWindow === null) scheduleResync(0);
    else applyCountDelta(changes, snapshot.docs);
    lastWindow = {
      newest: snapshot.docs.length ? orderKey(snapshot.docs[0]) : -Infinity,
    };
    serverSeen = true;
  }

  if (changes.length > 0) {
    showViews(snapshot.docs.map(toView).filter(Boolean));
  }
  updateEmptyState();
}

function handleListenError(error) {
  console.warn("[hollow] listener stopped, retrying:", error?.code || error);
  unsubscribe = null;
  lastWindow = null;
  setServerConnected(false);
  clearTimeout(listenRetryTimer);
  listenRetryTimer = setTimeout(listen, listenBackoffMs);
  listenBackoffMs = Math.min(listenBackoffMs * 2, MAX_BACKOFF_MS);
}

// ---------------------------------------------------------------------------
// Boot + recovery
// ---------------------------------------------------------------------------

async function startRealtime() {
  try {
    const [appModule, firestoreModule] = await Promise.all([
      import(`${FIREBASE_SDK_BASE}/firebase-app.js`),
      import(`${FIREBASE_SDK_BASE}/firebase-firestore.js`),
    ]);

    fs = firestoreModule;
    fs.setLogLevel(DEBUG ? "debug" : "silent");

    const app = appModule.initializeApp(firebaseConfig);
    db = fs.initializeFirestore(app, {
      localCache: fs.memoryLocalCache({
        garbageCollector: fs.memoryEagerGarbageCollector(),
      }),
    });

    listen();
  } catch (error) {
    console.warn("[hollow] Firebase SDK unavailable, waiting for network:", error);
    setServerConnected(false);
    // Browsers cache a failed module import for the page's lifetime, so a
    // retry needs a reload — but only once the network is really back,
    // otherwise the TV would be left on the browser's own error page.
    scheduleRecoveryReload(5000);
  }
}

function scheduleRecoveryReload(delay) {
  setTimeout(async () => {
    try {
      const probes = await Promise.all([
        fetch(location.href, { cache: "no-store" }),
        fetch(`${FIREBASE_SDK_BASE}/firebase-app.js`, { cache: "no-store" }),
      ]);
      if (probes.every((response) => response.ok)) {
        location.reload();
        return;
      }
    } catch {
      /* still offline */
    }
    scheduleRecoveryReload(Math.min(delay * 2, MAX_BACKOFF_MS));
  }, delay);
}

let kicking = false;
async function onBrowserOnline() {
  syncBadge();
  if (!qrReady) bootQr();
  if (!db || kicking) return;

  // Cycling the network resets the SDK's reconnect backoff, so the wall
  // catches up the moment Wi-Fi returns instead of on its next retry tick.
  kicking = true;
  try {
    await fs.disableNetwork(db);
    await fs.enableNetwork(db);
  } catch {
    /* the SDK keeps retrying on its own */
  } finally {
    kicking = false;
  }
  if (!unsubscribe) listen();
}

let qrReady = false;
let qrLoading = false;
let qrRetryTimer = null;
let qrBackoffMs = 3000;

async function bootQr() {
  if (qrReady || qrLoading) return;
  clearTimeout(qrRetryTimer);
  qrRetryTimer = null;
  qrLoading = true;
  try {
    await renderQr(el.qr, visitorUrl(), {
      label: "امسح لكتابة رسالتك",
      dark: "#2B2160",
      light: "#FFFFFF",
    });
    qrReady = true;
  } catch {
    qrRetryTimer = setTimeout(bootQr, qrBackoffMs);
    qrBackoffMs = Math.min(qrBackoffMs * 2, MAX_BACKOFF_MS);
  } finally {
    qrLoading = false;
  }
}

function waitForFonts() {
  const loads = Promise.all([
    document.fonts.load('700 40px "Tajawal"', "رسالة"),
    document.fonts.load('500 40px "Tajawal"', "رسالة"),
    document.fonts.load('700 40px "Reem Kufi"', "Hollow ٩٦"),
  ]).catch(() => {});
  return Promise.race([loads, new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS))]);
}

let wakeLock = null;
let wakeLockPending = false;
async function holdWakeLock() {
  if (!("wakeLock" in navigator) || wakeLock || wakeLockPending) return;
  if (document.visibilityState !== "visible") return;
  wakeLockPending = true;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; }, { once: true });
  } catch {
    wakeLock = null;
  } finally {
    wakeLockPending = false;
  }
}

function installDebugHooks() {
  let previewSeq = 0;
  window.hollow = {
    offline: () => fs.disableNetwork(db),
    online: () => fs.enableNetwork(db),
    /** Render arbitrary messages locally (newest first) — never written anywhere. */
    preview: (messages) =>
      render(
        messages.slice(0, LIMIT).map((m) => ({
          id: m.id ?? `preview-${++previewSeq}`,
          text: String(m.text),
          name: m.name ?? "زائر",
        }))
      ),
    state: () => ({
      cards: cards.size,
      gridChildren: el.grid.childElementCount,
      ghosts: el.ghosts.childElementCount,
      total,
      serverConnected,
      badgeVisible: !el.badge.hidden,
      listening: Boolean(unsubscribe),
    }),
  };
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

if (KIOSK) document.documentElement.classList.add("kiosk");
if (DEBUG) installDebugHooks();

window.addEventListener("online", onBrowserOnline);
window.addEventListener("offline", syncBadge);
document.addEventListener("visibilitychange", holdWakeLock);
document.fonts.addEventListener("loadingdone", scheduleRefit);
new ResizeObserver(scheduleRefit).observe(el.grid);

waitForFonts().then(() => {
  fontsReady = true;
  if (pendingViews) {
    const views = pendingViews;
    pendingViews = null;
    render(views);
  } else {
    refitAll();
  }
});

syncBadge();
bootQr();
holdWakeLock();
startRealtime();
