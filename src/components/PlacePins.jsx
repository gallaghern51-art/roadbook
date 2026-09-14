import { useEffect, useRef } from 'react';
import mapboxgl from 'mapbox-gl';

// The place picker's candidates as REAL pins — a category glyph and a name,
// tappable, on every basemap. This replaced two circle layers that could not
// carry a name (a symbol layer needs glyphs the raster satellite basemaps do
// not ship) and could not be tapped (owner, Sep 13 2026: "can users look at the
// map and see locations as pins… the satellite view has the location pins as
// flat images you can't interact with"). Google bakes its own POI icons into
// the satellite tiles; basemaps.js now asks it not to, so the only pins on the
// map are ours — the trip's stops, and these while a search is open.
//
// DOM markers, DIFFED rather than rebuilt (the same discipline as RouteShields):
// a search that returns the same eight places must not blink eight pins.
//
//   map    the loaded Mapbox GL map (null while it loads)
//   pins   [{ id, lat, lng, name, glyph, hot }]  — `hot` is the expanded row
//   onTap  (id) → the caller expands that row
//   mode   'plan' | 'ride' — ride pins are bigger, for a glove
export default function PlacePins({ map, pins, onTap, mode = 'plan' }) {
  const have = useRef(new Map()); // id → { p, el, marker, name, glyph }
  const mapRef = useRef(null);
  const tapRef = useRef(onTap);
  tapRef.current = onTap;

  useEffect(() => {
    const marks = have.current;
    if (map !== mapRef.current) {
      marks.forEach((rec) => rec.marker.remove());
      marks.clear();
      mapRef.current = map;
    }
    if (!map) return;
    const want = new Map((pins ?? []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)).map((p) => [String(p.id), p]));
    for (const [id, rec] of [...marks]) {
      if (want.has(id)) continue;
      rec.marker.remove();
      marks.delete(id);
    }
    for (const [id, p] of want) {
      let rec = marks.get(id);
      // a HALO marks a place the map already draws (a tapped POI label): a ring
      // around the basemap's own icon, centred on it, no second glyph or name.
      // It is a different marker shape (anchor centre), so a pin that changes
      // kind is rebuilt.
      const halo = !!p.halo;
      if (rec && rec.halo !== halo) { rec.marker.remove(); marks.delete(id); rec = undefined; }
      if (!rec) {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `pl-pin pl-${mode}${halo ? ' pl-halo' : ''}`;
        el.setAttribute('data-id', id);
        el.dataset.lng = p.lng; el.dataset.lat = p.lat;
        const g = document.createElement('span'); g.className = 'pl-glyph';
        const l = document.createElement('span'); l.className = 'pl-label';
        el.append(g, l);
        // a pin tap is the pin's, never the map's click-to-add
        el.addEventListener('click', (ev) => { ev.stopPropagation(); ev._wpHandled = true; tapRef.current?.(id); });
        el.addEventListener('mousedown', (ev) => ev.stopPropagation());
        el.addEventListener('touchstart', (ev) => ev.stopPropagation(), { passive: true });
        const marker = new mapboxgl.Marker({ element: el, anchor: halo ? 'center' : 'bottom' }).setLngLat([p.lng, p.lat]).addTo(map);
        rec = { p, el, marker, name: null, glyph: null, halo };
        marks.set(id, rec);
      } else if (rec.p.lat !== p.lat || rec.p.lng !== p.lng) {
        rec.marker.setLngLat([p.lng, p.lat]);
        rec.el.dataset.lng = p.lng; rec.el.dataset.lat = p.lat;
      }
      rec.p = p;
      const name = String(p.name ?? '');
      if (rec.name !== name) { rec.el.querySelector('.pl-label').textContent = name.length > 22 ? `${name.slice(0, 21)}…` : name; rec.name = name; }
      const glyph = p.glyph ?? '📍';
      if (rec.glyph !== glyph) { rec.el.querySelector('.pl-glyph').textContent = glyph; rec.glyph = glyph; }
      // the category colours the roundel (Google's grammar: food orange, coffee brown, fuel blue…)
      const cat = `pl-cat-${p.cat ?? 'place'}`;
      if (rec.cat !== cat) { if (rec.cat) rec.el.classList.remove(rec.cat); rec.el.classList.add(cat); rec.cat = cat; }
      rec.el.classList.toggle('hot', !!p.hot);
      rec.el.setAttribute('aria-label', name);
      rec.el.setAttribute('aria-pressed', p.hot ? 'true' : 'false');
    }
  }, [map, pins, mode]);

  useEffect(() => () => { have.current.forEach((rec) => rec.marker.remove()); have.current.clear(); }, []);

  return null;
}
