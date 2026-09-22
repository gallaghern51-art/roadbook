// Share a place, or a whole list of places, as a short link.
//
// Owner, Sep 22 2026: "save the location as favorite or a list and then share
// locations to someone with link and they can click and open in their
// roadbook". A link has to survive a text message, so it is short — the places
// live here, in Netlify Blobs (store "place-shares"), under an unguessable id,
// and the link is just `/#places=<id>`. The client can also build a link that
// carries the places inline (no server) when this is unreachable; see
// src/engine/placeShare.js.
//
//   POST { name, kind: 'place'|'list', places: [{ name, address, lat, lng, placeId, note, placed }] }
//        → { id }
//   GET  ?id=<id> → the same payload, as stored
//
// No account and no key: possession of the link is the whole permission, the
// same as a Google Maps list link. What is stored is only what the sharer
// chose to share — names, coordinates, a note — never their other places, and
// a share is immutable once made (a new share is a new link).
//
// Local dev runs functions inside the vite process, where Blobs has no site
// context: a module-level Map stands in, exactly as collab.mjs does it.

const devMem = new Map();
const memStore = {
  get: async (k) => devMem.get(k) ?? null,
  setJSON: async (k, v) => { devMem.set(k, v); },
};
let blobsMod;
async function store() {
  if (blobsMod === undefined) {
    try { blobsMod = await import('@netlify/blobs'); } catch { blobsMod = null; }
  }
  if (blobsMod) {
    try { return blobsMod.getStore({ name: 'place-shares', consistency: 'strong' }); } catch { /* fall through */ }
  }
  return memStore;
}

export const MAX_PLACES = 100;
const MAX_BYTES = 64_000;
const ID_RE = /^p[a-z0-9]{12}$/;

const clip = (v, n) => String(v ?? '').trim().slice(0, n);

/** The payload as stored: only the fields a shared place needs, clipped and checked. */
export function cleanShare(body) {
  const places = (Array.isArray(body?.places) ? body.places : [])
    .filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)) && Math.abs(Number(p.lat)) <= 90 && Math.abs(Number(p.lng)) <= 180)
    .slice(0, MAX_PLACES)
    .map((p) => ({
      name: clip(p.name, 120) || 'Pinned spot',
      address: clip(p.address, 200),
      lat: Number(Number(p.lat).toFixed(6)),
      lng: Number(Number(p.lng).toFixed(6)),
      ...(p.placeId ? { placeId: clip(p.placeId, 200) } : {}),
      ...(p.note ? { note: clip(p.note, 500) } : {}),
      ...(p.placed ? { placed: 'rider' } : {}),
    }));
  return {
    v: 1,
    kind: body?.kind === 'list' ? 'list' : 'place',
    name: clip(body?.name, 80) || (places.length === 1 ? places[0].name : 'Shared places'),
    places,
    createdAt: new Date().toISOString(),
  };
}

const newId = () => {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `p${Array.from(bytes, (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('')}`;
};

const json = (status, body, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', ...headers },
});

export default async (req) => {
  const s = await store();
  if (req.method === 'GET') {
    const id = new URL(req.url).searchParams.get('id') ?? '';
    if (!ID_RE.test(id)) return json(400, { error: 'not a share link' });
    let share = null;
    try { share = await s.get(`share/${id}`, { type: 'json' }); } catch { share = await memStore.get(`share/${id}`); }
    if (typeof share === 'string') { try { share = JSON.parse(share); } catch { share = null; } }
    if (!share) return json(404, { error: 'This share link has no places behind it.' });
    // a share never changes once made, so a browser may keep it
    return json(200, share, { 'cache-control': 'public, max-age=3600' });
  }
  if (req.method !== 'POST') return json(405, { error: 'GET or POST' });

  const raw = await req.text();
  if (raw.length > MAX_BYTES) return json(413, { error: 'too many places for one link' });
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: 'bad JSON' }); }
  const share = cleanShare(body);
  if (!share.places.length) return json(400, { error: 'nothing to share — no place has a location' });

  const id = newId();
  try {
    await s.setJSON(`share/${id}`, share);
  } catch {
    await memStore.setJSON(`share/${id}`, share);
  }
  return json(200, { id });
};
