// Accounts.
//
// The app has always run with no account at all, and still does — localStorage
// is the device's truth and nothing here changes that. An account adds exactly
// one thing: somewhere off the phone for the trips to live, so deleting the
// PWA, wiping the browser, or losing the bike bag stops being the same event as
// losing the roadbook.
//
// Email + password, deliberately. The join code is the right credential for a
// crew that already trusts each other and is standing in the same car park —
// see SyncPanel — but it is a bad one for "prove this library is mine" on a new
// phone a year later. Those are different questions and they get different
// answers: the code opens a TRIP, an account opens a LIBRARY.
//
// Every call fails soft and every call is a no-op when Supabase is not
// configured, exactly like the rest of the sync layer.

import { useEffect, useState } from 'react';
import { supabase, SYNC_ENABLED, currentUser } from './supabase.js';

/** A real account, as opposed to the silent anonymous session sharing mints. */
export function isAccount(user) {
  return Boolean(user && !user.is_anonymous && user.email);
}

export function displayName(user) {
  if (!user) return '';
  return user.user_metadata?.name || user.email || 'Rider';
}

function need() {
  if (!supabase) throw new Error('Accounts are not configured on this build.');
}

// Supabase speaks in error codes; riders do not.
function friendly(err) {
  const msg = String(err?.message ?? err);
  if (/invalid login credentials/i.test(msg)) return 'That email and password do not match.';
  if (/user already registered|already been registered/i.test(msg)) return 'There is already an account on that email — sign in instead.';
  if (/password should be at least/i.test(msg)) return 'Use at least 8 characters.';
  if (/unable to validate email|invalid email/i.test(msg)) return 'That does not look like an email address.';
  if (/email rate limit|over_email_send_rate_limit/i.test(msg)) return 'Too many emails just went out. Wait a few minutes and try again.';
  if (/failed to fetch|network/i.test(msg)) return 'No connection. Your trips are safe on this device — try again when you have signal.';
  return msg;
}

/**
 * Create an account.
 *
 * If this device already carries an anonymous session — it joined a shared trip
 * before it ever had an account — that session is UPGRADED rather than replaced.
 * Signing up fresh would mint a second user id and silently strand the rider's
 * trip memberships and authored ops behind the old one.
 *
 * Returns { user, needsConfirmation }. `needsConfirmation` is true when the
 * project has "Confirm email" switched on, in which case there is no session
 * yet and the rider has to click a link first.
 */
export async function signUp({ email, password, name }) {
  need();
  const mail = email.trim().toLowerCase();
  try {
    const existing = await currentUser();
    if (existing?.is_anonymous) {
      const { data, error } = await supabase.auth.updateUser({
        email: mail,
        password,
        data: { name: name?.trim() || undefined },
      });
      if (error) throw error;
      // The upgrade only completes once the address is confirmed; until then
      // the session is still the anonymous one it started as.
      return { user: data.user, needsConfirmation: !data.user?.email || data.user?.is_anonymous };
    }
    const { data, error } = await supabase.auth.signUp({
      email: mail,
      password,
      options: { data: { name: name?.trim() || null }, emailRedirectTo: redirectTo() },
    });
    if (error) throw error;
    return { user: data.user, needsConfirmation: !data.session };
  } catch (e) {
    throw new Error(friendly(e));
  }
}

export async function signIn({ email, password }) {
  need();
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    });
    if (error) throw error;
    return data.user;
  } catch (e) {
    throw new Error(friendly(e));
  }
}

export async function signOutAccount() {
  if (supabase) await supabase.auth.signOut();
}

/** Emails a recovery link back to this origin. */
export async function sendReset(email) {
  need();
  try {
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), {
      redirectTo: redirectTo(),
    });
    if (error) throw error;
  } catch (e) {
    throw new Error(friendly(e));
  }
}

/** Finish a recovery: the link put a session on this tab, this sets the password. */
export async function updatePassword(password) {
  need();
  try {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw error;
  } catch (e) {
    throw new Error(friendly(e));
  }
}

function redirectTo() {
  try { return window.location.origin; } catch { return undefined; }
}

/**
 * Who is signed in, as a hook.
 *
 * `status` is 'loading' until the stored session has been read back — the gate
 * in App must not flash the landing page at a rider who is already signed in.
 * `recovery` goes true when the tab was opened from a password-reset link, so
 * the landing page can ask for a new password instead of the old one.
 */
export function useAuth() {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState(SYNC_ENABLED ? 'loading' : 'off');
  const [recovery, setRecovery] = useState(false);

  useEffect(() => {
    if (!SYNC_ENABLED) return undefined;
    let alive = true;
    currentUser()
      .then((u) => { if (alive) { setUser(u); setStatus('ready'); } })
      .catch(() => { if (alive) setStatus('ready'); });
    const { data } = supabase.auth.onAuthStateChange((event, session) => {
      if (!alive) return;
      if (event === 'PASSWORD_RECOVERY') setRecovery(true);
      if (event === 'SIGNED_OUT') setRecovery(false);
      setUser(session?.user ?? null);
      setStatus('ready');
    });
    return () => { alive = false; data.subscription.unsubscribe(); };
  }, []);

  return {
    user,
    status,
    recovery,
    clearRecovery: () => setRecovery(false),
    account: isAccount(user) ? user : null,
    enabled: SYNC_ENABLED,
  };
}
