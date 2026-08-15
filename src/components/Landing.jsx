import React, { useState } from 'react';
import { useT } from '../engine/settings.jsx';
import { signIn, signUp, sendReset, updatePassword } from '../engine/auth.js';
import { SYNC_ENABLED } from '../engine/supabase.js';

// The front door, for anyone who is not signed in.
//
// It is a SOFT gate, and that is a product decision rather than an oversight.
// The whole engine is offline-first — a rider on day four with no bars in the
// Black Hills opens the app and their roadbook is there, because localStorage
// is the device's truth. A hard login wall would trade that away for a signup
// number. So the account is offered, argued for, and skippable, and a trip made
// as a guest is adopted into the account the moment one is created.
//
// What the account actually buys is stated plainly, because it is a real
// answer to a real fear: delete the PWA, lose the phone, clear the browser, and
// until now the trips went with it.

const MIN_PW = 8;

export default function Landing({ onGuest, recovery, onRecovered }) {
  const t = useT();
  const [mode, setMode] = useState(recovery ? 'recovery' : 'signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const go = (next) => { setMode(next); setError(null); setNotice(null); };

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
          setNotice(t('Account created. Check your email for the confirmation link, then sign in.'));
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
      }
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const heading = {
    signin: t('Sign in'),
    signup: t('Create your account'),
    forgot: t('Reset your password'),
    recovery: t('Set a new password'),
  }[mode];

  const cta = {
    signin: busy ? t('Signing in…') : t('Sign in'),
    signup: busy ? t('Creating…') : t('Create account'),
    forgot: busy ? t('Sending…') : t('Email me a link'),
    recovery: busy ? t('Saving…') : t('Save password'),
  }[mode];

  return (
    <div className="landing">
      {/* The way past the gate is the block under the card, and only there. A
          second copy up here said the same words twice on one desktop screen,
          and the quieter of the two is the one that can explain itself. */}
      <header className="landing-mast">
        <h1 className="brand">ROAD<span className="yr">BOOK</span></h1>
      </header>

      <div className="landing-inner">
        <section className="land-pitch">
          <div className="eyebrow">{t('The AI roadbook for motorcycle trips')}</div>
          <h2>
            {t('Plan the ride.')}
            <br />
            {t('Then ride the plan.')}
          </h2>
          <p className="land-sub">
            {t('Describe the trip in a sentence and get back a routed, dated, hour-by-hour plan — graded for whether it can actually be ridden, and yours to argue with until it can.')}
          </p>
        </section>

        {/* On a phone this sits between the headline and the detail: the pitch
            earns the tap, the card takes it, and the four points are there for
            anyone still deciding. The grid areas do the reordering. */}
        <ul className="land-points">
          <li>
            <span className="lp-k">{t('Drafted by AI, settled by you')}</span>
            <span className="lp-v">{t('Riders, days, region, pace. The Copilot proposes changes as edits you can see, apply, and undo — never a black box that rewrites your trip.')}</span>
          </li>
          <li>
            <span className="lp-k">{t('Graded before you turn a wheel')}</span>
            <span className="lp-v">{t('Fuel gaps against your bike’s real range, daylight, dwell time, and hard arrival times — every day carries a grade and tells you what is wrong with it.')}</span>
          </li>
          <li>
            <span className="lp-k">{t('Turn-by-turn built for a bike')}</span>
            <span className="lp-v">{t('Ride Mode is full navigation: course-up chase camera, spoken turns, posted speed limits, fuel-range countdown, and how far ahead or behind the plan you are running.')}</span>
          </li>
          <li>
            <span className="lp-k">{t('One plan, whole crew')}</span>
            <span className="lp-v">{t('Share a code. Everyone rides the same roadbook, edits arrive as proposals, and the road captain has the final call.')}</span>
          </li>
        </ul>

        <section className="land-auth">
          <div className="auth-card">
            <h3>{heading}</h3>

            {mode === 'signup' && (
              <p className="auth-why">
                {t('Your trips live on this device. An account gives them a second home — delete the app, change phones, or lose the bike bag, and the roadbook is still there.')}
              </p>
            )}
            {mode === 'recovery' && (
              <p className="auth-why">{t('You followed a reset link. Pick a new password and you are back in.')}</p>
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

              {mode !== 'recovery' && (
                <label className="auth-field">
                  <span>{t('Email')}</span>
                  <input
                    type="email" required value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="email" autoCapitalize="none" spellCheck="false"
                    placeholder="you@example.com"
                  />
                </label>
              )}

              {mode !== 'forgot' && (
                <label className="auth-field">
                  <span>{mode === 'recovery' ? t('New password') : t('Password')}</span>
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
            </form>

            <div className="auth-alt">
              {mode === 'signin' && (
                <>
                  <button onClick={() => go('signup')}>{t('Create an account')}</button>
                  <button onClick={() => go('forgot')}>{t('Forgot password?')}</button>
                </>
              )}
              {mode === 'signup' && <button onClick={() => go('signin')}>{t('I already have an account')}</button>}
              {mode === 'forgot' && <button onClick={() => go('signin')}>{t('Back to sign in')}</button>}
            </div>
          </div>

          {mode !== 'recovery' && (
            <button className="land-skip" onClick={onGuest}>
              {t('Continue without an account →')}
              <span>{t('Everything works offline on this device. You can create an account later and your trips come with you.')}</span>
            </button>
          )}
        </section>
      </div>
    </div>
  );
}
