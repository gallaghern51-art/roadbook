import React, { useEffect, useState } from 'react';

// Real signage for every route, downloaded — with a local override.
//
// Order, first hit wins:
//
//   1. public/shields/<ROUTE>.svg|png|webp — the override folder. Anything
//      dropped in there beats the download, no code change and no list: the
//      filename IS the route key. For routes where Commons is wrong, missing,
//      or has a worse drawing than one you sourced yourself.
//   2. the `shield` function — resolves the route on Wikimedia Commons and
//      caches it immutably for a year at the CDN and in the browser, so a road
//      is fetched once and is offline after that. This already returns the real
//      state designs: Wyoming's bucking horse, South Dakota's state outline,
//      Idaho's silhouette, Montana's square.
//
// If both miss, the route number is set as plain type. It is deliberately NOT
// drawn into a shield shape — a hand-made lozenge in roughly the right colours
// reads as signage while being wrong, which is worse than honest text.
const SOURCES = (label) => [
  `/shields/${label}.svg`,
  `/shields/${label}.png`,
  `/shields/${label}.webp`,
  `/.netlify/functions/shield?route=${encodeURIComponent(label)}`,
];

// Resolutions, remembered for the page load. Two reasons, and the second is
// the one that was a bug: a route resolves once instead of once per mount, and
// a REMOUNT of a road already resolved renders its artwork on the first frame.
//
// Field report, Aug 16 2026: "when the road signs load there is a brief
// flashing where it just says the road name, I ninety for example, and then it
// turns into the icon." The plain-type fallback was rendered while the artwork
// was still being fetched, so every sign announced itself as text first. It is
// the answer for a route no source has, not a loading state — until the search
// is finished this component renders NOTHING, and the sign simply appears.
//
//   label → string (the artwork's URL) | null (searched, nothing found)
const RESOLVED = new Map();

export default function RoadShield({ road, className = '' }) {
  const label = `${road.prefix}-${road.num}`;
  // undefined = still looking. Distinct from null, which means "looked and
  // there is no artwork for this route" — the only case that gets plain type.
  const [art, setArt] = useState(() => (RESOLVED.has(label) ? RESOLVED.get(label) : undefined));
  const dim = road.inherited ? ' inherited' : '';

  useEffect(() => {
    if (RESOLVED.has(label)) { setArt(RESOLVED.get(label)); return undefined; }
    let alive = true;
    setArt(undefined);
    // The walk finishes even if this instance unmounts — filling the cache is
    // the point, and the next sign for this route wants the answer already in.
    const tryNext = ([src, ...rest]) => {
      if (!src) {
        RESOLVED.set(label, null);
        if (alive) setArt(null);
        return;
      }
      const img = new Image();
      img.onload = () => {
        if (img.naturalWidth <= 0) { tryNext(rest); return; }
        RESOLVED.set(label, src);
        if (alive) setArt(src);
      };
      img.onerror = () => tryNext(rest);
      img.src = src;
    };
    tryNext(SOURCES(label));
    return () => { alive = false; };
  }, [label]);

  if (art === undefined) return null; // nothing, rather than the wrong thing
  if (art) {
    return <img className={`shield-img${dim} ${className}`.trim()} src={art} alt={label} title={label} />;
  }
  return <i className={`shield-text${dim} ${className}`.trim()}>{label}</i>;
}
