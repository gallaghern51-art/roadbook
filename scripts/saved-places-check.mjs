// Saved places, lists and share links — the engine half (Sep 22, 2026).
//
// Owner: "save the location as favorite or a list and then share locations to
// someone with link and they can click and open in their roadbook". The
// browser sim (tools/sims/saved-places-check.mjs) drives the screens; this
// pins down the rules underneath them, with no browser:
//
//   • the profile: Favorites and lists, what a re-save keeps, what a list
//     delete takes, what the planner is told
//   • the share function: what it stores, what it refuses, the round trip
//   • the link: the short form, the self-contained fallback, and reading back
//
// Run: node scripts/saved-places-check.mjs

import * as P from '../src/engine/profile.js';
import handler, { cleanShare, MAX_PLACES } from '../netlify/functions/place-share.mjs';
import { createShareLink, shareTokenFrom, shareTokenIn, loadShare, sharePlace, inlineToken } from '../src/engine/placeShare.js';

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const shop = { name: "Rosco's Motorcycles", lat: 44.0805, lng: -103.231, detail: 'Rapid City, SD', source: 'google', id: 'g-rosco', placeId: 'g-rosco' };
const pullout = { name: 'US-14A, Lovell', lat: 44.83, lng: -108.4, detail: 'US-14A, Lovell, WY', placed: 'rider' };

console.log('The profile');
{
  // an older build's profile: no lists, a favorite and a home
  let p = P.normalizeProfile({ places: [{ id: 'h', role: 'home', label: 'Home', lat: 40.7, lng: -74 }, { id: 'f', role: 'favorite', label: 'Old fav', lat: 41, lng: -73 }] });
  check('a profile saved before lists existed still loads, every place with an empty list set',
    p.lists.length === 0 && p.places.every((x) => Array.isArray(x.lists) && x.lists.length === 0));

  p = P.addList(p, 'Moto shops', 'ls1');
  p = P.savePlaceTo(p, shop, { favorite: true, lists: ['ls1', 'ls-gone'], note: 'ask for Dave' });
  const s1 = P.findSaved(p, shop);
  check('Save puts a place in Favorites and a list, with its note', s1?.role === 'favorite' && s1.lists.join() === 'ls1' && s1.note === 'ask for Dave');
  check('a list id that does not exist is never stored', !s1.lists.includes('ls-gone'));
  check('a listing keeps its place id, so it reopens as that listing', s1.placeId === 'g-rosco' && s1.address === 'Rapid City, SD');
  check('it is found again by its id from anywhere', !!P.findSaved(p, { lat: 0, lng: 0, placeId: 'g-rosco' }));

  p = P.savePlaceTo(p, pullout, { label: 'Canyon pullout', lists: ['ls1'] });
  const s2 = P.findSaved(p, { lat: 44.83002, lng: -108.40001 });
  check('a dropped pin is found again by position (within 30 m) — it has no id', s2?.label === 'Canyon pullout');
  check('a pin kept in a list but not Favorites is "saved", and stays a placed pin', s2.role === P.SAVED_ROLE && s2.placed === 'rider');
  check('a spot 100 m away is a different place', !P.findSaved(p, { lat: 44.8309, lng: -108.4 }));

  // a re-save EDITS, it does not duplicate
  const before = p.places.length;
  p = P.savePlaceTo(p, shop, { favorite: false, lists: ['ls1'], label: "Rosco's (Dave)" });
  check('saving a saved place again edits it — one row, the new name, out of Favorites', p.places.length === before && P.findSaved(p, shop).label === "Rosco's (Dave)" && P.findSaved(p, shop).role === P.SAVED_ROLE);
  check('…and keeps its note when the sheet sends none', P.findSaved(p, shop).note === 'ask for Dave');

  // nothing ticked = not saved any more
  p = P.savePlaceTo(p, pullout, { lists: [] });
  check('a place left in no list and not a favorite is removed', !P.findSaved(p, pullout));

  // home is one place
  p = P.savePlaceTo(p, { name: 'New house', lat: 40.8, lng: -74.1 }, { role: 'home' });
  const homes = p.places.filter((x) => x.role === 'home');
  check('setting a new Home demotes the old one rather than keeping two', homes.length === 1 && homes[0].label === 'New house');

  // a list delete takes only what was kept for it alone
  p = P.addList(p, 'Photo spots', 'ls2');
  p = P.savePlaceTo(p, pullout, { lists: ['ls2'] });
  p = P.addPlaceToList(p, P.findSaved(p, { lat: 41, lng: -73 }) ?? { lat: 41, lng: -73, name: 'Old fav' }, 'ls2');
  p = P.deleteList(p, 'ls2');
  check('deleting a list removes the places that were only in it', !P.findSaved(p, pullout));
  check('…but never a favorite that was also in it', P.findSaved(p, { lat: 41, lng: -73 })?.role === 'favorite');
  check('…and the list itself is gone', !p.lists.some((l) => l.id === 'ls2'));

  // Save all from a share: a place already saved keeps what it was
  p = P.savePlaceTo(p, { name: 'Diner', lat: 45, lng: -110 }, { favorite: true });
  p = P.addList(p, 'Shared: Beartooth', 'ls3');
  p = P.addPlaceToList(p, { name: 'Diner', lat: 45, lng: -110 }, 'ls3');
  p = P.addPlaceToList(p, { name: 'New spot', lat: 45.2, lng: -110.1 }, 'ls3');
  const diner = P.findSaved(p, { lat: 45, lng: -110 });
  check('adding a place you already had to a shared list keeps it a favorite', diner.role === 'favorite' && diner.lists.includes('ls3'));
  check('a new one arrives as "saved" in that list', P.findSaved(p, { lat: 45.2, lng: -110.1 })?.role === P.SAVED_ROLE);
  check('placesInList reads a list and Favorites alike', P.placesInList(p, 'ls3').length === 2 && P.placesInList(p, 'favorites').some((x) => x.label === 'Diner'));

  const planner = P.placesForPlanner(p);
  const pr = planner.find((x) => x.label === "Rosco's (Dave)");
  check('the planner is told which lists a place is in, by name', JSON.stringify(pr?.lists) === '["Moto shops"]');
  check('…and no notes or ids it cannot use', planner.every((x) => x.note === undefined && x.id === undefined));

  const merged = P.mergeProfiles(P.normalizeProfile({}), { ...p, updatedAt: '2026-09-22T00:00:00Z' });
  check('an account pull brings the lists with the places', merged.lists.length === p.lists.length && merged.places.length === p.places.length);
}

console.log('\nThe share function');
{
  const clean = cleanShare({ name: '  Moto shops  ', kind: 'list', places: [
    { name: 'A', lat: 44, lng: -103, placeId: 'g1', note: 'n', role: 'home', lists: ['x'], secret: 'no' },
    { name: 'bad lat', lat: 'x', lng: 1 },
    { name: 'off the globe', lat: 95, lng: 1 },
    { name: '', lat: 1.23456789, lng: 2 },
  ] });
  check('only located places on the globe are kept', clean.places.length === 2);
  check('only a shared place\'s own fields are stored — never the sharer\'s roles, lists or anything else',
    Object.keys(clean.places[0]).sort().join() === 'address,lat,lng,name,note,placeId');
  check('a nameless place is called something, coordinates are rounded', clean.places[1].name === 'Pinned spot' && clean.places[1].lat === 1.234568);
  check('the name is trimmed and the kind kept', clean.name === 'Moto shops' && clean.kind === 'list');
  check(`at most ${MAX_PLACES} places ride in one link`, cleanShare({ places: Array.from({ length: 150 }, (_, i) => ({ lat: 1, lng: i / 10 })) }).places.length === MAX_PLACES);

  const post = await handler(new Request('http://x/.netlify/functions/place-share', { method: 'POST', body: JSON.stringify({ name: 'Two', kind: 'list', places: [{ name: 'A', lat: 1, lng: 2 }, { name: 'B', lat: 3, lng: 4 }] }) }));
  const { id } = await post.json();
  check('POST answers a short, unguessable id', post.status === 200 && /^p[a-z0-9]{12}$/.test(id ?? ''));
  const got = await handler(new Request(`http://x/.netlify/functions/place-share?id=${id}`));
  const back = await got.json();
  check('GET gives the places back as stored', got.status === 200 && back.places.map((x) => x.name).join() === 'A,B' && back.name === 'Two');
  check('a share is cacheable — it never changes once made', /max-age/.test(got.headers.get('cache-control') ?? ''));
  check('an id that is not one is refused', (await handler(new Request('http://x/?id=../../etc'))).status === 400);
  check('an id with nothing behind it is a 404', (await handler(new Request('http://x/?id=pzzzzzzzzzzzz'))).status === 404);
  check('nothing to share is refused', (await handler(new Request('http://x/', { method: 'POST', body: JSON.stringify({ places: [{ lat: 'x' }] }) }))).status === 400);
  check('an oversized share is refused', (await handler(new Request('http://x/', { method: 'POST', body: 'x'.repeat(70_000) }))).status === 413);
  check('only GET and POST', (await handler(new Request('http://x/', { method: 'DELETE' }))).status === 405);
}

console.log('\nThe link');
{
  const places = [{ ...shop, label: "Rosco's", note: 'ask for Dave', role: 'favorite', lists: ['ls1'], id: 'pl_1' }, { name: 'Café Ñandú — 日本', lat: 45, lng: -110, placed: 'rider' }];
  const sp = sharePlace(places[0]);
  check('a shared place carries its name, place, coordinates and note — not the sharer\'s role, lists or ids',
    sp.name === "Rosco's" && sp.placeId === 'g-rosco' && sp.note === 'ask for Dave' && sp.role === undefined && sp.lists === undefined && sp.id === undefined);

  const ok = await createShareLink({ name: 'Moto', kind: 'list', places }, {
    origin: 'https://roadbook-app.netlify.app',
    fetchImpl: async () => ({ ok: true, json: async () => ({ id: 'pabcdefghijkl' }) }),
  });
  check('the link is the site with the id in the HASH (never sent to a server)', ok.url === 'https://roadbook-app.netlify.app/#places=pabcdefghijkl' && !ok.inline);

  const down = await createShareLink({ name: 'Moto', kind: 'list', places }, {
    origin: 'https://roadbook-app.netlify.app',
    fetchImpl: async () => { throw new Error('offline'); },
  });
  check('with the share function unreachable, the places ride IN the link instead of Share failing', down.inline && /#places=i\./.test(down.url));
  const token = shareTokenFrom(new URL(down.url).hash);
  const read = await loadShare(token);
  check('that link reads back with every place, accents and all', read.places.length === 2 && read.places[1].name === 'Café Ñandú — 日本' && read.name === 'Moto');
  check('the token is read from a hash and nothing else', shareTokenFrom('#places=pabc') === 'pabc' && shareTokenFrom('#trip=pabc') === null && shareTokenFrom('#places=a b') === null);

  // pasted into the Home Screen app's search (iOS never hands it a tapped link)
  check('a pasted link is found on its own', shareTokenIn('https://roadbook-app.netlify.app/#places=pabcdefghijkl') === 'pabcdefghijkl');
  check('…and inside the whole message it came in, stopping at the link\'s end',
    shareTokenIn("Photo spots — 2 places in Roadbook https://roadbook-app.netlify.app/#places=pabcdefghijkl see you Friday") === 'pabcdefghijkl');
  check('…and the self-contained form too', shareTokenIn(`look: ${down.url}`) === token);
  check('ordinary search text is not a link', shareTokenIn('Rosco\'s Motorcycles') === null && shareTokenIn('#trip=abc') === null && shareTokenIn('') === null && shareTokenIn(null) === null);

  const viaServer = await loadShare('pabcdefghijkl', { fetchImpl: async (u) => ({ ok: /id=pabcdefghijkl/.test(u), json: async () => ({ name: 'Moto', kind: 'list', places: [{ name: 'A', lat: 1, lng: 2 }] }) }) });
  check('a short link reads back through the function', viaServer.places[0].name === 'A');
  let threw = '';
  try { await loadShare('pzzzzzzzzzzzz', { fetchImpl: async () => ({ ok: false, json: async () => ({ error: 'This share link has no places behind it.' }) }) }); } catch (e) { threw = e.message; }
  check('a dead link throws the reason, for the screen to show', /no places behind it/.test(threw));
  let empty = '';
  try { await loadShare(inlineToken({ name: 'x', places: [] })); } catch (e) { empty = e.message; }
  check('a link with no places in it is refused, not shown as an empty list', /no places/.test(empty));
}

console.log(`\n${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
