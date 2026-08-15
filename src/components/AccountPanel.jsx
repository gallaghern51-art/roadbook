import React, { useState } from 'react';
import { useT } from '../engine/settings.jsx';
import { useTrip } from '../engine/store.js';
import { signOutAccount, displayName } from '../engine/auth.js';

// The account, as seen from Settings.
//
// Two jobs, and the second is the important one: say plainly whether the trips
// are backed up. "Signed in" is not the fact a rider wants — "eleven trips,
// saved a minute ago" is. A backup nobody can see the state of is a backup
// nobody trusts.

function ago(d, t) {
  if (!d) return null;
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 45) return t('just now');
  if (s < 3600) return `${Math.round(s / 60)} ${t('min ago')}`;
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export default function AccountPanel({ auth, backup, onCreateAccount }) {
  const t = useT();
  const { state } = useTrip();
  const [busy, setBusy] = useState(false);
  const account = auth?.account;

  if (!auth?.enabled) return null;

  // ---- no account: name the risk, offer the fix ----
  if (!account) {
    return (
      <div className="set-account">
        <span className="set-label">{t('Account')}</span>
        <p className="set-note">
          {t('No account. Your trips live only on this device — deleting the app, clearing the browser, or losing the phone loses them.')}
        </p>
        <button className="btn gold" onClick={onCreateAccount}>{t('Create an account')}</button>
      </div>
    );
  }

  const count = state.lib.trips.length;
  const when = ago(backup?.savedAt, t);

  return (
    <div className="set-account">
      <span className="set-label">{t('Account')}</span>
      <p className="acct-who">{displayName(account)}</p>
      {account.email && displayName(account) !== account.email && (
        <p className="set-note acct-mail">{account.email}</p>
      )}

      <p className={`acct-backup ${backup?.status ?? 'off'}`}>
        {backup?.status === 'syncing' && t('Backing up…')}
        {backup?.status === 'saved' && `${count} ${count === 1 ? t('trip backed up') : t('trips backed up')}${when ? ` · ${when}` : ''}`}
        {backup?.status === 'error' && t('Backup failed — it will retry. Your trips are safe on this device.')}
        {(!backup?.status || backup.status === 'off') && t('Not backed up yet.')}
      </p>
      {backup?.error && <p className="set-note">{backup.error}</p>}

      <div className="acct-actions">
        <button
          className="btn" disabled={backup?.status === 'syncing'}
          onClick={() => backup?.backupNow?.()}
        >{t('Back up now')}</button>
        <button
          className="btn" disabled={busy}
          onClick={async () => {
            setBusy(true);
            // Back up before letting go of the account — signing out with an
            // unsaved edit still in the debounce window would strand it.
            try { await backup?.backupNow?.(); } catch { /* sign out anyway */ }
            await signOutAccount();
            setBusy(false);
          }}
        >{t('Sign out')}</button>
      </div>
      <p className="set-note">{t('Signing out leaves every trip on this device. Sign back in on any phone to get them all.')}</p>
    </div>
  );
}
