// Building a long trip in passes — decided BEFORE the first request, not
// after the first failure.
//
// A 30-day itinerary is minutes of model output however long the function
// may run: on Netlify's streaming path (~50 s) it cannot finish, on the
// background path (10 min) it can but the rider stares at a counter for the
// whole of it, and either way one dropped connection loses all thirty days.
// So the intake's day count decides the plan up front: passes of a size the
// transport can carry, each continuing from where the last ended, each landing
// in the trip as it arrives. The first pass CREATES the trip; every later
// pass appends its days with the insert_days op, so a rider who closes the
// door mid-build keeps what was built.
//
// Pure helpers; the loop that drives them lives in TripConstructionChat.

// Days per pass, by the transport that carried the previous one. Measured
// budgets: the background function has a 10-minute planner budget, the
// streaming fallback about 50 s — and a full-trip generate of ~6 days "barely
// fits" that window (planner.js), so 4 is the honest streaming size.
export const PASS_DAYS = { background: 8, stream: 4 };

export const passSizeFor = (transport) => PASS_DAYS[transport] ?? PASS_DAYS.stream;

/** Is this trip big enough to build in passes at all? */
export const needsPasses = (totalDays, transport = 'background') => Number(totalDays) > passSizeFor(transport);

/**
 * The next pass: days `from`…`to` (1-based, inclusive) of `total`.
 * Returns null when nothing is left.
 */
export function nextPass(from, total, size) {
  const n = Number(total) || 0;
  if (from > n) return null;
  const to = Math.min(n, from + Math.max(1, size) - 1);
  return { from, to, total: n, last: to === n };
}

/** What a pass says while it runs. */
export const passLabel = ({ from, to, total }) => (from === 1 && to === total
  ? 'Writing the confirmed trip'
  : `Building days ${from}–${to} of ${total}`);

/**
 * What the next pass needs to know about the days already built: enough to
 * continue from the right place — the last stop of the previous day is the
 * start of the next — without re-sending whole days. The most recent days
 * carry their stops; older ones only their title, so the prompt stays small
 * on a 30-day trip.
 */
export function priorDaysDigest(days, { detailLast = 4 } = {}) {
  const list = Array.isArray(days) ? days : [];
  return list.map((d, i) => {
    const wps = (d.waypoints ?? []).filter((w) => Number.isFinite(w?.lat) && Number.isFinite(w?.lng));
    const end = wps[wps.length - 1];
    const base = { day: i + 1, date: d.date ?? null, title: d.title ?? '', phase: d.phase ?? 'outbound' };
    if (i < list.length - detailLast) return base;
    return {
      ...base,
      from: wps[0]?.name ?? null,
      to: end ? { name: end.name, lat: end.lat, lng: end.lng, ...(end.placeId ? { placeId: end.placeId } : {}) } : null,
      stops: wps.length,
      lodging: d.lodging?.name || d.lodging?.where || null,
    };
  });
}

/** After a pass ran out of room, try a smaller one — halved, never below two days. */
export const shrinkPass = (size) => Math.max(2, Math.floor(size / 2));
