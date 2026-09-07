import React, { useState } from 'react';
import { useSettings, useT } from '../engine/settings.jsx';
import { useTrip } from '../engine/store.js';
import { translationCoverage } from '../i18n/collect.js';
import { clearTranslateFailure } from '../engine/autoTranslate.js';
import SyncPanel from './SyncPanel.jsx';
import AccountPanel from './AccountPanel.jsx';
import PlacesPanel from './PlacesPanel.jsx';
import RiderPanel from './RiderPanel.jsx';
import { cacheReport, clearRouteCaches } from '../engine/routing.js';

// Settings, in sections.
//
// It used to be one flat list of three device switches, which was honest when
// three switches was all there was — but every graded output in this app is
// supposed to have an input, and by now a lot of them had grown one somewhere
// else or nowhere at all. So the sections are organized by WHOSE fact it is,
// not by which screen it happens to affect:
//
//   Account / Places / Riding  — the RIDER's, and they follow the account.
//   Display / Map / Ride       — the DEVICE's, and they stay on it.
//   Crew / Data / About        — the app's own plumbing.
//
// That split is the reason home address and food preferences are not in
// settings.jsx: you want those on your new phone next year, and you do not want
// somebody else's phone in the crew inheriting your dark mode.

const SECTIONS = [
  ['account', 'Account'],
  ['places', 'Places'],
  ['riding', 'Riding'],
  ['display', 'Display'],
  ['map', 'Map'],
  ['ride', 'Ride Mode'],
  ['crew', 'Crew'],
  ['data', 'Data'],
  ['about', 'About'],
];

// Everything the shell layout depends on, read at the moment it is asked for.
function readShell() {
  const cs = getComputedStyle(document.documentElement);
  const app = document.querySelector('.app')?.getBoundingClientRect();
  const px = (v) => Math.round(parseFloat(cs.getPropertyValue(v)) || 0);
  return {
    mode: document.documentElement.dataset.appDisplay ?? 'unset',
    apple: navigator.standalone === true,
    top: px('--viewport-safe-top'),
    bottom: px('--viewport-safe-bottom'),
    guardTop: px('--ios-status-guard'),
    guardBottom: px('--ios-home-guard'),
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    screenW: window.screen?.width ?? 0,
    screenH: window.screen?.height ?? 0,
    appTop: app ? Math.round(app.top) : null,
    appBottom: app ? Math.round(app.bottom) : null,
    // The number that answers "why does the bottom bar sit high".
    gapBelow: app ? Math.round(window.innerHeight - app.bottom) : null,
  };
}

function Seg({ label, value, options, onPick, note }) {
  return (
    <>
      <div className="set-row">
        <span className="set-label">{label}</span>
        <div className="set-seg">
          {options.map(([v, l]) => (
            <button key={String(v)} type="button" className={value === v ? 'active' : ''} onClick={() => onPick(v)}>{l}</button>
          ))}
        </div>
      </div>
      {note && <p className="set-note">{note}</p>}
    </>
  );
}

export default function SettingsModal({ sync, auth, backup, profile, onCreateAccount }) {
  const s = useSettings();
  const { lang, theme, units, shields, density, basemap, terrain, voice, speedSign, keepAwake, set } = s;
  const t = useT();
  const { state } = useTrip();
  const [tab, setTab] = useState('account');
  const [cache, setCache] = useState(null);
  const [shell, setShell] = useState(null);
  const coverage = translationCoverage(state.trip, lang === 'en' ? 'es' : lang);

  const backupNote = (() => {
    if (!auth?.account) return t('Sign in and your places and preferences travel with you.');
    if (profile?.status === 'saved') return t('Saved to your account.');
    if (profile?.status === 'syncing') return t('Saving…');
    if (profile?.status === 'error') return t('Kept on this device — the account copy could not be reached.');
    return t('Kept on this device.');
  })();

  return (
    <div className="panel-view settings">
      <div className="panel-view-inner">
        <div className="modal-head"><h3>{t('Settings')}</h3></div>

        <div className="set-tabs" role="tablist" aria-label={t('Settings')}>
          {SECTIONS.map(([id, label]) => (
            <button
              key={id} type="button" role="tab" aria-selected={tab === id}
              className={tab === id ? 'active' : ''} onClick={() => setTab(id)}
            >{t(label)}</button>
          ))}
        </div>

        <div className="modal-body">
          {tab === 'account' && (
            <div className="set-section">
              <AccountPanel auth={auth} backup={backup} onCreateAccount={onCreateAccount} />
            </div>
          )}

          {tab === 'places' && (
            <>
              <PlacesPanel
                profile={profile?.profile}
                onSave={(p) => profile?.setPlace(p)}
                onRemove={(id) => profile?.dropPlace(id)}
              />
              <p className="set-note">{backupNote}</p>
            </>
          )}

          {tab === 'riding' && (
            <>
              <RiderPanel
                profile={profile?.profile}
                onRiding={(patch) => profile?.setRiding(patch)}
                onTaste={(patch) => profile?.setTaste(patch)}
                onCosts={(patch) => profile?.setCosts(patch)}
              />
              <p className="set-note">{backupNote}</p>
            </>
          )}

          {tab === 'display' && (
            <div className="set-section">
              <Seg
                label={t('Language')} value={lang} onPick={(v) => set({ lang: v })}
                options={[['en', t('English')], ['es', t('Spanish')]]}
              />
              <Seg
                label={t('Theme')} value={theme} onPick={(v) => set({ theme: v })}
                options={[['dark', t('Dark')], ['light', t('Light')]]}
              />
              <Seg
                label={t('Units')} value={units} onPick={(v) => set({ units: v })}
                options={[['imperial', t('Imperial (mi, °F)')], ['metric', t('Metric (km, °C)')]]}
              />
              <p className="set-note">
                {t('Applies on this device only. Trip text and AI answers stay in the language they were written in — ask the optimizer in Spanish and it answers in Spanish.')}
              </p>
            </div>
          )}

          {tab === 'map' && (
            <div className="set-section">
              <Seg
                label={t('Default basemap')} value={basemap} onPick={(v) => set({ basemap: v })}
                options={[['sat', t('Satellite')], ['streets', t('Streets')], ['dark', t('Dark')], ['light', t('Light')]]}
                note={t('Which map the plan screen opens on. The switcher on the map still changes it for the session.')}
              />
              <Seg
                label={t('3D terrain')} value={terrain} onPick={(v) => set({ terrain: v })}
                options={[[true, t('On')], [false, t('Off')]]}
                note={t('Hillshaded relief from open elevation data. Costs a little battery on a phone.')}
              />
              <Seg
                label={t('Highway shields')} value={shields} onPick={(v) => set({ shields: v })}
                options={[[true, t('On')], [false, t('Off')]]}
                note={t('Real route signage drawn on the road you are on, over the basemap.')}
              />
            </div>
          )}

          {tab === 'ride' && (
            <div className="set-section">
              <Seg
                label={t('Spoken directions')} value={voice} onPick={(v) => set({ voice: v })}
                options={[[true, t('On')], [false, t('Off')]]}
                note={t('Announcements at one mile, a quarter mile, and the turn. Ride Mode’s mute button still overrides this for one ride.')}
              />
              <Seg
                label={t('HUD density')} value={density} onPick={(v) => set({ density: v })}
                options={[['detailed', t('Detailed')], ['minimal', t('Minimal')]]}
                note={t('Minimal sheds the labels and the weather chip and leaves the numbers.')}
              />
              <Seg
                label={t('Posted speed limit')} value={speedSign} onPick={(v) => set({ speedSign: v })}
                options={[[true, t('On')], [false, t('Off')]]}
                note={t('Read from OpenStreetMap where the road carries a limit. Hidden where it does not — it is never a guess.')}
              />
              <Seg
                label={t('Keep the screen awake')} value={keepAwake} onPick={(v) => set({ keepAwake: v })}
                options={[[true, t('On')], [false, t('Off')]]}
              />
            </div>
          )}

          {tab === 'crew' && (
            <div className="set-section">
              {sync
                ? <SyncPanel sync={sync} />
                : <p className="set-note">{t('Sharing is not configured on this build.')}</p>}
            </div>
          )}

          {tab === 'data' && (
            <div className="set-section">
              <span className="set-label">{t('What this app has learned')}</span>
              <p className="set-note">
                {t('Selecting an option, replacing a stop, and confirming a trip teach Roadbook which kinds of places you like. It stores the Google place id and a broad tag — never ratings, addresses or hours.')}
              </p>
              <Seg
                label={t('Learn from my choices')} value={s.learnPlaces !== false} onPick={(v) => set({ learnPlaces: v })}
                options={[[true, t('On')], [false, t('Off')]]}
                note={t('Off stops new evidence being recorded. It does not delete what is already there.')}
              />

              <span className="set-label">{t('Storage on this device')}</span>
              <div className="set-row">
                <span className="set-note">
                  {cache
                    ? `${cache.routes} ${t('routed days')} · ${cache.steps} ${t('navigation sets')} · ${cache.kb} KB`
                    : t('Not measured yet')}
                </span>
                <button className="btn" type="button" onClick={() => setCache(cacheReport())}>{t('Measure')}</button>
              </div>
              <p className="set-note">
                {t('Cached routes and turn-by-turn. Clearing them costs nothing but a re-route next time the trip is opened — your trips are not touched.')}
              </p>
              <button className="btn" type="button" onClick={() => { clearRouteCaches(); setCache(cacheReport()); }}>
                {t('Clear cached routes')}
              </button>
            </div>
          )}

          {tab === 'about' && (
            <div className="set-section">
              <div className="set-credits">
                <span className="set-label">{t('Credits')}</span>
                <p>
                  Map imagery © Esri, Maxar, Earthstar Geographics · Street data ©
                  {' '}OpenStreetMap contributors, © OpenMapTiles · Routing by Valhalla and OSRM
                  {' '}· Places by Google · Highway shields from Wikimedia Commons · Weather by Open-Meteo
                </p>
              </div>
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
              {/* Shell diagnostics. Three rounds of PWA layout reports were
                  debugged from photographs, which is guessing. These are the
                  numbers that decide the layout: what the app thinks it is,
                  what iOS says the insets are, and — the one that actually
                  answers "why is the bar high" — how far the shell's bottom
                  edge falls short of the screen. */}
              <div className="set-row">
                <span className="set-label">{t('Shell')}</span>
                <button className="btn" type="button" onClick={() => setShell(readShell())}>{t('Measure')}</button>
              </div>
              {shell && (
                <div className="set-build">
                  <code>
                    {`mode ${shell.mode}${shell.apple ? ' (apple)' : ''}\n`}
                    {`inset top ${shell.top} · bottom ${shell.bottom}\n`}
                    {`guard top ${shell.guardTop} · bottom ${shell.guardBottom}\n`}
                    {`viewport ${shell.innerW}x${shell.innerH} · screen ${shell.screenW}x${shell.screenH}\n`}
                    {`shell ${shell.appTop}→${shell.appBottom} · gap below ${shell.gapBelow}px`}
                  </code>
                </div>
              )}
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
  );
}
