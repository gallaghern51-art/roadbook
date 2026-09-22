// Sharing places as a link another rider opens in their own Roadbook.
//
// Owner, Sep 22 2026: "share locations to someone with link and they can click
// and open in their roadbook". The link is `<site>/#places=<token>`:
//
//   <id>        a short share stored by netlify/functions/place-share.mjs —
//               what a text message wants
//   i.<data>    the places themselves, base64url JSON, in the link — used
//               only when the share function cannot be reached (offline, a
//               deploy without Blobs), so Share never fails outright
//
// The token rides in the HASH, not the query: a fragment is never sent to a
// server, so the places a rider shares are not written into anyone's access
// logs on the way to the app.

const FN = '/.netlify/functions/place-share';

/** The fields a shared place carries — nothing else of the sharer's profile. */
export function sharePlace(p) {
  const placeId = p.placeId ?? (p.source === 'google' ? p.id : null);
  return {
    name: p.label ?? p.name ?? '',
    address: p.address ?? p.detail ?? '',
    lat: Number(p.lat),
    lng: Number(p.lng),
    ...(placeId ? { placeId } : {}),
    ...(p.note ? { note: p.note } : {}),
    ...(p.placed ? { placed: 'rider' } : {}),
  };
}

const b64url = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

export const inlineToken = (payload) => `i.${b64url(JSON.stringify(payload))}`;

/**
 * Make the link. `payload` is { name, kind, places }. Resolves to
 * { url, inline } — inline=true when the places had to ride in the link.
 */
export async function createShareLink(payload, { fetchImpl = fetch, origin = location.origin } = {}) {
  const body = { name: payload.name, kind: payload.kind, places: (payload.places ?? []).map(sharePlace) };
  try {
    const res = await fetchImpl(FN, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json.id) return { url: `${origin}/#places=${json.id}`, inline: false };
  } catch { /* fall through to a self-contained link */ }
  return { url: `${origin}/#places=${inlineToken(body)}`, inline: true };
}

/** The share token in a location hash, or null. */
export function shareTokenFrom(hash) {
  const m = /^#places=([A-Za-z0-9._-]+)$/.exec(String(hash ?? ''));
  return m ? m[1] : null;
}

/**
 * A share token anywhere in pasted text — a bare link, or the whole message
 * it arrived in ("Photo spots — 2 places in Roadbook https://…/#places=p…").
 * The Home Screen app is how iPhone riders use Roadbook, and iOS never hands
 * it a tapped link (links open in Safari, whose storage is separate), so the
 * rider copies the link and pastes it into the app's search instead.
 */
export function shareTokenIn(text) {
  const m = /#places=([A-Za-z0-9._-]+)/.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/** The shared payload behind a token: { name, kind, places }. Throws when there is none. */
export async function loadShare(token, { fetchImpl = fetch } = {}) {
  if (token.startsWith('i.')) {
    const data = JSON.parse(unb64url(token.slice(2)));
    return normalize(data);
  }
  const res = await fetchImpl(`${FN}?id=${encodeURIComponent(token)}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || 'That share link could not be opened.');
  return normalize(json);
}

function normalize(data) {
  const places = (Array.isArray(data?.places) ? data.places : [])
    .filter((p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng)))
    .map((p) => ({ ...p, lat: Number(p.lat), lng: Number(p.lng), name: String(p.name || 'Pinned spot') }));
  if (!places.length) throw new Error('That share link has no places in it.');
  return { name: String(data?.name || (places.length === 1 ? places[0].name : 'Shared places')), kind: data?.kind === 'list' ? 'list' : 'place', places };
}

/**
 * Hand the link to the phone's share sheet (Messages, WhatsApp…), or copy it.
 * Resolves to 'shared' | 'copied' | 'cancelled' | 'manual' (nothing worked —
 * the caller shows the link to copy by hand).
 */
export async function sendShareLink({ title, text, url }) {
  const data = { title, text, url };
  if (typeof navigator !== 'undefined' && navigator.share && (!navigator.canShare || navigator.canShare(data))) {
    try { await navigator.share(data); return 'shared'; } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
      /* not allowed here — fall back to the clipboard */
    }
  }
  try { await navigator.clipboard.writeText(url); return 'copied'; } catch { return 'manual'; }
}
