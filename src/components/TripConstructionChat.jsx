import React, { useEffect, useMemo, useRef, useState } from 'react';
import { runPlanner } from '../engine/planner.js';
import { passSizeFor, nextPass, passLabel, priorDaysDigest, shrinkPass } from '../engine/buildPasses.js';
import { CATEGORIES } from '../engine/nearby.js';
import { replaceConceptStop, replaceableAt, withDeltas, remeasureConcept, decodePolyline5, conceptToTrip } from '../engine/conceptEdit.js';
import { alongOnRoute } from '../engine/tripEngine.js';
import PlaceSheet from './PlaceSheet.jsx';
import NearbyPicker from './NearbyPicker.jsx';

const mins = (value) => {
  if (!Number.isFinite(value)) return '—';
  const h = Math.floor(value / 60);
  const m = Math.round(value % 60);
  return h ? `${h}h ${m ? `${m}m` : ''}`.trim() : `${m}m`;
};

const kindLabel = {
  start: 'Start', end: 'Finish', road: 'Road', fuel: 'Fuel', food: 'Food',
  lodging: 'Stay', attraction: 'Experience',
};

const priceLabel = {
  PRICE_LEVEL_FREE: 'Free',
  PRICE_LEVEL_INEXPENSIVE: '$',
  PRICE_LEVEL_MODERATE: '$$',
  PRICE_LEVEL_EXPENSIVE: '$$$',
  PRICE_LEVEL_VERY_EXPENSIVE: '$$$$',
};

// kind → the picker's category, for the sheet's roundel glyph
const KIND_CAT = { food: 'food', lodging: 'lodging', attraction: 'sights', fuel: 'fuel' };
const kindGlyph = (kind) => CATEGORIES.find((c) => c.id === KIND_CAT[kind])?.glyph ?? '📍';

// A verified place on a route option: the glance a rider scans (rating,
// count, price) and a Details button that opens Roadbook's own place page —
// the same PlaceSheet the map's POI tap and the picker use, never a link out
// to Google Maps (owner, Sep 13 2026). Photo, hours, phone and website are
// fetched by placeId when the sheet opens, not for every row.
function PlaceGlance({ stop, onDetails }) {
  const hasGooglePlace = Boolean(stop.placeId);
  if (!hasGooglePlace || !['food', 'lodging', 'attraction'].includes(stop.kind)) return null;
  return (
    <div className="place-glance-row">
      <span className="place-glance">
        {Number.isFinite(stop.rating) && <b>{stop.rating.toFixed(1)} ★</b>}
        {Number.isFinite(stop.userRatingCount) && <small>{stop.userRatingCount.toLocaleString()} ratings</small>}
        {stop.priceLevel && <b>{priceLabel[stop.priceLevel] || stop.priceLevel}</b>}
      </span>
      <button type="button" className="place-details-btn" onClick={() => onDetails(stop)}>Details</button>
    </div>
  );
}

// An option's measured day count against the Days in the trip details. Said
// as what the DETAILS say, not what the rider "asked for": the field defaults
// to 5, and a rider who typed "two days" into the sentence never set it.
// Null when they agree or either is unknown.
function daysOff(metrics, requestedDays) {
  const have = metrics?.dayCount;
  if (!Number.isFinite(have) || !(requestedDays > 0) || have === requestedDays) return null;
  return `${have} ${have === 1 ? 'day' : 'days'} · trip details say ${requestedDays}`;
}

function RouteFacts({ metrics, pending = false, error = '', requestedDays = null }) {
  // A stop was just replaced by hand: the old figures described a road this
  // option no longer rides, so they are gone and this says so plainly rather
  // than showing miles that are no longer true.
  if (pending) return <span className="concept-remeasure">Re-measuring the route…</span>;
  if (!metrics) return <span className="concept-error">{error || 'Route could not be measured'}</span>;
  return (
    <div className="concept-facts" aria-label="Measured route facts">
      <span><b>{metrics.miles}</b> mi</span>
      <span><b>{mins(metrics.rideMinutes)}</b> riding</span>
      {metrics.dayCount > 1
        ? <span><b>{metrics.dayCount}</b> day shape · <b>{mins(metrics.longestDayMinutes)}</b> longest day</span>
        : <span><b>{metrics.arrival}</b> arrival</span>}
      <span><b>{metrics.longestFuelGap}</b> mi max fuel gap</span>
      {Number.isFinite(metrics.ascentFeet) && <span><b>{metrics.ascentFeet.toLocaleString()}</b> ft climbing</span>}
      {(metrics.deltaMiles > 0 || metrics.deltaMinutes > 0) && (
        <span className="detour"><b>+{metrics.deltaMiles} mi · +{mins(metrics.deltaMinutes)}</b> vs quickest option</span>
      )}
      {daysOff(metrics, requestedDays) && <span className="days-off">{daysOff(metrics, requestedDays)}</span>}
    </div>
  );
}

// A stop's role, as the category its replacement is searched in: replacing a
// dinner opens on Food, a fuel stop on Fuel. A road-shape anchor has no
// category — the rider types what they want instead.
const KIND_CATEGORY = { fuel: 'fuel', food: 'food', lodging: 'lodging', attraction: 'sights' };

function ConceptDetail({ concept, onRefine, onReject, onReplace }) {
  const [detail, setDetail] = useState(null); // the stop whose place sheet is open
  // The stop being replaced by hand (owner, Sep 20 2026: "if you recommend one
  // dinner spot and they dont want to go there. they should be able to choose
  // replace and then ... search area for food"). Replacing is the rider's own
  // act: a live search, a pick, a re-measure — no planner turn.
  const [replacing, setReplacing] = useState(null);
  const pickerRef = useRef(null);
  useEffect(() => {
    if (replacing != null) pickerRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [replacing]);
  const askPlanner = (stop) => {
    onReject?.(stop, concept);
    onRefine(`Replace ${stop.name}, but keep the rest of ${concept.title}. Show me verified alternatives and recheck the route.`);
  };
  const detailIdx = detail ? concept.locations.indexOf(detail) : -1;
  const canChange = detailIdx > 0 && detailIdx < concept.locations.length - 1;
  return (
    <div className="concept-detail">
      {detail && (
        <PlaceSheet
          place={detail}
          glyph={kindGlyph(detail.kind)}
          kicker={kindLabel[detail.kind] || 'Stop'}
          onClose={() => setDetail(null)}
          actions={canChange ? (
            <>
              <button type="button" className="btn gold" onClick={() => { setDetail(null); setReplacing(detailIdx); }}>Replace this stop</button>
              <button type="button" className="btn" onClick={() => { setDetail(null); askPlanner(detail); }}>Ask the planner</button>
            </>
          ) : null}
        />
      )}
      {replacing != null && concept.locations[replacing] && (() => {
        const stop = concept.locations[replacing];
        const chain = decodePolyline5(concept.searchPolyline);
        const here = chain.length > 1 ? alongOnRoute(chain, { lat: stop.lat, lng: stop.lng })?.along : null;
        return (
          <div ref={pickerRef} className="concept-replace">
            <NearbyPicker
              variant="tiles"
              mode="swap"
              title={`Replace ${stop.name}`}
              subtitle={chain.length > 1 ? 'Search around this stop, or along the proposed road' : 'Search around this stop'}
              near={{ lat: stop.lat, lng: stop.lng }}
              chain={chain.length > 1 ? chain : null}
              fromAlong={Number.isFinite(here) ? here : 0}
              initialCategory={KIND_CATEGORY[stop.kind] ?? null}
              onPick={(place) => {
                const i = replacing;
                setReplacing(null);
                onReject?.(stop, concept);
                onReplace?.(i, place);
              }}
              onClose={() => setReplacing(null)}
            />
            <button type="button" className="concept-replace-ai" onClick={() => { setReplacing(null); askPlanner(stop); }}>
              Or ask the planner to find alternatives
            </button>
          </div>
        );
      })()}
      <div className="concept-story">
        {concept.edits?.length > 0 && (
          // The planner wrote the notes below about the ORIGINAL stops. Saying
          // so beats silently showing prose that names a place the rider
          // just took out.
          <p className="concept-edited">
            You replaced {concept.edits.map((e) => `${e.from} with ${e.to}`).join('; ')}. The planner&rsquo;s notes below were written for the original stops.
          </p>
        )}
        <p>{concept.routeDescription}</p>
        <dl>
          <div><dt>Why this works</dt><dd>{concept.why}</dd></div>
          <div><dt>For your group</dt><dd>{concept.groupFit}</dd></div>
          <div><dt>The tradeoff</dt><dd>{concept.tradeoff}</dd></div>
        </dl>
      </div>
      <ol className="concept-stops">
        {(concept.locations ?? []).map((stop, i) => (
          <React.Fragment key={`${stop.placeId || stop.name}-${i}`}>
          {(i === 0 || concept.locations[i - 1]?.kind === 'lodging') && <li className="concept-day">Day {(concept.locations.slice(0, i).filter((p) => p.kind === 'lodging').length) + 1}</li>}
          <li className="concept-stop">
            <div className="concept-stop-row">
              <span className={`stop-kind ${stop.kind}`}>{kindLabel[stop.kind] || 'Stop'}</span>
              <span className="stop-copy">
                <b>{stop.name}{stop.placeId && <span className="stop-verified" title="Verified listing"> ✓</span>}{stop.verified === false && <span className="stop-unverified" title="No matching business was found near this pin"> ⚠ unverified</span>}</b>
                {stop.detail && <small>{stop.detail}</small>}
              </span>
              {replaceableAt(concept.locations, i) && (
                <button type="button" className={replacing === i ? 'active' : ''} aria-pressed={replacing === i}
                  onClick={() => setReplacing(replacing === i ? null : i)}>Replace</button>
              )}
            </div>
            <PlaceGlance stop={stop} onDetails={setDetail} />
          </li>
          </React.Fragment>
        ))}
      </ol>
      <div className="concept-refine">
        <button type="button" onClick={() => onRefine(`Keep the road shape from ${concept.title}, but show me different food, fuel, lodging, and attraction stops along it.`)}>Keep route, change stops</button>
        <button type="button" onClick={() => onRefine(`Keep the stops from ${concept.title}, but find a better motorcycle road between them and compare the cost.`)}>Keep stops, change roads</button>
        <button type="button" onClick={() => onRefine(`Shorten ${concept.title} without losing its best experience. Recheck the route and fuel gaps.`)}>Shorten it</button>
      </div>
    </div>
  );
}

// The proposal, kept on this device until it is created (owner, Sep 20 2026:
// "...or save for later"). Before this a rider who closed the app, or whose
// phone reloaded the tab, lost the conversation AND the options the planner
// had spent a minute researching. A created trip already lives in the library
// and backs up to the account; this covers the part before that — "I'll decide
// tomorrow". Two weeks, then it is let go.
const SESSION_KEY = 'moto.builderSession.v1';
const SESSION_TTL_MS = 14 * 24 * 3600 * 1000;
function loadSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    if (!saved || Date.now() - (saved.at ?? 0) > SESSION_TTL_MS) return null;
    if (!saved.concepts?.length && !saved.messages?.length) return null;
    return saved;
  } catch { return null; }
}
const saveSession = (value) => {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify({ ...value, at: Date.now() })); } catch { /* storage full — a convenience, not a loss */ }
};
const clearSession = () => { try { localStorage.removeItem(SESSION_KEY); } catch { /* nothing kept */ } };
// A re-measure in flight when the session was saved did not survive it.
const settle = (concepts) => (concepts ?? []).map((c) => ({ ...c, remeasuring: false }));

export default function TripConstructionChat({
  initialPrompt = '', basics, onTrip, onBusyChange, onStageChange, placePreferences,
}) {
  // Opened with no new sentence: pick the last plan back up. Opened WITH one
  // (typed on the home pill): that is a new ride — start fresh, but offer the
  // old plan back instead of overwriting it without a word.
  const [saved] = useState(loadSession);
  const restoring = !initialPrompt && !!saved;
  const [messages, setMessages] = useState(() => (restoring ? saved.messages ?? [] : []));
  const [input, setInput] = useState(() => (restoring ? saved.input ?? '' : initialPrompt));
  const [concepts, setConcepts] = useState(() => (restoring ? settle(saved.concepts) : []));
  const [selectedId, setSelectedId] = useState(() => (restoring ? saved.selectedId ?? null : null));
  const [resumable, setResumable] = useState(() => !!initialPrompt && !!saved);
  const [busyMode, setBusyMode] = useState(null);
  const [progress, setProgress] = useState(null);
  const [pass, setPass] = useState(null); // { from, to, total, built } while a long trip builds in passes
  const [live, setLive] = useState('');
  const [error, setError] = useState('');
  // Coming back to a kept plan means coming back to DECIDE on it — land on the
  // route, not on the conversation that produced it. (On a phone these are two
  // panes; restoring into the chat hid the options behind a tab.)
  const [mobilePane, setMobilePane] = useState(() => (restoring && saved.concepts?.length ? 'plan' : 'chat'));
  const inputRef = useRef(null);
  const liveRef = useRef(''); // the streamed text, readable synchronously in catch/finally
  const transportRef = useRef('background'); // which transport carried the last planner call
  const endRef = useRef(null);
  const selected = useMemo(() => concepts.find((c) => c.id === selectedId) ?? null, [concepts, selectedId]);
  const started = messages.length > 0 || concepts.length > 0;

  useEffect(() => onStageChange?.(started), [started, onStageChange]);

  // Keep the plan as it changes. Once the trip is created the kept copy is
  // spent — doneRef stops a save that was already queued from writing it back
  // in the moment between creating and the builder closing.
  const doneRef = useRef(false);
  useEffect(() => {
    if (doneRef.current || (!messages.length && !concepts.length)) return undefined;
    const id = setTimeout(() => {
      if (!doneRef.current) saveSession({ messages, concepts, selectedId, input });
    }, 400);
    return () => clearTimeout(id);
  }, [messages, concepts, selectedId, input]);

  // A stop replaced just before the app closed never got its re-measure; the
  // figures it would have replaced were already cleared. Finish that job now
  // rather than showing an option with no numbers.
  useEffect(() => {
    if (!restoring) return;
    for (const c of concepts) {
      if (c.metrics || (c.locations?.length ?? 0) < 2) continue;
      setConcepts((cs) => cs.map((x) => (x.id === c.id ? { ...x, remeasuring: true } : x)));
      remeasureConcept(c, basics).then(
        (m) => setConcepts((cs) => withDeltas(cs.map((x) => (x.id === c.id ? { ...m, remeasuring: false, measureError: '' } : x)))),
        () => setConcepts((cs) => cs.map((x) => (x.id === c.id ? { ...x, remeasuring: false, measureError: 'The route could not be re-measured — replace the stop again to retry.' } : x))),
      );
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const resume = () => {
    if (!saved) return;
    setMessages(saved.messages ?? []);
    setConcepts(settle(saved.concepts));
    setSelectedId(saved.selectedId ?? null);
    setInput(saved.input ?? '');
    setResumable(false);
    if (saved.concepts?.length) setMobilePane('plan');
  };
  const startOver = () => {
    clearSession();
    setMessages([]); setConcepts([]); setSelectedId(null); setInput(''); setError('');
    setResumable(false);
    setMobilePane('chat');
  };

  // Text that arrives while the rider watches has to stay in view, or the
  // narration scrolls out of the pane as fast as it is written.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, live, busyMode]);

  const busy = !!busyMode;
  const setBusy = (mode) => {
    setBusyMode(mode);
    onBusyChange?.(!!mode);
  };

  // The planner narrates each research round while it works — "the Catskills
  // route runs 255 miles with no fuel stop planned, let me fix that before
  // presenting". Held back until 'done' that arrives as a wall of text about
  // work already finished. Streamed, it IS the progress display, and the
  // elapsed stamp on every line proves the job is still moving.
  const readLine = (obj) => {
    // the builder sizes its next pass by what carried this call
    if (obj.type === 'transport') { transportRef.current = obj.transport; return; }
    if (typeof obj.ms === 'number') {
      setProgress((p) => ({
        ms: obj.ms,
        chars: obj.chars ?? p?.chars ?? 0,
        thinking: obj.thinking ?? p?.thinking ?? 0,
        note: obj.note ?? p?.note ?? '',
        thought: obj.thought ?? p?.thought ?? '',
      }));
    }
    if (obj.type === 'delta' && obj.text) {
      liveRef.current += obj.text;
      setLive(liveRef.current);
    }
  };

  const clearLive = () => { liveRef.current = ''; setLive(''); };

  const research = async (preset) => {
    const content = String(preset ?? input).trim();
    if (!content || busy) return;
    setInput('');
    setError('');
    setProgress(null);
    clearLive();
    const next = [...messages, { role: 'user', content }];
    setMessages(next);
    setBusy('explore');
    try {
      const data = await runPlanner({
        mode: 'explore',
        basics,
        messages: next,
        concepts,
        preferenceProfile: placePreferences?.profile ?? null,
      }, readLine);
      setMessages((old) => [...old, { role: 'assistant', content: data.text || 'Here are the route choices I found.' }]);
      if (data.concepts?.length) {
        setConcepts(data.concepts);
        setSelectedId(data.recommendedId || data.concepts[0].id);
        setMobilePane('plan');
      }
    } catch (e) {
      setError(String(e.message || e));
      setInput(content);
      // Whatever streamed is usually the useful half of a failed round — keep
      // it in the thread rather than blanking the reasoning along with the run.
      const partial = liveRef.current.trim();
      if (partial) setMessages((old) => [...old, { role: 'assistant', content: partial, partial: true }]);
    } finally {
      setBusy(null);
      setProgress(null);
      clearLive();
    }
  };

  const refine = (text) => {
    setInput(text);
    setMobilePane('chat');
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // Replace one stop by hand, then re-measure the road with no model. The swap
  // lands at once (the stop's role and position are kept); the figures clear
  // to "re-measuring" because they described the old road; and every option's
  // "vs quickest" comparison is redone across the whole set, since the one
  // just measured may now be the quickest. Latest-only per option: a rider who
  // replaces twice in a row never sees the first answer land on top of the
  // second.
  const remeasureSeq = useRef({});
  const replaceStop = async (conceptId, index, place) => {
    const current = concepts.find((c) => c.id === conceptId);
    if (!current) return;
    let edited;
    try {
      edited = replaceConceptStop(current, index, place);
    } catch (e) {
      setError(String(e.message || e));
      return;
    }
    const my = (remeasureSeq.current[conceptId] = (remeasureSeq.current[conceptId] ?? 0) + 1);
    setConcepts((cs) => withDeltas(cs.map((c) => (c.id === conceptId ? { ...edited, remeasuring: true, measureError: '' } : c))));
    try {
      const measured = await remeasureConcept(edited, basics);
      if (remeasureSeq.current[conceptId] !== my) return;
      setConcepts((cs) => withDeltas(cs.map((c) => (c.id === conceptId ? { ...measured, remeasuring: false, measureError: '' } : c))));
    } catch {
      if (remeasureSeq.current[conceptId] !== my) return;
      setConcepts((cs) => cs.map((c) => (c.id === conceptId
        ? { ...c, remeasuring: false, measureError: 'The stop is replaced, but the route could not be re-measured right now — replace it again to retry, or ask the planner.' }
        : c)));
    }
  };

  const selectConcept = (concept) => {
    if (concept.id === selectedId) return;
    setSelectedId(concept.id);
    placePreferences?.record?.('selected', concept.locations, { optionId: concept.id });
  };

  // Create the trip straight from the chosen proposal — no model. The rider
  // already chose this plan (and may have replaced stops in it); a second full
  // planner generation just to re-write it cost 20-60 seconds between them and
  // the editor where they can reorder, move stops between days, add, remove,
  // undo, and save. It goes through the same normalisation as the planner's
  // trip (onTrip), so the two doors cannot build differently-shaped trips.
  const buildInstant = async () => {
    if (!selected || busy) return;
    setError('');
    setBusy('instant');
    try {
      await placePreferences?.record?.('confirmed', selected.locations, { optionId: selected.id });
      await onTrip(conceptToTrip(selected, basics));
      doneRef.current = true;
      clearSession();
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(null);
    }
  };

  // The build, in passes sized to the transport that carries them (a long
  // trip is decided up front from the intake's day count — see
  // src/engine/buildPasses.js). Each pass continues from where the last
  // ended and lands in the trip as it arrives: the first creates it, the rest
  // append, the last hands off. A pass that runs out of room is retried
  // smaller rather than failing the whole build.
  const build = async () => {
    if (!selected || busy) return;
    setError('');
    setProgress(null);
    setPass(null);
    clearLive();
    setBusy('build');
    // On a phone the plan pane owns the screen while options are compared; a
    // build can run for minutes, and its status, narration and pass bar live
    // in the conversation — bring that forward so the rider watches the work
    // rather than a button that says "Creating…".
    setMobilePane('chat');
    const total = Math.max(1, Number(basics?.numDays) || 1);
    // transportRef already knows what carried the research turns — a deploy
    // without background functions sizes its FIRST pass right, not after a
    // wasted eight-day call against the streaming budget
    try {
      const construction = {
        selected,
        conversation: messages.map((m) => `${m.role === 'user' ? 'Rider' : 'Roadbook'}: ${m.content}`).join('\n'),
      };
      // Stops the rider replaced by hand. The concept's prose (why / tradeoff /
      // route description) was written BEFORE those edits and may still name
      // the old places — and the generator is told to "preserve stated
      // tradeoffs", which without this line invites it to put a place the
      // rider deliberately removed straight back.
      const edits = selected.edits?.length
        ? `\n\nThe rider replaced these stops by hand, and their choice is final: ${selected.edits.map((e) => `"${e.from}" was replaced with "${e.to}"`).join('; ')}. Use the places in \`locations\` exactly. Where the prose mentions a replaced place, it is out of date — do not restore it.`
        : '';
      const prompt = `Create the confirmed Roadbook trip from this selected, already researched construction plan. Preserve its route order, verified places, and stated tradeoffs.${edits}\n\n${JSON.stringify(construction)}`;
      let built = [];
      let size = passSizeFor(transportRef.current);
      let createdYet = false;
      let meta = null;
      for (;;) {
        const next = nextPass(built.length + 1, total, size);
        if (!next) break;
        const single = next.from === 1 && next.last;
        setPass(single ? null : { ...next, built: built.length });
        setProgress(null);
        clearLive();
        let data;
        try {
          data = await runPlanner({
            mode: 'generate',
            prompt,
            basics,
            ...(single ? {} : { dayRange: { from: next.from, to: next.to, total }, priorDays: priorDaysDigest(built) }),
          }, readLine);
        } catch (e) {
          // the pass did not fit its budget — halve it and go again
          if (/ran out of time|length limit/i.test(String(e?.message)) && size > 2) { size = shrinkPass(size); continue; }
          throw e;
        }
        const days = data?.trip?.days ?? [];
        if (!days.length) throw new Error('The builder returned no days for this pass — try again.');
        meta = meta ?? data.trip?.meta ?? {};
        const last = built.length + days.length >= total;
        await onTrip({ ...data, trip: { meta, days } }, { partial: !last, append: createdYet });
        if (!createdYet) {
          // the first pass made it a trip in the library — the kept proposal
          // is spent, even if a later pass fails (resuming it would build a
          // second copy)
          doneRef.current = true;
          clearSession();
        }
        createdYet = true;
        built = [...built, ...days];
        if (last) break;
        size = passSizeFor(transportRef.current);
      }
      await placePreferences?.record?.('confirmed', selected.locations, { optionId: selected.id });
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(null);
      setProgress(null);
      setPass(null);
      clearLive();
    }
  };

  const requestedDays = Number(basics?.numDays) > 0 ? Number(basics.numDays) : null;
  const selectedDaysOff = !!(selected?.metrics && daysOff(selected.metrics, requestedDays));

  const status = (() => {
    const secs = progress?.ms ? ` · ${Math.round(progress.ms / 1000)}s` : '';
    if (busyMode === 'build') {
      if (pass) return `${passLabel(pass)}${progress?.note ? ` — ${progress.note}` : ''}${secs}`;
      if (progress?.note) return `Checking every place — ${progress.note}${secs}`;
      return `Writing the confirmed trip${secs}`;
    }
    if (progress?.note === 'searching places') return `Checking real places and hours${secs}`;
    if (progress?.note === 'routing options') return `Comparing routes with Valhalla${secs}`;
    if (progress?.note === 'verifying option stops') return `Verifying every stop is a real business${secs}`;
    return `Working through the route and group tradeoffs${secs}`;
  })();

  return (
    <div className={`construction-chat${started ? ' started' : ''} mobile-${mobilePane}`}>
      {started && concepts.length > 0 && (
        <div className="construction-mobile-nav" aria-label="Construction view">
          <button type="button" className={mobilePane === 'chat' ? 'active' : ''} aria-pressed={mobilePane === 'chat'} onClick={() => setMobilePane('chat')}>Conversation</button>
          <button type="button" className={mobilePane === 'plan' ? 'active' : ''} aria-pressed={mobilePane === 'plan'} onClick={() => setMobilePane('plan')}>Route plan</button>
        </div>
      )}

      <section className="construction-dialogue" aria-label="Planning conversation">
        <div className="construction-thread" aria-live="polite">
          {resumable && saved && (
            <div className="builder-resume" role="status">
              <div>
                <b>You have an unfinished plan.</b>
                <span>{saved.concepts?.length ? `${saved.concepts.length} route option${saved.concepts.length === 1 ? '' : 's'}` : 'A conversation'} from {new Date(saved.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, not created yet.</span>
              </div>
              <div className="builder-resume-actions">
                <button type="button" className="btn" onClick={resume}>Resume it</button>
                <button type="button" className="builder-resume-drop" onClick={() => { clearSession(); setResumable(false); }}>Discard</button>
              </div>
            </div>
          )}
          {started && !busy && (
            <button type="button" className="builder-startover" onClick={startOver}>Start over</button>
          )}
          {messages.length === 0 && (
            <div className="builder-intro">
              <span className="builder-mark">✦</span>
              <div><b>Build it with Roadbook</b><p>Describe the ride. I’ll research real stops, measure route choices, and show you the pieces before anything is created.</p></div>
            </div>
          )}
          {messages.map((message, i) => (
            <div key={i} className={`msg ${message.role === 'user' ? 'user' : 'ai'}${message.partial ? ' partial' : ''}`}>{message.content}</div>
          ))}
          {busy && (
            <div className="msg ai streaming">
              {live && <span className="live-text">{live}</span>}
              <span className="thinking">{status}</span>
              {pass && (
                <span className="build-pass" role="progressbar" aria-label="Days built" aria-valuemin={0} aria-valuemax={pass.total} aria-valuenow={pass.built} title={`${pass.built} of ${pass.total} days built`}>
                  <i style={{ width: `${(pass.built / pass.total) * 100}%` }} />
                  <b style={{ left: `${(pass.built / pass.total) * 100}%`, width: `${((pass.to - pass.from + 1) / pass.total) * 100}%` }} />
                </span>
              )}
              {progress?.thought && <span className="thought">{progress.thought}</span>}
            </div>
          )}
          <div ref={endRef} />
        </div>

        {error && <div className="warning danger construction-error">⚠ {error}</div>}

        <div className="construction-composer">
          <textarea
            ref={inputRef}
            rows={3}
            value={input}
            disabled={busy}
            placeholder={messages.length ? 'Change a stop, combine options, add a constraint…' : 'e.g. Six days from Denver for four riders. Great mountain roads, moderate days, one hot-springs night, reliable fuel, memorable local food.'}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); research(); }
            }}
          />
          <button type="button" className="btn gold" disabled={busy || !input.trim()} onClick={() => research()}>
            {messages.length ? 'Send' : 'Explore the trip'}
          </button>
        </div>
      </section>

      <section className="construction-plan" aria-label="Route plan">
        {concepts.length > 0 ? (
          <section className="concept-workbench" aria-label="Route options">
            <div className="concept-head"><span>Route options</span><small>Select one. Replace any stop yourself, or refine it in the conversation.</small></div>
            <div className="concept-tabs" role="tablist">
              {concepts.map((concept) => (
                <button
                  type="button" role="tab" aria-selected={selectedId === concept.id}
                  className={selectedId === concept.id ? 'active' : ''}
                  key={concept.id} onClick={() => selectConcept(concept)}
                >
                  <span>{concept.title}</span>
                  <small>{concept.summary}</small>
                </button>
              ))}
            </div>
            {selected && (
              <div className="concept-selected">
                <RouteFacts metrics={selected.metrics} pending={!!selected.remeasuring} error={selected.measureError} requestedDays={requestedDays} />
                <ConceptDetail
                  concept={selected}
                  onRefine={refine}
                  onReplace={(index, place) => replaceStop(selected.id, index, place)}
                  onReject={(stop, concept) => placePreferences?.record?.('rejected', [stop], { optionId: concept.id })}
                />
              </div>
            )}
          </section>
        ) : started ? (
          <div className="construction-plan-wait"><b>Route plan</b><span>Your researched options will appear here.</span></div>
        ) : null}

        {selected && (
          <div className="construction-confirm">
            <div>
              <b>Nothing is created yet.</b>
              <span className="cc-long">Create it now and edit it in the trip — reorder, add or remove stops, save your own versions.</span>
              <span className="cc-short">You can edit every stop after.</span>
              {/* Create builds the days the option has; say so when that is not
                  the number the rider set, and name the door that fills them */}
              {selectedDaysOff && (
                <span className="cc-days">
                  {`This option covers ${selected.metrics.dayCount} ${selected.metrics.dayCount === 1 ? 'day' : 'days'}; your trip details say ${requestedDays}. Create makes a ${selected.metrics.dayCount}-day trip`}
                  {selected.metrics.dayCount < requestedDays
                    ? ` — add days after, or have the planner write up all ${requestedDays}.`
                    : '.'}
                </span>
              )}
            </div>
            <div className="construction-confirm-actions">
              <button type="button" className="btn gold" disabled={busy || !!selected?.remeasuring} onClick={buildInstant}>
                {busyMode === 'instant' ? 'Creating…' : selected?.remeasuring ? 'Re-measuring…' : 'Create this trip'}
              </button>
              {/* the planner's full write-up — per-day narratives, meal timing —
                  for a rider who wants it, never as a wait everyone pays */}
              <button type="button" className="btn construction-writeup" disabled={busy || !!selected?.remeasuring} onClick={build}
                title="The planner writes day-by-day notes and meal timing. Takes up to a minute.">
                {busyMode === 'build' ? 'Planner is writing it up…' : 'Have the planner write it up'}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
