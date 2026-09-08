import React from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/app.css';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { SettingsProvider } from './engine/settings.jsx';

// Establish the shell mode before React creates any UI.
//
// iOS has two different answers for "am I a Home Screen app?". Modern
// installs usually match the display-mode media query; older icons and icons
// created through Safari's legacy Add to Home Screen path can report ONLY
// navigator.standalone. The shell used to trust the media query alone, so none
// of its fixed-viewport or safe-area rules ran on exactly those installations.
// That produced the field screenshots: a short shell above the Home indicator,
// then a masthead under the status bar when the side panel changed the layout.
const root = document.documentElement;
const standaloneMedia = window.matchMedia?.('(display-mode: standalone)');
const appleStandalone = navigator.standalone === true;

const syncShellMode = () => {
  const standalone = appleStandalone || standaloneMedia?.matches === true;
  root.dataset.appDisplay = standalone ? 'standalone' : 'browser';
  root.toggleAttribute('data-apple-standalone', appleStandalone);

  // There is no top guard any more, and this is the reason.
  //
  // It existed to hold the masthead clear of a status bar drawn ON TOP of the
  // page, which is what `black-translucent` does. index.html now ships
  // `black`: iOS places the web view BELOW the status bar, so nothing overlaps
  // the top of the page and `env(safe-area-inset-top)` is the whole answer —
  // zero in portrait, zero in landscape. A device-shaped 62px fallback here
  // would now push the masthead 62pt down inside a box that already starts
  // below the status bar, which is the bug it was written to prevent.
  //
  // The bottom guard, by contrast, only just became load-bearing. Until now
  // the shell stopped ~62pt above the glass and the Home indicator was
  // somebody else's problem; the shell reaches the glass now, so the mode bar
  // has to clear the gesture itself. `env(safe-area-inset-bottom)` is still
  // authoritative — this is the fallback for an install that reports zero.
  let bottomGuard = 0;
  if (appleStandalone) {
    const portrait = !window.matchMedia('(orientation: landscape)').matches;
    const shortSide = Math.min(screen.width || 0, screen.height || 0);
    const longSide = Math.max(screen.width || 0, screen.height || 0);
    const fullScreenIPhone = shortSide <= 440 && longSide >= 812;
    if (fullScreenIPhone) bottomGuard = portrait ? 34 : 21;
  }
  root.style.setProperty('--ios-home-guard', `${bottomGuard}px`);

  // NOTE: a --shell-h experiment lived here and was reverted — see app.css.
  // iOS CLIPS a black-translucent standalone app to its reported viewport, so
  // sizing the shell to screen.height hid the mode bar entirely. That is the
  // failure the status-bar style change above actually fixes.
};

syncShellMode();
if (standaloneMedia?.addEventListener) standaloneMedia.addEventListener('change', syncShellMode);
else standaloneMedia?.addListener?.(syncShellMode);
window.addEventListener('orientationchange', () => {
  syncShellMode();
  // WebKit can dispatch orientationchange just before its media queries and
  // screen metrics settle. The second read prevents a portrait guard surviving
  // into landscape (or the reverse) until the next interaction.
  setTimeout(syncShellMode, 250);
});

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/* Outside SettingsProvider on purpose: if the settings store itself is what
        threw, the boundary still has to render. */}
    <ErrorBoundary>
      <SettingsProvider>
        <App />
      </SettingsProvider>
    </ErrorBoundary>
  </React.StrictMode>
);
