import React, { useEffect, useMemo, useRef, useState } from 'react';
import { runPlanner } from '../engine/planner.js';
import { passSizeFor, nextPass, passLabel, priorDaysDigest, shrinkPass } from '../engine/buildPasses.js';
import { CATEGORIES } from '../engine/nearby.js';
import PlaceSheet from './PlaceSheet.jsx';

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

function RouteFacts({ metrics }) {
  if (!metrics) return <span className="concept-error">Route could not be measured</span>;
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
    </div>
  );
}

function ConceptDetail({ concept, onRefine, onReject }) {
  const [detail, setDetail] = useState(null); // the stop whose place sheet is open
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
            <button type="button" className="btn gold" onClick={() => {
              setDetail(null);
              onReject?.(detail, concept);
              onRefine(`Replace ${detail.name}, but keep the rest of ${concept.title}. Show me verified alternatives and recheck the route.`);
            }}>Change this stop</button>
          ) : null}
        />
      )}
      <div className="concept-story">
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
              {i > 0 && i < concept.locations.length - 1 && (
                <button type="button" onClick={() => {
                  onReject?.(stop, concept);
                  onRefine(`Replace ${stop.name}, but keep the rest of ${concept.title}. Show me verified alternatives and recheck the route.`);
                }}>Change</button>
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

export default function TripConstructionChat({
  initialPrompt = '', basics, onTrip, onBusyChange, onStageChange, placePreferences,
}) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState(initialPrompt);
  const [concepts, setConcepts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [busyMode, setBusyMode] = useState(null);
  const [progress, setProgress] = useState(null);
  const [pass, setPass] = useState(null); // { from, to, total, built } while a long trip builds in passes
  const [live, setLive] = useState('');
  const [error, setError] = useState('');
  const [mobilePane, setMobilePane] = useState('chat');
  const inputRef = useRef(null);
  const liveRef = useRef(''); // the streamed text, readable synchronously in catch/finally
  const transportRef = useRef('background'); // which transport carried the last planner call
  const endRef = useRef(null);
  const selected = useMemo(() => concepts.find((c) => c.id === selectedId) ?? null, [concepts, selectedId]);
  const started = messages.length > 0 || concepts.length > 0;

  useEffect(() => onStageChange?.(started), [started, onStageChange]);

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

  const selectConcept = (concept) => {
    if (concept.id === selectedId) return;
    setSelectedId(concept.id);
    placePreferences?.record?.('selected', concept.locations, { optionId: concept.id });
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
      const prompt = `Create the confirmed Roadbook trip from this selected, already researched construction plan. Preserve its route order, verified places, and stated tradeoffs.\n\n${JSON.stringify(construction)}`;
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
            <div className="concept-head"><span>Route options</span><small>Select one, then refine any piece in the conversation.</small></div>
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
                <RouteFacts metrics={selected.metrics} />
                <ConceptDetail
                  concept={selected}
                  onRefine={refine}
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
            <div><b>Nothing is created yet.</b><span>Confirm when the route and its pieces feel right.</span></div>
            <button type="button" className="btn gold" disabled={busy} onClick={build}>{busyMode === 'build' ? 'Creating…' : 'Create this trip'}</button>
          </div>
        )}
      </section>
    </div>
  );
}
