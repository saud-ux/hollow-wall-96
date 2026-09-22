// ============================================================================
// Hollow — visitor form (index.html)
//
// Flow: signInAnonymously → write throttle/{uid} → write messages/{auto}
// The throttle write goes FIRST so a duplicate submission is rejected by the
// throttle rule before the message rule is ever evaluated.
// ============================================================================

import { firebaseConfig, FIREBASE_SDK_BASE } from "./firebase-config.js";
import {
  normalizeText,
  normalizeName,
  validateMessage,
  validateName,
  toArabicDigits,
} from "./filters.js";

const COOLDOWN_MS = 45_000;
const LS_KEY = "hollow:lastPost";
const NET_TIMEOUT_MS = 12_000;

const el = {
  form: document.getElementById("form"),
  text: document.getElementById("text"),
  name: document.getElementById("name"),
  anon: document.getElementById("anon"),
  count: document.getElementById("count"),
  counter: document.getElementById("counter"),
  error: document.getElementById("error"),
  submit: document.getElementById("submit"),
  submitLabel: document.getElementById("submitLabel"),
  retry: document.getElementById("retry"),
  success: document.getElementById("success"),
  again: document.getElementById("again"),
  againLabel: document.getElementById("againLabel"),
  offlineBar: document.getElementById("offlineBar"),
};

const LABEL_SEND = "أرسل رسالتك";
const LABEL_AGAIN = "أرسل رسالة ثانية";

let busy = false;
let pending = null;          // payload of the submission currently being retried
let throttleAttempted = false; // we already fired a throttle write for `pending`
let throttleClaimed = false;   // that throttle write is known to have landed
let cooldownTimer = null;

// ---------------------------------------------------------------------------
// Firebase — loaded lazily so the form is interactive before the SDK arrives.
// ---------------------------------------------------------------------------

let firebasePromise = null;

function loadFirebase() {
  if (firebasePromise) return firebasePromise;

  firebasePromise = (async () => {
    const [appMod, authMod, fs] = await Promise.all([
      import(`${FIREBASE_SDK_BASE}/firebase-app.js`),
      import(`${FIREBASE_SDK_BASE}/firebase-auth.js`),
      import(`${FIREBASE_SDK_BASE}/firebase-firestore.js`),
    ]);

    const app = appMod.initializeApp(firebaseConfig);
    const auth = authMod.getAuth(app);
    const db = fs.getFirestore(app);
    const credential = await authMod.signInAnonymously(auth);

    return { db, fs, uid: credential.user.uid };
  })();

  // Let a later submission retry the whole handshake if this one failed.
  firebasePromise.catch(() => {
    firebasePromise = null;
  });

  return firebasePromise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error("timeout");
      err.code = "hollow/timeout";
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function stage(name, promise) {
  try {
    return await withTimeout(promise, NET_TIMEOUT_MS);
  } catch (err) {
    err.stage = name;
    throw err;
  }
}

function readLastPost() {
  try {
    const raw = Number(localStorage.getItem(LS_KEY) || 0);
    if (!Number.isFinite(raw) || raw <= 0) return 0;
    // A clock moved backwards (or a tampered value) must not lock the device out.
    return raw > Date.now() ? 0 : raw;
  } catch {
    return 0;
  }
}

function writeLastPost(value) {
  try {
    localStorage.setItem(LS_KEY, String(value));
  } catch {
    /* private mode — the Security Rules still enforce the 45s window */
  }
}

function cooldownRemaining() {
  const last = readLastPost();
  if (!last) return 0;
  return Math.max(0, last + COOLDOWN_MS - Date.now());
}

function clockLabel(ms) {
  const total = Math.ceil(ms / 1000);
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return toArabicDigits(`${mm}:${ss}`);
}

// ---------------------------------------------------------------------------
// UI state
// ---------------------------------------------------------------------------

function showError(message, { retryable = false } = {}) {
  el.error.textContent = message;
  el.error.hidden = false;
  el.retry.hidden = !retryable;
}

function clearError() {
  el.error.hidden = true;
  el.error.textContent = "";
  el.retry.hidden = true;
}

function setBusy(value) {
  busy = value;
  el.submit.disabled = value || cooldownRemaining() > 0;
  el.retry.disabled = value;
  el.submitLabel.textContent = value ? "جارٍ الإرسال…" : LABEL_SEND;
  el.form.classList.toggle("is-busy", value);
}

function updateCounter() {
  const n = el.text.value.length;
  el.count.textContent = toArabicDigits(n);
  el.counter.classList.toggle("is-near", n >= 130);
}

function startCooldown() {
  stopCooldown();
  tickCooldown();
  cooldownTimer = setInterval(tickCooldown, 250);
}

function stopCooldown() {
  if (cooldownTimer) {
    clearInterval(cooldownTimer);
    cooldownTimer = null;
  }
  if (!busy) {
    el.submit.disabled = false;
    el.submitLabel.textContent = LABEL_SEND;
  }
  el.again.disabled = false;
  el.againLabel.textContent = LABEL_AGAIN;
}

function tickCooldown() {
  const remaining = cooldownRemaining();
  if (remaining <= 0) {
    stopCooldown();
    return;
  }
  const label = `أرسل بعد ${clockLabel(remaining)}`;
  if (!busy) {
    el.submit.disabled = true;
    el.submitLabel.textContent = label;
  }
  el.again.disabled = true;
  el.againLabel.textContent = label;
}

function showSuccess() {
  el.form.hidden = true;
  el.success.hidden = false;
}

function showForm() {
  el.success.hidden = true;
  el.form.hidden = false;
  clearError();
  el.text.value = "";
  updateCounter();
  el.text.focus();
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

async function send() {
  setBusy(true);
  clearError();

  try {
    if (!navigator.onLine) {
      const err = new Error("offline");
      err.code = "hollow/offline";
      throw err;
    }

    const { db, fs, uid } = await stage("connect", loadFirebase());

    if (!throttleClaimed) {
      try {
        throttleAttempted = true;
        await stage(
          "throttle",
          fs.setDoc(fs.doc(db, "throttle", uid), {
            lastPost: fs.serverTimestamp(),
          })
        );
      } catch (err) {
        // A denial on a *retry* means our own earlier throttle write actually
        // landed and only its response was lost — claim it and carry on.
        if (err.code === "permission-denied" && throttleAttempted && pending?.retried) {
          throttleClaimed = true;
        } else {
          throw err;
        }
      }
      throttleClaimed = true;
    }

    await stage(
      "message",
      fs.addDoc(fs.collection(db, "messages"), {
        text: pending.text,
        name: pending.name,
        anonymous: pending.anonymous,
        uid,
        createdAt: fs.serverTimestamp(),
      })
    );

    onSent();
  } catch (err) {
    onFailed(err);
  } finally {
    setBusy(false);
  }
}

function onSent() {
  writeLastPost(Date.now());
  pending = null;
  throttleAttempted = false;
  throttleClaimed = false;
  el.text.value = "";
  updateCounter();
  showSuccess();
  startCooldown();
}

function onFailed(err) {
  const code = err?.code || "";

  if (code === "hollow/offline") {
    showError("لا يوجد اتصال بالإنترنت. تأكد من الشبكة وحاول مرة ثانية.", {
      retryable: true,
    });
    return;
  }

  if (code === "hollow/timeout") {
    showError("الاتصال بطيء ولم تصل الرسالة. حاول مرة ثانية.", { retryable: true });
    return;
  }

  if (err?.stage === "throttle" && code === "permission-denied") {
    // Server-side rate limit: the 45s window has not elapsed for this uid.
    writeLastPost(Date.now());
    pending = null;
    throttleAttempted = false;
    throttleClaimed = false;
    showError("أرسلت رسالة قبل قليل. انتظر شوي قبل الرسالة الثانية.");
    startCooldown();
    return;
  }

  if (err?.stage === "message" && code === "permission-denied") {
    showError("تعذّر قبول الرسالة. تأكد أن النص والاسم ضمن الحد المسموح.");
    pending = null;
    return;
  }

  if (code === "unavailable" || code === "auth/network-request-failed") {
    showError("تعذّر الوصول للخادم. تأكد من الشبكة وحاول مرة ثانية.", {
      retryable: true,
    });
    return;
  }

  showError("صار خطأ غير متوقع. حاول مرة ثانية.", { retryable: true });
}

async function onSubmit(event) {
  event.preventDefault();
  if (busy) return;

  const remaining = cooldownRemaining();
  if (remaining > 0) {
    showError(`انتظر ${clockLabel(remaining)} قبل إرسال رسالة ثانية.`);
    startCooldown();
    return;
  }

  const text = normalizeText(el.text.value);
  const name = normalizeName(el.name.value);

  // Reflect the cleaned-up values so the visitor sees exactly what is sent.
  el.text.value = text;
  el.name.value = name;
  updateCounter();

  const textCheck = validateMessage(text);
  if (!textCheck.ok) {
    showError(textCheck.error);
    el.text.focus();
    return;
  }

  const nameCheck = validateName(name);
  if (!nameCheck.ok) {
    showError(nameCheck.error);
    el.name.focus();
    return;
  }

  pending = { text, name, anonymous: el.anon.checked, retried: false };
  throttleAttempted = false;
  throttleClaimed = false;
  await send();
}

function onRetry() {
  if (busy) return;
  if (!pending) {
    onSubmit(new Event("submit"));
    return;
  }
  pending.retried = true;
  send();
}

// ---------------------------------------------------------------------------
// Network banner
// ---------------------------------------------------------------------------

function renderConnectivity() {
  el.offlineBar.hidden = navigator.onLine;
}

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

el.form.addEventListener("submit", onSubmit);
el.retry.addEventListener("click", onRetry);
el.again.addEventListener("click", showForm);
el.text.addEventListener("input", updateCounter);
window.addEventListener("online", renderConnectivity);
window.addEventListener("offline", renderConnectivity);

updateCounter();
renderConnectivity();
if (cooldownRemaining() > 0) startCooldown();

// Warm up auth + SDK in the background so the first submit is instant.
if ("requestIdleCallback" in window) {
  requestIdleCallback(() => loadFirebase().catch(() => {}), { timeout: 2000 });
} else {
  setTimeout(() => loadFirebase().catch(() => {}), 600);
}
