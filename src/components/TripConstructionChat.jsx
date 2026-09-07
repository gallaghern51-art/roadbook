import React, { useMemo, useRef, useState } from 'react';
import { runPlanner } from '../engine/planner.js';

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

function ConceptDetail({ concept, onRefine }) {
  return (
    <div className="concept-detail">
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
          <li>
            <span className={`stop-kind ${stop.kind}`}>{kindLabel[stop.kind] || 'Stop'}</span>
            <span className="stop-copy">
              <b>{stop.name}{stop.placeId && <span className="stop-verified" title="Verified with Google Places"> ✓</span>}{stop.verified === false && <span className="stop-unverified" title="No matching business was found near this pin"> ⚠ unverified</span>}</b>
              {stop.detail && <small>{stop.detail}</small>}
            </span>
            {i > 0 && i < concept.locations.length - 1 && (
              <button type="button" onClick={() => onRefine(`Replace ${stop.name}, but keep the rest of ${concept.title}. Show me verified alternatives and recheck the route.`)}>Change</button>
            )}
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

export default function TripConstructionChat({ initialPrompt = '', basics, onTrip, onBusyChange }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState(initialPrompt);
  const [concepts, setConcepts] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [busyMode, setBusyMode] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState('');
  const inputRef = useRef(null);
  const selected = useMemo(() => concepts.find((c) => c.id === selectedId) ?? null, [concepts, selectedId]);

  const busy = !!busyMode;
  const setBusy = (mode) => {
    setBusyMode(mode);
    onBusyChange?.(!!mode);
  };

  const research = async (preset) => {
    const content = String(preset ?? input).trim();
    if (!content || busy) return;
    setInput('');
    setError('');
    setProgress(null);
    const next = [...messages, { role: 'user', content }];
    setMessages(next);
    setBusy('explore');
    try {
      const data = await runPlanner({
        mode: 'explore',
        basics,
        messages: next,
        concepts,
      }, (obj) => {
        if (typeof obj.ms === 'number') {
          setProgress((p) => ({
            ms: obj.ms,
            chars: obj.chars ?? p?.chars ?? 0,
            thinking: obj.thinking ?? p?.thinking ?? 0,
            note: obj.note ?? p?.note ?? '',
          }));
        }
      });
      setMessages((old) => [...old, { role: 'assistant', content: data.text || 'Here are the route choices I found.' }]);
      if (data.concepts?.length) {
        setConcepts(data.concepts);
        setSelectedId(data.recommendedId || data.concepts[0].id);
      }
    } catch (e) {
      setError(String(e.message || e));
      setInput(content);
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const refine = (text) => {
    setInput(text);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const build = async () => {
    if (!selected || busy) return;
    setError('');
    setProgress(null);
    setBusy('build');
    try {
      const construction = {
        selected,
        conversation: messages.map((m) => `${m.role === 'user' ? 'Rider' : 'Roadbook'}: ${m.content}`).join('\n'),
      };
      const data = await runPlanner({
        mode: 'generate',
        prompt: `Create the confirmed Roadbook trip from this selected, already researched construction plan. Preserve its route order, verified places, and stated tradeoffs.\n\n${JSON.stringify(construction)}`,
        basics,
      }, (obj) => {
        if (typeof obj.ms === 'number') {
          setProgress((p) => ({
            ms: obj.ms,
            chars: obj.chars ?? p?.chars ?? 0,
            thinking: obj.thinking ?? p?.thinking ?? 0,
            note: obj.note ?? p?.note ?? '',
          }));
        }
      });
      await onTrip(data);
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const status = (() => {
    const secs = progress?.ms ? ` · ${Math.round(progress.ms / 1000)}s` : '';
    if (busyMode === 'build') {
      if (progress?.note) return `Checking every place — ${progress.note}${secs}`;
      return `Writing the confirmed trip${secs}`;
    }
    if (progress?.note === 'searching places') return `Checking real places and hours${secs}`;
    if (progress?.note === 'routing options') return `Comparing routes with Valhalla${secs}`;
    return `Working through the route and group tradeoffs${secs}`;
  })();

  return (
    <div className="construction-chat">
      <div className="construction-thread" aria-live="polite">
        {messages.length === 0 && (
          <div className="builder-intro">
            <span className="builder-mark">✦</span>
            <div><b>Build it with Roadbook</b><p>Describe the ride. I’ll research real stops, measure route choices, and show you the pieces before anything is created.</p></div>
          </div>
        )}
        {messages.map((message, i) => (
          <div key={i} className={`msg ${message.role === 'user' ? 'user' : 'ai'}`}>{message.content}</div>
        ))}
        {busy && <div className="msg ai"><span className="thinking">{status}</span></div>}
      </div>

      {concepts.length > 0 && (
        <section className="concept-workbench" aria-label="Route options">
          <div className="concept-head"><span>Route options</span><small>Select one, then refine any piece in the chat.</small></div>
          <div className="concept-tabs" role="tablist">
            {concepts.map((concept) => (
              <button
                type="button" role="tab" aria-selected={selectedId === concept.id}
                className={selectedId === concept.id ? 'active' : ''}
                key={concept.id} onClick={() => setSelectedId(concept.id)}
              >
                <span>{concept.title}</span>
                <small>{concept.summary}</small>
              </button>
            ))}
          </div>
          {selected && (
            <div className="concept-selected">
              <RouteFacts metrics={selected.metrics} />
              <ConceptDetail concept={selected} onRefine={refine} />
            </div>
          )}
        </section>
      )}

      {error && <div className="warning danger">⚠ {error}</div>}

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

      {selected && (
        <div className="construction-confirm">
          <div><b>Nothing is created yet.</b><span>Confirm when the route and its pieces feel right.</span></div>
          <button type="button" className="btn gold" disabled={busy} onClick={build}>Create this trip</button>
        </div>
      )}
    </div>
  );
}
