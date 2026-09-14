#!/usr/bin/env node
// Rasterise the Roadbook route mark into the PNGs iOS and Android require.
//
// iOS silently IGNORES an SVG apple-touch-icon — it falls back to a generated
// letter tile, which is why the installed PWA showed a plain "R" instead of
// the route mark (field-reported Aug 12, 2026). Android's maskable icons need
// the artwork inside the center safe zone or the launcher crops it.
//
// Chromium (already present for the GPS sims) does the rasterising, so there
// is no new image dependency.
//
//   node scripts/make-icons.mjs
//
// Re-run whenever public/icon.svg changes; the PNGs are committed.

import { writeFileSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { join } from 'path';
import { chromium } from 'playwright-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUB = join(ROOT, 'public');
const BG = '#1a1a1a';

// The mark itself: the SAME artwork as the in-app lockup (RoadbookBrand in
// src/components/Chrome.jsx — a 36-unit box: the route in rally orange, a
// turquoise departure dot, a finish FLAG in ink), scaled so the mark's own
// frame fills the tile. The tile IS the frame, so the inner rect is dropped.
// Stroke widths scale with it (2.2 → ~38px at 512). Kept in sync with
// public/icon.svg by hand — change one, change both, re-run this script.
//
// Sep 14, 2026 — owner, home-screen screenshot: "the icon is a flag at end,
// did it get updated?" It had not: the PNGs still carried the Aug 12 dot-and-
// ring finish from before the mark got its flag.
const S = 17.5;                              // 36-box units → px
const DX = (512 - 26 * S) / 2 - 5 * S;       // centre the mark's 26×27 frame
const DY = (512 - 27 * S) / 2 - 4.5 * S;
const MARK = `
  <g transform="translate(${DX} ${DY}) scale(${S})" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 26.5c2.8-1.1 3.8-4.6 6.3-5.4 2.9-.9 4 2 6.3.7 2.2-1.2.9-4.2 3.3-6.2 1.4-1.1 2.2-2.7 2.2-5.1"
          fill="none" stroke="#f53f1f" stroke-width="2.2"/>
    <circle cx="9" cy="26.5" r="1.7" fill="#56c5c8"/>
    <path d="M25.4 8.4v5.5m0-5.2h4l-1.3 1.5 1.3 1.5h-4" fill="none" stroke="#ffffff" stroke-width="1.35"/>
  </g>
`;

// scale: 1 fills the tile (iOS rounds its own corners); < 1 insets the mark
// into a maskable icon's safe zone. radius 0 = full bleed square.
const svg = ({ scale = 1, radius = 0 }) => {
  const inset = (512 * (1 - scale)) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" rx="${radius}" fill="${BG}"/>
  <g transform="translate(${inset} ${inset}) scale(${scale})">${MARK}</g>
</svg>`;
};

const TARGETS = [
  // iOS home screen: full bleed, iOS applies its own squircle mask
  { file: 'apple-touch-icon.png', size: 180, svg: svg({ scale: 1, radius: 0 }) },
  // Android / desktop PWA
  { file: 'icon-192.png', size: 192, svg: svg({ scale: 1, radius: 96 }) },
  { file: 'icon-512.png', size: 512, svg: svg({ scale: 1, radius: 96 }) },
  // maskable: launcher may crop to a circle — keep the mark in the safe zone
  { file: 'icon-maskable-512.png', size: 512, svg: svg({ scale: 0.62, radius: 0 }) },
];

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? '/opt/pw-browsers/chromium',
  args: ['--enable-unsafe-swiftshader'],
});

for (const t of TARGETS) {
  const page = await browser.newPage({
    viewport: { width: t.size, height: t.size },
    deviceScaleFactor: 1,
  });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:${BG}}svg{display:block;width:${t.size}px;height:${t.size}px}</style>${t.svg}`,
    { waitUntil: 'load' }
  );
  const buf = await page.screenshot({ omitBackground: false });
  writeFileSync(join(PUB, t.file), buf);
  await page.close();
  console.log(`  ✓ public/${t.file} (${t.size}×${t.size}, ${(buf.length / 1024).toFixed(1)} kB)`);
}

await browser.close();

// sanity: every PNG is a real PNG with the expected pixel dimensions
for (const t of TARGETS) {
  const b = readFileSync(join(PUB, t.file));
  const isPng = b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG';
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  if (!isPng || w !== t.size || h !== t.size) {
    console.error(`  ✗ ${t.file}: png=${isPng} ${w}×${h}, expected ${t.size}×${t.size}`);
    process.exit(1);
  }
}
console.log('\nAll icons written and verified.');
