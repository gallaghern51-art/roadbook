import React from 'react';
import { useSettings, useT } from '../engine/settings.jsx';

export function RoadbookBrand() {
  return (
    <span className="roadbook-lockup">
      <svg className="roadbook-mark" viewBox="0 0 36 36" aria-hidden="true">
        <rect className="mark-frame" x="5" y="4.5" width="26" height="27" rx="5" />
        <path className="mark-route" d="M9 26.5c2.8-1.1 3.8-4.6 6.3-5.4 2.9-.9 4 2 6.3.7 2.2-1.2.9-4.2 3.3-6.2 1.4-1.1 2.2-2.7 2.2-5.1" />
        <circle className="mark-start" cx="9" cy="26.5" r="1.7" />
        <path className="mark-finish" d="M25.4 8.4v5.5m0-5.2h4l-1.3 1.5 1.3 1.5h-4" />
      </svg>
      <span className="roadbook-wordmark">ROAD<span className="yr">BOOK</span></span>
    </span>
  );
}

export function SettingsIcon() {
  return (
    <svg className="chrome-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 8.2a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" />
      <path d="M19.2 13.3v-2.6l-2-.6a7 7 0 0 0-.7-1.6l1-1.8-1.9-1.9-1.8 1a7 7 0 0 0-1.6-.7l-.6-2H9l-.6 2a7 7 0 0 0-1.6.7L5 4.8 3.1 6.7l1 1.8a7 7 0 0 0-.7 1.6l-2 .6v2.6l2 .6a7 7 0 0 0 .7 1.6l-1 1.8L5 19.2l1.8-1a7 7 0 0 0 1.6.7l.6 2h2.6l.6-2a7 7 0 0 0 1.6-.7l1.8 1 1.9-1.9-1-1.8a7 7 0 0 0 .7-1.6l2-.6Z" />
    </svg>
  );
}

export function ThemeToggle({ className = '' }) {
  const { theme, set } = useSettings();
  const t = useT();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      className={`theme-toggle ${className}`.trim()}
      aria-label={`${t('Theme')}: ${t(next === 'light' ? 'Light' : 'Dark')}`}
      title={`${t('Theme')}: ${t(next === 'light' ? 'Light' : 'Dark')}`}
      onClick={() => set({ theme: next })}
    >
      <svg className="theme-sun" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="3.25" />
        <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
      </svg>
      <svg className="theme-moon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 15.1A8.2 8.2 0 0 1 8.9 4a8.2 8.2 0 1 0 11.1 11.1Z" />
      </svg>
    </button>
  );
}
