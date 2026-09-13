import React, { useState } from 'react';
import { useT } from '../engine/settings.jsx';

// Real dialogs for the actions that used to run on window.prompt/confirm.
// Same modal chrome as NewTripModal, so every dialog in the app is one species.

export function Sheet({ eyebrow, title, onClose, children, foot }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            <h3>{title}</h3>
          </div>
          <button className="btn" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {foot && <div className="modal-foot">{foot}</div>}
      </div>
    </div>
  );
}

export function ConfirmSheet({ title, body, confirmLabel, danger, onConfirm, onClose }) {
  const t = useT();
  return (
    <Sheet
      title={title}
      onClose={onClose}
      foot={(
        <>
          <span className="foot-note" />
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button
            className={`btn ${danger ? 'danger-solid' : 'gold'}`}
            onClick={() => { onConfirm(); onClose(); }}
          >{confirmLabel}</button>
        </>
      )}
    >
      <p className="sheet-body">{body}</p>
    </Sheet>
  );
}

export function InputSheet({ title, label, placeholder, submitLabel, onSubmit, onClose, defaultValue = '' }) {
  const t = useT();
  const [value, setValue] = useState(defaultValue);
  const submit = () => {
    const v = value.trim();
    if (!v) return;
    onSubmit(v);
    onClose();
  };
  return (
    <Sheet
      title={title}
      onClose={onClose}
      foot={(
        <>
          <span className="foot-note" />
          <button className="btn" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn gold" disabled={!value.trim()} onClick={submit}>{submitLabel}</button>
        </>
      )}
    >
      <label className="fld">{label}
        <input
          autoFocus
          value={value}
          placeholder={placeholder}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
      </label>
    </Sheet>
  );
}
