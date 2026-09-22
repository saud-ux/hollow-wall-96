// ============================================================================
// Hollow — validation & content guards
// Pure functions. No DOM, no Firebase. Safe to import anywhere.
// ============================================================================

export const MAX_TEXT = 150;
export const MAX_NAME = 20;

// Arabic-Indic (٠-٩) and Extended Arabic-Indic (۰-۹) digits.
const ARABIC_DIGITS = /[٠-٩۰-۹]/g;

// Zero-width, bidi overrides and other invisible characters. Stripped so that
// nobody can pad a message with them or flip the layout on the TV.
const INVISIBLES = /[​-‍‎‏‪-‮⁦-⁩﻿]/g;

const URL_RE =
  /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]{2,}\.(?:com|net|org|sa|io|co|me|ly|app|dev|xyz|info|biz|shop|store|online|site|link|club|tv|gg|edu|gov)\b/i;

/** Convert Arabic-Indic digits to Latin so numeric checks work on both. */
function toLatinDigits(input) {
  return input.replace(ARABIC_DIGITS, (d) => {
    const code = d.codePointAt(0);
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660);
  });
}

/** Render Latin digits as Arabic-Indic, for UI counters and countdowns. */
export function toArabicDigits(input) {
  return String(input).replace(/\d/g, (d) => "٠١٢٣٤٥٦٧٨٩"[Number(d)]);
}

/**
 * True when the string contains something that looks like a contact number.
 * Separators are stripped first so "05 12 34 56 78" is caught too.
 */
function hasPhoneNumber(input) {
  const digitsOnly = toLatinDigits(input).replace(/[\s\-().+_/]/g, "");
  return /\d{7,}/.test(digitsOnly);
}

/**
 * Clean up a message before validating or storing it:
 *   • normalise line endings, drop invisible characters
 *   • collapse horizontal whitespace
 *   • strip excessive newlines (any run becomes a single break)
 *   • collapse a run of the same character beyond 8 (ههههههههههههه → ههههههههه)
 */
export function normalizeText(raw) {
  let t = String(raw ?? "");
  t = t.replace(/\r\n?/g, "\n");
  t = t.replace(INVISIBLES, "");
  t = t.replace(/[^\S\n]+/g, " ");
  t = t.replace(/ *\n */g, "\n");
  t = t.replace(/\n{2,}/g, "\n");
  t = t.replace(/(.)\1{8,}/gu, (_, ch) => ch.repeat(8));
  return t.trim();
}

/** Names are single-line; same invisible/whitespace cleanup, no newlines kept. */
export function normalizeName(raw) {
  return String(raw ?? "")
    .replace(INVISIBLES, "")
    .replace(/\s+/g, " ")
    .replace(/(.)\1{8,}/gu, (_, ch) => ch.repeat(8))
    .trim();
}

/** @returns {{ok: true} | {ok: false, error: string}} */
export function validateMessage(text) {
  if (!text || !text.trim()) {
    return { ok: false, error: "اكتب رسالتك أولًا." };
  }
  // Measured in UTF-16 units to match both <textarea maxlength> and the
  // string.size() check in firestore.rules — never under-count.
  if (text.length > MAX_TEXT) {
    return { ok: false, error: "رسالتك أطول من ١٥٠ حرفًا. اختصرها شوي." };
  }
  if (URL_RE.test(text)) {
    return { ok: false, error: "لا يمكن إرسال روابط في الرسالة." };
  }
  if (hasPhoneNumber(text)) {
    return { ok: false, error: "لا يمكن إرسال أرقام تواصل في الرسالة." };
  }
  return { ok: true };
}

/** @returns {{ok: true} | {ok: false, error: string}} */
export function validateName(name) {
  if (!name || !name.trim()) {
    return { ok: false, error: "اكتب اسمك." };
  }
  if (name.length > MAX_NAME) {
    return { ok: false, error: "الاسم أطول من ٢٠ حرفًا." };
  }
  if (URL_RE.test(name) || hasPhoneNumber(name)) {
    return { ok: false, error: "هذا الاسم غير مقبول." };
  }
  return { ok: true };
}
