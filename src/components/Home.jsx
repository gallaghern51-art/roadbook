import React, { useMemo, useState } from 'react';
import { useTrip } from '../engine/store.js';
import { tripFeasibility } from '../engine/timeline.js';
import { tripSummary } from '../engine/tripEngine.js';
import { fmtLongDate } from '../engine/dates.js';
import { SEED_TRIP } from '../data/seedTrip.js';
import RouteSilhouette from './RouteSilhouette.jsx';
import { RoadbookBrand, SettingsIcon, ThemeToggle } from './Chrome.jsx';
import { useT, useUnits } from '../engine/settings.jsx';
import { libraryTrips, libraryTemplates } from '../engine/templates.js';

// The front door. Not a map: nothing is on the map until there is a trip.
// The intake box is the product's opening move — describe the ride, get a
// plan — so it gets ONE primary action and everything else steps back. Each
// trip card wears the trip's own shape: the silhouette is how a rider tells
// their trips apart the way they'd tell routes apart on paper roadbooks.

export default function Home({ onOpenTrip, onNewTrip, onImport, onDeleteTrip, onSettings, onHelp, onUseTemplate, onShareTemplate, onDeleteTemplate }) {
  const { state, routedLegsByDay } = useTrip();
  const { lib } = state;
  const t = useT();
  const u = useUnits();
  const [draft, setDraft] = useState('');

  // The active trip has real routed legs; the others fall back to the engine's
  // documented-mileage / haversine estimates, which is honest enough for a card.
  // Templates live in the same list (see src/engine/templates.js) but they are
  // not trips — they get their own row further down.
  const templates = useMemo(() => libraryTemplates(lib), [lib]);
  const cards = useMemo(() => libraryTrips(lib).map((rec) => {
    const legs = rec.id === lib.activeId ? routedLegsByDay : {};
    const feas = tripFeasibility(rec.trip, legs);
    const summary = tripSummary(rec.trip, legs);
    const days = rec.trip.days;
    return {
      rec,
      grade: feas.grade,
      score: feas.overall,
      miles: summary.totalMiles,
      dayCount: days.length,
      from: days[0]?.date ?? rec.trip.meta.startDate,
      to: days[days.length - 1]?.date ?? rec.trip.meta.startDate,
      riders: rec.trip.meta.riders,
    };
  }), [lib, routedLegsByDay]);

  const build = () => onNewTrip({ tab: 'ai', prompt: draft.trim() });

  return (
    <div className="home">
      <header className="home-mast">
        <h1 className="brand"><RoadbookBrand /></h1>
        <div className="mast-controls">
          <ThemeToggle />
          <button className="btn icon" title={t('How to use Roadbook')} onClick={onHelp} aria-label={t('How to use Roadbook')}>?</button>
          <button className="btn icon" title={t('Settings')} onClick={onSettings} aria-label={t('Settings')}><SettingsIcon /></button>
        </div>
      </header>

      <div className="home-inner">
        <section className="home-hero">
          <h2>{t('Where do you want to ride?')}</h2>
          <p className="home-sub">{t('Describe riders, days, region, and pace. Roadbook researches real opportunities, compares routed choices, and lets you shape every piece before the trip is created.')}</p>
          <div className="home-intake">
            <textarea
              rows={3}
              value={draft}
              placeholder={t('e.g. 4 riders, 6 days, Denver loop through the San Juans — Million Dollar Highway, hot springs one night, big scenic passes, moderate daily miles.')}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) build(); }}
            />
            <div className="intake-actions">
              <button className="btn gold" onClick={build}>{t('Plan with AI')}</button>
              <span className="intake-hint">
                {/* the shortcut half means nothing to a thumb — CSS drops it on touch */}
                <span className="kbd-only">{t('⌘↵ opens the planner · ')}</span>
                {t('compare first, create when it feels right')}
              </span>
            </div>
          </div>
        </section>

        {cards.length > 0 && (
          <section className="section">
            <h3>{t('Your trips')} <span className="cnt">{cards.length}</span></h3>
            <div className="trip-grid">
              {cards.map(({ rec, grade, score, miles, dayCount, from, to, riders }) => (
                <div
                  key={rec.id}
                  className={`trip-card${rec.id === lib.activeId ? ' active' : ''}`}
                  role="button"
                  tabIndex={0}
                  aria-label={rec.name}
                  onClick={() => onOpenTrip(rec.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') onOpenTrip(rec.id); }}
                >
                  <RouteSilhouette trip={rec.trip} height={64} />
                  <div className="tc-top">
                    <span className={`grade grade-${grade}`} title={`${score}/100`}>{grade}</span>
                    {cards.length > 1 && (
                      <button
                        className="tc-del"
                        title={t('Delete this trip')}
                        onClick={(e) => { e.stopPropagation(); onDeleteTrip(rec); }}
                      >✕</button>
                    )}
                  </div>
                  <div className="tc-name">{rec.name}</div>
                  <div className="tc-meta">{fmtLongDate(from)} → {fmtLongDate(to)}</div>
                  <div className="tc-meta">{dayCount} {t('days')} · {u.mi(miles)} · {riders} {t('riders')}</div>
                  <div className="tc-open">{rec.id === lib.activeId ? t('Continue planning →') : t('Open →')}</div>
                </div>
              ))}
            </div>
          </section>
        )}

        {templates.length > 0 && (
          <section className="section">
            <h3>{t('Your templates')} <span className="cnt">{t('saved starting points — copy one, or lay its days into a trip')}</span></h3>
            <div className="trip-grid">
              {templates.map((rec) => (
                <div key={rec.id} className="trip-card tpl-card" role="button" tabIndex={0}
                  onClick={() => onUseTemplate(rec.id)}
                  onKeyDown={(e) => { if (e.key === 'Enter') onUseTemplate(rec.id); }}>
                  <RouteSilhouette trip={rec.trip} height={64} />
                  <div className="tc-top">
                    <span className="tpl-tag">{t('Template')}</span>
                    <button className="tc-del" title={t('Delete this template')}
                      onClick={(e) => { e.stopPropagation(); onDeleteTemplate(rec); }}>✕</button>
                  </div>
                  <div className="tc-name">{rec.name}</div>
                  <div className="tc-meta">{rec.trip.days.length} {t('days')}{rec.trip.meta?.templateNote ? ` · ${rec.trip.meta.templateNote}` : ''}</div>
                  <div className="tc-actions">
                    <button className="tc-open" onClick={(e) => { e.stopPropagation(); onUseTemplate(rec.id); }}>{t('Use it →')}</button>
                    {/* A file is the share that always works — no account, no
                        code, no signal. The friend imports it and it lands as a
                        template on their shelf. */}
                    <button className="tc-share" onClick={(e) => { e.stopPropagation(); onShareTemplate(rec); }}>{t('Share')}</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section className="section">
          <h3>{t('Start from')}</h3>
          <div className="trip-grid start-grid">
            <div className="trip-card start-card" role="button" tabIndex={0}
              onClick={() => onNewTrip({ tab: 'template' })}
              onKeyDown={(e) => { if (e.key === 'Enter') onNewTrip({ tab: 'template' }); }}>
              <RouteSilhouette trip={SEED_TRIP} height={64} />
              <div className="tc-name">{t('Sturgis template')}</div>
              <div className="tc-meta">{SEED_TRIP.days.length} {t('days')} · {t('the full field guide')}</div>
              <div className="tc-open">{t('Copy it →')}</div>
            </div>
            <div className="trip-card start-card" role="button" tabIndex={0}
              onClick={() => onNewTrip({ tab: 'blank' })}
              onKeyDown={(e) => { if (e.key === 'Enter') onNewTrip({ tab: 'blank' }); }}>
              <RouteSilhouette trip={{ days: [] }} height={64} />
              <div className="tc-name">{t('Blank trip')}</div>
              <div className="tc-meta">{t('An empty frame — add days and stops by hand')}</div>
              <div className="tc-open">{t('Start empty →')}</div>
            </div>
            <div className="trip-card start-card" role="button" tabIndex={0}
              onClick={onImport}
              onKeyDown={(e) => { if (e.key === 'Enter') onImport(); }}>
              <RouteSilhouette trip={{ days: [] }} height={64} />
              <div className="tc-name">{t('Import JSON')}</div>
              <div className="tc-meta">{t('A trip file from a riding buddy')}</div>
              <div className="tc-open">{t('Load it →')}</div>
            </div>
            {/* Not a way to start a trip — a way to learn the app. It sits in
                this row because this row is where a first-time rider looks. */}
            <div className="trip-card start-card guide-card" role="button" tabIndex={0}
              onClick={onHelp}
              onKeyDown={(e) => { if (e.key === 'Enter') onHelp(); }}>
              <div className="gc-mark" aria-hidden="true">?</div>
              <div className="tc-name">{t('How to use Roadbook')}</div>
              <div className="tc-meta">{t('Step-by-step directions and walkthrough videos')}</div>
              <div className="tc-open">{t('Open the guide →')}</div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
