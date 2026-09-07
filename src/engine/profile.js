// The RIDER's profile: the places they keep, and how they like to ride.
//
// Deliberately not in settings.jsx. That store is the DEVICE's — language,
// theme, units, HUD density — and it says so on the tin ("applies on this
// device only"). This is the opposite kind of fact: your home address and the
// food you will actually stop for should be on your new phone a year from now,
// so it follows the ACCOUNT.
//
// It is also not placePreferences.js. That is passive evidence the app infers
// from what you pick and reject; this is what you told it outright. When they
// disagree, what you said wins — an inference is a ranking hint, a stated
// preference is a constraint.
//
// Offline-first like everything else: localStorage is the truth on the device,
// the account is the second home, and with no Supabase configured the whole
// thing still works and simply never leaves the phone. The merge is
// last-write-wins on `updatedAt` for the same reason cloudLibrary's is — the
// only conflict possible is one person on two devices.

import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase, SYNC_ENABLED } from './supabase.js';

const KEY = 'moto.profile.v1';
const TABLE = 'user_profile';

// A place the rider named. `id` is stable so a favourite can be edited without
// becoming a new one; `role` marks the ones the app resolves by meaning rather
// than by name — "home" is the one the AI needs when a prompt says "from home".
export const PLACE_ROLES = ['home', 'work', 'favorite'];

export const EMPTY_PROFILE = {
  places: [],          // [{id, role, label, address, lat, lng, placeId, note}]
  riding: {
    // What they ride. Only here to answer the three numbers the feasibility
    // engine actually grades against — see data/bikes.js.
    bike: null,            // {make, model, years, tank, mpg, weight, electric, source}
    style: 'touring',      // quick | touring | backroads — the default for new trips
    avoidTolls: false,
    pace: null,            // null = derive from rider count, else a multiplier
    riders: 1,
    rangeComfort: 180,
    rangeAbsolute: 200,
    dailyMaxHours: null,   // soft ceiling the planner respects when set
    departDefault: '09:00',
  },
  // What a day costs this rider. BudgetPanel used to hold these as module
  // constants with a per-device override, which meant every new device forgot
  // them and the estimate started from a stranger's assumptions.
  costs: {
    currency: 'USD',
    gas: 3.6,          // per gallon
    lodging: 95,       // per night, per rider
    food: 75,          // per day, per rider
  },
  taste: {
    food: [],            // free tags: "diner breakfast", "BBQ", "local seafood"
    dietary: [],         // "vegetarian", "gluten free" — constraints, not tastes
    lodging: [],         // "motel with covered parking", "boutique", "camping"
    interests: [],       // "twisty roads", "history", "hot springs", "national parks"
    avoid: [],           // "interstates", "gravel", "big cities", "chain restaurants"
    notes: '',           // anything that does not fit a tag
  },
  updatedAt: null,
};

const uid = () => `pl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

// Merge rather than spread, so a profile saved by an older build (missing a
// section that has since been added) still loads with every default present.
export function normalizeProfile(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    places: Array.isArray(p.places) ? p.places.filter((x) => x && x.label) : [],
    riding: { ...EMPTY_PROFILE.riding, ...(p.riding ?? {}) },
    costs: { ...EMPTY_PROFILE.costs, ...(p.costs ?? {}) },
    taste: { ...EMPTY_PROFILE.taste, ...(p.taste ?? {}) },
    updatedAt: p.updatedAt ?? null,
  };
}

export function loadProfile() {
  try { return normalizeProfile(JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { return normalizeProfile(null); }
}

function persist(profile) {
  try { localStorage.setItem(KEY, JSON.stringify(profile)); } catch { /* quota */ }
}

// ---- places ---------------------------------------------------------------

export const homePlace = (profile) => (profile?.places ?? []).find((p) => p.role === 'home') ?? null;

export function upsertPlace(profile, place) {
  const next = normalizeProfile(profile);
  const row = {
    id: place.id || uid(),
    role: PLACE_ROLES.includes(place.role) ? place.role : 'favorite',
    label: String(place.label ?? '').trim(),
    address: place.address ?? '',
    lat: Number(place.lat),
    lng: Number(place.lng),
    placeId: place.placeId ?? null,
    note: place.note ?? '',
  };
  if (!row.label || !Number.isFinite(row.lat) || !Number.isFinite(row.lng)) return next;
  // One home, one work — a second "home" is a rename of the first, not a
  // rival. Anything else and "start at home" has to guess, which is the
  // ambiguity this whole feature exists to remove.
  const places = next.places
    .filter((p) => p.id !== row.id)
    .map((p) => ((p.role === row.role && row.role !== 'favorite') ? { ...p, role: 'favorite' } : p));
  return { ...next, places: [...places, row] };
}

export const removePlace = (profile, id) => {
  const next = normalizeProfile(profile);
  return { ...next, places: next.places.filter((p) => p.id !== id) };
};

// What the planner is handed. Only what it needs to resolve a phrase like
// "leave from home" into a real coordinate — no notes, no ids it cannot use.
export function placesForPlanner(profile) {
  return (profile?.places ?? [])
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    .map((p) => ({
      role: p.role,
      label: p.label,
      address: p.address || undefined,
      lat: Number(p.lat.toFixed(6)),
      lng: Number(p.lng.toFixed(6)),
      placeId: p.placeId || undefined,
    }));
}

// Stated preferences, stripped of anything empty — an empty array in the
// prompt reads as "the rider said none", which is not what a blank field means.
export function tasteForPlanner(profile) {
  const t = profile?.taste ?? {};
  const out = {};
  for (const key of ['food', 'dietary', 'lodging', 'interests', 'avoid']) {
    const list = (t[key] ?? []).map((s) => String(s).trim()).filter(Boolean);
    if (list.length) out[key] = list;
  }
  if (t.notes?.trim()) out.notes = t.notes.trim();
  return Object.keys(out).length ? out : null;
}

// The frame a new trip starts from, so the builder's first turn is already
// shaped like this rider rather than like the app's defaults.
export function tripDefaults(profile) {
  const r = normalizeProfile(profile).riding;
  const riders = Math.max(1, Number(r.riders) || 1);
  return {
    riders,
    pace: Number.isFinite(r.pace) && r.pace > 0 ? r.pace : (riders > 4 ? 1.15 : riders > 1 ? 1.08 : 1),
    bike: r.bike ?? null,
    mpg: Number(r.bike?.mpg) > 0 ? Math.round(Number(r.bike.mpg)) : 45,
    range: { comfort: Number(r.rangeComfort) || 180, absolute: Number(r.rangeAbsolute) || 200 },
    routePrefs: { style: r.style ?? 'touring', avoidTolls: r.avoidTolls === true },
    dailyMaxHours: Number.isFinite(r.dailyMaxHours) && r.dailyMaxHours > 0 ? r.dailyMaxHours : null,
    departDefault: r.departDefault || '09:00',
  };
}

// ---- account backup -------------------------------------------------------

const newer = (a, b) => (String(a ?? '') >= String(b ?? '') ? a : b);

// Same shape of decision as the library merge: whole-record, last write wins.
// A profile that has never been edited (no updatedAt) never overwrites one that
// has — signing in on a fresh phone must not blank the real thing.
export function mergeProfiles(local, remote) {
  const l = normalizeProfile(local);
  const r = normalizeProfile(remote);
  if (!r.updatedAt) return l;
  if (!l.updatedAt) return r;
  return newer(l.updatedAt, r.updatedAt) === l.updatedAt ? l : r;
}

export function useProfile(account) {
  const [profile, setProfile] = useState(loadProfile);
  const [status, setStatus] = useState('idle'); // idle | syncing | saved | error
  const pushedRef = useRef(null);
  const userId = account?.id ?? null;

  // Local writes are immediate and unconditional — the account is a backup,
  // never a gate.
  const update = useCallback((patch) => {
    setProfile((cur) => {
      const next = normalizeProfile(typeof patch === 'function' ? patch(cur) : { ...cur, ...patch });
      next.updatedAt = new Date().toISOString();
      persist(next);
      return next;
    });
  }, []);

  // Pull → merge → push, in that order, for the reason cloudLibrary documents.
  useEffect(() => {
    if (!SYNC_ENABLED || !userId) return undefined;
    let dead = false;
    (async () => {
      setStatus('syncing');
      try {
        const { data, error } = await supabase
          .from(TABLE).select('profile, updated_at').eq('user_id', userId).maybeSingle();
        if (error) throw error;
        if (dead) return;
        const remote = data ? normalizeProfile({ ...data.profile, updatedAt: data.updated_at }) : null;
        setProfile((cur) => {
          const merged = mergeProfiles(cur, remote);
          persist(merged);
          return merged;
        });
        setStatus('saved');
      } catch {
        if (!dead) setStatus('error');
      }
    })();
    return () => { dead = true; };
  }, [userId]);

  useEffect(() => {
    if (!SYNC_ENABLED || !userId || !profile.updatedAt) return undefined;
    const key = `${userId}:${profile.updatedAt}`;
    if (pushedRef.current === key) return undefined;
    const timer = setTimeout(async () => {
      pushedRef.current = key;
      setStatus('syncing');
      try {
        const { error } = await supabase.from(TABLE).upsert({
          user_id: userId,
          profile: {
            places: profile.places, riding: profile.riding, costs: profile.costs, taste: profile.taste,
          },
          updated_at: profile.updatedAt,
        }, { onConflict: 'user_id' });
        if (error) throw error;
        setStatus('saved');
      } catch {
        pushedRef.current = null; // let the next edit try again
        setStatus('error');
      }
    }, 900);
    return () => clearTimeout(timer);
  }, [userId, profile]);

  return {
    profile,
    status: SYNC_ENABLED && userId ? status : 'local',
    update,
    setPlace: (place) => update((cur) => upsertPlace(cur, place)),
    dropPlace: (id) => update((cur) => removePlace(cur, id)),
    setRiding: (patch) => update((cur) => ({ ...cur, riding: { ...normalizeProfile(cur).riding, ...patch } })),
    setTaste: (patch) => update((cur) => ({ ...cur, taste: { ...normalizeProfile(cur).taste, ...patch } })),
    setCosts: (patch) => update((cur) => ({ ...cur, costs: { ...normalizeProfile(cur).costs, ...patch } })),
  };
}
