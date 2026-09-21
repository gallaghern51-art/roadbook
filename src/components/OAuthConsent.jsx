import React, { useEffect, useState } from 'react';
import { useT } from '../engine/settings.jsx';
import { supabase } from '../engine/supabase.js';
import { displayName } from '../engine/auth.js';
import { RoadbookBrand } from './Chrome.jsx';

// /oauth/consent — the page Supabase Auth sends a rider to when an AI host
// (Claude.ai, ChatGPT, Claude Code…) asks to connect to their Roadbook
// through the MCP server. The rider sees WHO is asking and approves or
// denies; Supabase then issues the host a token for this account and sends
// it back where it came from. No token ever passes through this page.
//
// Reached only with ?authorization_id=…; App routes here on that path.

export const CONSENT_PATH = '/oauth/consent';
export const isConsentPath = () => typeof window !== 'undefined' && window.location.pathname === CONSENT_PATH;

export default function OAuthConsent({ auth, onNeedAccount }) {
  const t = useT();
  const account = auth?.account;
  const id = new URLSearchParams(window.location.search).get('authorization_id');
  const [details, setDetails] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supabase || !account || !id) return;
    let alive = true;
    (async () => {
      const { data, error: e } = await supabase.auth.oauth.getAuthorizationDetails(id);
      if (!alive) return;
      if (e || !data) { setError(e?.message || t('This connection request is not valid any more.')); return; }
      // already approved once — Supabase hands back the return address directly
      if (!('authorization_id' in data) && data.redirect_url) { window.location.assign(data.redirect_url); return; }
      setDetails(data);
    })();
    return () => { alive = false; };
  }, [account?.id, id]); // eslint-disable-line react-hooks/exhaustive-deps

  const decide = async (approve) => {
    setBusy(true); setError(null);
    try {
      const { data, error: e } = approve
        ? await supabase.auth.oauth.approveAuthorization(id)
        : await supabase.auth.oauth.denyAuthorization(id);
      if (e) throw e;
      if (data?.redirect_url) window.location.assign(data.redirect_url);
      else setError(t('Done — you can close this window.'));
    } catch (e) {
      setError(e?.message ?? String(e));
      setBusy(false);
    }
  };

  const scopes = String(details?.scope ?? '').split(' ').filter(Boolean);
  const client = details?.client ?? {};

  return (
    <div className="consent">
      <div className="consent-card">
        <RoadbookBrand />
        <h2 className="consent-h">{t('Connect to your Roadbook')}</h2>

        {!id && <p className="set-note">{t('This link is missing its authorization id. Start the connection again from your AI app.')}</p>}

        {id && !account && (
          <>
            <p>{t('Sign in to your Roadbook account to approve this connection.')}</p>
            <button className="btn gold" type="button" onClick={onNeedAccount}>{t('Sign in')}</button>
          </>
        )}

        {id && account && !details && !error && <p className="set-note">{t('Checking who is asking…')}</p>}

        {id && account && details && (
          <>
            <p className="consent-who">
              <b>{client.name || t('An AI app')}</b> {t('wants to plan and save trips as')} <b>{displayName(account)}</b>.
            </p>
            {client.uri && <p className="set-note">{client.uri}</p>}
            <ul className="consent-scopes">
              <li>{t('Read your trips, places and riding profile')}</li>
              <li>{t('Measure roads, traffic and tolls on your behalf')}</li>
              <li>{t('Create and edit trips in your library')}</li>
              {scopes.length > 0 && <li className="set-note">{t('Requested')}: {scopes.join(', ')}</li>}
            </ul>
            <p className="set-note">{t('You can revoke this later from your account. Nothing is shared with anyone else.')}</p>
            <div className="consent-actions">
              <button className="btn" type="button" disabled={busy} onClick={() => decide(false)}>{t('Deny')}</button>
              <button className="btn gold" type="button" disabled={busy} onClick={() => decide(true)}>{t('Approve')}</button>
            </div>
          </>
        )}

        {error && <p className="set-note warn" role="alert">{error}</p>}
      </div>
    </div>
  );
}
