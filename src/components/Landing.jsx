import React, { useEffect, useRef, useState } from 'react';
import { useT } from '../engine/settings.jsx';
import { signIn, signUp, sendReset, updatePassword } from '../engine/auth.js';
import { SYNC_ENABLED } from '../engine/supabase.js';
import { RoadbookBrand } from './Chrome.jsx';
import RouteSilhouette from './RouteSilhouette.jsx';
import WeatherIcon from './WeatherIcon.jsx';
import LandingFrame from './LandingFrame.jsx';
import { LANDING_REMAINING_MI } from '../data/landingRoute.js';
import { EARLY_EXIT_TRIP } from '../data/earlyExitTemplate.js';

// The front door, for anyone who is not signed in.
//
// It is a SOFT gate, and that is a product decision rather than an oversight.
// The whole engine is offline-first — a rider on day four with no bars in the
// Black Hills opens the app and their roadbook is there, because localStorage
// is the device's truth. A hard login wall would trade that away for a signup
// number. So the primary action on this page is the PRODUCT (plan a trip, as a
// guest), the account is argued for lower down where it can explain itself,
// and a trip made as a guest is adopted into the account the moment one is
// created.
//
// The page is authored DARK and stays dark whatever theme the rider keeps in
// Settings (the tokens are re-pinned on .landing in app.css). The proof on this
// page is the product itself — Ride Mode over night-black map, the grade chips,
// the turn card — and every one of those instruments was drawn for the dark
// palette; signal orange carries the most weight on blue-black metal. Light is
// the in-product daylight atlas, and it is still one tap away in Settings.

const MIN_PW = 8;

export default function Landing({ onGuest, onHelp, onLegal, recovery, finishAccount, onRecovered, onFinished, children }) {
  const t = useT();
  const [mode, setMode] = useState(recovery ? 'recovery' : finishAccount ? 'finish' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const emailRef = useRef(null);
  const accountRef = useRef(null);

  const go = (next) => { setMode(next); setError(null); setNotice(null); };

  // "Sign in" / "Create an account" from the top of the page: bring the card up
  // and put the cursor in it, so a returning rider is one tap from their trips.
  const jumpToAccount = (next) => {
    if (next) go(next);
    accountRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    window.setTimeout(() => emailRef.current?.focus({ preventScroll: true }), 420);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      if (mode === 'signin') {
        await signIn({ email, password });
        // The auth listener in App opens the gate; nothing to do here.
      } else if (mode === 'signup') {
        if (password.length < MIN_PW) throw new Error(t('Use at least 8 characters.'));
        const { needsConfirmation } = await signUp({ email, password, name });
        if (needsConfirmation) {
          setNotice(t('Check your email to verify the address. If this device was already sharing a trip, the link will ask you to finish with a password.'));
          setMode('signin');
          setPassword('');
        }
      } else if (mode === 'forgot') {
        await sendReset(email);
        setNotice(t('If that address has an account, a reset link is on its way.'));
      } else if (mode === 'recovery') {
        if (password.length < MIN_PW) throw new Error(t('Use at least 8 characters.'));
        await updatePassword(password);
        setNotice(t('Password changed.'));
        onRecovered?.();
      } else if (mode === 'finish') {
        if (password.length < MIN_PW) throw new Error(t('Use at least 8 characters.'));
        await updatePassword(password);
        setNotice(t('Account ready.'));
        onFinished?.();
      }
    } catch (err) {
      setError(t(err.message || String(err)));
    } finally {
      setBusy(false);
    }
  };

  const heading = {
    signin: t('Sign in'),
    signup: t('Create your account'),
    forgot: t('Reset your password'),
    recovery: t('Set a new password'),
    finish: t('Finish your account'),
  }[mode];

  const cta = {
    signin: busy ? t('Signing in…') : t('Sign in'),
    signup: busy ? t('Creating…') : t('Create account'),
    forgot: busy ? t('Sending…') : t('Email me a link'),
    recovery: busy ? t('Saving…') : t('Save password'),
    finish: busy ? t('Saving…') : t('Save password'),
  }[mode];

  // A reset or confirmation link is a task, not a visit: the card alone,
  // centred, with nothing to sell.
  const focused = mode === 'recovery' || mode === 'finish';

  const card = (
    <div className="auth-card" id="account">
      <h3>{heading}</h3>

      {mode === 'signup' && (
        <p className="auth-why">
          {t('Your trips live on this device. An account gives them a second home — delete the app, change phones, or lose the bike bag, and the roadbook is still there.')}
        </p>
      )}
      {mode === 'recovery' && (
        <p className="auth-why">{t('You followed a reset link. Pick a new password and you are back in.')}</p>
      )}
      {mode === 'finish' && (
        <p className="auth-why">{t('Your email is verified. Choose a password to finish protecting this account.')}</p>
      )}

      <form onSubmit={submit}>
        {mode === 'signup' && (
          <label className="auth-field">
            <span>{t('Your name')}</span>
            <input
              value={name} onChange={(e) => setName(e.target.value)}
              autoComplete="name" placeholder={t('Shown to your crew')}
            />
          </label>
        )}

        {!focused && (
          <label className="auth-field">
            <span>{t('Email')}</span>
            <input
              ref={emailRef}
              type="email" required value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="email" autoCapitalize="none" spellCheck="false"
              placeholder="you@example.com"
            />
          </label>
        )}

        {mode !== 'forgot' && (
          <label className="auth-field">
            <span>{focused ? t('New password') : t('Password')}</span>
            <input
              type="password" required value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              minLength={mode === 'signin' ? undefined : MIN_PW}
              placeholder={mode === 'signin' ? '' : t('At least 8 characters')}
            />
          </label>
        )}

        {error && <p className="auth-msg err">{error}</p>}
        {notice && <p className="auth-msg ok">{notice}</p>}
        {!SYNC_ENABLED && (
          <p className="auth-msg err">{t('Accounts are not configured on this build.')}</p>
        )}

        <button className="btn gold auth-go" type="submit" disabled={busy || !SYNC_ENABLED}>{cta}</button>
        {mode === 'signup' && (
          <p className="auth-consent">
            {t('By creating an account you agree to the')} <button type="button" onClick={() => onLegal?.('terms')}>{t('Terms of Service')}</button> {t('and the')} <button type="button" onClick={() => onLegal?.('privacy')}>{t('Privacy Policy')}</button>.
          </p>
        )}
      </form>

      <div className="auth-alt">
        {mode === 'signin' && (
          <>
            <button type="button" onClick={() => go('signup')}>{t('Create an account')}</button>
            <button type="button" onClick={() => go('forgot')}>{t('Forgot password?')}</button>
          </>
        )}
        {mode === 'signup' && <button type="button" onClick={() => go('signin')}>{t('I already have an account')}</button>}
        {mode === 'forgot' && <button type="button" onClick={() => go('signin')}>{t('Back to sign in')}</button>}
      </div>
    </div>
  );

  if (focused) {
    return (
      <div className="landing focus">
        <header className="landing-mast">
          <h1 className="brand"><RoadbookBrand /></h1>
        </header>
        <div className="landing-focus">{card}</div>
        {children}
      </div>
    );
  }

  return (
    <div className="landing">
      <header className="landing-mast">
        <h1 className="brand"><RoadbookBrand /></h1>
        <nav className="land-nav" aria-label={t('Landing')}>
          <button type="button" className="land-nav-link" onClick={onHelp}>{t('How it works')}</button>
          <button type="button" className="btn land-nav-signin" onClick={() => jumpToAccount('signin')}>{t('Sign in')}</button>
        </nav>
      </header>

      {/* ---- Direction C, "The Long Way Round": one ride told in order, the
          product appearing at each moment it earned. The hero is the builder's
          intake; the chapters are the app's own surfaces. ---- */}
      <section className="land-hero">
        <div className="land-pitch">
          <h2>
            {t('Plan the ride.')}
            <br />
            {t('Then ride the plan.')}
          </h2>
          <p className="land-sub">
            {t('Tell Roadbook the ride in a sentence. It researches the stops, measures the roads on a motorcycle, grades every day, and then rides the plan with you.')}
          </p>
          <div className="land-cta">
            <button type="button" className="btn gold land-go" onClick={onGuest}>
              {t('Plan a trip with AI')}
              <span aria-hidden="true">→</span>
            </button>
            <button type="button" className="btn land-second" onClick={onHelp}>{t('See how it works')}</button>
          </div>
          <p className="land-fine">{t('No account needed to start. Everything works offline on this device; create an account later and your trips come with you.')}</p>
        </div>
        <div className="land-art land-intake" aria-hidden="true">
          <IntakeMock t={t} />
        </div>
      </section>

      <ol className="land-chapters">
        <li className="land-step">
          <div className="ls-text">
            <span className="ls-when">{t('Six weeks out')}</span>
            <h4>{t('The sentence.')}</h4>
            <p>{t('“Five days Missoula to Sturgis, back roads, no tolls, in by four on Friday.” That is the whole brief. The planner narrates while it works — searching places, routing options, checking fuel against your range — because it is doing research, not typing from memory.')}</p>
          </div>
          <NarrationMock />
        </li>
        <li className="land-step wide">
          <div className="ls-text">
            <span className="ls-when">{t('The same evening')}</span>
            <h4>{t('Three ways to do it.')}</h4>
            <p>{t('All three cross the Beartooth; they differ on the Bighorns and on how hard Friday works. One is graded A with fifty minutes to spare at the gate. That is the one you send the crew.')}</p>
          </div>
          <div className="land-desk" aria-hidden="true"><BuilderMock /></div>
        </li>
        <li className="land-step">
          <div className="ls-text">
            <span className="ls-when">{t('Two weeks out')}</span>
            <h4>{t('The plan gets a planner.')}</h4>
            <p>{t('A rider drops out. “Re-time everything from Cody.” The Copilot proposes the edits, locks the beds already booked, and shows the delta on every line. Apply, and Thursday is an A again.')}</p>
          </div>
          <GradeMock t={t} />
        </li>
        <li className="land-step">
          <div className="ls-text">
            <span className="ls-when">{t('The week of')}</span>
            <h4>{t('The board.')}</h4>
            <p>{t('Prep is the map-less status board: the trip’s grade with its top issues, bookings, packing, a budget built from the trip’s own nights and miles, and the crew.')}</p>
          </div>
          <PrepMock t={t} />
        </li>
        <li className="land-step">
          <div className="ls-text">
            <span className="ls-when">{t('Day two')}</span>
            <h4>{t('The Beartooth.')}</h4>
            <p>{t('Ride Mode is full navigation for a bike: course-up chase camera, spoken turns, the posted limit as a sign, fuel range counting down, the next gate’s margin. Miss a stop and the plan follows you.')}</p>
          </div>
          <div className="ls-ride"><RideMock /></div>
        </li>
        <li className="land-step">
          <div className="ls-text">
            <span className="ls-when">{t('Next year')}</span>
            <h4>{t('The ride gets ridden again.')}</h4>
            <p>{t('Save the trip as a template and hand it to a friend. Their copy arrives with fresh dates and nothing booked, ready for the AI to change what they like.')}</p>
          </div>
          <TemplateMock t={t} />
        </li>
      </ol>

      {/* ---- the account: argued for, and skippable ---- */}
      <section className="land-account" ref={accountRef}>
        <div className="land-account-pitch">
          <h3>{t('Give the plan a second home.')}</h3>
          <p>{t('Your trips live on this device first. An account backs the whole library up — delete the app, change phones, or lose the bike bag, and it is still there when you sign in.')}</p>
          <ul className="land-account-points">
            <li>{t('Sign in on a new phone and your trips come down.')}</li>
            <li>{t('Saved places, your bike and its range, your riding style.')}</li>
            <li>{t('Crews still join with a code — no email needed in the car park.')}</li>
          </ul>
        </div>
        <div className="land-auth">
          {card}
          <button type="button" className="land-skip" onClick={onGuest}>
            {t('Continue without an account →')}
            <span>{t('Everything works offline on this device. You can create an account later and your trips come with you.')}</span>
          </button>
          {/* A rider sent a link by a friend should be able to see what the
              app does before deciding to hand over an email. */}
          <button type="button" className="land-help" onClick={onHelp}>{t('See how it works →')}</button>
        </div>
      </section>

      <footer className="land-foot">
        <span className="brand"><RoadbookBrand /></span>
        <span className="lf-note">{t('Real roads, real places, and a roadbook that stays on your phone until you decide it needs an account.')}</span>
        <span className="lf-legal">
          <span>{t('Roadbook is a product of Calaf, Inc.')}</span>
          <button type="button" onClick={() => onLegal?.('privacy')}>{t('Privacy Policy')}</button>
          <button type="button" onClick={() => onLegal?.('terms')}>{t('Terms of Service')}</button>
        </span>
      </footer>
      {children}
    </div>
  );
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/* ------------------------------------------------------------------ */
/* The instruments, drawn. These are the app's own surfaces re-set as   */
/* still lifes — nothing here is a screenshot that can go stale, and    */
/* nothing here claims a real route: the figures are illustrative.      */
/* ------------------------------------------------------------------ */

function RideMock() {
  // The app's own Ride Mode classes — turn-card, nav-puck, m-chip, speed-sign,
  // ride-bar — so this IS the look, not a drawing of it. Only the map is ours.
  const Head = ({ x, y, r }) => <path d="M0 -4.9 L4.3 3.1 L-4.3 3.1 Z" fill="currentColor" transform={`translate(${x} ${y}) rotate(${r})`} />;
  const RightArrow = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M12 21 V14.5 Q12 9.8 16.7 9.8" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="butt" />
      <Head x={19.1} y={9.8} r={90} />
    </svg>
  );
  const StraightArrow = ({ className }) => (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path d="M12 21 V7" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="butt" />
      <Head x={12} y={5} r={0} />
    </svg>
  );
  const MI = Math.round(LANDING_REMAINING_MI);
    // The map is drawn from data we may ship (LandingFrame): OpenStreetMap's Red
  // Lodge around the router's real road, the real distance to Cooke City. Laid out at a real phone's 430×932 (a Pro Max: the ride bar has the room
  // it needs to show every figure without an ellipsis) — the HUD's type is
  // sized for a tank mount and the bar's container query wants a real width —
  // and scaled to whatever slot the page gives it.
  const fitRef = useRef(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = fitRef.current;
    if (!el) return;
    const measure = () => setScale(Math.min(1, el.clientWidth / 430));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div className="ride-mock-fit" ref={fitRef} style={{ height: Math.round(932 * scale) }}>
    <div className="ride-mock" style={{ transform: `scale(${scale})` }}>
      <LandingFrame />

      <div className="ride-overlay ride-overlay-top">
        <div className="turn-card">
          <div className="turn-head">
            <div className="turn-icon"><StraightArrow className="turn-arrow" /></div>
            <div className="turn-body">
              <div className="t-dist"><span className="t-mi">{MI} mi</span></div>
              <div className="t-instr">US-212 · Beartooth Hwy</div>
            </div>
          </div>
          <div className="t-then"><RightArrow className="turn-arrow" /><span>Turn right onto Eaton Street</span></div>
        </div>
        <div className="ride-topbar">
          <div className="ride-chip wx"><WeatherIcon code={2} className="wxc-icon" /><span className="wxc-temp">64°</span><i className="wxc-ahead">ahead</i></div>
          <span className="btn icon-btn ride-x">✕</span>
        </div>
      </div>

      <div className="ride-overlay ride-overlay-bottom">
        <div className="speed-sign"><span className="ss-word">SPEED<br />LIMIT</span><b className="ss-num">55</b></div>
        <div className="ride-chips">
          <span className="m-chip fuel">
            <svg viewBox="0 0 20 20" className="mc-ic" aria-hidden="true"><path d="M4 17V5a1.5 1.5 0 0 1 1.5-1.5H10A1.5 1.5 0 0 1 11.5 5v12M3 17h9.5M11.5 8.5H14a1.5 1.5 0 0 1 1.5 1.5v4.2a1.15 1.15 0 1 0 2.3 0V7.4L16 5.6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></svg>
            {MI} mi
          </span>
          <span className="m-chip gate">
            <svg viewBox="0 0 20 20" className="mc-ic" aria-hidden="true"><circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" strokeWidth="1.7" /><path d="M10 6.2V10l2.9 1.8" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></svg>
            Check-in · 42m margin
            <span className="mc-x">✕</span>
          </span>
        </div>
        <div className="ride-bar">
          <div className="rb-grip" />
          <div className="rb-main"><b className="rb-big">1h 33m</b><span className="rb-chip behind">+4 min</span></div>
          <div className="rb-duo"><span className="rb-mid">2:18 PM · {MI} mi</span><span className="rb-day">Day 5:40 PM<span className="rb-day-mi"> · 187 mi</span></span></div>
          <div className="rb-foot"><div className="rb-next mq-row"><i className="mq-label">Next</i><div className="mq-box"><span className="mq-ink"><span className="mq-seg">Cooke City · Exxon</span></span></div></div></div>
        </div>
      </div>
    </div>
    </div>
  );
}

function BuilderMock() {
  // The app's OWN builder classes (construction-chat, msg, concept-*): this is
  // the construction desk as it looks after one turn, not a drawing of it.
  // Figures are illustrative; the places are real businesses on that road.
  const Stop = ({ kind, k, name, detail, glance, placed, change = true }) => (
    <li className="concept-stop">
      <div className="concept-stop-row">
        <span className={`stop-kind ${kind}`}>{k}</span>
        <span className="stop-copy">
          <b>{name}{placed ? <span className="stop-placed" title="A deliberate pin"> ◎ placed</span> : <span className="stop-verified" title="Verified with Google Places"> ✓</span>}</b>
          {detail && <small>{detail}</small>}
        </span>
        {change && <button type="button" tabIndex={-1}>Change</button>}
      </div>
      {glance && <div className="place-glance-row"><span className="place-glance"><b>{glance[0]} ★</b><small>{glance[1]} ratings</small>{glance[2] && <b>{glance[2]}</b>}</span><span className="place-details-btn">Details</span></div>}
    </li>
  );
  return (
    <div className="build-mock construction-chat started">
      <div className="builder-context bm-context">
        <div><span>Beartooth &amp; Bighorns</span><span>Sep 18 – 22</span><span>5 days</span><span>7 riders</span><span>Backroads</span><span>No tolls</span></div>
        <button type="button" tabIndex={-1}>Edit</button>
      </div>
      <section className="construction-dialogue">
        <div className="construction-thread">
          <div className="msg user">Missoula to Sturgis over five days, backroads and no tolls. We have to be in Sturgis by 4 on Friday and nobody wants more than 300 miles in a day.</div>
          <div className="msg ai streaming">
            <span className="live-text">Three ways to do this. All three cross the Beartooth; they differ on the Bighorns and on how hard Friday works. Every stop below is a live listing I checked — the one I could not verify is marked.</span>
            <span className="thinking">Routing 3 options on motorcycle roads · checking fuel against 180 mi</span>
            <span className="thought">Sinclair in Ten Sleep closes the 214-mile gap on the Bighorn day.</span>
          </div>
        </div>
        <div className="construction-composer">
          <div className="bm-composer">Change a stop, combine options, add a constraint…</div>
          <span className="btn gold">Send</span>
        </div>
      </section>
      <section className="construction-plan">
        <section className="concept-workbench">
          <div className="concept-head"><span>Route options</span><small>Select one, then refine any piece in the conversation.</small></div>
          <div className="concept-tabs">
            <span className="active"><span>Beartooth + Bighorns</span><small>1,412 mi · in by 3:10 Fri · grade A</small></span>
            <span><span>Chief Joseph loop</span><small>1,480 mi · Wednesday ends after dusk</small></span>
            <span><span>Interstate direct</span><small>1,240 mi · a 322-mile day</small></span>
          </div>
          <div className="concept-selected">
            <div className="concept-facts">
              <span><b>1,412</b> mi</span>
              <span><b>27h 40m</b> riding</span>
              <span><b>5</b> day shape · <b>6h 10m</b> longest day</span>
              <span><b>118</b> mi max fuel gap</span>
              <span><b>12,300</b> ft climbing</span>
              <span className="detour"><b>+172 mi · +2h 10m</b> vs quickest option</span>
            </div>
            <div className="concept-detail">
              <div className="concept-story">
                <p>Red Lodge to Cooke City over the Beartooth on day two, then US-14A over the Bighorns to Buffalo. The last day is short on purpose.</p>
                <dl>
                  <div><dt>Why this works</dt><dd>Every day ends before dusk and the longest is 289 miles.</dd></div>
                  <div><dt>For your group</dt><dd>Fuel every 118 miles or less against a 180-mile range; both beds take seven.</dd></div>
                  <div><dt>The tradeoff</dt><dd>172 miles longer than the interstate, and Friday has fifty minutes to spare rather than two hours.</dd></div>
                </dl>
              </div>
              <ol className="concept-stops">
                <li className="concept-day">Day 1</li>
                <Stop kind="road" k="Start" name="Missoula, MT" change={false} />
                <Stop kind="fuel" k="Fuel" name="Sinclair · Big Timber" detail="I-90 exit 367 · open 24h" />
                <Stop kind="lodging" k="Lodging" name="The Pollard · Red Lodge" detail="Sleeps 7 · check-in 3:00 PM" glance={['4.6', '312', '$$$']} />
                <li className="concept-day">Day 2</li>
                <Stop kind="attraction" k="Sight" name="Beartooth Pass · 10,947 ft" detail="Photo stop · no listing, pinned on purpose" placed />
                <Stop kind="fuel" k="Fuel" name="Exxon · Cooke City" detail="Last fuel for 63 mi" />
                <Stop kind="food" k="Food" name="Ten Sleep Saloon" detail="Lunch · 12:40 PM arrival · open" glance={['4.5', '220', '$$']} />
                <Stop kind="lodging" k="Lodging" name="Occidental Hotel · Buffalo" detail="Sleeps 7 · check-in 4:00 PM · 42 min to spare" glance={['4.7', '1,020', '$$']} />
                <li className="concept-day bm-more">+ 9 more stops · Days 3 – 5</li>
              </ol>
              <div className="concept-refine">
                <button type="button" tabIndex={-1}>Keep route, change stops</button>
                <button type="button" tabIndex={-1}>Keep stops, change roads</button>
                <button type="button" tabIndex={-1}>Shorten it</button>
              </div>
            </div>
          </div>
        </section>
        <div className="construction-confirm">
          <div><b>Nothing is created yet.</b><span>Confirm when the route and its pieces feel right.</span></div>
          <span className="btn gold">Create this trip</span>
        </div>
      </section>
    </div>
  );
}

function NarrationMock() {
  return (
    <div className="inst inst-narr">
      <div className="msg user">Five days Missoula to Sturgis, back roads, no tolls, in by four on Friday.</div>
      <div className="msg ai streaming">
        <span className="live-text">Three ways to do this. All three cross the Beartooth; they differ on the Bighorns and on how hard Friday works. Every stop below is a live listing I checked — the one I could not verify is marked.</span>
        <span className="thinking">Routing 3 options on motorcycle roads · checking fuel against 180 mi</span>
        <span className="thought">Sinclair in Ten Sleep closes the 214-mile gap on the Bighorn day.</span>
      </div>
    </div>
  );
}

function PrepMock({ t }) {
  // the app's own Prep board classes: prep-hero, ph-*, dash-card
  return (
    <div className="inst inst-prep">
      <div className="ip-head"><span className="chip">Thu Sep 18 → Mon Sep 22</span><span className="chip anchor">12 days to go</span></div>
      <div className="prep-hero">
        <div className="ph-grade grade grade-A">A</div>
        <div className="ph-main">
          <div className="ph-score">91/100 · {t('the plan holds')}</div>
          <ul className="ph-issues">
            <li className="warn"><b>Thu</b> Occidental Hotel check-in 4:00 PM · 42 min to spare</li>
            <li className="ok">No fuel or daylight issues anywhere in the plan.</li>
          </ul>
        </div>
      </div>
      <div className="dash-grid">
        <span className="dash-card"><span className="dc-label">{t('Crew')}</span><span className="dc-meta">7 {t('joined')} · PUBLISHED</span></span>
        <span className="dash-card warn"><span className="dc-label">{t('Bookings')}</span><span className="dc-meta">2 {t('open')}</span></span>
        <span className="dash-card"><span className="dc-label">{t('Budget & fuel')}</span><span className="dc-meta">≈ $612 / {t('rider')}</span></span>
        <span className="dash-card"><span className="dc-label">{t('Packing')}</span><span className="dc-meta">14 / 22</span></span>
      </div>
    </div>
  );
}

function TemplateMock({ t }) {
  return (
    <div className="inst inst-template">
      <div className="land-template as-card">
        <div className="lt-art"><RouteSilhouette trip={EARLY_EXIT_TRIP} height={96} /></div>
        <div className="lt-body">
          <div className="lt-title">Beartooth &amp; Bighorns</div>
          <div className="lt-sub">Missoula · Red Lodge · Cody · Ten Sleep · Buffalo · Sturgis</div>
          <div className="lt-meta">5 {t('days')} · 24 {t('stops')} · {t('saved as a template')}</div>
        </div>
      </div>
      <div className="it-actions"><span className="btn gold">{t('Share')}</span><span className="btn">{t('Start a trip from it')}</span><span className="it-note">{t('beartooth-bighorns-template.json → a friend’s Import')}</span></div>
    </div>
  );
}

function IntakeMock({ t }) {
  return (
    <div className="inst inst-intake">
      <div className="builder-intro"><span className="builder-mark">✦</span><div><b>Build it with Roadbook</b><p>{t('Describe the ride. I’ll research real stops, measure route choices, and show you the pieces before anything is created.')}</p></div></div>
      <div className="ii-box">Five days Missoula to Sturgis, back roads, no tolls, in by four on Friday.</div>
      <div className="ii-row"><span className="ii-chip">Roads · Backroads</span><span className="ii-chip">Avoid tolls</span><span className="ii-chip">Range · 180 mi</span><span className="btn gold">{t('Explore the trip')}</span></div>
    </div>
  );
}

function GradeMock({ t }) {
  const days = [['Mon', 'A'], ['Tue', 'A'], ['Wed', 'B'], ['Thu', 'C'], ['Fri', 'A']];
  return (
    <div className="inst inst-grade">
      <div className="ig-ribbon">
        {days.map(([d, g]) => (
          <span key={d} className={`ig-day g-${g.toLowerCase()} ${d === 'Thu' ? 'on' : ''}`}><b>{d}</b><i>{g}</i></span>
        ))}
      </div>
      <div className="ig-issue">
        <span className="ig-tag">{t('Thursday · grade C')}</span>
        <p><b>214 mi</b> {t('between fuel stops · your range is')} <b>180 mi</b></p>
      </div>
      <div className="ig-proposal">
        <div className="ig-prop-head">{t('Copilot proposes')}</div>
        <ul>
          <li><span className="ig-op add">+</span> {t('Add fuel')} · Sinclair, Ten Sleep <span className="ig-delta">+3 mi</span></li>
          <li><span className="ig-op set">↻</span> {t('Move lunch')} · Buffalo → Ten Sleep <span className="ig-delta">−0:20</span></li>
        </ul>
        <div className="ig-actions"><span className="btn gold">{t('Apply')}</span><span className="btn">{t('Undo')}</span><span className="ig-after">{t('Thursday → A')}</span></div>
      </div>
    </div>
  );
}
