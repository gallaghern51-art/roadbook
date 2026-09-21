import React, { useEffect, useState } from 'react';
import { useT } from '../engine/settings.jsx';
import { supabase, SYNC_ENABLED } from '../engine/supabase.js';

// Settings → Connect your AI.
//
// Riders already ask the AI they carry where to go. The MCP server at /mcp
// lets that conversation end as a trip in THIS library. Two ways in:
//
//   • OAuth — hosts that can (Claude.ai, ChatGPT, Claude Code, Cursor) take the
//     endpoint URL and sign the rider in through Supabase Auth; the consent
//     page in this app approves the connection. Nothing to copy but the URL.
//   • A connector token — for a host that only takes a header (the stdio
//     bridge, a script). Minted here, shown ONCE, stored as a hash; revocable.
//
// The token is generated in the browser, hashed with SubtleCrypto, and only
// the hash is inserted (RLS: the rider's own rows). The plain value never
// leaves this screen except by the rider's own copy.

const MCP_PATH = '/mcp';
const TOKEN_PREFIX = 'rbk_';

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return TOKEN_PREFIX + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const when = (iso) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : null);

export default function ConnectorPanel({ auth }) {
  const t = useT();
  const account = auth?.account;
  const [tokens, setTokens] = useState([]);
  const [label, setLabel] = useState('');
  const [fresh, setFresh] = useState(null); // { token, label } shown once
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [copied, setCopied] = useState(null);
  const endpoint = typeof window !== 'undefined' ? `${window.location.origin}${MCP_PATH}` : MCP_PATH;

  const load = async () => {
    if (!supabase || !account) return;
    const { data, error: e } = await supabase.from('mcp_tokens')
      .select('id, label, created_at, last_used_at, revoked_at')
      .eq('user_id', account.id)
      .order('created_at', { ascending: false });
    if (e) { setError(e.message); return; }
    setTokens(data ?? []);
  };
  useEffect(() => { load(); }, [account?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!SYNC_ENABLED) return null;

  const copy = async (text, which) => {
    try { await navigator.clipboard.writeText(text); setCopied(which); setTimeout(() => setCopied(null), 1800); } catch { /* the field is selectable */ }
  };

  const mint = async () => {
    if (!account) return;
    setBusy(true); setError(null);
    try {
      const token = randomToken();
      const token_hash = await sha256Hex(token);
      const name = label.trim() || t('AI connector');
      const { error: e } = await supabase.from('mcp_tokens').insert({ user_id: account.id, token_hash, label: name });
      if (e) throw e;
      setFresh({ token, label: name });
      setLabel('');
      await load();
    } catch (e) {
      setError(e?.message ?? String(e));
    } finally { setBusy(false); }
  };

  const revoke = async (id) => {
    setBusy(true); setError(null);
    try {
      const { error: e } = await supabase.from('mcp_tokens').update({ revoked_at: new Date().toISOString() }).eq('id', id);
      if (e) throw e;
      if (fresh && tokens.find((x) => x.id === id)?.label === fresh.label) setFresh(null);
      await load();
    } catch (e) {
      setError(e?.message ?? String(e));
    } finally { setBusy(false); }
  };

  const live = tokens.filter((x) => !x.revoked_at);

  return (
    <div className="conn">
      <p className="set-note">
        {t('Ask the AI you already use — Claude, ChatGPT, Claude Code — where to ride, see every road measured with traffic and tolls, and save the one you pick straight into this library.')}
      </p>

      <div className="conn-row">
        <span className="fld">{t('Connector address')}</span>
        <div className="conn-field">
          <code className="conn-url" data-testid="mcp-endpoint">{endpoint}</code>
          <button className="btn compact" type="button" onClick={() => copy(endpoint, 'url')}>{copied === 'url' ? t('Copied') : t('Copy')}</button>
        </div>
        <p className="set-note">{t('Add it as a custom connector or MCP server. Hosts that can sign in will send you back here to approve the connection with your Roadbook account.')}</p>
      </div>

      {!account ? (
        <p className="set-note">{t('Sign in to make a connector token.')}</p>
      ) : (
        <div className="conn-row">
          <span className="fld">{t('Connector tokens')}</span>
          <p className="set-note">{t('For a host that only takes a key — the stdio bridge, a script. A token is shown once; revoke it here any time.')}</p>

          {fresh && (
            <div className="conn-fresh" role="status">
              <p className="conn-fresh-title">{t('Your new token — copy it now, it will not be shown again.')}</p>
              <div className="conn-field">
                <code className="conn-url conn-token" data-testid="mcp-token">{fresh.token}</code>
                <button className="btn compact gold" type="button" onClick={() => copy(fresh.token, 'token')}>{copied === 'token' ? t('Copied') : t('Copy')}</button>
              </div>
            </div>
          )}

          <div className="conn-mint">
            <input
              type="text" value={label} maxLength={60}
              placeholder={t('Label (e.g. Claude Desktop)')}
              onChange={(e) => setLabel(e.target.value)}
            />
            <button className="btn" type="button" disabled={busy} onClick={mint}>{t('Make a token')}</button>
          </div>

          {live.length > 0 && (
            <ul className="conn-list">
              {live.map((x) => (
                <li key={x.id} className="conn-item">
                  <span className="conn-item-main">
                    <b>{x.label}</b>
                    <span className="set-note">
                      {t('made')} {when(x.created_at)}{x.last_used_at ? ` · ${t('last used')} ${when(x.last_used_at)}` : ` · ${t('never used')}`}
                    </span>
                  </span>
                  <button className="btn compact danger-ghost" type="button" disabled={busy} onClick={() => revoke(x.id)}>{t('Revoke')}</button>
                </li>
              ))}
            </ul>
          )}
          {error && <p className="set-note warn">{error}</p>}
        </div>
      )}
    </div>
  );
}
