import React, { useEffect, useRef } from 'react';
import { useT } from '../engine/settings.jsx';
import { PRIVACY, TERMS, LEGAL_EFFECTIVE_DATE, COMPANY, POSTAL_ADDRESS } from '../data/legal.js';
import { RoadbookBrand } from './Chrome.jsx';

// Privacy Policy and Terms of Service — one sheet, the guide's shell, no
// dependencies beyond the settings provider, so it serves the signed-out
// door (footer links), Settings → About, the account card, and the cold
// #privacy / #terms deep links. The prose lives in src/data/legal.js.
export default function LegalSheet({ doc = 'privacy', onClose, onSwitch }) {
  const t = useT();
  const d = doc === 'terms' ? TERMS : PRIVACY;
  const bodyRef = useRef(null);
  useEffect(() => { bodyRef.current?.scrollTo?.({ top: 0 }); }, [doc]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop guide-backdrop legal-backdrop" onClick={onClose}>
      <div className="modal guide-modal legal-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={d.title}>
        <div className="modal-head">
          <div>
            <div className="eyebrow">{t('Legal')}</div>
            <h3>{d.title}</h3>
          </div>
          <button className="btn" onClick={onClose} aria-label={t('Close')}>✕</button>
        </div>
        <div className="legal-body" ref={bodyRef}>
          <p className="legal-date">{t('Effective and last updated')} {LEGAL_EFFECTIVE_DATE}</p>
          <p className="legal-intro">{d.intro}</p>
          {d.sections.map((s) => (
            <section key={s.h} className="legal-sec">
              <h4>{s.h}</h4>
              {s.p?.map((p, i) => <p key={i}>{p}</p>)}
              {s.ul && <ul>{s.ul.map((li, i) => <li key={i}>{li}</li>)}</ul>}
            </section>
          ))}
          <footer className="legal-foot">
            <span className="brand"><RoadbookBrand /></span>
            <span>© 2026 {COMPANY} All rights reserved. · {POSTAL_ADDRESS}</span>
            <span className="legal-links">
              <button type="button" className={doc === 'privacy' ? 'on' : ''} onClick={() => onSwitch?.('privacy')}>{t('Privacy Policy')}</button>
              <button type="button" className={doc === 'terms' ? 'on' : ''} onClick={() => onSwitch?.('terms')}>{t('Terms of Service')}</button>
            </span>
          </footer>
        </div>
      </div>
    </div>
  );
}
