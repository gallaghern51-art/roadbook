import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CHAPTERS, searchChapters } from '../data/guide.js';
import { useT } from '../engine/settings.jsx';

// The how-to guide: written directions first, video where a video exists.
//
// It deliberately depends on NOTHING but the settings provider — no trip, no
// account — so the same component serves the signed-out front door, the home
// screen and a trip. It is mounted once in App's sheet stack.
//
// Videos are data (src/data/guide.js). A chapter names the clip it wants; if
// the file is not in public/guide/ yet the player renders a placeholder naming
// it rather than a broken <video>, so an un-recorded guide still reads fine.

const SEEN_KEY = 'moto.guideSeen.v1';

function VideoSlot({ video, title }) {
  const t = useT();
  const [failed, setFailed] = useState(false);
  const ref = useRef(null);

  // A new chapter is a new file — clear the last one's failure.
  useEffect(() => { setFailed(false); }, [video?.src]);

  if (!video?.src) return null;

  // A hosted clip (YouTube/Vimeo) embeds; anything else is a local file.
  const embed = /^https?:\/\//.test(video.src);
  if (embed) {
    return (
      <div className="g-video">
        <iframe src={video.src} title={`${title} — video`} allowFullScreen loading="lazy" referrerPolicy="no-referrer" />
      </div>
    );
  }

  if (failed) {
    return (
      <div className="g-video g-video-todo" role="note">
        <div className="gv-mark" aria-hidden="true">▶</div>
        <div>
          <b>{t('Walkthrough video coming soon')}</b>
          <small>{video.src}{video.length ? ` · ~${video.length}` : ''}</small>
        </div>
      </div>
    );
  }

  return (
    <div className="g-video">
      <video
        ref={ref}
        controls
        playsInline
        preload="metadata"
        poster={video.poster || undefined}
        onError={() => setFailed(true)}
      >
        <source src={video.src} />
      </video>
    </div>
  );
}

export default function HelpGuide({ onClose, initialChapter }) {
  const t = useT();
  const [openId, setOpenId] = useState(initialChapter ?? CHAPTERS[0].id);
  const [q, setQ] = useState('');
  const bodyRef = useRef(null);
  const navRef = useRef(null);
  const shown = useMemo(() => searchChapters(q), [q]);
  const chapter = shown.find((c) => c.id === openId) ?? shown[0] ?? null;

  useEffect(() => {
    try { localStorage.setItem(SEEN_KEY, new Date().toISOString()); } catch { /* non-fatal */ }
  }, []);

  // Escape closes, like every other sheet in the app.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Switching chapters on a phone must land at the TOP of the new chapter —
  // the reading column is what scrolls, not the page. On a phone the rail is a
  // sideways strip, so the chapter you are reading has to be brought into it
  // too (the same move the day ribbon makes).
  useEffect(() => {
    bodyRef.current?.scrollTo?.({ top: 0 });
    navRef.current?.querySelector('.guide-chap.active')
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
  }, [chapter?.id]);

  return (
    <div className="modal-backdrop guide-backdrop" onClick={onClose}>
      <div className="modal guide-modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t('How to use Roadbook')}>
        <div className="modal-head">
          <div>
            <div className="eyebrow">{t('Guide')}</div>
            <h3>{t('How to use Roadbook')}</h3>
          </div>
          <button className="btn" onClick={onClose} aria-label={t('Close')}>✕</button>
        </div>

        <div className="guide-wrap">
          <nav className="guide-nav" ref={navRef} aria-label={t('Guide chapters')}>
            <input
              className="guide-search"
              type="search"
              value={q}
              placeholder={t('Search the guide')}
              aria-label={t('Search the guide')}
              onChange={(e) => setQ(e.target.value)}
            />
            {shown.map((c) => (
              <button
                key={c.id}
                className={`guide-chap${c.id === chapter?.id ? ' active' : ''}`}
                aria-current={c.id === chapter?.id}
                onClick={() => setOpenId(c.id)}
              >
                <i aria-hidden="true">{c.icon}</i>
                <span>{c.title}</span>
              </button>
            ))}
            {!shown.length && <p className="guide-empty">{t('Nothing in the guide matches that.')}</p>}
          </nav>

          <article className="guide-body" ref={bodyRef}>
            {chapter && (
              <>
                <h4>{chapter.title}</h4>
                <p className="guide-blurb">{chapter.blurb}</p>
                <VideoSlot video={chapter.video} title={chapter.title} />
                <ol className="guide-steps">
                  {chapter.steps.map((s, i) => (
                    <li key={i}>
                      <b>{s.t}</b>
                      <p>{s.b}</p>
                    </li>
                  ))}
                </ol>
                {chapter.tips?.length > 0 && (
                  <div className="guide-tips">
                    <h5>{t('Worth knowing')}</h5>
                    <ul>{chapter.tips.map((x, i) => <li key={i}>{x}</li>)}</ul>
                  </div>
                )}
                <div className="guide-foot">
                  {CHAPTERS.findIndex((c) => c.id === chapter.id) > 0 && (
                    <button
                      className="btn"
                      onClick={() => setOpenId(CHAPTERS[CHAPTERS.findIndex((c) => c.id === chapter.id) - 1].id)}
                    >‹ {CHAPTERS[CHAPTERS.findIndex((c) => c.id === chapter.id) - 1].title}</button>
                  )}
                  {CHAPTERS.findIndex((c) => c.id === chapter.id) < CHAPTERS.length - 1 && (
                    <button
                      className="btn gold"
                      onClick={() => setOpenId(CHAPTERS[CHAPTERS.findIndex((c) => c.id === chapter.id) + 1].id)}
                    >{CHAPTERS[CHAPTERS.findIndex((c) => c.id === chapter.id) + 1].title} ›</button>
                  )}
                </div>
              </>
            )}
          </article>
        </div>
      </div>
    </div>
  );
}
