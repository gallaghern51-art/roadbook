// Picking a language IS the instruction to translate. There is no second step:
// switch to Spanish and the trip's text starts arriving, cached onto the trip so
// it only ever happens once per trip per language.
//
// Terminating is the thing to get right here, because the work dispatches into
// the trip and the trip is what the effect watches:
//   · a full pass leaves nothing missing, so the next run returns immediately
//   · a partial pass leaves less missing, so the next run resumes the remainder
//   · a pass that returns nothing marks the language dead for this session,
//     which is what stops a missing API key from becoming a retry loop
// A manual retry lives in Settings → Developer tools for when the cause is
// fixed (key added, network back) without needing a reload.

import { useEffect, useRef, useState } from 'react';
import { useSettings } from './settings.jsx';
import { useTrip } from './store.js';
import { translationCoverage } from '../i18n/collect.js';
import { translateTrip } from './translate.js';

// Module-level: survives re-renders and remounts, resets on reload — which is
// the right lifetime for "this language is not working right now".
const deadLangs = new Set();

export function clearTranslateFailure(lang) {
  deadLangs.delete(lang);
}

export function useAutoTranslate() {
  const { lang } = useSettings();
  const { state, dispatch } = useTrip();
  const [progress, setProgress] = useState(null);
  const busy = useRef(false);
  const trip = state.trip;

  useEffect(() => {
    if (lang === 'en' || busy.current || deadLangs.has(lang)) return undefined;
    const { missing } = translationCoverage(trip, lang);
    if (!missing.length) return undefined;

    busy.current = true;
    let canceled = false;

    (async () => {
      try {
        const { translations, done } = await translateTrip(trip, lang, (p) => {
          if (!canceled) setProgress(p);
        });
        if (canceled) return;
        if (done > 0) dispatch({ type: 'save_translations', lang, translations });
        else deadLangs.add(lang); // nothing came back — stop rather than spin
      } finally {
        if (!canceled) {
          busy.current = false;
          setProgress(null);
        }
      }
    })();

    return () => { canceled = true; busy.current = false; };
  }, [lang, trip, dispatch]);

  return { progress, unavailable: deadLangs.has(lang) };
}
