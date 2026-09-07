import React from 'react';
import { createRoot } from 'react-dom/client';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles/app.css';
import App from './App.jsx';
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

  // `env(safe-area-inset-*)` remains authoritative. A legacy iOS Home Screen
  // install can return zero, though, so provide a device-shaped fallback only
  // for that platform. These are the CSS-pixel safe areas used by the iPhone
  // families; iPad is excluded by its much wider hardware screen. In landscape
  // the status bar is not above the app, while the Home gesture keeps a smaller
  // bottom exclusion.
  let topGuard = 0;
  let bottomGuard = 0;
  if (appleStandalone) {
    const portrait = !window.matchMedia('(orientation: landscape)').matches;
    const shortSide = Math.min(screen.width || 0, screen.height || 0);
    const longSide = Math.max(screen.width || 0, screen.height || 0);
    const fullScreenIPhone = shortSide <= 440 && longSide >= 812;
    if (fullScreenIPhone) {
      if (portrait) {
        topGuard = longSide >= 874 && shortSide >= 402 ? 62
          : longSide >= 852 && shortSide >= 393 ? 59
            : 47;
        bottomGuard = 34;
      } else {
        bottomGuard = 21;
      }
    } else if (portrait && shortSide <= 440) {
      topGuard = 20;
    }
  }
  root.style.setProperty('--ios-status-guard', `${topGuard}px`);
  root.style.setProperty('--ios-home-guard', `${bottomGuard}px`);
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
    <SettingsProvider>
      <App />
    </SettingsProvider>
  </React.StrictMode>
);
