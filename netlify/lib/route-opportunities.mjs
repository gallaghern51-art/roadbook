// Valhalla-backed route comparison for the AI construction conversation.
//
// The model chooses candidate anchors and verified businesses; this module
// supplies the facts it cannot safely guess: routed distance/time, detour cost,
// fuel gaps and (best effort) climbing. The compact result is safe to return to
// the model and UI — no giant encoded geometry crosses that boundary.

const DEFAULT_URL = 'https://valhalla1.openstreetmap.de';
const KM_TO_MI = 0.621371;
const M_TO_FT = 3.28084;
export const MAX_ROUTE_LOCATIONS = 20;

const round = (n, places = 0) => Number(Number(n).toFixed(places));
const finite = (n) => Number.isFinite(Number(n));
const locationKey = (location = {}) => {
  if (location.kind === 'start' || location.kind === 'end') return location.kind;
  const name = String(location.name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ' ');
  if (name) return `${location.kind || ''}:${name}`;
  if (location.placeId) return `place:${location.placeId}`;
  const lat = finite(location.lat) ? Number(location.lat).toFixed(4) : '';
  const lng = finite(location.lng) ? Number(location.lng).toFixed(4) : '';
  return `${location.kind || ''}:${lat}:${lng}`;
};

// An additive refinement is a patch, even though the model has to submit a
// complete option for Valhalla. Preserve the old sequence mechanically so an
// abbreviated model reply cannot erase a later day while adding a stop to an
// earlier one. A shortest common supersequence keeps both orderings and uses
// the freshly researched object whenever a location appears in both.
function mergeLocationSequences(previous = [], proposed = []) {
  const a = previous.map(locationKey);
  const b = proposed.map(locationKey);
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const merged = [];
  let i = 0;
  let j = 0;
  while (i < previous.length && j < proposed.length) {
    if (a[i] === b[j]) {
      merged.push({ ...previous[i], ...proposed[j] });
      i++;
      j++;
    } else if (dp[i + 1][j] > dp[i][j + 1]) {
      merged.push(previous[i++]);
    } else {
      merged.push(proposed[j++]);
    }
  }
  while (i < previous.length) merged.push(previous[i++]);
  while (j < proposed.length) merged.push(proposed[j++]);
  return merged;
}

const additiveOnly = (request = '') => {
  const text = String(request).toLowerCase();
  const adds = /\b(add|added|include|insert|another|extra|also)\b/.test(text);
  const removes = /\b(remove|delete|drop|replace|swap|shorten|skip|instead|reroute|re-route|reorder)\b/.test(text);
  return adds && !removes;
};

export function preserveAdditiveRefinement(input, previousConcepts = [], request = '') {
  if (!additiveOnly(request) || !previousConcepts.length) return structuredClone(input ?? {});
  const copy = structuredClone(input ?? {});
  const byId = new Map(previousConcepts.map((concept) => [String(concept.id), concept]));
  const byTitle = new Map(previousConcepts.map((concept) => [String(concept.title || '').trim().toLowerCase(), concept]));
  copy.concepts = (copy.concepts ?? []).map((concept, index) => {
    const prior = byId.get(String(concept.id))
      ?? byTitle.get(String(concept.title || '').trim().toLowerCase())
      ?? previousConcepts[index];
    if (!prior?.locations?.length) return concept;
    return { ...concept, locations: mergeLocationSequences(prior.locations, concept.locations ?? []) };
  });
  return copy;
}
const clock = (minutes) => {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
};
const parseClock = (value) => {
  const match = String(value || '08:00').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return 480;
  return Math.min(1439, Number(match[1]) * 60 + Number(match[2]));
};

function costingOptions(prefs = {}) {
  const style = ['quick', 'touring', 'backroads'].includes(prefs.style) ? prefs.style : 'touring';
  return {
    motorcycle: {
      use_highways: style === 'quick' ? 1 : style === 'backroads' ? 0.05 : 0.5,
      use_tolls: prefs.avoidTolls ? 0 : 0.5,
      use_trails: 0,
    },
  };
}

function decodePolyline6(encoded = '') {
  const points = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    lat += result & 1 ? ~(result >> 1) : result >> 1;
    result = 0;
    shift = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index <= encoded.length);
    lon += result & 1 ? ~(result >> 1) : result >> 1;
    points.push({ lat: lat / 1e6, lon: lon / 1e6 });
  }
  return points;
}

function compactShape(legs, max = 350) {
  const all = legs.flatMap((leg, i) => {
    const pts = decodePolyline6(leg.shape);
    return i ? pts.slice(1) : pts;
  });
  if (all.length <= max) return all;
  const step = (all.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => all[Math.round(i * step)]);
}

async function jsonPost(fetchImpl, url, body, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Valhalla ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

function fuelGapMiles(locations, legs) {
  let running = 0;
  let longest = 0;
  for (let i = 0; i < legs.length; i++) {
    running += Number(legs[i]?.summary?.length) * KM_TO_MI || 0;
    const next = locations[i + 1];
    if (next?.kind === 'fuel' || next?.kind === 'lodging' || i === legs.length - 1) {
      longest = Math.max(longest, running);
      running = 0;
    }
  }
  return longest;
}

function ridingDays(locations, legs, pace, departMin) {
  const days = [];
  let km = 0;
  let rideMinutes = 0;
  let dwellMinutes = 0;
  for (let i = 0; i < legs.length; i++) {
    km += Number(legs[i]?.summary?.length) || 0;
    rideMinutes += (Number(legs[i]?.summary?.time) / 60 || 0) * pace;
    const next = locations[i + 1];
    if (i < legs.length - 1 && next?.kind !== 'lodging') {
      dwellMinutes += finite(next?.dwell) ? Number(next.dwell) : 20;
    }
    if (next?.kind === 'lodging' || i === legs.length - 1) {
      const totalMinutes = rideMinutes + dwellMinutes;
      days.push({
        day: days.length + 1,
        miles: round(km * KM_TO_MI),
        rideMinutes: round(rideMinutes),
        dwellMinutes: round(dwellMinutes),
        totalMinutes: round(totalMinutes),
        arrival: clock(departMin + totalMinutes),
        afterDusk: departMin + totalMinutes > 20 * 60 + 30,
      });
      km = 0;
      rideMinutes = 0;
      dwellMinutes = 0;
    }
  }
  return days;
}

async function elevationFeet(fetchImpl, baseUrl, legs) {
  const shape = compactShape(legs);
  if (shape.length < 2) return null;
  try {
    const data = await jsonPost(fetchImpl, `${baseUrl}/height`, {
      shape,
      range: true,
      resample_distance: 500,
    });
    const heights = data.height ?? [];
    let gain = 0;
    for (let i = 1; i < heights.length; i++) {
      const a = Array.isArray(heights[i - 1]) ? heights[i - 1][1] : heights[i - 1];
      const b = Array.isArray(heights[i]) ? heights[i][1] : heights[i];
      if (finite(a) && finite(b) && b > a) gain += b - a;
    }
    return round(gain * M_TO_FT);
  } catch {
    return null;
  }
}

export async function evaluateRouteOptions(input, {
  fetchImpl = fetch,
  baseUrl = process.env.VALHALLA_URL || DEFAULT_URL,
} = {}) {
  const concepts = Array.isArray(input?.concepts) ? input.concepts.slice(0, 3) : [];
  if (!concepts.length) throw new Error('At least one route concept is required.');
  const comfort = finite(input?.range?.comfort) ? Number(input.range.comfort) : 180;
  const absolute = finite(input?.range?.absolute) ? Number(input.range.absolute) : 200;
  const pace = finite(input?.pace) ? Number(input.pace) : 1.08;
  const departMin = parseClock(input?.depart);

  const options = await Promise.all(concepts.map(async (concept) => {
    const locations = (concept.locations ?? []).filter((p) => finite(p.lat) && finite(p.lng));
    if (locations.length > MAX_ROUTE_LOCATIONS) {
      return {
        id: concept.id,
        title: concept.title,
        error: `has ${locations.length} locations; reduce road-shape anchors but preserve requested stops (maximum ${MAX_ROUTE_LOCATIONS})`,
      };
    }
    if (locations.length < 2) return { id: concept.id, title: concept.title, error: 'needs at least two located stops' };
    try {
      const data = await jsonPost(fetchImpl, `${String(baseUrl).replace(/\/$/, '')}/route`, {
        locations: locations.map((p, i) => ({
          lat: Number(p.lat),
          lon: Number(p.lng),
          type: i > 0 && i < locations.length - 1 ? 'break_through' : 'break',
        })),
        costing: 'motorcycle',
        costing_options: costingOptions(input.routePrefs),
        units: 'kilometers',
        directions_options: { units: 'kilometers' },
      });
      const legs = data.trip?.legs ?? [];
      const miles = Number(data.trip?.summary?.length) * KM_TO_MI;
      const rawRideMinutes = Number(data.trip?.summary?.time) / 60;
      const rideMinutes = rawRideMinutes * pace;
      const dwellMinutes = locations.slice(1, -1).reduce((n, p) => n + (p.kind === 'lodging' ? 0 : (finite(p.dwell) ? Number(p.dwell) : 20)), 0);
      const totalMinutes = rideMinutes + dwellMinutes;
      const longestFuelGap = fuelGapMiles(locations, legs);
      const days = ridingDays(locations, legs, pace, departMin);
      const longestDay = days.reduce((longest, day) => (!longest || day.totalMinutes > longest.totalMinutes ? day : longest), null);
      return {
        id: String(concept.id || `option-${Math.random().toString(36).slice(2, 7)}`),
        title: String(concept.title || 'Route option'),
        locations,
        metrics: {
          miles: round(miles),
          rideMinutes: round(rideMinutes),
          dwellMinutes: round(dwellMinutes),
          totalMinutes: round(totalMinutes),
          dayCount: days.length,
          arrival: days.length === 1 ? days[0].arrival : null,
          longestDayMiles: longestDay?.miles ?? null,
          longestDayMinutes: longestDay?.totalMinutes ?? null,
          afterDusk: days.some((day) => day.afterDusk),
          longestFuelGap: round(longestFuelGap),
          overComfort: longestFuelGap > comfort,
          overAbsolute: longestFuelGap > absolute,
          ascentFeet: await elevationFeet(fetchImpl, String(baseUrl).replace(/\/$/, ''), legs),
          days,
        },
      };
    } catch (e) {
      return { id: concept.id, title: concept.title, locations, error: String(e.message).slice(0, 200) };
    }
  }));

  const valid = options.filter((o) => o.metrics);
  const baseline = valid.reduce((best, o) => (!best || o.metrics.rideMinutes < best.metrics.rideMinutes ? o : best), null);
  for (const option of valid) {
    option.metrics.deltaMiles = round(option.metrics.miles - baseline.metrics.miles);
    option.metrics.deltaMinutes = round(option.metrics.rideMinutes - baseline.metrics.rideMinutes);
  }
  return { options, baselineId: baseline?.id ?? null };
}
