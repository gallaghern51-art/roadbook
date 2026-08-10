import React from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/app.css';
import App from './App.jsx';
import { SettingsProvider } from './engine/settings.jsx';

// Installed PWA (standalone): iOS launches with a stale viewport that CSS
// [d]vh AND the % chain both inherit — the bottom bar floats off the bottom
// and nothing re-resolves until a drag. window.innerHeight corrects itself a
// beat after launch (and fires resize when it does), so mirror the measured
// height into --app-h and let the shells size off that instead.
if (window.matchMedia?.('(display-mode: standalone)').matches) {
  const setH = () => document.documentElement.style.setProperty('--app-h', `${window.innerHeight}px`);
  setH();
  // the corrected height lands shortly after first paint
  setTimeout(setH, 60);
  setTimeout(setH, 300);
  setTimeout(setH, 1000);
  window.addEventListener('resize', setH);
  window.visualViewport?.addEventListener('resize', setH);
  window.addEventListener('orientationchange', () => setTimeout(setH, 250));
  window.addEventListener('pageshow', setH);
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <SettingsProvider>
      <App />
    </SettingsProvider>
  </React.StrictMode>
);
