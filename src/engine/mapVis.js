// Is a ground point actually on screen?
//
// MapLibre keeps DOM markers in the document wherever they land — it never
// removes an off-screen one. A stop 200 miles up the trip still has a live
// element, and with a pitched chase camera its projected x swings by thousands
// of pixels between frames (the perspective divide runs away as the point
// approaches, then crosses, the camera plane). Anything that MEASURES marker
// elements has to reject those itself; the map will not do it for you.
//
// Field report, Aug 15 2026 — "on ride mode the labels for stops shoot across
// the screen continuously, seems like it's trying to show them even if it's
// far away": Ride Mode's edge clamp measured every stop in the day, found the
// rest of them at x = -700000px, and dutifully slid them back inside the
// frame. Under a chase camera that fires on every camera settle, forever.
//
// A note on the horizon, since it is the obvious next worry: a pitched camera
// would fold ground beyond the horizon back into the top of the frame, where a
// stop hundreds of miles away renders as if it were up the road. It cannot
// happen here. MapLibre's ground is a flat plane and its horizon line sits at
// pitch 90 minus the half-FOV (~18°) above the camera axis — off the top of
// the frame for any pitch it allows (max 60; Ride Mode uses 55). Screen bounds
// are the whole answer. If maxPitch is ever raised past ~70, this needs a
// horizon test to go with it.

const asLL = (p) => (Array.isArray(p) ? { lng: p[0], lat: p[1] } : { lng: p.lng, lat: p.lat });

/**
 * Build a visibility test for the map's CURRENT camera. Call once per pass and
 * reuse it for every point — it measures the container once.
 *
 * @param {import('maplibre-gl').Map} map
 * @param {{pad?: number}} opts  pad: px of slack outside the container, for
 *   markers that should appear a beat before they slide into frame
 * @returns {(lngLat: [number,number]|{lng:number,lat:number}) => {x:number,y:number}|null}
 *          the screen point when the location is genuinely on screen, else null
 */
export function viewGate(map, { pad = 0 } = {}) {
  const box = map.getContainer();
  const w = box.clientWidth;
  const h = box.clientHeight;

  return (lngLat) => {
    if (!w || !h) return null;
    const ll = asLL(lngLat);
    if (!Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) return null;
    const p = map.project([ll.lng, ll.lat]);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    if (p.x < -pad || p.x > w + pad || p.y < -pad || p.y > h + pad) return null;
    return p;
  };
}

// ---- where the route line belongs in the layer stack ----
// Field observation, Aug 16 2026: "it actually looks like the maps already
// have road signs but they are just covered by the route marker. Is it
// possible to just have the map native road markers lay above route marker?"
// Correct, and worth doing wherever the style allows it — the basemap's own
// signage is complete (every road, not just the one you are routed down),
// properly collided by the renderer, and free.
//
// Whether it is possible depends entirely on how the basemap is built:
//
//   vector (liberty / positron / dark) — every label, road shields included,
//     is a SYMBOL layer sitting above the fills and lines. Insert the route
//     before the first one and the whole label set paints over it.
//   Esri hybrid — the imagery is one opaque raster, but the road network and
//     the place names ride above it as TRANSPARENT raster overlays. The route
//     belongs between them.
//   Google Map Tiles — satellite, roads, shields and labels are baked into
//     ONE opaque image. There is no layer to raise, at any price. This is the
//     case RouteShields exists for, and the reason it cannot simply be
//     deleted in favour of reordering.
//
// Our own layers are skipped when scanning: the route's direction chevrons
// are themselves a symbol layer, and finding those would walk the floor down
// a notch on every redraw.
const OUR_LAYERS = /^(route-|leg-hi|ride-route|ride-live)/;

export function labelFloorId(map) {
  const layers = map?.getStyle?.()?.layers ?? [];
  const theirs = layers.filter((l) => !OUR_LAYERS.test(l.id));
  if (!theirs.length) return null;
  const sym = theirs.find((l) => l.type === 'symbol');
  if (sym) return sym.id;
  const overlay = theirs.slice(1).find((l) => l.type === 'raster');
  return overlay ? overlay.id : null;
}
