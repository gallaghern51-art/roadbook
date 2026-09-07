# Roadbook visual system

Roadbook is a precision touring instrument: part field atlas, part cockpit,
always centered on the route and the group decision around it.

## Character

- The route is the signature. Route silhouettes, measured progress, and day
  sequence carry identity before decoration does.
- Dark mode is a low-glare night instrument, with warm bone-white type over
  blue-black metal surfaces.
- Light mode is a daylight field atlas, using mineral paper, carbon ink, and
  higher-pigment route colors. It is designed independently, not inverted.
- Signal orange is reserved for a primary action or a condition that deserves
  attention. Cool turquoise marks routing intelligence and live system state.
- Corners are functional: 14px on major sheets/cards, 8–10px on controls, and
  pills only for compact statuses.

## Type

- Barlow Condensed carries the wordmark and the largest editorial headings.
- Barlow carries interface headings, controls, and body copy.
- IBM Plex Mono is limited to measurements, dates, times, route identifiers,
  and compact machine state. It is never generic decoration.
- Interface labels use sentence case. Existing all-caps labels may remain where
  they act like roadbook notation, but new labels do not introduce more.

## Surfaces

- Canvas → panel → raised control is a strict three-step elevation system.
- Major cards use either a boundary or a shadow, not both. Dark-mode depth is
  mostly tonal; light-mode depth uses a restrained soft shadow.
- Selected objects use an inset accent and a surface change. Warnings use a
  semantic wash rather than a thick colored side border.
- Form controls have a visible filled field, a high-contrast focus ring, and
  at least a 44px touch target on coarse pointers.

## Layout

- Planning keeps the map dominant and the workbench readable beside it.
- The AI builder is a two-pane construction desk on desktop and explicit
  Conversation / Route plan views on a phone.
- Landing and Home use generous editorial space; in-product surfaces become
  denser and more instrumental.
- Light and dark themes must be screenshot-tested at 375px and desktop width.

## Motion

- Motion explains a state change: opening the AI dock, selecting a trip, or
  expanding detail. No page-load choreography.
- All motion is disabled under `prefers-reduced-motion`.
