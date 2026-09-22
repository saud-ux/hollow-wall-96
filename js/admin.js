// ============================================================================
// Hollow — moderation console (admin.html)
//
// - Email/password gate. The client-side check that "you are the admin" is
//   only for UX; the delete permission is enforced by firestore.rules against
//   ADMIN_UID. A signed-in visitor still cannot delete.
// - One live listener over the newest 100 messages so the list reflects any
//   phone submission in real time.
// - Single-confirm delete for one message. Double-confirm delete-all (a phrase
//   the admin must type). Delete-all is paged, resilient, and shows progress.
// ============================================================================

import { firebaseConfig, FIREBASE_SDK_BASE } from "./firebase-config.js";

const LIST_LIMIT = 100;
const WIPE_BATCH = 400;         // Firestore batched writes cap out at 500 ops
const CONN_TIMEOUT_MS = 12_000;
const MAX_BACKOFF_MS = 60_000;
const CONFIRM_ALL_PHRASE = "حذف الكل";

const el = {
  login: document.getElementById("login"),
  loginForm: document.getElementById("loginForm"),
  email: document.getElementById("email"),
  password: document.getElementById("password"),
  loginBtn: document.getElementById("loginBtn"),
  loginLabel: document.getElementById("loginLabel"),
  loginError: document.getElementById("loginError"),

  console: document.getElementById("console"),
  who: document.getElementById("who"),
  conn: document.getElementById("conn"),
  connText: document.getElementById("connText"),
  signOut: document.getElementById("signOut"),

  statVisible: document.getElementById("statVisible"),
  statTotal: document.getElementById("statTotal"),
  wipeBtn: document.getElementById("wipeBtn"),

  listStatus: document.getElementById("listStatus"),
  list: document.getElementById("list"),
  listFooter: document.getElementById("listFooter"),
  footerCount: document.getElementById("footerCount"),

  toasts: document.getElementById("toasts"),

  confirmOne: document.getElementById("confirmOne"),
  confirmOnePreview: document.getElementById("confirmOnePreview"),
  confirmOneOk: document.getElementById("confirmOneOk"),
  confirmAll: document.getElementById("confirmAll"),
  confirmAllPhrase: document.getElementById("confirmAllPhrase"),
  confirmAllProgress: document.getElementById("confirmAllProgress"),
  confirmAllOk: document.getElementById("confirmAllOk"),
};

// ---------------------------------------------------------------------------
// Firebase — loaded once, on first render.
// ---------------------------------------------------------------------------

let fb = null;
let currentUser = null;
let unsubscribeList = null;
let unsubscribeAuth = null;
let listBackoffMs = 2000;
let listRetryTimer = null;
let serverConnected = false;

async function loadFirebase() {
  if (fb) return fb;
  const [appMod, authMod, fs] = await Promise.all([
    import(`${FIREBASE_SDK_BASE}/firebase-app.js`),
    import(`${FIREBASE_SDK_BASE}/firebase-auth.js`),
    import(`${FIREBASE_SDK_BASE}/firebase-firestore.js`),
  ]);
  const app = appMod.initializeApp(firebaseConfig);
  fb = {
    app,
    auth: authMod.getAuth(app),
    authMod,
    db: fs.getFirestore(app),
    fs,
  };
  // Persist across refreshes so the console isn't kicked back to login every reload.
  await fb.authMod.setPersistence(fb.auth, fb.authMod.browserLocalPersistence);
  fb.authMod.onAuthStateChanged(fb.auth, onAuthChange);
  return fb;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const arNumber = new Intl.NumberFormat("ar-SA");
const arDate = new Intl.DateTimeFormat("ar-SA", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});
const arDateFull = new Intl.DateTimeFormat("ar-SA", {
  day: "2-digit",
  month: "long",
  hour: "2-digit",
  minute: "2-digit",
  hour12: true,
});

function relativeTime(from) {
  if (!from) return "…";
  const diff = Math.max(0, Date.now() - from.getTime());
  const sec = Math.floor(diff / 1000);
  if (sec < 5)         return "الآن";
  if (sec < 60)        return `قبل ${arNumber.format(sec)} ث`;
  const min = Math.floor(sec / 60);
  if (min < 60)        return `قبل ${arNumber.format(min)} د`;
  const hr = Math.floor(min / 60);
  if (hr < 24)         return `قبل ${arNumber.format(hr)} س`;
  return arDateFull.format(from);
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toast(message, kind = "info") {
  const node = document.createElement("div");
  node.className = `toast toast--${kind}`;
  node.textContent = message;
  el.toasts.append(node);
  requestAnimationFrame(() => node.classList.add("is-in"));
  setTimeout(() => {
    node.classList.remove("is-in");
    node.addEventListener("transitionend", () => node.remove(), { once: true });
    setTimeout(() => node.remove(), 800);
  }, kind === "error" ? 6000 : 3200);
}

// ---------------------------------------------------------------------------
// Login gate
// ---------------------------------------------------------------------------

function showLoginError(message) {
  el.loginError.hidden = false;
  el.loginError.textContent = message;
}

function clearLoginError() {
  el.loginError.hidden = true;
  el.loginError.textContent = "";
}

function setLoginBusy(busy) {
  el.loginBtn.disabled = busy;
  el.loginLabel.textContent = busy ? "جارٍ الدخول…" : "دخول";
}

async function onLoginSubmit(event) {
  event.preventDefault();
  clearLoginError();
  const email = el.email.value.trim();
  const password = el.password.value;
  if (!email || !password) {
    showLoginError("أدخل البريد وكلمة المرور.");
    return;
  }
  setLoginBusy(true);
  try {
    await loadFirebase();
    await fb.authMod.signInWithEmailAndPassword(fb.auth, email, password);
    // onAuthChange takes it from here.
  } catch (err) {
    setLoginBusy(false);
    const code = err?.code || "";
    if (code === "auth/invalid-credential"
        || code === "auth/wrong-password"
        || code === "auth/user-not-found"
        || code === "auth/invalid-email") {
      showLoginError("بيانات الدخول غير صحيحة.");
    } else if (code === "auth/too-many-requests") {
      showLoginError("محاولات كثيرة. انتظر دقيقة قبل المحاولة مرة أخرى.");
    } else if (code === "auth/network-request-failed") {
      showLoginError("تعذّر الاتصال بالشبكة. تأكد من الإنترنت.");
    } else {
      showLoginError("حدث خطأ غير متوقع أثناء الدخول.");
      console.warn("[hollow admin] sign-in error", err);
    }
  }
}

async function onSignOut() {
  try {
    await fb.authMod.signOut(fb.auth);
    location.reload();
  } catch (err) {
    toast("تعذّر تسجيل الخروج.", "error");
    console.warn(err);
  }
}

// ---------------------------------------------------------------------------
// Auth state → what the page shows
// ---------------------------------------------------------------------------

function onAuthChange(user) {
  currentUser = user;
  if (user) {
    el.login.hidden = true;
    el.console.hidden = false;
    el.who.textContent = user.email || "المشرف";
    startListener();
    refreshTotal();
    setLoginBusy(false);
  } else {
    el.console.hidden = true;
    el.login.hidden = false;
    stopListener();
    setLoginBusy(false);
    el.password.value = "";
  }
}

// ---------------------------------------------------------------------------
// Live list of the newest 100 messages
// ---------------------------------------------------------------------------

let rowsById = new Map(); // id → <li>
let deletingIds = new Set();
let lastVisibleCount = -1;

function setListStatus(text) {
  if (!text) {
    el.listStatus.hidden = true;
    el.listStatus.textContent = "";
    return;
  }
  el.listStatus.hidden = false;
  el.listStatus.textContent = text;
}

function setConnected(value) {
  serverConnected = value;
  el.conn.classList.toggle("pill--ok", value);
  el.conn.classList.toggle("pill--warn", !value);
  el.connText.textContent = value ? "متصل" : "إعادة الاتصال…";
}

function startListener() {
  stopListener();
  const { fs, db } = fb;
  const q = fs.query(
    fs.collection(db, "messages"),
    fs.orderBy("createdAt", "desc"),
    fs.limit(LIST_LIMIT)
  );

  setListStatus("جارٍ تحميل الرسائل…");
  unsubscribeList = fs.onSnapshot(
    q,
    { includeMetadataChanges: true },
    (snapshot) => {
      setConnected(!snapshot.metadata.fromCache);
      renderList(snapshot);
      if (!snapshot.metadata.fromCache) listBackoffMs = 2000;
    },
    (error) => {
      console.warn("[hollow admin] listener error:", error?.code || error);
      setConnected(false);
      setListStatus("انقطع الاتصال — إعادة المحاولة…");
      unsubscribeList = null;
      clearTimeout(listRetryTimer);
      listRetryTimer = setTimeout(startListener, listBackoffMs);
      listBackoffMs = Math.min(listBackoffMs * 2, MAX_BACKOFF_MS);
    }
  );
}

function stopListener() {
  clearTimeout(listRetryTimer);
  listRetryTimer = null;
  unsubscribeList?.();
  unsubscribeList = null;
  el.list.replaceChildren();
  rowsById = new Map();
  deletingIds = new Set();
  lastVisibleCount = -1;
  setListStatus("");
  el.statVisible.textContent = "—";
  el.statTotal.textContent = "—";
  el.listFooter.hidden = true;
  el.wipeBtn.disabled = true;
}

function renderList(snapshot) {
  const docs = snapshot.docs;
  el.statVisible.textContent = arNumber.format(docs.length);
  el.wipeBtn.disabled = docs.length === 0;

  el.footerCount.textContent = arNumber.format(LIST_LIMIT);
  el.listFooter.hidden = docs.length < LIST_LIMIT;

  // Total is unknown when the window is full (there could be more beyond LIMIT),
  // so re-query the server aggregation. Otherwise the visible count IS the total.
  if (!snapshot.metadata.fromCache && docs.length !== lastVisibleCount) {
    lastVisibleCount = docs.length;
    if (docs.length < LIST_LIMIT) {
      el.statTotal.textContent = arNumber.format(docs.length);
    } else {
      refreshTotal();
    }
  }

  if (docs.length === 0) {
    el.list.replaceChildren();
    rowsById = new Map();
    setListStatus("لا توجد رسائل حالياً.");
    return;
  }
  setListStatus("");

  const nextRows = new Map();
  const fragment = document.createDocumentFragment();

  for (const doc of docs) {
    let row = rowsById.get(doc.id);
    if (!row) {
      row = buildRow(doc);
    } else {
      updateRow(row, doc);
    }
    nextRows.set(doc.id, row);
    fragment.append(row);
  }

  el.list.replaceChildren(fragment);
  rowsById = nextRows;
}

function buildRow(doc) {
  const data = doc.data();
  const row = document.createElement("li");
  row.className = "row";
  row.dataset.id = doc.id;
  row.innerHTML = `
    <div class="row__body">
      <p class="row__text"></p>
      <div class="row__meta">
        <span class="row__name"></span>
        <span class="row__time" title=""></span>
      </div>
    </div>
    <div class="row__actions">
      <button type="button" class="btn btn--ghost btn--sm row__delete" aria-label="حذف الرسالة">
        حذف
      </button>
    </div>
  `;
  const del = row.querySelector(".row__delete");
  del.addEventListener("click", () => askDeleteOne(doc.id));
  updateRow(row, doc);
  return row;
}

function updateRow(row, doc) {
  const data = doc.data();
  row.querySelector(".row__text").textContent = data.text ?? "";
  const nameNode = row.querySelector(".row__name");
  const hidden = data.anonymous === true;
  nameNode.textContent = hidden ? "زائر (اسم مخفي)" : (data.name?.trim() || "زائر");
  nameNode.classList.toggle("is-anonymous", hidden);

  const timestamp = data.createdAt?.toDate?.() ?? null;
  const timeNode = row.querySelector(".row__time");
  timeNode.textContent = relativeTime(timestamp);
  timeNode.title = timestamp ? arDateFull.format(timestamp) : "";
  timeNode.dataset.timestamp = timestamp ? String(timestamp.getTime()) : "";
}

// Tick the relative-time labels every 20 s. Bounded work: at most 100 rows.
setInterval(() => {
  for (const row of rowsById.values()) {
    const raw = Number(row.querySelector(".row__time").dataset.timestamp);
    if (raw) row.querySelector(".row__time").textContent = relativeTime(new Date(raw));
  }
}, 20_000);

// ---------------------------------------------------------------------------
// Delete one
// ---------------------------------------------------------------------------

function askDeleteOne(id) {
  const row = rowsById.get(id);
  if (!row || deletingIds.has(id)) return;
  el.confirmOnePreview.textContent = row.querySelector(".row__text").textContent;
  el.confirmOne.returnValue = "cancel";
  el.confirmOne.showModal();
  el.confirmOne.addEventListener(
    "close",
    async () => {
      if (el.confirmOne.returnValue !== "ok") return;
      await deleteOne(id);
    },
    { once: true }
  );
}

async function deleteOne(id) {
  const row = rowsById.get(id);
  if (!row) return;
  deletingIds.add(id);
  row.classList.add("is-deleting");
  const button = row.querySelector(".row__delete");
  button.disabled = true;
  button.textContent = "جارٍ الحذف…";

  try {
    await fb.fs.deleteDoc(fb.fs.doc(fb.db, "messages", id));
    toast("تم حذف الرسالة.", "success");
    refreshTotal();
  } catch (err) {
    row.classList.remove("is-deleting");
    button.disabled = false;
    button.textContent = "حذف";
    console.warn("[hollow admin] delete failed", err);
    if (err?.code === "permission-denied") {
      toast("لا صلاحية لحذف الرسائل — تحقق من قواعد الحماية.", "error");
    } else {
      toast("تعذّر حذف الرسالة. حاول مرة أخرى.", "error");
    }
  } finally {
    deletingIds.delete(id);
  }
}

// ---------------------------------------------------------------------------
// Delete all (paged batches)
// ---------------------------------------------------------------------------

function openWipeDialog() {
  el.confirmAllPhrase.value = "";
  el.confirmAllOk.disabled = true;
  el.confirmAllProgress.hidden = true;
  el.confirmAllProgress.textContent = "";
  el.confirmAll.returnValue = "cancel";
  el.confirmAll.showModal();
  setTimeout(() => el.confirmAllPhrase.focus(), 0);
}

el.confirmAllPhrase?.addEventListener("input", () => {
  el.confirmAllOk.disabled = el.confirmAllPhrase.value.trim() !== CONFIRM_ALL_PHRASE;
});

async function wipeAll() {
  const { fs, db } = fb;
  el.confirmAllOk.disabled = true;
  el.confirmAllPhrase.disabled = true;
  el.confirmAllProgress.hidden = false;

  let total = 0;
  try {
    while (true) {
      const snapshot = await fs.getDocs(
        fs.query(fs.collection(db, "messages"), fs.limit(WIPE_BATCH))
      );
      if (snapshot.empty) break;
      const batch = fs.writeBatch(db);
      for (const doc of snapshot.docs) batch.delete(doc.ref);
      await batch.commit();
      total += snapshot.size;
      el.confirmAllProgress.textContent = `تم حذف ${arNumber.format(total)}…`;
    }
    el.confirmAllProgress.textContent = `اكتمل. تم حذف ${arNumber.format(total)} رسالة.`;
    toast(`تم مسح ${arNumber.format(total)} رسالة.`, "success");
    refreshTotal();
    setTimeout(() => {
      if (el.confirmAll.open) el.confirmAll.close("ok-done");
    }, 900);
  } catch (err) {
    console.warn("[hollow admin] wipe failed", err);
    el.confirmAllProgress.textContent = "فشل الحذف — بعض الرسائل ربما لم تُحذف.";
    if (err?.code === "permission-denied") {
      toast("لا صلاحية لحذف كل الرسائل — تحقق من قواعد الحماية.", "error");
    } else {
      toast("توقف الحذف قبل الانتهاء. حاول مرة أخرى.", "error");
    }
  } finally {
    el.confirmAllPhrase.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// Total messages counter — cheap aggregation, refreshed on demand.
// ---------------------------------------------------------------------------

let totalInFlight = false;
let totalQueued = false;
async function refreshTotal() {
  if (totalInFlight) {
    totalQueued = true;
    return;
  }
  totalInFlight = true;
  try {
    const { fs, db } = fb;
    const snapshot = await withTimeout(
      fs.getCountFromServer(fs.collection(db, "messages")),
      CONN_TIMEOUT_MS
    );
    el.statTotal.textContent = arNumber.format(snapshot.data().count);
  } catch {
    el.statTotal.textContent = "—";
  } finally {
    totalInFlight = false;
    if (totalQueued) {
      totalQueued = false;
      refreshTotal();
    }
  }
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

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

el.loginForm.addEventListener("submit", onLoginSubmit);
el.signOut.addEventListener("click", onSignOut);
el.wipeBtn.addEventListener("click", openWipeDialog);
el.confirmAll.addEventListener("close", () => {
  if (el.confirmAll.returnValue !== "ok") return;
  wipeAll();
});
el.confirmOneOk.addEventListener("click", () => {
  el.confirmOne.returnValue = "ok";
});
el.confirmAllOk.addEventListener("click", (event) => {
  if (el.confirmAllPhrase.value.trim() !== CONFIRM_ALL_PHRASE) {
    event.preventDefault();
    return;
  }
  el.confirmAll.returnValue = "ok";
});

window.addEventListener("online", () => {
  if (currentUser && !unsubscribeList) startListener();
});

// Warm up the SDK so the first login click doesn't wait on a cold import.
loadFirebase().catch((err) => {
  console.warn("[hollow admin] Firebase load failed", err);
});
