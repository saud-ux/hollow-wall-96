// ============================================================================
// Hollow — reusable QR module
// Used by screen.html (corner panel) and qr.html (printable sheet).
//
// Generation is 100% client-side via the `qrcode-generator` UMD build on
// cdnjs (global `qrcode`). Output is a single-path SVG, so it stays razor
// sharp at 1080p, 4K and on paper without re-rendering.
// ============================================================================

const LIB_SRC =
  "https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js";
const LIB_SRI =
  "sha512-ZDSPMa/JM1D+7kdg2x3BsruQ6T/JpJo3jWDWkCZsP+5yVyp1KfESqLI+7RqB5k24F7p2cV7i2YHh/890y6P6Sw==";

const SVG_NS = "http://www.w3.org/2000/svg";

let libPromise = null;

function loadLibrary() {
  if (typeof window.qrcode === "function") return Promise.resolve(window.qrcode);
  if (libPromise) return libPromise;

  libPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = LIB_SRC;
    script.integrity = LIB_SRI;
    script.crossOrigin = "anonymous";
    script.referrerPolicy = "no-referrer";
    script.async = true;
    script.onload = () => {
      if (typeof window.qrcode === "function") resolve(window.qrcode);
      else reject(new Error("qrcode library loaded without its global"));
    };
    script.onerror = () => {
      script.remove();
      reject(new Error("qrcode library failed to load"));
    };
    document.head.append(script);
  });

  // A failed CDN fetch must not poison later attempts.
  libPromise.catch(() => {
    libPromise = null;
  });

  return libPromise;
}

/**
 * The public URL of the visitor form, derived from wherever this page is
 * served. On Netlify, screen.html and qr.html both resolve to the site root.
 */
export function visitorUrl(from = location.href) {
  return new URL("./", from).href;
}

/**
 * Build an <svg> QR code for `text`.
 *
 * @param {string} text
 * @param {object} [options]
 * @param {"L"|"M"|"Q"|"H"} [options.ecl="M"]  error-correction level
 * @param {number} [options.margin=2]          quiet zone, in modules
 * @param {string} [options.dark="#0B0F0D"]    module colour
 * @param {string} [options.light="#F4EFE4"]   background colour
 * @param {string} [options.label]             accessible name
 * @returns {Promise<SVGSVGElement>}
 */
export async function createQrSvg(
  text,
  { ecl = "M", margin = 2, dark = "#0B0F0D", light = "#F4EFE4", label } = {}
) {
  const qrcode = await loadLibrary();
  const qr = qrcode(0, ecl);
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const size = count + margin * 2;

  // One path; each horizontal run of dark modules becomes a single rectangle.
  let d = "";
  for (let row = 0; row < count; row++) {
    let col = 0;
    while (col < count) {
      if (!qr.isDark(row, col)) {
        col++;
        continue;
      }
      const start = col;
      while (col < count && qr.isDark(row, col)) col++;
      const run = col - start;
      d += `M${start + margin} ${row + margin}h${run}v1h-${run}z`;
    }
  }

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label || text);

  const background = document.createElementNS(SVG_NS, "rect");
  background.setAttribute("width", String(size));
  background.setAttribute("height", String(size));
  background.setAttribute("fill", light);

  const modules = document.createElementNS(SVG_NS, "path");
  modules.setAttribute("d", d);
  modules.setAttribute("fill", dark);

  svg.append(background, modules);
  return svg;
}

/** Render a QR code into `target`, replacing its contents. */
export async function renderQr(target, text, options) {
  const svg = await createQrSvg(text, options);
  target.replaceChildren(svg);
  return svg;
}
