// App-wide settings: language (en/es), theme (dark/light), and units
// (imperial/metric), persisted per browser in moto.settings.v1. The theme
// lands as data-theme on <html> so CSS variable overrides do the work.
//
// Two translators, one per kind of text — they scale differently, so they are
// deliberately not the same mechanism:
//
//   t()  — app CHROME (buttons, headings, labels). A finite, stable set, so a
//          dictionary in this file is right. `npm run i18n:check` fails the
//          build when a t() call has no translation, so it cannot drift.
//
//   tt() — trip CONTENT and engine sentences. Unbounded: every new trip, in any
//          country, brings its own prose. So it resolves through
//          i18n/resolve.js, which reads the TRIP'S OWN translation cache first
//          (see i18n/collect.js and the translate flow). Nothing about adding a
//          trip requires touching source.
//
// Place names, road numbers, and addresses stay as-written in both — they have
// to match road signs and GPS.

import React, { createContext, useContext, useEffect, useState } from 'react';
import { resolveContent } from '../i18n/resolve.js';
import { TripContext } from './store.js';

const KEY = 'moto.settings.v1';
// `density` is the Ride Mode HUD's information budget: 'detailed' shows the
// labels and the weather, 'minimal' strips it to numbers only.
const DEFAULTS = { lang: 'en', theme: 'dark', units: 'imperial', shields: true, density: 'detailed' };

function load() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULTS }; }
}

const SettingsContext = createContext({ ...DEFAULTS, set: () => {} });

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(load);

  useEffect(() => {
    document.documentElement.dataset.theme = settings.theme;
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* full */ }
  }, [settings]);

  const set = (patch) => setSettings((s) => ({ ...s, ...patch }));
  return <SettingsContext.Provider value={{ ...settings, set }}>{children}</SettingsContext.Provider>;
}

export const useSettings = () => useContext(SettingsContext);

// ---- chrome dictionary ----
// Keyed by the English string so call sites stay readable: t('Feasibility').
// Missing keys fall back to English rather than breaking the UI.

const ES = {
  // masthead / menu
  'Menu': 'Menú',
  'Trip controls': 'Controles del viaje',
  'New trip': 'Nuevo viaje',
  'Delete current trip': 'Eliminar viaje actual',
  'Save current as scenario': 'Guardar como escenario',
  'Trips': 'Viajes',
  'Scenarios': 'Escenarios',
  'Load': 'Cargar',
  'Plan': 'Plan',
  'Feasibility': 'Factibilidad',
  'Budget': 'Presupuesto',
  'Ride': 'Rodar',
  'Undo': 'Deshacer',
  'Export': 'Exportar',
  'Import': 'Importar',
  'Reset': 'Restablecer',
  'Optimizer': 'Optimizador',
  'Hide': 'Ocultar',
  'Packing': 'Equipaje',
  'Settings': 'Ajustes',
  'Map': 'Mapa',
  'Trip': 'Viaje',
  'riders': 'motociclistas',
  'days': 'días',
  // day panel
  'Day': 'Día',
  'of': 'de',
  'Depart': 'Salida',
  'End': 'Fin',
  'Miles': 'Millas',
  'Ride hrs': 'Hrs en ruta',
  'Stop hrs': 'Hrs parado',
  'Longest fuel gap': 'Mayor tramo sin bencina',
  'Hard constraints': 'Restricciones duras',
  'Constraints': 'Restricciones',
  'notes — the engine grades the Hard gates below': 'notas — el motor evalúa las Puertas duras de abajo',
  'read from the route — suggestions add to it': 'leídas de la ruta — las sugerencias se agregan a ella',
  'not on the route': 'fuera de la ruta',
  'Add to route': 'Agregar a la ruta',
  'stop removed — re-point': 'parada eliminada — reasignar',
  'Route & stops': 'Ruta y paradas',
  'drag ⠿ to reorder · tap to zoom the map · ⓘ for details': 'arrastra ⠿ para reordenar · toca para acercar el mapa · ⓘ para detalles',
  'Conditions': 'Condiciones',
  'Optional modules': 'Módulos opcionales',
  'Food': 'Comida',
  'Photo stops': 'Paradas de foto',
  'Lodging': 'Alojamiento',
  'Operations': 'Operaciones',
  'click ✎ to edit': 'toca ✎ para editar',
  'total': 'total',
  // packing
  'Packing list': 'Lista de equipaje',
  'Per rider — saves on this device only, so each rider checks off their own.': 'Por motociclista — se guarda solo en este dispositivo, cada uno marca la suya.',
  'packed': 'listo',
  'Uncheck all': 'Desmarcar todo',
  'Close': 'Cerrar',
  // settings
  'Language': 'Idioma',
  'English': 'Inglés',
  'Spanish': 'Español',
  'Theme': 'Tema',
  'Dark': 'Oscuro',
  'Light': 'Claro',
  'Applies on this device only. Trip text and AI answers stay in the language they were written in — ask the optimizer in Spanish and it answers in Spanish.': 'Se aplica solo en este dispositivo. El texto del viaje y las respuestas de la IA quedan en el idioma en que fueron escritos — pregúntale al optimizador en español y responde en español.',
  // misc chrome
  'Feasibility studies': 'Estudios de factibilidad',
  'The whole trip at a glance': 'El viaje completo de un vistazo',
  'nights': 'noches',
  // settings (units)
  'Units': 'Unidades',
  // trip translation
  'Trip text': 'Texto del viaje',
  'translated': 'traducido',
  'Retry': 'Reintentar',
  'Trip text translates itself when you pick a language, and is stored on the trip so it travels with export and import. Retry is only needed if a run was interrupted.': 'El texto del viaje se traduce solo al elegir un idioma, y queda guardado en el viaje, así que viaja con la exportación y la importación. Reintentar solo hace falta si una pasada quedó a medias.',
  "Sends this trip's text to the optimizer for translation and stores the result on the trip, so it travels with export and import. Place names, road numbers and addresses are left as written.": 'Envía el texto de este viaje al optimizador para traducirlo y guarda el resultado en el viaje, así viaja con exportar e importar. Los nombres de lugares, números de ruta y direcciones se dejan como están.',
  'Imperial (mi, °F)': 'Imperial (mi, °F)',
  'Metric (km, °C)': 'Métrico (km, °C)',
  // overview panel
  'Days': 'Días',
  'drag to reorder': 'arrastra para reordenar',
  'press & hold to reorder': 'mantén presionado para reordenar',
  'Add day': 'Agregar día',
  'Trip settings': 'Configuración del viaje',
  'Trip name': 'Nombre del viaje',
  'Trip summary': 'Resumen del viaje',
  'dates stay pinned to the calendar': 'las fechas quedan fijas al calendario',
  'Start date': 'Fecha de inicio',
  'Riders': 'Motociclistas',
  'Range: comfort mi': 'Rango cómodo (mi)',
  'Range: absolute mi': 'Rango absoluto (mi)',
  'MPG': 'MPG',
  'Ride pack': 'Kit de ruta',
  'GPX — full trip': 'GPX — viaje completo',
  'Calendar (.ics)': 'Calendario (.ics)',
  'GPX loads into Garmin, Rever, or any nav app (per-day GPX is on each day panel).': 'El GPX se carga en Garmin, Rever o cualquier app de navegación (el GPX por día está en el panel de cada día).',
  'The calendar file drops all 11 days — departures, gates, dinners — into everyone\'s phone in Mountain Time.': 'El archivo de calendario deja los 11 días — salidas, cortes, cenas — en el teléfono de todos, en hora de la Montaña.',
  'Road status & smoke': 'Estado de rutas y humo',
  'check the week of': 'revisar la semana del viaje',
  'Reserve these now': 'Reservar esto ahora',
  'open': 'pendientes',
  'Field notes': 'Notas de campo',
  'Fuel discipline': 'Disciplina de bencina',
  'Intercom': 'Intercomunicador',
  'Cash & passes': 'Efectivo y pases',
  'Altitude': 'Altitud',
  'Emergency': 'Emergencia',
  'Rider roster': 'Nómina de motociclistas',
  'name + bike, saved on the trip': 'nombre + moto, se guarda en el viaje',
  'Rider name': 'Nombre',
  'Bike': 'Moto',
  'Add rider': 'Agregar motociclista',
  'Choose a bike…': 'Elegir moto…',
  'marks the': 'marca los',
  'anchor day': 'día ancla',
  'anchor days': 'días ancla',
  'everything else is built around — if a day has to be trimmed, trim anywhere else first.': 'en torno a los que se arma todo lo demás — si hay que recortar un día, recorta primero en cualquier otro.',
  'Drag days to restructure': 'Arrastra los días para reestructurar',
  'Press and hold a day to restructure': 'Mantén presionado un día para reestructurar',
  '— dates stay pinned to the calendar; content moves.': '— las fechas quedan fijas al calendario; el contenido se mueve.',
  // feasibility panel
  'Engine-computed · routed miles · timed stop-by-stop': 'Calculado por el motor · millas ruteadas · cronometrado parada a parada',
  'Feasibility study': 'Estudio de factibilidad',
  'overall': 'general',
  'routed': 'ruteadas',
  'Day by day': 'Día a día',
  '◎ How to break this loop': '◎ Cómo cortar este circuito',
  '✂ Where to split this day': '✂ Dónde dividir este día',
  'Have the optimizer restructure it →': 'Que el optimizador lo reestructure →',
  'Saved permutations': 'Permutaciones guardadas',
  'None yet. Use “Save scenario” in the top bar — or ask the optimizer to rebuild the trip and save the result — then compare permutations here and swap between them.': 'Todavía no hay. Usa «Guardar escenario» en la barra superior — o pídele al optimizador que rearme el viaje y guarde el resultado — y compara las permutaciones aquí.',
  'Plan (col)': 'Plan',
  'Miles (col)': 'Millas',
  'Feas.': 'Fact.',
  'Current working plan': 'Plan de trabajo actual',
  'Method: departure times from each day\'s plan, routed leg durations (OSRM, +15% group pace), planned time-on-ground at every stop, checked against the trip\'s hard gates, its configured fuel range, daylight (~8:30 PM), and booking status. Scenario rows use cached routing where available and planned mileage otherwise.': 'Método: horas de salida del plan de cada día, duraciones de tramos ruteados (OSRM, +15% por ritmo de grupo), tiempo en tierra planificado en cada parada, contrastado con los cortes duros del viaje, su rango de bencina configurado, la luz de día (~8:30 PM) y el estado de las reservas. Las filas de escenarios usan ruteo en caché cuando existe y millaje planificado si no.',
  // budget panel
  'Fuel from routed miles · everything else adjustable': 'Bencina según millas ruteadas · todo lo demás ajustable',
  'Budget & fuel': 'Presupuesto y bencina',
  'Assumptions': 'Supuestos',
  'Gas $/gal': 'Bencina $/galón',
  'Lodging $/night/rider': 'Alojamiento $/noche/persona',
  'Food $/day/rider': 'Comida $/día/persona',
  'Tickets $/rider': 'Entradas $/persona',
  'Misc $/rider': 'Varios $/persona',
  'Fuel by day': 'Bencina por día',
  'Day (col)': 'Día',
  'Gal/bike': 'Gal/moto',
  '$/rider': '$/persona',
  '$ group': '$ grupo',
  'Per-rider total': 'Total por persona',
  'Fuel': 'Bencina',
  'Lodging (row)': 'Alojamiento',
  'Food (row)': 'Comida',
  'Tickets (Buffalo Chip, museums, passes)': 'Entradas (Buffalo Chip, museos, pases)',
  'Misc / buffer': 'Varios / colchón',
  'Total per rider': 'Total por persona',
  // chat panel
  'Clear': 'Limpiar',
  'Proposed changes': 'Cambios propuestos',
  'saves as': 'se guarda como',
  'Apply': 'Aplicar',
  'Dismiss': 'Descartar',
  'Ask, or tell me to rework the trip…': 'Pregunta, o pídeme que rearme el viaje…',
  'Send': 'Enviar',
  'Thinking…': 'Pensando…',
  // detail modal / misc
  'Open this day': 'Abrir este día',
  'Close (btn)': 'Cerrar',
  'Add a stop here — name it:': 'Agregar una parada aquí — ponle nombre:',
  'Add a stop — search any real place (e.g. \'Wall Drug, SD\')…': 'Agregar una parada — busca cualquier lugar real (p. ej. \'Wall Drug, SD\')…',
  'Click for details': 'Clic para ver detalles',
  // day panel details
  'Tonight': 'Esta noche',
  'lodging': 'alojamiento',
  '● Confirmed booking': '● Reserva confirmada',
  '▲ Not yet booked — reserve now': '▲ Sin reservar — reservar ahora',
  '○ No lodging set': '○ Sin alojamiento definido',
  'Nothing planned yet': 'Nada planificado aún',
  '✎ edit': '✎ editar',
  'Property / plan': 'Propiedad / plan',
  'Status': 'Estado',
  'none': 'ninguno',
  'needs booking': 'falta reservar',
  'booked': 'reservado',
  'Address / town': 'Dirección / pueblo',
  'Note': 'Nota',
  'Spot': 'Lugar',
  'Where': 'Dónde',
  'Save': 'Guardar',
  'Cancel': 'Cancelar',
  'breakfast': 'desayuno',
  'lunch': 'almuerzo',
  'dinner': 'cena',
  'Remove this day': 'Eliminar este día',
  // day description + drift flag
  'The route changed after this description was written.': 'La ruta cambió después de escribir esta descripción.',
  'Rewrite with Copilot': 'Reescribir con Copilot',
  'Edit': 'Editar',
  'Still accurate': 'Sigue siendo correcta',
  'Edit description': 'Editar descripción',
  'Write a description': 'Escribir una descripción',
  'No description for this day yet.': 'Este día aún no tiene descripción.',
  'What this day is, and what it costs.': 'Qué es este día y qué cuesta.',
  'Stops now': 'Paradas actuales',
  'ride hrs': 'h de ruta',
  'Rewrite this day\'s description to match the route it actually has now — set_day_field summary, and the title too if the endpoints no longer match. One or two honest sentences in the field-guide voice, trade-offs included. Do not change the route.':
    'Reescribe la descripción de este día para que coincida con la ruta que tiene ahora — set_day_field summary, y también el título si los extremos ya no coinciden. Una o dos frases honestas con la voz de la guía de campo, incluyendo las concesiones. No cambies la ruta.',
  'Remove meal': 'Quitar comida',
  'Why:': 'Por qué:',
  'Trade-off:': 'Costo:',
  'Logistics:': 'Logística:',
  'Best light': 'Luz',
  'Parking': 'Estacionamiento',
  '★ Anchor day — trim elsewhere first': '★ Día ancla — recortar primero en otro lado',
  'Prep': 'Preparación',
  'Outbound': 'Ida',
  'Rally': 'Rally',
  'Return': 'Regreso',
  'Satellite': 'Satélite',
  'Streets': 'Calles',
  'Road': 'Ruta',
  'Photo': 'Foto',
  // weather
  'checking forecast…': 'consultando el pronóstico…',
  'Forecast not in range yet — Open-Meteo covers ~16 days out. Check back closer to the date.': 'El pronóstico aún no alcanza — Open-Meteo cubre ~16 días hacia adelante. Revisa más cerca de la fecha.',
  'near': 'cerca de',
  'wind': 'viento',
  'Clear': 'Despejado',
  'Mostly clear': 'Mayormente despejado',
  'Partly cloudy': 'Parcialmente nublado',
  'Overcast': 'Cubierto',
  'Fog': 'Niebla',
  'Rime fog': 'Niebla escarchada',
  'Light drizzle': 'Llovizna suave',
  'Drizzle': 'Llovizna',
  'Heavy drizzle': 'Llovizna intensa',
  'Light rain': 'Lluvia suave',
  'Rain': 'Lluvia',
  'Heavy rain': 'Lluvia intensa',
  'Freezing rain': 'Lluvia helada',
  'Light snow': 'Nieve suave',
  'Snow': 'Nieve',
  'Heavy snow': 'Nieve intensa',
  'Snow grains': 'Granos de nieve',
  'Rain showers': 'Chubascos',
  'Violent showers': 'Chubascos violentos',
  'Snow showers': 'Chubascos de nieve',
  'Thunderstorms': 'Tormentas eléctricas',
  'T-storms w/ hail': 'Tormentas con granizo',
  'Changing the start date re-pins every day to the new calendar. Fuel warnings and feasibility use the bike range set here.': 'Cambiar la fecha de inicio vuelve a fijar cada día al nuevo calendario. Las advertencias de bencina y la factibilidad usan el rango de moto configurado aquí.',
  // detail modal
  'Arrive': 'Llegada',
  'On the ground': 'En tierra',
  'Roll out': 'Salida',
  'Leg in': 'Tramo de llegada',
  'Time here (min)': 'Tiempo aquí (min)',
  'Fuel stop': 'Parada de bencina',
  'Move to day': 'Mover al día',
  'Remove stop': 'Eliminar parada',
  'Done': 'Listo',
  'Distance': 'Distancia',
  'Ride time': 'Tiempo de ruta',
  'stop': 'parada',
  'leg': 'tramo',
  'Depart (short)': 'Salida',
  'This stop no longer exists.': 'Esta parada ya no existe.',
  'This leg no longer exists.': 'Este tramo ya no existe.',
  'searching…': 'buscando…',
  'Choose…': 'Elegir…',
  'Type any real place — e.g. Bozeman, MT': 'Escribe cualquier lugar real — p. ej. Bozeman, MT',
  'Start:': 'Inicio:',
  'End:': 'Fin:',
  '✓ Location updated →': '✓ Ubicación actualizada →',
  '— route re-snaps on save': '— la ruta se recalcula al guardar',
  'Rule of thumb extras: cash in small bills for vendor-heavy events, and the $80 America the Beautiful pass if the route touches multiple national parks — it usually pays for itself twice.': 'Extras de regla general: efectivo en billetes chicos para eventos con muchos vendedores, y el pase America the Beautiful de $80 si la ruta toca varios parques nacionales — normalmente se paga solo dos veces.',
  'analyzing the route…': 'analizando la ruta…',
  'working through the trip…': 'trabajando el viaje…',
  'drafting changes…': 'redactando cambios…',
  'characters': 'caracteres',
  // chat greeting + suggestion chips (clicking sends the Spanish text, so the
  // optimizer is asked in Spanish and answers in Spanish)
  "I hold the whole plan — every waypoint, booking, fuel stop, and constraint — plus the live metrics from your edits. Ask for analysis, or tell me to rework the trip and I'll propose concrete changes you can preview and apply.": 'Tengo el plan completo — cada parada, reserva, carga de bencina y restricción — más las métricas en vivo de tus ediciones. Pídeme análisis, o dime que rearme el viaje y te propondré cambios concretos que puedes previsualizar y aplicar.',
  'Run a full feasibility read — where does this plan break?': 'Haz una lectura completa de factibilidad — ¿dónde se rompe este plan?',
  'Where should we break up the loops and the long days?': '¿Dónde deberíamos cortar los circuitos y los días largos?',
  'Rebuild the trip to fix every failed gate and save it as "Fixed gates"': 'Rearma el viaje para corregir cada corte incumplido y guárdalo como "Cortes corregidos"',
  'Give me a lower-mileage version of the whole trip, save as "Relaxed"': 'Dame una versión del viaje completo con menos kilometraje, guárdala como "Relajado"',
  // map hints
  'Editing': 'Editando',
  '— click map to add a stop · drag markers · click stops & legs for details': '— clic en el mapa para agregar una parada · arrastra los marcadores · clic en paradas y tramos para detalles',
  'Whole-trip view': 'Vista del viaje completo',
  '— hover a route for leg info, click for details, pick a day to edit': '— pasa el cursor por una ruta para info del tramo, clic para detalles, elige un día para editar',
  // packing edit
  'Add an item…': 'Agregar un ítem…',
  'Add': 'Agregar',
  'Restore removed items': 'Restaurar ítems eliminados',
  // dashboard
  'Switch trip': 'Cambiar de viaje',
  'in the library': 'en la biblioteca',
  'saved': 'guardados',
  'Save this plan as a named permutation': 'Guardar este plan como una permutación con nombre',
  'Change which trip you are planning': 'Cambiar qué viaje estás planificando',
  'Dashboard': 'Panel',
  'Planner': 'Planificador',
  'Plan the trip': 'Planificar el viaje',
  'Get ready': 'Prepararse',
  'Trip file': 'Archivo del viaje',
  'Day by day, stops, food, lodging': 'Día a día, paradas, comida, alojamiento',
  'days need attention': 'días requieren atención',
  'No hard failures': 'Sin fallas graves',
  'Fuel, lodging, food, tickets': 'Bencina, alojamiento, comida, entradas',
  'AI': 'IA',
  'Ask for changes, preview, apply': 'Pide cambios, previsualiza, aplica',
  'Per rider, saved on this device': 'Por motociclista, guardado en este dispositivo',
  'All booked': 'Todo reservado',
  'Bookings still to make': 'Reservas pendientes',
  'GPS': 'GPS',
  'Turn-by-turn, ahead or behind plan': 'Indicaciones giro a giro, adelantados o atrasados',
  'Language, theme, units': 'Idioma, tema, unidades',
  'Save this trip as JSON': 'Guardar este viaje como JSON',
  'Load a trip from JSON': 'Cargar un viaje desde JSON',
  'From scratch, a description, or the template': 'Desde cero, una descripción o la plantilla',
  'Back to the bundled template': 'Volver a la plantilla incluida',
  // highway shields
  'Highway shields': 'Escudos de carretera',
  'Developer tools': 'Herramientas de desarrollo',
  'Build': 'Versión',
  'Route shields under each stop. Experimental — remove it if it reads as clutter.': 'Escudos de ruta bajo cada parada. Experimental — quítalo si se ve desordenado.',
  'On': 'Sí',
  'Off': 'No',
  'National park': 'Parque nacional',
  // module editor
  'add an option': 'agregar una opción',
  'move to': 'mover a',
  'another day…': 'otro día…',
  'Name': 'Nombre',
  'Timing': 'Horario',
  'Why': 'Por qué',
  'Trade-off': 'Costo',
  'Logistics': 'Logística',
  'Next': 'Siguiente',
  'ETA': 'ETA',
  'left': 'restante',
  'ON PLAN': 'SEGÚN EL PLAN',
  'LATE': 'TARDE',
  'ahead': 'adelante',
  'away': 'de distancia',
  'Speed limit': 'Límite de velocidad',
  'EARLY': 'TEMPRANO',
  'LOCATING…': 'UBICANDO…',
  'WAITING FOR GPS': 'ESPERANDO GPS',
  // ride mode hub
  'Ride menu': 'Menú de ruta',
  'Leg': 'Tramo',
  'Voice': 'Voz',
  'Map settings': 'Ajustes del mapa',
  'Credits': 'Créditos',
  'Your name, so the others know who is who.': 'Tu nombre, para que los demás sepan quién es quién.',
  'Keep this code. It is how you get back in on a new phone.': 'Guarda este código. Así vuelves a entrar desde otro teléfono.',
  'Leave this trip': 'Salir de este viaje',
  'Save': 'Guardar',
  'Joining a trip? Enter your name and the code the organiser sent.': '¿Te unes a un viaje? Escribe tu nombre y el código que te enviaron.',
  'Your name': 'Tu nombre',
  'Join trip': 'Unirse al viaje',
  'or': 'o',
  'Organising the trip? Sign in by email so it is recoverable on a new phone.': '¿Organizas el viaje? Inicia sesión por correo para poder recuperarlo en otro teléfono.',
  'Rider': 'Motociclista',
  'No GPS available in this browser.': 'No hay GPS disponible en este navegador.',
  'Location needs a secure connection — open the app over https. A plain http address will not get a fix on a phone.': 'La ubicación necesita una conexión segura — abre la app por https. Una dirección http simple no obtiene señal en el teléfono.',
  'Waiting for a GPS fix. Outdoors with a clear view of the sky is fastest.': 'Esperando señal GPS. Al aire libre con vista despejada del cielo es más rápido.',
  'Location permission denied — allow it in your browser settings to ride with the HUD.': 'Permiso de ubicación denegado — actívalo en los ajustes del navegador para usar el HUD.',
  'Share': 'Compartir',
  'Sign in to share this trip with your riders. Every change syncs to everyone.': 'Inicia sesión para compartir este viaje con tus motociclistas. Cada cambio se sincroniza con todos.',
  'you@example.com': 'tu@ejemplo.com',
  'Send link': 'Enviar enlace',
  'Check your email for the sign-in link.': 'Revisa tu correo para el enlace de acceso.',
  'Riders join with this code. Everything they change appears here.': 'Los motociclistas se unen con este código. Todo lo que cambien aparece aquí.',
  'Share this trip': 'Compartir este viaje',
  'Shared. Send the code to your riders.': 'Compartido. Envía el código a tus motociclistas.',
  'Join code': 'Código',
  'Join': 'Unirse',
  'Joined.': 'Te uniste.',
  'Live': 'En vivo',
  'Syncing': 'Sincronizando',
  'Waiting for signal': 'Esperando señal',
  'Offline': 'Sin conexión',
  'Sign out': 'Cerrar sesión',
  'Sharing is not configured on this build.': 'Compartir no está configurado en esta versión.',
  'Basemap': 'Mapa base',
  'Density': 'Densidad',
  'Minimalist': 'Minimalista',
  'Detailed': 'Detallado',
  'then': 'luego',
  'Route overview': 'Vista de la ruta',
  'Re-center': 'Recentrar',
  'End navigation': 'Terminar navegación',
  // ride mode
  'Exit': 'Salir',
  'Overview': 'Vista general',
  'Mute': 'Silenciar',
  'Unmute': 'Sonido',
  'Recenter': 'Recentrar',
  'ahead of plan': 'adelantados al plan',
  'behind plan': 'atrasados del plan',
  'on plan': 'según el plan',
  // reimagined shell: Home / PLAN·PREP·RIDE / Copilot dock
  'The AI roadbook for motorcycle trips': 'El roadbook con IA para viajes en moto',
  'Where do you want to ride?': '¿Adónde quieres rodar?',
  'Describe riders, days, region, pace — the AI drafts a routed, dated, feasibility-graded plan you can negotiate with.': 'Describe motociclistas, días, región, ritmo — la IA redacta un plan ruteado, fechado y calificado por factibilidad que puedes negociar.',
  'e.g. 4 riders, 6 days, Denver loop through the San Juans — Million Dollar Highway, hot springs one night, big scenic passes, moderate daily miles.': 'ej. 4 motociclistas, 6 días, circuito desde Denver por los San Juans — Million Dollar Highway, termas una noche, grandes pasos escénicos, millas diarias moderadas.',
  'Build with AI': 'Construir con IA',
  'Blank trip': 'Viaje en blanco',
  'Sturgis template': 'Plantilla Sturgis',
  'Import JSON': 'Importar JSON',
  'Your trips': 'Tus viajes',
  'Continue planning →': 'Seguir planificando →',
  'Open →': 'Abrir →',
  'Delete': 'Eliminar',
  'Delete this trip': 'Eliminar este viaje',
  'Delete this trip?': '¿Eliminar este viaje?',
  'its days, scenarios, and chat go with it. There is no undo for this.': 'sus días, escenarios y chat se van con él. Esto no se puede deshacer.',
  'Plan': 'Planificar',
  'Prep': 'Preparar',
  'Prep board': 'Tablero de preparación',
  'Ridden': 'Rodado',
  'Day': 'Día',
  'of': 'de',
  'the plan holds': 'el plan aguanta',
  'No gate, fuel, or daylight issues anywhere in the plan.': 'Sin problemas de horarios, bencina ni luz de día en todo el plan.',
  'Full feasibility study': 'Estudio de factibilidad completo',
  'Ask the AI to fix it': 'Pídele a la IA que lo arregle',
  'Fix every failing day in this plan — retime departures, move stops to neighboring days, or trim — keep the anchor days intact, and save the result as a scenario.': 'Arregla cada día que falla en este plan — reprograma salidas, mueve paradas a días vecinos o recorta — mantén intactos los días ancla y guarda el resultado como escenario.',
  'Status': 'Estado',
  'Bookings': 'Reservas',
  'Budget & fuel': 'Presupuesto y bencina',
  'Fuel from routed miles · everything else adjustable': 'Bencina según millas ruteadas · todo lo demás ajustable',
  'Export, import, GPX, calendar, reset': 'Exportar, importar, GPX, calendario, restablecer',
  'Every day, one file, ETAs on the waypoints': 'Cada día, un archivo, ETAs en los puntos',
  'Departures, gates, dinners on every phone': 'Salidas, horarios y cenas en cada teléfono',
  'Nothing to reserve — this trip has no booking checklist yet.': 'Nada que reservar — este viaje aún no tiene lista de reservas.',
  'Copilot': 'Copiloto',
  'Sure?': '¿Seguro?',
  'Save scenario': 'Guardar escenario',
  'Name this trip permutation': 'Nombra esta permutación del viaje',
  'e.g. Relaxed — lower miles': 'ej. Relajado — menos millas',
  'Reset this trip?': '¿Restablecer este viaje?',
  // design pass: silhouettes, start-from gallery, copilot chips
  'Start from': 'Partir desde',
  'the full field guide': 'la guía de campo completa',
  'Copy it →': 'Copiarla →',
  'An empty frame — add days and stops by hand': 'Un marco vacío — agrega días y paradas a mano',
  'Start empty →': 'Partir vacío →',
  'A trip file from a riding buddy': 'Un archivo de viaje de un compañero de ruta',
  'Load it →': 'Cargarlo →',
  '⌘↵ builds it · ': '⌘↵ lo construye · ',
  'every draft is editable, gradeable, undoable': 'cada borrador es editable, calificable, reversible',
  'Ask Copilot': 'Pregúntale al Copiloto',
  'Review this day in detail — where is it tight, what breaks, and what would you change?': 'Revisa este día en detalle — dónde va justo, qué falla y qué cambiarías.',
  'Routing': 'Ruteando',
  'rider': 'motociclista',
  // collaborate mode
  'Crew': 'Grupo',
  'Ride together': 'Rodar juntos',
  'Share this trip with the crew. Riders join from a link, make edits that arrive as proposals, drop recommendations, and vote when the plan is ready. You stay road captain — the plan publishes when you say it does.': 'Comparte este viaje con el grupo. Los motociclistas entran por un enlace, sus ediciones llegan como propuestas, dejan recomendaciones y votan cuando el plan está listo. Tú sigues siendo el capitán de ruta — el plan se publica cuando tú lo digas.',
  'Your name — shown to the crew': 'Tu nombre — visible para el grupo',
  'Start sharing': 'Empezar a compartir',
  'Starting…': 'Iniciando…',
  'Reaching the crew…': 'Contactando al grupo…',
  'Invite riders — plan it together': 'Invita motociclistas — planifíquenlo juntos',
  'Proposals, votes, recommendations': 'Propuestas, votos, recomendaciones',
  'shared': 'compartido',
  'joined': 'en el grupo',
  'DRAFT': 'BORRADOR',
  'VOTING': 'VOTACIÓN',
  'PUBLISHED': 'PUBLICADO',
  'Planning is open — edit, propose, recommend.': 'La planificación está abierta — edita, propone, recomienda.',
  'The captain called the vote. Say whether you\'re in.': 'El capitán llamó a votar. Di si te sumas.',
  'The plan is published. Prep continues; the route is locked.': 'El plan está publicado. La preparación sigue; la ruta queda fija.',
  'Call the vote': 'Llamar a votar',
  'Publish the plan': 'Publicar el plan',
  'Back to planning': 'Volver a planificar',
  'Reopen planning': 'Reabrir la planificación',
  'Copy invite': 'Copiar invitación',
  'Copied ✓': 'Copiado ✓',
  'Your changes': 'Tus cambios',
  'Send to the captain': 'Enviar al capitán',
  'Discard & resync': 'Descartar y resincronizar',
  'Your vote': 'Tu voto',
  'I\'m in': 'Me sumo',
  'I have concerns': 'Tengo dudas',
  'What worries you — day, distance, budget…': 'Qué te preocupa — día, distancia, presupuesto…',
  'Riders': 'Motociclistas',
  'you': 'tú',
  'in': 'se suma',
  'concerns': 'dudas',
  'no note': 'sin nota',
  'Remove from crew': 'Quitar del grupo',
  'Proposals': 'Propuestas',
  'None yet. Rider edits arrive here for the captain\'s call.': 'Aún no hay. Las ediciones de los motociclistas llegan aquí para la decisión del capitán.',
  'Decline': 'Rechazar',
  'applied': 'aplicada',
  'declined': 'rechazada',
  'Recommendations': 'Recomendaciones',
  'Nothing yet — routes, roadhouses, must-sees.': 'Nada aún — rutas, paradores, imperdibles.',
  'Recommend a road, a stop, a change…': 'Recomienda una ruta, una parada, un cambio…',
  'Show this leg on the map': 'Ver este tramo en el mapa',
  'Hide the panel': 'Ocultar el panel',
  'Show the panel': 'Mostrar el panel',
  'Back to the map': 'Volver al mapa',
  'Published plan': 'Plan publicado',
  'reopen planning from the Crew board to edit': 'reabre la planificación desde el tablero del Grupo para editar',
  'your edits arrive as proposals to the captain': 'tus ediciones llegan como propuestas al capitán',
  'Join this ride?': '¿Unirte a esta ruta?',
  'Join the crew': 'Unirme al grupo',
  'Joining…': 'Uniéndome…',
  'e.g. Marco': 'ej. Marco',
  // ride mode rebuilt
  'North up': 'Norte arriba',
  'Track up': 'Rumbo arriba',
  'Arrived': 'Llegaste',
  'End ride': 'Terminar ruta',
  'Stops ahead': 'Paradas por delante',
  'margin': 'de margen',
  'ridden today': 'recorridas hoy',
  // input audit: gates, bookings, dusk/tz, phase & anchor controls
  'Hard gates': 'Horarios límite',
  'be there by — feasibility grades against these': 'llegar antes de — la factibilidad se califica contra esto',
  'What has to happen': 'Qué tiene que pasar',
  'at which stop…': 'en cuál parada…',
  'Add gate': 'Agregar horario límite',
  'New gate': 'Nuevo horario límite',
  'Remove this gate': 'Quitar este horario límite',
  'Anchor': 'Ancla',
  'Anchor days are protected — the AI trims elsewhere first': 'Los días ancla están protegidos — la IA recorta primero en otro lado',
  'Sure? Later days shift earlier': '¿Seguro? Los días siguientes se adelantan',
  'Add booking': 'Agregar reserva',
  'Remove this booking': 'Quitar esta reserva',
  'Nothing on the checklist yet — add the calls this trip depends on.': 'Aún no hay nada en la lista — agrega las llamadas de las que depende este viaje.',
  'What to book — hotel, table, tickets': 'Qué reservar — hotel, mesa, entradas',
  'For when — “Night of Fri Aug 14”': 'Para cuándo — “Noche del vie 14 ago”',
  'Where / phone': 'Dónde / teléfono',
  'Notes — backups, what to ask for': 'Notas — respaldos, qué pedir',
  'Dusk (after-dark warnings)': 'Anochecer (avisos de oscuridad)',
  'UTC offset (calendar export)': 'Desfase UTC (exportar calendario)',
  'Dusk drives the after-dark warnings; the UTC offset places .ics calendar times in the trip’s zone.': 'El anochecer maneja los avisos de oscuridad; el desfase UTC ubica las horas del calendario .ics en la zona del viaje.',
  'Bike — type anything': 'Moto — escribe lo que sea',
  'Tickets, entries & passes': 'Entradas, accesos y pases',
  'Method: departure times from each day\'s plan, routed leg durations (OSRM, speed-calibrated for real highway pace, scaled by the trip\'s group-pace setting), planned time-on-ground at every stop, checked against the trip\'s hard gates, its configured fuel range, its dusk setting, and booking status. Saved-plan rows use cached routing where available and planned mileage otherwise.': 'Método: horas de salida del plan de cada día, duraciones de tramo ruteadas (OSRM, calibradas a la velocidad real de carretera y escaladas por el ritmo de grupo del viaje), tiempo en tierra planificado en cada parada, verificado contra los horarios límite del viaje, su autonomía de bencina configurada, su hora de anochecer y el estado de reservas. Las filas de planes guardados usan ruteo en caché cuando existe y millaje planificado si no.',
  'Back to the bundled Sturgis template. Every edit to this trip is discarded.': 'Vuelve a la plantilla Sturgis incluida. Se descarta cada edición de este viaje.',
  // pace + off-road pin (planning)
  'Group pace buffer %': 'Margen de ritmo de grupo %',
  'The pace buffer slows every planned leg for group riding — set 0 for a solo trip, 15+ for a big group.': 'El margen de ritmo ralentiza cada tramo planificado para rodar en grupo — usa 0 para un viaje solo, 15+ para un grupo grande.',
  'This pin sits off the road network, so routing detours to reach it. Drag it onto the road or re-pick the stop via search.': 'Este pin está fuera de la red de caminos, así que el ruteo se desvía para tocarlo. Arrástralo al camino o vuelve a elegir la parada con el buscador.',
  'off road': 'fuera del camino',
  // plans strip: saved-plan switching on the PLAN surface
  'Plans': 'Planes',
  'Current': 'Actual',
  'Save plan as…': 'Guardar plan como…',
  'Apply as new trip': 'Aplicar como viaje nuevo',
  'Apply for the group': 'Aplicar para el grupo',
  'Name this version — e.g. Solo Thursday': 'Nombra esta versión — p. ej. Jueves solo',
  'Snapshots the whole current plan under a name. Copilot restructures land here automatically too.': 'Guarda una copia del plan actual bajo un nombre. Las reestructuraciones del Copiloto también llegan aquí automáticamente.',
  'Update': 'Actualizar',
  'The working plan has drifted from this saved plan — Update writes your edits back into it.': 'El plan de trabajo se apartó de este plan guardado — Actualizar escribe tus ediciones de vuelta en él.',
  'You are on this plan, with unsaved edits — Update writes them back into it.': 'Estás en este plan, con ediciones sin guardar — Actualizar las escribe de vuelta en él.',
  'This is the current plan.': 'Este es el plan actual.',
  'The working plan — unsaved. Tap to name it.': 'El plan de trabajo — sin guardar. Toca para nombrarlo.',
  'Compare and load saved plans — save new ones from the Plans strip': 'Compara y carga planes guardados — guarda nuevos desde la franja Planes',
  'Saved plans': 'Planes guardados',
  'None yet. Save one from the Plans strip at the top of the trip overview — or ask Copilot to restructure the trip and save the result — then compare plans here and swap between them.': 'Aún no hay. Guarda uno desde la franja Planes arriba del resumen del viaje — o pide al Copiloto que reestructure el viaje y guarde el resultado — y luego compara planes aquí y cambia entre ellos.',
  'Load for the group': 'Cargar para el grupo',
  'Just me — new trip': 'Solo yo — viaje nuevo',
  'Personal copy': 'Copia personal',
  'Duplicate trip': 'Duplicar viaje',
  'Create my copy': 'Crear mi copia',
  'A separate copy of the current plan as its own trip on this phone — unshared, so nothing you change there reaches the group.': 'Una copia aparte del plan actual como su propio viaje en este teléfono — sin compartir, así que nada de lo que cambies ahí llega al grupo.',
  'A separate copy of this trip to experiment on — the original stays as it is.': 'Una copia aparte de este viaje para experimentar — el original queda como está.',
  'Group: every rider’s plan switches to this — it syncs like any other edit. Just me: a separate trip only on this phone; the group plan stays untouched.': 'Grupo: el plan de cada piloto cambia a este — se sincroniza como cualquier otra edición. Solo yo: un viaje aparte solo en este teléfono; el plan del grupo queda intacto.',
  'Group: these changes sync to every rider. Just me: they land in a separate trip on this phone.': 'Grupo: estos cambios se sincronizan a todos los pilotos. Solo yo: quedan en un viaje aparte en este teléfono.',
  'The current plan is auto-saved first — switching back is always possible.': 'El plan actual se guarda automáticamente primero — siempre puedes volver.',
  // ride mode: destination control + speed limit + mid-ride search
  'Add a stop ahead': 'Agregar una parada adelante',
  'Gas, food, a place…': 'Bencina, comida, un lugar…',
  'Searching…': 'Buscando…',
  'No matches — try adding the town name.': 'Sin resultados — agrega el nombre del pueblo.',
  'Stop': 'Parada',
  'FUEL': 'BENCINA',
  'Go next': 'Ir ahora',
  'Skip': 'Omitir',
  'Skipped': 'Omitida',
  'skipped': 'omitida',
  'Restore': 'Restaurar',
  'UNDO': 'DESHACER',
  'SPEED': 'SPEED',
  'LIMIT': 'LIMIT',
};

export function useT() {
  const { lang } = useSettings();
  return (s) => (lang === 'es' ? (ES[s] ?? s) : s);
}

// ---- units ----
// Imperial is the app's native unit system (the data is written in mi/°F).
// Metric converts at the last moment, display-only.

const MI_KM = 1.609344;

export function useUnits() {
  const { units } = useSettings();
  const metric = units === 'metric';
  return {
    metric,
    // distances
    mi: (n, digits = 0) => (n == null || Number.isNaN(n) ? '—'
      : metric ? `${(n * MI_KM).toFixed(digits)} km` : `${Number(n).toFixed(digits)} mi`),
    miNum: (n) => (metric ? Math.round(n * MI_KM) : Math.round(n)),
    miUnit: metric ? 'km' : 'mi',
    // temperature (data is °F)
    temp: (f) => (f == null || Number.isNaN(f) ? '—'
      : metric ? `${Math.round(((f - 32) * 5) / 9)}°` : `${Math.round(f)}°`),
    tempUnit: metric ? '°C' : '°F',
    // speed (data is mph)
    speed: (mph) => (mph == null || Number.isNaN(mph) ? '—'
      : metric ? `${Math.round(mph * MI_KM)} km/h` : `${Math.round(mph)} mph`),
  };
}

// Convert the units that appear inside prose/engine sentences. Conservative:
// only "N mi", "N-mi", "N mph", "N ft", "N°F" style tokens; road numbers
// (US-14, I-90) and times are untouched.
function metricizeText(s) {
  return s
    .replace(/(\d[\d,]*(?:\.\d+)?)([ -])mi\b/g, (_, n, sep) => `${Math.round(parseFloat(n.replace(/,/g, '')) * MI_KM)}${sep}km`)
    .replace(/(\d[\d,]*(?:\.\d+)?) ?mph\b/g, (_, n) => `${Math.round(parseFloat(n.replace(/,/g, '')) * MI_KM)} km/h`)
    .replace(/(\d[\d,]*(?:\.\d+)?)[ -]?ft\b/g, (_, n) => `${Math.round(parseFloat(n.replace(/,/g, '')) * 0.3048).toLocaleString('en-US')} m`)
    .replace(/(\d+(?:\.\d+)?)°F\b/g, (_, n) => `${Math.round(((parseFloat(n) - 32) * 5) / 9)}°C`)
    .replace(/(\d[\d,]*(?:\.\d+)?) miles\b/g, (_, n) => `${Math.round(parseFloat(n.replace(/,/g, '')) * MI_KM)} km`)
    .replace(/(\d[\d,]*(?:\.\d+)?) millas\b/g, (_, n) => `${Math.round(parseFloat(n.replace(/,/g, '')) * MI_KM)} km`);
}

// Trip-content translator. Resolution order lives in i18n/resolve.js; the trip's
// own cache wins, so a translated AI-generated trip needs no code change.
export function useTT() {
  const { lang, units } = useSettings();
  // Optional on purpose: tt() is also used above the trip provider in tests and
  // in chrome-only contexts, where there is simply no cache to consult.
  const tripCache = useContext(TripContext)?.state?.trip?.i18n?.[lang];
  return (s) => {
    if (s == null || typeof s !== 'string') return s;
    let out = resolveContent(s, lang, tripCache);
    // a handful of strings are both chrome and content (phase names, weather
    // conditions), so fall through to the chrome dictionary before giving up
    if (out === s && lang !== 'en') out = ES[s] ?? out;
    if (units === 'metric') out = metricizeText(out);
    return out;
  };
}
