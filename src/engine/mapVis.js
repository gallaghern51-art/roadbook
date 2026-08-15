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
