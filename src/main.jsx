import React from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/app.css';
import App from './App.jsx';
import { SettingsProvider } from './engine/settings.jsx';

// Installed PWA (standalone): iOS launches — and returns from the app
// switcher — with a stale viewport that CSS [d]vh AND the % chain both
// inherit, floating the bottom bar off the bottom until a drag. So the
// shells size off a MEASURED height (--app-h) instead. At a stale launch
// innerHeight AND visualViewport report the SAME short number — the max of
// two stale values is still stale, and iOS often doesn't correct either
// until a user drag. But screen.width/height are hardware truth, and this
// app runs black-translucent + viewport-fit=cover, so standalone content
// covers the WHOLE screen: the real height IS the screen height. Floor the
// measurement there whenever the app spans the full screen width (the
// width axis never goes stale) — the guard keeps iPad Split View and
// pinch-zoom honest. iOS-only (via navigator.standalone, which only iOS
// Safari exposes): Android/desktop standalone content sits BELOW system
// chrome, where the screen height over-reports, and their viewport numbers
// aren't stale anyway.
if (window.matchMedia?.('(display-mode: standalone)').matches) {
  const root = document.documentElement;
  const ios = 'standalone' in navigator;
  const measure = () => {
    const vv = window.visualViewport;
    let floor = 0;
    if (ios) {
      // iOS keeps screen.width/height portrait-fixed; derive by orientation.
      const portrait = !window.matchMedia('(orientation: landscape)').matches;
      const a = screen.width || 0, b = screen.height || 0;
      const scrW = portrait ? Math.min(a, b) : Math.max(a, b);
      const scrH = portrait ? Math.max(a, b) : Math.min(a, b);
      if (Math.abs((window.innerWidth || 0) - scrW) <= 2) floor = scrH;
    }
    const h = Math.max(
      window.innerHeight || 0,
      vv && vv.scale === 1 ? Math.round(vv.height + (vv.offsetTop || 0)) : 0,
      floor
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
