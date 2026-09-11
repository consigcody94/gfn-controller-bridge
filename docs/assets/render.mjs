// Renders the HTML design sources in this folder to 2x PNGs with headless Chrome for Testing.
//   node docs/assets/render.mjs
import { launch, sleep } from "../../tools/cdp.mjs";
const here = new URL(".", import.meta.url).pathname;
const chrome = await launch({ profile: `${here}.render-profile`, port: 9340, extraArgs: ["--allow-file-access-from-files", "--hide-scrollbars"] });
async function shot(file, query, w, h, out, dsf = 2, transparent = false) {
  const page = await chrome.newPage("about:blank");
  await page.send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: dsf, mobile: false });
  if (transparent) await page.send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });
  await page.send("Page.navigate", { url: `file://${here}${file}${query}` });
  await sleep(600);
  await page.evaluate("document.fonts.ready.then(()=>document.fonts.status)");
  await sleep(200);
  const { writeFileSync } = await import("node:fs");
  const r = await page.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
  writeFileSync(out.startsWith("/") ? out : `${here}${out}`, Buffer.from(r.data, "base64"));
  page.close();
  console.log("wrote", out, `${w * dsf}x${h * dsf}`);
}
try {
  await shot("banner.html", "?h=400", 1280, 400, "banner.png");
  await shot("banner.html", "?h=640", 1280, 640, "social-preview.png");
  await shot("badges.html", "", 1240, 96, "badges.png");
  const ext = new URL("../../extension/icons/", import.meta.url).pathname;
  const { mkdirSync } = await import("node:fs"); mkdirSync(ext, { recursive: true });
  for (const s of [16, 32, 48, 128]) await shot("icon.html", `?s=${s}`, s, s, `${ext}icon${s}.png`, 1, true);
} finally { await chrome.close(); }
