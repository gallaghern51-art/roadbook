#!/usr/bin/env node
// Rasterise the Roadbook route mark into the PNGs iOS and Android require.
//
// iOS silently IGNORES an SVG apple-touch-icon — it falls back to a generated
// letter tile, which is why the installed PWA showed a plain "R" instead of
// the route mark (field-reported Aug 12, 2026). Android's maskable icons need
// the artwork inside the centre safe zone or the launcher crops it.
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
const BG = '#14110d';

// The mark itself, sized to a 512 box: a route running between two points —
// gold departure dot, cream destination ring. Kept in sync with icon.svg.
const MARK = `
  <path d="M 96 400 C 160 400 140 280 220 280 C 300 280 260 160 360 150 C 400 146 420 170 416 200"
        fill="none" stroke="#e8622c" stroke-width="34" stroke-linecap="round"/>
  <circle cx="96" cy="400" r="40" fill="#e5a83b"/>
  <circle cx="416" cy="200" r="28" fill="#f0e3c8"/>
  <circle cx="416" cy="200" r="52" fill="none" stroke="#f0e3c8" stroke-width="10" opacity="0.45"/>
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
  executablePath: '/opt/pw-browsers/chromium',
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
