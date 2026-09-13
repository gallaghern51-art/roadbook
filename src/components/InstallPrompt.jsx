import React, { useEffect, useState } from 'react';
import { useT } from '../engine/settings.jsx';

// "Add this to your Home Screen" — shown only in a browser tab, never inside
// the installed app, and never twice in a fortnight once dismissed.
//
// Why it exists: Ride Mode is a full-screen app that holds the wake lock and
// runs on GPS; in a Safari tab it fights the browser chrome for the screen and
// loses it on every scroll. The install is the difference between a nav app
// and a web page, and iOS gives a site no way to trigger it — the rider has to
// do the Share → Add to Home Screen dance by hand. So the prompt has to TEACH
// it, per browser, because Safari and Chrome on an iPhone put the button in
// different places.
//
// Android/desktop Chrome fire `beforeinstallprompt`; there the card offers a
// real Install button and the written steps are the fallback.

const SNOOZE_KEY = 'moto.installSnooze.v1';
const SNOOZE_MS = 14 * 24 * 3600 * 1000;

export function isStandalone() {
  return navigator.standalone === true || window.matchMedia?.('(display-mode: standalone)')?.matches === true;
}

function platform() {
  const ua = navigator.userAgent || '';
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios) {
    // Chrome/Firefox/Edge on iOS all wrap WebKit; their share button lives in
    // the ⋯ menu rather than on the toolbar.
    if (/CriOS/.test(ua)) return 'ios-chrome';
    if (/FxiOS|EdgiOS/.test(ua)) return 'ios-other';
    return 'ios-safari';
  }
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}

export default function InstallPrompt() {
  const t = useT();
  const [show, setShow] = useState(false);
  const [deferred, setDeferred] = useState(null); // beforeinstallprompt event
  const [plat] = useState(platform);

  useEffect(() => {
    if (isStandalone()) return undefined;
    try {
      const until = Number(localStorage.getItem(SNOOZE_KEY) || 0);
      if (until > Date.now()) return undefined;
    } catch { /* storage blocked — show once */ }
    setShow(true);
    const onPrompt = (e) => { e.preventDefault(); setDeferred(e); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    // installed from this tab → the card is done
    const onInstalled = () => setShow(false);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const dismiss = () => {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + SNOOZE_MS)); } catch { /* non-fatal */ }
    setShow(false);
  };
  const install = async () => {
    if (!deferred) return;
    deferred.prompt();
    const { outcome } = await deferred.userChoice.catch(() => ({ outcome: 'dismissed' }));
    if (outcome === 'accepted') setShow(false);
    setDeferred(null);
  };

  if (!show) return null;

  // Step text per browser. Written as the rider will see the buttons.
  const steps = plat === 'ios-safari' ? [
    t('Tap the Share button — the square with the arrow — at the bottom of Safari'),
    t('Scroll down and tap “Add to Home Screen”'),
    t('Tap “Add” — Roadbook opens full-screen from your Home Screen'),
  ] : plat === 'ios-chrome' || plat === 'ios-other' ? [
    t('Tap the ⋯ menu at the top right'),
    t('Tap “Share”, then scroll down to “Add to Home Screen”'),
    t('Tap “Add” — Roadbook opens full-screen from your Home Screen'),
  ] : plat === 'android' ? [
    t('Tap the ⋮ menu at the top right of the browser'),
    t('Tap “Add to Home screen” or “Install app”'),
    t('Confirm — Roadbook opens full-screen from your Home Screen'),
  ] : [
    t('Look for the install icon at the right end of the address bar'),
    t('Or open the browser menu and choose “Install Roadbook”'),
  ];

  return (
    <aside className="install-card" role="complementary" aria-label={t('Install Roadbook')}>
      <button className="install-x" onClick={dismiss} aria-label={t('Not now')}>✕</button>
      <div className="install-head">
        <div className="install-mark" aria-hidden="true">⤓</div>
        <div>
          <b>{t('Add Roadbook to your Home Screen')}</b>
          <small>{t('Full-screen, offline, and Ride Mode keeps the screen awake — a tab cannot do that.')}</small>
        </div>
      </div>
      {deferred ? (
        <div className="install-actions">
          <button className="btn gold" onClick={install}>{t('Install')}</button>
          <button className="btn" onClick={dismiss}>{t('Not now')}</button>
        </div>
      ) : (
        <>
          <ol className="install-steps">
            {steps.map((s, i) => <li key={i}>{s}</li>)}
          </ol>
          <div className="install-actions">
            <button className="btn" onClick={dismiss}>{t('Not now')}</button>
          </div>
        </>
      )}
    </aside>
  );
}
