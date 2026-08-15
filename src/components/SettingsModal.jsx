import React, { useState } from 'react';
import { useSettings, useT } from '../engine/settings.jsx';
import { useTrip } from '../engine/store.js';
import { translationCoverage } from '../i18n/collect.js';
import { clearTranslateFailure } from '../engine/autoTranslate.js';
import SyncPanel from './SyncPanel.jsx';
import AccountPanel from './AccountPanel.jsx';

// Language + theme, per device. Both apply instantly; nothing to save.
export default function SettingsModal({ sync, auth, backup, onCreateAccount }) {
  const { lang, theme, units, shields, set } = useSettings();
  const t = useT();
  const [devOpen, setDevOpen] = useState(false);
  const { state } = useTrip();
  // Diagnostic only — translation itself runs the moment a language is chosen.
  const coverage = translationCoverage(state.trip, lang === 'en' ? 'es' : lang);

  return (
    <div className="panel-view settings">
      <div className="panel-view-inner">
        <div className="modal-head">
          <h3>{t('Settings')}</h3>
        </div>
        <div className="modal-body">
          <div className="set-row">
            <span className="set-label">{t('Language')}</span>
            <div className="set-seg">
              <button className={lang === 'en' ? 'active' : ''} onClick={() => set({ lang: 'en' })}>{t('English')}</button>
              <button className={lang === 'es' ? 'active' : ''} onClick={() => set({ lang: 'es' })}>{t('Spanish')}</button>
            </div>
          </div>
          <div className="set-row">
            <span className="set-label">{t('Theme')}</span>
            <div className="set-seg">
              <button className={theme === 'dark' ? 'active' : ''} onClick={() => set({ theme: 'dark' })}>{t('Dark')}</button>
              <button className={theme === 'light' ? 'active' : ''} onClick={() => set({ theme: 'light' })}>{t('Light')}</button>
            </div>
          </div>
          <div className="set-row">
            <span className="set-label">{t('Units')}</span>
            <div className="set-seg">
              <button className={units === 'imperial' ? 'active' : ''} onClick={() => set({ units: 'imperial' })}>{t('Imperial (mi, °F)')}</button>
              <button className={units === 'metric' ? 'active' : ''} onClick={() => set({ units: 'metric' })}>{t('Metric (km, °C)')}</button>
            </div>
          </div>

          <p className="set-note">
            {t('Applies on this device only. Trip text and AI answers stay in the language they were written in — ask the optimizer in Spanish and it answers in Spanish.')}
          </p>

          <AccountPanel auth={auth} backup={backup} onCreateAccount={onCreateAccount} />

          {sync && <SyncPanel sync={sync} />}

          {/* The map credits. Esri and OpenMapTiles require these to be shown;
              they do not require them to be shown on the map, so they live here
              rather than as a pill across the corner of every view. */}
          <div className="set-credits">
            <span className="set-label">{t('Credits')}</span>
            <p>
              Map imagery © Esri, Maxar, Earthstar Geographics · Street data ©
              {' '}OpenStreetMap contributors, © OpenMapTiles · Routing by OSRM
              {' '}· Highway shields from Wikimedia Commons · Weather by Open-Meteo
            </p>
          </div>

          {/* Experiments live behind a fold so the everyday settings stay to
              three choices. Anything in here can be pulled without ceremony. */}
          <div className="set-dev">
            <button className="set-dev-toggle" aria-expanded={devOpen} onClick={() => setDevOpen((v) => !v)}>
              {devOpen ? '▾' : '▸'} {t('Developer tools')}
            </button>
            {devOpen && (
              <div className="set-dev-body">
                <div className="set-row">
                  <span className="set-label">{t('Highway shields')}</span>
                  <div className="set-seg">
                    <button className={shields ? 'active' : ''} onClick={() => set({ shields: true })}>{t('On')}</button>
                    <button className={!shields ? 'active' : ''} onClick={() => set({ shields: false })}>{t('Off')}</button>
                  </div>
                </div>
                <p className="set-note">{t('Route shields under each stop. Experimental — remove it if it reads as clutter.')}</p>
                <div className="set-row">
                  <span className="set-label">{t('Trip text')}</span>
                  <span className="set-xlate-count">
                    {coverage.done}/{coverage.total} {t('translated')}
                    {coverage.missing.length > 0 && (
                      <button className="btn set-retry" onClick={() => clearTranslateFailure('es')}>{t('Retry')}</button>
                    )}
                  </span>
                </div>
                <p className="set-note">{t('Trip text translates itself when you pick a language, and is stored on the trip so it travels with export and import. Retry is only needed if a run was interrupted.')}</p>
                <div className="set-build">
                  <span className="set-label">{t('Build')}</span>
                  <code>
                    {__APP_PR__ ? `PR #${__APP_PR__} · ` : ''}
                    {__APP_BRANCH__ ? `${__APP_BRANCH__} · ` : ''}
                    {__APP_COMMIT__} · v{__APP_VERSION__} · {__APP_BUILT__}
                  </code>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
