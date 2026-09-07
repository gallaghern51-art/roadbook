// Private place-choice history for signed-in riders.
//
// This is deliberately event history rather than a mutable "favorite cuisine"
// profile. Roadbook can improve its inference as the rider confirms and rejects
// real choices, while the underlying evidence stays inspectable and deletable.
// Anonymous crew sessions never write here; RLS enforces the same rule server-
// side even if a client calls this module incorrectly.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase, SYNC_ENABLED } from './supabase.js';

const TABLE = 'user_place_events';
const KINDS = new Set(['food', 'lodging', 'attraction']);
const ACTION_WEIGHT = { selected: 1, rejected: -3, confirmed: 4 };

// Google Places content is rendered live in the construction UI, but is not
// copied into our preference history. Place ids are explicitly cacheable; the
// broad tags below are Roadbook-authored concepts supplied by the planner.
const preferenceTags = (place) => [...new Set((place.preferenceTags ?? [])
  .map((tag) => String(tag).trim())
  .filter(Boolean))]
  .slice(0, 3);

export function rowsForPlaceEvent(accountId, action, places, { optionId = null, source = 'ai_construction' } = {}) {
  if (!accountId || !ACTION_WEIGHT[action]) return [];
  const seen = new Set();
  return (places ?? []).filter((place) => {
    if (!KINDS.has(place.kind) || !place.placeId || seen.has(place.placeId)) return false;
    seen.add(place.placeId);
    return true;
  }).map((place) => ({
    user_id: accountId,
    place_id: place.placeId,
    kind: place.kind,
    action,
    source,
    option_id: optionId,
    traits: { tags: preferenceTags(place) },
  }));
}

// A route reconciliation is the only Copilot proposal whose acceptance should
// teach route-shaped place taste here. Ordinary itinerary edits must not be
// mislabeled as preference evidence. Attractions can be inserted or replaced;
// resolve update_waypoint against the pre-apply trip so its existing role is
// still available when the patch only carries the changed place facts.
export function placesFromRouteReconciliation(trip, ops = []) {
  const isReconciliation = ops.some((op) => (
    op.op === 'set_meta' && op.patch?.routePrefs
  ));
  if (!isReconciliation) return [];

  return ops.flatMap((op) => {
    if (op.op === 'update_meal' && op.patch?.placeId) {
      return [{ ...op.patch, kind: 'food', name: op.patch.name }];
    }
    if (op.op === 'update_lodging' && op.patch?.placeId) {
      return [{ ...op.patch, kind: 'lodging', name: op.patch.name }];
    }
    if (op.op === 'add_waypoint' && op.waypoint?.placeId && op.waypoint?.kind === 'photo') {
      return [{ ...op.waypoint, kind: 'attraction' }];
    }
    if (op.op === 'update_waypoint' && op.patch?.placeId) {
      const day = (trip?.days ?? []).find((candidate) => candidate.id === op.dayId);
      const waypoint = (day?.waypoints ?? []).find((candidate) => candidate.id === op.waypointId);
      if ((op.patch.kind ?? waypoint?.kind) === 'photo') {
        return [{ ...waypoint, ...op.patch, kind: 'attraction' }];
      }
    }
    return [];
  });
}

export function summarizePlacePreferences(events = []) {
  const tagScores = new Map();
  const tagLabels = new Map();
  const placeScores = new Map();
  const add = (map, key, score) => {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + score);
  };

  for (const event of events) {
    const weight = ACTION_WEIGHT[event.action] || 0;
    if (!weight) continue;
    for (const label of event.traits?.tags ?? []) {
      const key = String(label).trim().toLowerCase();
      if (!key) continue;
      if (!tagLabels.has(key)) tagLabels.set(key, String(label).trim());
      add(tagScores, key, weight);
    }
    add(placeScores, event.place_id, weight);
  }

  const ranked = (map, direction = 1) => [...map.entries()]
    .filter(([, score]) => direction > 0 ? score > 0 : score < 0)
    .sort((a, b) => direction * (b[1] - a[1]));
  const preferredTags = ranked(tagScores).slice(0, 8).map(([tag]) => tagLabels.get(tag));
  const avoidTags = ranked(tagScores, -1).slice(0, 5).map(([tag]) => tagLabels.get(tag));
  const positivePlaceIds = ranked(placeScores).slice(0, 8).map(([placeId]) => placeId);
  const negativePlaceIds = ranked(placeScores, -1).slice(0, 5).map(([placeId]) => placeId);

  if (!events.length) return null;
  return {
    evidenceCount: events.length,
    preferredTags,
    avoidTags,
    positivePlaceIds,
    negativePlaceIds,
    guidance: 'Soft preference evidence only. Route fit, operating hours, safety, range and explicit trip requests take priority.',
  };
}

export async function fetchPlaceEvents(accountId, client = supabase) {
  if (!client || !accountId) return [];
  const { data, error } = await client
    .from(TABLE)
    .select('place_id, kind, action, source, option_id, traits, created_at')
    .eq('user_id', accountId)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw error;
  return data ?? [];
}

export async function recordPlaceEvent(accountId, action, places, meta = {}, client = supabase) {
  const rows = rowsForPlaceEvent(accountId, action, places, meta);
  if (!client || !rows.length) return [];
  const { error } = await client.from(TABLE).insert(rows);
  if (error) throw error;
  return rows.map((row) => ({ ...row, created_at: new Date().toISOString() }));
}

export function usePlacePreferences(account) {
  const [events, setEvents] = useState([]);
  const [status, setStatus] = useState('off');
  const accountId = account?.id ?? null;

  useEffect(() => {
    let alive = true;
    if (!SYNC_ENABLED || !accountId) {
      setEvents([]);
      setStatus('off');
      return undefined;
    }
    setStatus('loading');
    fetchPlaceEvents(accountId)
      .then((rows) => {
        if (!alive) return;
        setEvents(rows);
        setStatus('ready');
      })
      .catch(() => { if (alive) setStatus('error'); });
    return () => { alive = false; };
  }, [accountId]);

  const record = useCallback(async (action, places, meta) => {
    if (!SYNC_ENABLED || !accountId) return;
    try {
      const fresh = await recordPlaceEvent(accountId, action, places, meta);
      if (fresh.length) setEvents((old) => [...fresh, ...old].slice(0, 500));
    } catch {
      // Preference learning must never interrupt planning. The next meaningful
      // choice will provide another signal when connectivity returns.
    }
  }, [accountId]);

  return {
    profile: useMemo(() => summarizePlacePreferences(events), [events]),
    record,
    status,
    enabled: Boolean(SYNC_ENABLED && accountId),
  };
}
