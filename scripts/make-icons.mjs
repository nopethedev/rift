// Renders the Rift logo to the PNG icons used by the web app manifest / iOS / favicon (run once; the PNGs are committed).
//   PLAYWRIGHT_RESOLVE_FROM=/opt/node-tools/ node scripts/make-icons.mjs
import { createRequire } from "node:module";
import fs from "node:fs";
const require = createRequire(process.env.PLAYWRIGHT_RESOLVE_FROM || import.meta.url);
const { chromium } = require("playwright");

// full = edge-to-edge square (maskable / apple-touch: the OS applies its own mask); !full = the rounded logo on transparent
const svg = (full, inner) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="100%" height="100%">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8B5CF6"/><stop offset="1" stop-color="#6D28D9"/></linearGradient></defs>
  <rect width="32" height="32" rx="${full ? 0 : 9}" fill="url(#g)"/>
  <g transform="translate(16 16) scale(${inner}) translate(-16 -16)">
    <path d="M11 8h6.5a5 5 0 0 1 1.8 9.66L22 24h-3.6l-2.4-5.5H14V24h-3V8Zm3 3v4.5h3.4a2.25 2.25 0 0 0 0-4.5H14Z" fill="#fff"/>
    <path d="M9 26 25 6" stroke="#0B0B12" stroke-width="1.6" stroke-linecap="round" opacity=".55"/>
  </g></svg>`;
const OUT = [
  ["public/icons/icon-192.png", 192, false, 1], ["public/icons/icon-512.png", 512, false, 1],
  ["public/icons/maskable-512.png", 512, true, 0.72], // logo kept inside the 80 % safe zone
  ["src/app/apple-icon.png", 180, true, 0.8], ["src/app/icon.png", 256, false, 1],
];
const b = await chromium.launch();
for (const [file, size, full, inner] of OUT) {
  const p = await b.newPage({ viewport: { width: size, height: size } });
  await p.setContent(`<body style="margin:0;background:transparent">${svg(full, inner)}</body>`);
  await p.screenshot({ path: file, omitBackground: !full });
  await p.close();
  console.log(file, size, fs.statSync(file).size, "bytes");
}
await b.close();
