import React, { useEffect, useState } from 'react';
import { useSettings, useT } from '../engine/settings.jsx';

// Per-rider packing checklist. Checks persist in THIS browser only
// (moto.packing.v1) — every rider ticks their own list on their own phone.
// Items carry their own en/es names since the global chrome dictionary
// shouldn't swell with 60 pieces of gear.

const KEY = 'moto.packing.v1';

const LIST = [
  {
    id: 'ride', en: 'Ride gear', es: 'Equipo de ruta',
    items: [
      { id: 'helmet', en: 'Helmet (DOT) + clear & tinted visors or glasses', es: 'Casco (DOT) + visores o gafas claras y oscuras' },
      { id: 'jacket', en: 'Armored jacket', es: 'Chaqueta con protecciones' },
      { id: 'gloves', en: 'Riding gloves + warm gloves for the high passes', es: 'Guantes de ruta + guantes térmicos para los pasos altos' },
      { id: 'boots', en: 'Over-ankle boots', es: 'Botas sobre el tobillo' },
      { id: 'rain', en: 'Rain suit (afternoon storms build over the Bighorns)', es: 'Traje de lluvia (tormentas vespertinas en los Bighorns)' },
      { id: 'layers', en: 'Thermal base + mid layer — Beartooth is 10,947 ft and cold at dawn', es: 'Primera capa térmica + capa media — Beartooth está a 10,947 ft y amanece frío' },
      { id: 'gaiter', en: 'Neck gaiter / balaclava', es: 'Cuello / pasamontañas' },
      { id: 'earplugs', en: 'Earplugs — multi-pack, one set per day', es: 'Tapones de oídos — paquete múltiple, un par por día' },
      { id: 'hydro', en: 'Hydration pack or bottle on the bike', es: 'Mochila de hidratación o botella en la moto' },
      { id: 'spf', en: 'SPF 50 + lip balm (high-altitude sun)', es: 'Bloqueador FPS 50 + bálsamo labial (sol de altura)' },
    ],
  },
  {
    id: 'docs', en: 'Documents & money', es: 'Documentos y dinero',
    items: [
      { id: 'license', en: 'License with motorcycle endorsement', es: 'Licencia con habilitación de moto' },
      { id: 'passport', en: 'Passport (Chilean riders) / ID', es: 'Pasaporte (motociclistas chilenos) / identificación' },
      { id: 'reservation', en: 'EagleRider reservation + insurance docs', es: 'Reserva EagleRider + documentos del seguro' },
      { id: 'parkpass', en: 'America the Beautiful pass (parks entry)', es: 'Pase America the Beautiful (entrada a parques)' },
      { id: 'cash', en: 'Cash, small bills — rural fuel, cash-only cafés, park gates', es: 'Efectivo en billetes chicos — bencina rural, cafés solo efectivo, entradas de parques' },
      { id: 'cards', en: 'Two cards, carried separately', es: 'Dos tarjetas, guardadas por separado' },
    ],
  },
  {
    id: 'tech', en: 'Tech & navigation', es: 'Tecnología y navegación',
    items: [
      { id: 'mount', en: 'Phone + bar mount (vibration damper for the Harley)', es: 'Teléfono + soporte de manillar (con amortiguador para la Harley)' },
      { id: 'intercom', en: 'Intercom, charged + Open Mesh channel written down', es: 'Intercomunicador cargado + canal Open Mesh anotado' },
      { id: 'battery', en: 'Battery bank 10,000 mAh+ and cables', es: 'Batería externa 10,000 mAh+ y cables' },
      { id: 'gpx', en: 'GPX files loaded before leaving Wi-Fi', es: 'Archivos GPX cargados antes de dejar el Wi-Fi' },
      { id: 'charger', en: 'Wall charger — one per rider, motels have few outlets', es: 'Cargador de pared — uno por persona, los moteles tienen pocos enchufes' },
    ],
  },
  {
    id: 'health', en: 'Health', es: 'Salud',
    items: [
      { id: 'meds', en: 'Personal meds for 11 days + copies of prescriptions', es: 'Medicamentos personales para 11 días + copias de recetas' },
      { id: 'electrolytes', en: 'Electrolyte packets — altitude runs 3,000–10,900 ft', es: 'Sobres de electrolitos — la altitud va de 3,000 a 10,900 ft' },
      { id: 'ibuprofen', en: 'Ibuprofen / pain relief', es: 'Ibuprofeno / analgésicos' },
      { id: 'firstaid', en: 'Small first-aid kit (one per 2–3 bikes is enough)', es: 'Botiquín pequeño (uno por cada 2–3 motos alcanza)' },
      { id: 'insurance', en: 'Evacuation insurance confirmed — helicopter in Montana runs $50–100k', es: 'Seguro de evacuación confirmado — el helicóptero en Montana cuesta $50–100k' },
    ],
  },
  {
    id: 'off', en: 'Off the bike', es: 'Fuera de la moto',
    items: [
      { id: 'clothes', en: 'Riding-week clothes in a compressible bag', es: 'Ropa de la semana en bolsa compresible' },
      { id: 'shoes', en: 'Light shoes for evenings', es: 'Zapatos livianos para las noches' },
      { id: 'swimsuit', en: 'Swimsuit — Quinn’s Hot Springs on the last night', es: 'Traje de baño — Quinn’s Hot Springs la última noche' },
      { id: 'laundry', en: 'Laundry bag (laundromat mid-trip in Lead)', es: 'Bolsa de ropa sucia (lavandería a mitad de viaje en Lead)' },
    ],
  },
  {
    id: 'bike', en: 'On the bike', es: 'En la moto',
    items: [
      { id: 'drybag', en: 'Dry bag + bungee net', es: 'Bolsa seca + pulpo elástico' },
      { id: 'lock', en: 'Cable lock for crowded stops and overnight parking', es: 'Candado de cable para paradas concurridas y estacionamiento nocturno' },
      { id: 'headlamp', en: 'Headlamp — Wapiti cabin and pre-dawn departures', es: 'Linterna frontal — cabaña Wapiti y salidas antes del amanecer' },
      { id: 'tape', en: 'Zip ties + small roll of duct tape', es: 'Amarras plásticas + rollo chico de cinta americana' },
      { id: 'rag', en: 'Visor rag + cleaner', es: 'Paño y limpiador de visor' },
    ],
  },
];

// Storage: { checks: {id: bool}, custom: {secId: [{id, label}]}, hidden: [id] }.
// v1 was a flat {id: bool} check map — migrate it into `checks`.
function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '{}');
    if (raw.checks || raw.custom || raw.hidden) {
      return { checks: raw.checks ?? {}, custom: raw.custom ?? {}, hidden: raw.hidden ?? [] };
    }
    return { checks: raw, custom: {}, hidden: [] };
  } catch { return { checks: {}, custom: {}, hidden: [] }; }
}

// Progress for surfaces that show packing state without rendering the list
// (the Prep board card). Same effective-list math as the component below.
export function packingProgress() {
  const s = load();
  const hidden = new Set(s.hidden);
  let total = 0;
  let done = 0;
  for (const sec of LIST) {
    const items = [
      ...sec.items.filter((i) => !hidden.has(i.id)),
      ...(s.custom[sec.id] ?? []),
    ];
    total += items.length;
    for (const i of items) if (s.checks[i.id]) done += 1;
  }
  return { done, total };
}

export default function PackingList() {
  const t = useT();
  const { lang } = useSettings();
  const [state, setState] = useState(load);
  const [adding, setAdding] = useState(null); // section id with the add-input open
  const [draft, setDraft] = useState('');

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* full */ }
  }, [state]);

  const name = (o) => (lang === 'es' ? o.es : o.en);
  const hidden = new Set(state.hidden);
  // Effective list: defaults minus removed, plus this rider's own items.
  const sections = LIST.map((sec) => ({
    ...sec,
    items: [
      ...sec.items.filter((i) => !hidden.has(i.id)).map((i) => ({ ...i, label: name(i) })),
      ...(state.custom[sec.id] ?? []).map((c) => ({ ...c, custom: true, label: c.label })),
    ],
  }));
  const total = sections.reduce((a, s) => a + s.items.length, 0);
  const count = sections.reduce((a, s) => a + s.items.filter((i) => state.checks[i.id]).length, 0);

  const toggle = (id) => setState((s) => ({ ...s, checks: { ...s.checks, [id]: !s.checks[id] } }));
  const removeItem = (sec, item) => setState((s) => {
    const checks = { ...s.checks };
    delete checks[item.id];
    if (item.custom) {
      return { ...s, checks, custom: { ...s.custom, [sec.id]: (s.custom[sec.id] ?? []).filter((c) => c.id !== item.id) } };
    }
    return { ...s, checks, hidden: [...s.hidden, item.id] };
  });
  const addItem = (secId) => {
    const label = draft.trim();
    if (!label) return;
    setState((s) => ({
      ...s,
      custom: { ...s.custom, [secId]: [...(s.custom[secId] ?? []), { id: `c_${Date.now().toString(36)}`, label }] },
    }));
    setDraft('');
  };

  return (
    // A panel, not a modal. It is a destination in the view bar like Planner
    // or Budget, so it renders in the panel column with them rather than
    // throwing a dialog over whatever you were looking at.
    <div className="panel-view packing">
      <div className="panel-view-inner">
        <div className="modal-head">
          <div>
            <h3>{t('Packing list')} <span className="pack-count">{count}/{total} {t('packed')}</span></h3>
            <div className="pack-sub">{t('Per rider — saves on this device only, so each rider checks off their own.')}</div>
          </div>
        </div>
        <div className="modal-body">
          {sections.map((sec) => (
            <div key={sec.id} className="pack-sec">
              <h4>
                {name(sec)} <span className="cnt">{sec.items.filter((i) => state.checks[i.id]).length}/{sec.items.length}</span>
                <button className="mini-edit" title={t('Add an item…')} onClick={() => { setAdding(adding === sec.id ? null : sec.id); setDraft(''); }}>＋</button>
              </h4>
              {sec.items.map((item) => (
                <label key={item.id} className={`pack-item${state.checks[item.id] ? ' done' : ''}`}>
                  <input type="checkbox" checked={!!state.checks[item.id]} onChange={() => toggle(item.id)} />
                  <span>{item.label}</span>
                  <button
                    className="pack-rm"
                    title="✕"
                    onClick={(e) => { e.preventDefault(); removeItem(sec, item); }}
                  >✕</button>
                </label>
              ))}
              {adding === sec.id && (
                <div className="pack-add">
                  <input
                    autoFocus
                    value={draft}
                    placeholder={t('Add an item…')}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addItem(sec.id); if (e.key === 'Escape') setAdding(null); }}
                  />
                  <button className="btn gold" onClick={() => addItem(sec.id)} disabled={!draft.trim()}>{t('Add')}</button>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="modal-foot">
          <button
            className="btn danger-ghost"
            onClick={() => { if (confirm(lang === 'es' ? '¿Desmarcar todo?' : 'Uncheck everything?')) setState((s) => ({ ...s, checks: {} })); }}
          >{t('Uncheck all')}</button>
          {state.hidden.length > 0 && (
            <button className="btn" onClick={() => setState((s) => ({ ...s, hidden: [] }))}>{t('Restore removed items')} ({state.hidden.length})</button>
          )}
          <span style={{ flex: 1 }} />
        </div>
      </div>
    </div>
  );
}
