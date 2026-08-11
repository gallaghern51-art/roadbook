import React, { useEffect, useRef, useState } from 'react';
import { useTrip } from '../engine/store.js';
import { tripDigest, compactTripForModel } from '../engine/tripEngine.js';
import { feasibilityDigest } from '../engine/timeline.js';
import { splitsDigest } from '../engine/splits.js';
import { describeOps, applyOps } from '../engine/ops.js';
import { runPlanner } from '../engine/planner.js';
import { useT } from '../engine/settings.jsx';

const SUGGESTIONS = [
  'Run a full feasibility read — where does this plan break?',
  'Where should we break up the loops and the long days?',
  'Rebuild the trip to fix every failed gate and save it as "Fixed gates"',
  'Give me a lower-mileage permutation of the whole trip, save as "Relaxed"',
];

export default function ChatPanel({ onClose }) {
  const { state, dispatch, routedLegsByDay } = useTrip();
  const [messages, setMessages] = useState(state.chat ?? []); // {role, content} — hydrated from the trip record
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [building, setBuilding] = useState(null); // {chars, thinking} streamed so far
  const [confirmClear, setConfirmClear] = useState(false); // two-tap clear, no window.confirm
  const t = useT();
  const [setupNeeded, setSetupNeeded] = useState(false);
  const scrollRef = useRef(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, busy, state.pendingProposal]);

  // Re-hydrate when the active trip changes; persist whenever the thread grows.
  useEffect(() => {
    setMessages(state.chat ?? []);
  }, [state.lib.activeId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (messages !== state.chat) dispatch({ type: 'save_chat', messages });
  }, [messages]); // eslint-disable-line react-hooks/exhaustive-deps

  // Questions queued from elsewhere in the app (feasibility break-up recs) auto-send.
  useEffect(() => {
    if (state.chatAsk && !busy) {
      const text = state.chatAsk;
      dispatch({ type: 'clear_chat_ask' });
      send(text);
    }
  }, [state.chatAsk]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async (text) => {
    const content = (text ?? input).trim();
    if (!content || busy) return;
    setInput('');
    const next = [...messages, { role: 'user', content }];
    setMessages(next);
    setBusy(true);
    setBuilding(null);
    dispatch({ type: 'clear_proposal' });
    try {
      const payload = {
        // Local failure notices are UI artifacts, not conversation — replaying
        // them just invites the model to retry whatever already failed.
        messages: next.filter((m) => !m.local),
        tripDigest: `${tripDigest(state.trip, routedLegsByDay)}\n\n${feasibilityDigest(state.trip, routedLegsByDay)}\n\n${splitsDigest(state.trip, routedLegsByDay)}`,
        // Trimmed: read-only prose (photo notes, ops checklists, field notes)
        // is prefill the model pays for before it can start answering.
        tripJson: compactTripForModel(state.trip),
        scenarios: state.scenarios.map((s) => ({ id: s.id, name: s.name, savedAt: s.savedAt })),
      };
      // Background transport when the deployment has it (15-minute ceiling),
      // streaming otherwise. Both deliver the same events.
      let live = '';
      let started = false;
      const data = await runPlanner(payload, (obj) => {
        // Every server line is stamped with elapsed ms — drive a live counter
        // off it so a long restructure never looks like a hang.
        if (typeof obj.ms === 'number') {
          setBuilding((b) => ({ chars: obj.chars ?? b?.chars ?? 0, thinking: obj.thinking ?? b?.thinking ?? 0, ms: obj.ms }));
        }
        if (obj.type === 'delta') {
          live += obj.text;
          if (!started) {
            started = true;
            setMessages((m) => [...m, { role: 'assistant', content: live, streaming: true }]);
          } else {
            setMessages((m) => m.map((x, i) => (i === m.length - 1 && x.streaming ? { ...x, content: live } : x)));
          }
        }
      });
      const finalText = data.text || '(proposed changes below)';
      setMessages((m) => {
        const rest = m[m.length - 1]?.streaming ? m.slice(0, -1) : m;
        return [...rest, { role: 'assistant', content: finalText }];
      });
      if (data.proposal?.ops?.length) {
        dispatch({ type: 'set_proposal', proposal: data.proposal });
      }
    } catch (err) {
      if (err.code === 'not_configured') {
        setSetupNeeded(true);
        setMessages((m) => [...m, { role: 'assistant', local: true, content: 'The optimizer needs an Anthropic API key configured on Netlify before it can run — see the note below.' }]);
      } else {
        setMessages((m) => {
          // Keep whatever streamed — the analysis is usually the useful half —
          // but mark it so it is never mistaken for a finished answer.
          const kept = m.map((x) => (x.streaming ? { ...x, streaming: false, partial: true } : x));
          return [...kept, { role: 'assistant', local: true, content: err.message }];
        });
        // Hand the question back rather than making them retype it.
        setInput((cur) => cur || content);
      }
    } finally {
      setBusy(false);
      setBuilding(null);
    }
  };

  const applyProposal = () => {
    const { ops, saveAs, overwriteScenarioId } = state.pendingProposal;
    dispatch({ type: 'apply_ops', ops });
    const target = state.scenarios.find((s) => s.id === overwriteScenarioId);
    if (target) dispatch({ type: 'overwrite_scenario', id: target.id });
    else if (saveAs) dispatch({ type: 'save_scenario', name: saveAs });
    dispatch({ type: 'clear_proposal' });
    setMessages((m) => [...m, {
      role: 'assistant',
      content: target
        ? `Applied and updated scenario “${target.name}” — switch plans any time from the Plan strip (top of the trip overview or any day), or compare grades in the Feasibility view.`
        : saveAs
          ? `Applied and saved as “${saveAs}” — it's in the Plan strip at the top of the trip overview and every day panel, ready to switch to. Undo reverses the working plan.`
          : 'Applied. The map, timeline, and feasibility have recomputed — Undo reverses it if it reads wrong.',
    }]);
  };

  // Seed the proposal into a NEW trip instead of this one: ops apply to a
  // CLONE, which becomes its own unshared record. On a shared trip this is
  // the only safe way to take a personal variant — plain Apply would push
  // the ops to every rider before there was anything to fork.
  const applyAsNewTrip = () => {
    const { ops, saveAs } = state.pendingProposal;
    const { trip: forked, errors } = applyOps(structuredClone(state.trip), ops);
    if (errors.length) console.warn('fork op errors', errors);
    const name = saveAs || `${state.trip.meta.title} — variant`;
    forked.meta = { ...forked.meta, title: name };
    dispatch({ type: 'create_trip', trip: forked, name });
    dispatch({ type: 'clear_proposal' });
    setMessages((m) => [...m, {
      role: 'assistant',
      content: `Created “${name}” as its own trip and switched you to it — unshared, so nothing here touches the group plan. The original trip is exactly as it was; switch between them from HOME.`,
    }]);
  };

  const proposal = state.pendingProposal;

  return (
    <div className="chat-panel panel-view">
      <div className="chat-head">
        <span className="t">✦ <i>{t('Copilot')}</i></span>
        {messages.length > 0 && (
          <button
            className={`btn${confirmClear ? ' danger-ghost' : ''}`}
            title="Clear this trip's chat history"
            onClick={() => {
              if (!confirmClear) { setConfirmClear(true); setTimeout(() => setConfirmClear(false), 3000); return; }
              dispatch({ type: 'clear_chat' });
              setMessages([]);
              setConfirmClear(false);
            }}
          >{confirmClear ? t('Sure?') : t('Clear')}</button>
        )}
        {onClose && <button className="btn" onClick={onClose} aria-label={t('Close')}>✕</button>}
      </div>
      <div className="chat-msgs" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="msg ai">
            {t("I hold the whole plan — every waypoint, booking, fuel stop, and constraint — plus the live metrics from your edits. Ask for analysis, or tell me to rework the trip and I'll propose concrete changes you can preview and apply.")}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role === 'user' ? 'user' : 'ai'}`}>
            {m.content}
            {m.partial && <span className="cut">⋯ cut off here</span>}
          </div>
        ))}
        {busy && (
          <div className="msg ai">
            <span className="thinking">
              {(() => {
                const secs = building?.ms ? ` · ${Math.round(building.ms / 1000)}s` : '';
                if (!building) return t('analyzing the route…');
                if (building.chars > 0) return `${t('drafting changes…')} ${building.chars.toLocaleString()} ${t('characters')}${secs}`;
                if (building.thinking > 0) return `${t('working through the trip…')}${secs}`;
                return `reading the trip…${secs}`;
              })()}
            </span>
          </div>
        )}
      </div>

      {proposal && (
        <div className="proposal">
          <div className="p-title">{t('Proposed changes')}{proposal.saveAs ? ` → ${t('saves as')} “${proposal.saveAs}”` : ''}</div>
          <div style={{ fontSize: 13, color: 'var(--ink)', marginTop: 4 }}>{proposal.summary}</div>
          <ul>
            {describeOps(state.trip, proposal.ops).map((d, i) => <li key={i}>{d}</li>)}
          </ul>
          <div className="p-actions">
            <button className="btn gold" onClick={applyProposal}>{t('Apply')}</button>
            <button className="btn" onClick={applyAsNewTrip}>{t('Apply as new trip')}</button>
            <button className="btn" onClick={() => dispatch({ type: 'clear_proposal' })}>{t('Dismiss')}</button>
          </div>
        </div>
      )}

      {setupNeeded && (
        <div className="chat-setup">
          <b>One-time setup:</b> in the Netlify dashboard for this site, add an environment variable
          named <code>ANTHROPIC_API_KEY</code> (from console.anthropic.com), then redeploy. Everything
          else in the app works without it.
        </div>
      )}

      {messages.length === 0 && (
        <div className="chat-suggest">
          {/* the chip label is translated; the click sends the translated text,
              so the model is asked in the user's language and answers in it */}
          {SUGGESTIONS.map((s) => (
            <button key={s} onClick={() => send(t(s))}>{t(s)}</button>
          ))}
        </div>
      )}

      <div className="chat-input">
        <textarea
          value={input}
          placeholder={t('Ask, or tell me to rework the trip…')}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <button className="btn gold" onClick={() => send()} disabled={busy}>{t('Send')}</button>
      </div>
    </div>
  );
}
