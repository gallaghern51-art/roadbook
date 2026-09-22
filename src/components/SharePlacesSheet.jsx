import React, { useEffect, useRef, useState } from 'react';
import { Sheet } from './Sheets.jsx';
import { useT } from '../engine/settings.jsx';
import { createShareLink, sendShareLink } from '../engine/placeShare.js';

// Share a place or a list as a link (owner, Sep 22 2026: "share locations to
// someone with link and they can click and open in their roadbook").
//
// Two steps on purpose. Making the link is a network call, and a phone's share
// sheet (navigator.share) only opens from a FRESH tap — Safari refuses it once
// the tap that started things has waited on the network. So this sheet makes
// the link the moment it opens, shows it, and "Send…" hands it to Messages /
// WhatsApp / Mail from its own tap. "Copy link" works everywhere, and the link
// itself is on screen for a rider who would rather long-press it.
//
//   payload  { name, kind: 'place'|'list', places }
export default function SharePlacesSheet({ payload, onClose }) {
  const t = useT();
  const [link, setLink] = useState(null);   // { url, inline }
  const [status, setStatus] = useState('');  // '' | copied | shared | failed
  const fieldRef = useRef(null);
  useEffect(() => {
    let dead = false;
    createShareLink(payload).then((l) => { if (!dead) setLink(l); });
    return () => { dead = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const n = payload.places.length;
  const text = payload.kind === 'list'
    ? `${payload.name} — ${n} ${n === 1 ? t('place') : t('places')} ${t('in Roadbook')}`
    : `${payload.name} ${t('in Roadbook')}`;
  const canSend = typeof navigator !== 'undefined' && !!navigator.share;

  const send = async () => {
    const r = await sendShareLink({ title: payload.name, text, url: link.url });
    setStatus(r === 'manual' ? 'failed' : r === 'cancelled' ? '' : r);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(link.url); setStatus('copied'); } catch {
      fieldRef.current?.select();
      setStatus('failed');
    }
  };

  return (
    <Sheet
      eyebrow={payload.kind === 'list' ? t('Share list') : t('Share place')}
      title={payload.name}
      onClose={onClose}
      foot={(
        <>
          <span className="foot-note" />
          <button className="btn" disabled={!link} onClick={copy}>{status === 'copied' ? `✓ ${t('Copied')}` : t('Copy link')}</button>
          {canSend && <button className="btn gold" disabled={!link} onClick={send}>{t('Send…')}</button>}
        </>
      )}
    >
      <div className="share-sheet">
        <p className="sheet-body">
          {payload.kind === 'list'
            ? `${n} ${n === 1 ? t('place') : t('places')} · ${t('whoever opens the link sees them on their map in Roadbook and can save them to their own places.')}`
            : t('Whoever opens the link sees it on their map in Roadbook and can save it to their own places.')}
        </p>
        <ul className="share-list">
          {payload.places.slice(0, 5).map((p, i) => <li key={`${p.lat},${p.lng},${i}`}><b>{p.label ?? p.name}</b>{(p.address ?? p.detail) ? <small>{p.address ?? p.detail}</small> : null}</li>)}
          {n > 5 && <li className="more">+ {n - 5} {t('more')}</li>}
        </ul>
        <label className="fld">{t('Link')}
          <input ref={fieldRef} readOnly value={link?.url ?? t('Making a link…')} onFocus={(e) => e.target.select()} />
        </label>
        {status === 'copied' && <p className="nb-note ok">{t('Link copied — paste it into a message.')}</p>}
        {status === 'shared' && <p className="nb-note ok">{t('Sent.')}</p>}
        {status === 'failed' && <p className="nb-note warn">{t('Copy the link above by hand — this browser would not do it.')}</p>}
        {link?.inline && <p className="nb-note">{t('The places ride inside this link, so it is long — it still opens anywhere.')}</p>}
      </div>
    </Sheet>
  );
}
