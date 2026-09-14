import React, { useEffect, useRef } from 'react';
import { RIDE_SAFETY, RIDE_SAFETY_VERSION } from '../data/legal.js';
import { useT } from '../engine/settings.jsx';

// The gate in front of Ride Mode.
//
// Roadbook gives turn-by-turn directions to people on motorcycles at speed, and
// the Terms' "Ride at your own risk" clause is where that is written down —
// which is to say, somewhere nobody has ever opened. This is the same four
// facts said once, full screen, before the first navigation, where a rider
// actually reads them.
//
// It gates the MOUNT, not the render: App does not mount RideMode until the
// rider has accepted, so nothing starts a GPS watch, a wake lock, a map or a
// steps fetch behind a screen that has not been answered yet.
//
// The acknowledgement is stored with the version it was given for and with the
// moment it was given. Both halves matter: the version means a changed rule
// asks again instead of riding on an old tick, and the timestamp is the only
// record that this rider saw this warning on this device.

const KEY = 'moto.rideSafety.v1';

export function readRideAck() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || 'null');
    return raw && typeof raw === 'object' ? raw : null;
  } catch { return null; } // a private window or blocked storage: gate again, never throw
}

/** True when this device has accepted the CURRENT rules. An older version, a
    cleared store or a browser that refuses storage all read as "not yet", which
    is the safe direction to fail in. */
export function rideAckCurrent() {
  const ack = readRideAck();
  return !!ack && ack.v === RIDE_SAFETY_VERSION;
}

export function writeRideAck() {
  try {
    localStorage.setItem(KEY, JSON.stringify({ v: RIDE_SAFETY_VERSION, at: new Date().toISOString() }));
  } catch { /* storage refused; the gate simply asks again next time */ }
}

export default function RideSafety({ onAccept, onCancel, onLegal }) {
  const t = useT();
  const acceptRef = useRef(null);

  // Escape is "not now" — the same as the back button, and the only key that
  // does anything here: accepting is a deliberate press, never a stray Enter.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onCancel?.(); };
    window.addEventListener('keydown', onKey);
    acceptRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const accept = () => { writeRideAck(); onAccept?.(); };

  return (
    <div className="ride-safety" role="dialog" aria-modal="true" aria-labelledby="rs-title">
      <div className="rs-inner">
        <div className="rs-scroll">
        <header className="rs-head">
          <span className="rs-eyebrow">{t('Ride Mode')}</span>
          <h2 id="rs-title">{RIDE_SAFETY.title}</h2>
          <p className="rs-intro">{RIDE_SAFETY.intro}</p>
        </header>

        <ol className="rs-rules">
          {RIDE_SAFETY.rules.map((r, i) => (
            <li key={r.h}>
              <span className="rs-n" aria-hidden="true">{i + 1}</span>
              <div>
                <b>{r.h}</b>
                <p>{r.p}</p>
              </div>
            </li>
          ))}
        </ol>

        <p className="rs-foot">{RIDE_SAFETY.foot}</p>
        </div>

        <div className="rs-dock">
        <div className="rs-actions">
          <button ref={acceptRef} type="button" className="btn gold rs-go" onClick={accept}>
            {t('I understand — start navigation')}
          </button>
          <button type="button" className="btn rs-not" onClick={onCancel}>{t('Not now')}</button>
        </div>

        <p className="rs-legal">
          <button type="button" onClick={() => onLegal?.('terms')}>{t('Terms of Service')}</button>
          <span aria-hidden="true"> · </span>
          <button type="button" onClick={() => onLegal?.('privacy')}>{t('Privacy Policy')}</button>
        </p>
        </div>
      </div>
    </div>
  );
}
