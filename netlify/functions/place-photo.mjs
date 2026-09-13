// A place photo, by the name Place Details handed out — Google Places (New)
// Photo media, key server-side. GET ?name=places/…/photos/…&w=900 answers a
// 302 to the image itself (Google's CDN serves the bytes; we never proxy
// them), cached a day so a sheet reopened is free. One photo per sheet open
// is the whole spend — the list rows never ask.
const NAME_RE = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/;

export default async (req) => {
  if (req.method !== 'GET') return new Response('GET only', { status: 405 });
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) return new Response('GOOGLE_MAPS_API_KEY not configured', { status: 501 });
  const url = new URL(req.url);
  const name = url.searchParams.get('name') ?? '';
  if (!NAME_RE.test(name)) return new Response('bad photo name', { status: 400 });
  const w = Math.min(1600, Math.max(200, Number(url.searchParams.get('w')) || 900));
  try {
    const res = await fetch(`https://places.googleapis.com/v1/${name}/media?maxWidthPx=${w}&skipHttpRedirect=true&key=${encodeURIComponent(key)}`);
    if (!res.ok) return new Response('photo unavailable', { status: res.status === 404 ? 404 : 502 });
    const json = await res.json();
    if (!json?.photoUri) return new Response('photo unavailable', { status: 502 });
    return new Response(null, { status: 302, headers: { Location: json.photoUri, 'Cache-Control': 'public, max-age=86400' } });
  } catch (e) {
    return new Response(String(e.message).slice(0, 200), { status: 502 });
  }
};
