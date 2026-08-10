import React from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/app.css';
import App from './App.jsx';
import { SettingsProvider } from './engine/settings.jsx';

// Installed PWA (standalone): iOS launches — and returns from the app
// switcher — with a stale viewport that CSS [d]vh AND the % chain both
// inherit, floating the bottom bar off the bottom until a drag. So the
// shells size off a MEASURED height (--app-h) instead. innerHeight can stay
// stale for a while too, but the visual viewport usually knows the truth
// first — take the larger credible one, and keep re-reading on a short
// settle poll after every launch/return, since iOS corrects the numbers on
// its own lazy schedule without always firing an event.
if (window.matchMedia?.('(display-mode: standalone)').matches) {
  const root = document.documentElement;
  const measure = () => {
    const vv = window.visualViewport;
    const h = Math.max(
      window.innerHeight || 0,
      vv && vv.scale === 1 ? Math.round(vv.height + (vv.offsetTop || 0)) : 0
    );
    if (h > 0) root.style.setProperty('--app-h', `${h}px`);
  };
  let pollId = 0;
  const settle = () => {
    clearInterval(pollId);
    let n = 0;
    measure();
    pollId = setInterval(() => { measure(); if (++n >= 12) clearInterval(pollId); }, 250);
  };
  settle();
  window.addEventListener('resize', measure);
  window.visualViewport?.addEventListener('resize', measure);
  window.addEventListener('orientationchange', settle);
  window.addEventListener('pageshow', settle);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') settle();
  });
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <SettingsProvider>
      <App />
    </SettingsProvider>
  </React.StrictMode>
);
