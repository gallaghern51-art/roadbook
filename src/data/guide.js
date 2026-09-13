// The how-to guide's content.
//
// Written directions are the guide; video is an ENRICHMENT that can arrive
// later. Every chapter names the clip it wants at `video.src` — drop a screen
// recording at `public/guide/<file>` and it appears with no code change. Until
// the file exists the player renders a placeholder naming the missing file, so
// the written steps always stand on their own and nothing ever renders a
// broken <video>.
//
// Recording convention (matches the rest of the repo's QA widths):
//   · phone clips at 375×812, desktop clips at 1280×800
//   · MP4 (H.264 + AAC) or WebM, under ~8 MB, 30-90 seconds
//   · no audio narration needed — the steps below carry the words
//
// This prose is deliberately English-only: it is neither chrome (a finite
// dictionary in settings.jsx) nor trip content (translated per trip through
// tt()). If the guide is ever translated it wants its own catalog.

export const GUIDE_VERSION = '2026-09-12';

export const CHAPTERS = [
  {
    id: 'start',
    title: 'Start here',
    icon: '◎',
    blurb: 'What Roadbook is, and the five minutes that get you riding.',
    video: { src: '/guide/start.mp4', poster: '/guide/start.jpg', length: '1:00' },
    steps: [
      {
        t: 'Roadbook plans motorcycle trips and then rides them with you',
        b: 'It is one app in three parts. PLAN is the map room where the route and the days live. PREP is the status board — feasibility, bookings, packing, budget, crew. RIDE is full-screen turn-by-turn navigation built for a bike: fuel range, posted speed limits, gate deadlines, and voice at a mile, a quarter mile, and the turn.',
      },
      {
        t: 'You can use it without an account',
        b: 'Every trip lives on your device first, so the app works with no signal on day four. "Continue without an account" on the front door gets you straight in.',
      },
      {
        t: 'An account is a second home for your trips',
        b: 'Sign up with an email and password and your whole trip library backs up to the cloud and restores on a new phone. This is the one failure the app cannot survive on its own: deleting the app deletes the roadbook. Settings → Account, any time.',
      },
      {
        t: 'Open a trip and look around',
        b: 'Tap a trip card on the home screen. The bar at the bottom (PLAN · PREP · ▶ RIDE) switches the three parts. The strip of dates under the header is the day index — tap a date to open that day, tap TRIP to get back to the whole-trip view.',
      },
    ],
    tips: [
      'The app installs to a phone home screen from the browser share menu. It runs full-screen and keeps working offline.',
      'Nothing you do is destructive without a confirmation, and Undo sits in the header.',
    ],
  },
  {
    id: 'build-ai',
    title: 'Build a trip with the AI builder',
    icon: '✦',
    blurb: 'A conversation and a route workbench — it researches real places and measures real roads before you commit.',
    video: { src: '/guide/build-ai.mp4', poster: '/guide/build-ai.jpg', length: '2:30' },
    steps: [
      {
        t: 'Open New trip → AI builder',
        b: 'From the home screen, type what you want in "Where do you want to ride?", or press New trip and pick the AI builder tab.',
      },
      {
        t: 'Fill in the frame first',
        b: 'Name, start date, number of days, number of riders — plus two route settings that matter more than they look: Roads (Quick / Touring / Back roads) and Avoid tolls. Those two ride into every route the builder measures, and they are written onto the trip it creates.',
      },
      {
        t: 'Describe the ride in your own words',
        b: 'Where you are starting, what you want to see, how hard you want to push. "Four days out of Missoula, big scenery, no interstate slogs, easy 250-mile days" is plenty.',
      },
      {
        t: 'Read the options it comes back with',
        b: 'It searches Google Places for real businesses and routes each concept through the Valhalla motorcycle router. Each option carries measured miles, riding time at your group pace, arrival times, fuel gap against your bike range, and the detour cost of each stop — not estimates from memory.',
      },
      {
        t: 'Verified vs unverified is on the card',
        b: 'A stop found in Places shows its rating, hours, address, phone and a Maps link. A stop the model named but could not verify is marked. That distinction exists because a recalled gas station grades clean in the fuel engine and is discovered at a quarter tank.',
      },
      {
        t: 'Refine instead of regenerating',
        b: 'Every option can be pushed on: replace a stop, keep the roads but change the stops, keep the stops but change the roads, or shorten the day. Each refinement is researched and routed again. Nothing is generated twice from scratch.',
      },
      {
        t: 'Confirm creates the trip',
        b: 'Only a selected option plus "Create this trip" writes anything. Until then you are in a workbench, not a draft.',
      },
    ],
    tips: [
      'The builder narrates as it works — searching places, routing options — and the counter is live server time, not a spinner. A long turn is normal: it is running real searches and real route evaluations.',
      'Progress is kept if you wander off to the Blank or Template tab and come back.',
    ],
  },
  {
    id: 'plan',
    title: 'Plan mode — days, stops, and the map',
    icon: '⌖',
    blurb: 'The map room. Everything the engine grades has an input here.',
    video: { src: '/guide/plan.mp4', poster: '/guide/plan.jpg', length: '2:00' },
    steps: [
      {
        t: 'The date strip is the index',
        b: 'One chip per day — weekday, date, a phase colour on the bottom edge, a grade dot when the day scores below an A, a ★ when the day is anchored. A whole eleven-day trip fits one phone row. Tap TRIP at the left end for the whole-trip view.',
      },
      {
        t: 'Reorder days from the trip overview',
        b: 'In the TRIP view each day is a row. Grab the ⠿ grip on its left edge to drag it up or down; tapping the row itself opens that day. Dates stay pinned to the calendar — the content moves, so day three is always day three\'s date.',
      },
      {
        t: 'A day panel is the day\'s whole truth',
        b: 'Departure time, phase, anchor, every stop in order with arrival times and leg miles, meals, lodging, photo stops, hard gates and constraint notes. Tap the mileage figures on a stop row to zoom the map to that leg.',
      },
      {
        t: 'Add a stop',
        b: 'Use the search box in the day panel — results come from Google Places and carry the place identity, so routing aims at the business rather than a pin in its car park. New stops are inserted by ROUTE order, not by straight-line distance, so a stop on a loop day lands in the leg it actually belongs to.',
      },
      {
        t: 'Edit a stop',
        b: 'Each row opens an editor: name, coordinates, kind (start / via / fuel / photo / end), dwell minutes, notes. Marking a stop as fuel puts it into the fuel-gap math. Dwell minutes flow straight into the arrival times below it.',
      },
      {
        t: 'Hard gates are deadlines the engine enforces',
        b: 'A ferry, a timed tour, a booked dinner. Add one to a stop with the time it must be met, and the timeline grades the day against it and Ride Mode shows your margin.',
      },
      {
        t: 'Warnings are calls to action',
        b: 'Long days, fuel gaps beyond your bike range, after-dark arrivals, a day starting more than two miles from where the last one ended. Each one names the stop or leg it came from.',
      },
    ],
    tips: [
      'On a phone the panel slides over the map. Tap PLAN again, or the chevron handle on the panel edge, to get the bare map back.',
      'Bike range, group pace buffer, dusk time and time zone live in Trip settings at the bottom of the trip overview. The engine uses those numbers — it never assumes a 180-mile tank.',
    ],
  },
  {
    id: 'route',
    title: 'Shaping the route',
    icon: '⟋',
    blurb: 'Change the character of every road, or reach in and move one line.',
    video: { src: '/guide/route.mp4', poster: '/guide/route.jpg', length: '1:45' },
    steps: [
      {
        t: 'Route character is a trip-wide setting',
        b: 'Trip settings → Route character: Quick, Touring, or Back roads, plus Avoid tolls. It is the same choice the whole crew rides on a shared trip.',
      },
      {
        t: 'After a trip exists, changing it is a protected replan',
        b: 'Nothing changes the instant you click. Every day is routed into a draft, the proposed line is overlaid on the map, and you get the comparison: miles, time, feasibility, and any new warnings. Booked lodging and timed commitments are locked.',
      },
      {
        t: 'Then you choose',
        b: 'Cancel, Keep every stop (one undoable change), or Find better-fit stops — which hands the constraints to Copilot so it can propose replacements for the flexible stops while holding your beds, overnight cities and gates.',
      },
      {
        t: 'Drag the route line to move it',
        b: 'On a desktop, grab the selected day\'s line and pull it where the road should go. A dashed band shows the reshaped leg; drop it and the point becomes a real stop in the correct leg — even on a day that doubles back on itself.',
      },
      {
        t: 'On a phone, tap the line',
        b: 'Tapping the route of the day you are editing opens a wheel at that point. Drag the grip to say where the road should go, then confirm with ✓ (or ✕ to cancel, ⓘ for leg details). Adjusting and confirming are separate acts, so a stray touch can never edit the day.',
      },
      {
        t: 'Avoid tolls is the lever for river crossings',
        b: 'If a route dives through a tolled tunnel or bridge to reach somewhere on your own side of the water, that is the router\'s cost model, not a decision anyone made. Turn Avoid tolls on and re-plan.',
      },
    ],
    tips: [
      'Dragging a map marker or typing coordinates by hand clears the stop\'s Google identity on purpose: a deliberate pin means that exact coordinate.',
      'Route lines are cached until the stops or the route settings move, so replanning a big trip is fast the second time.',
    ],
  },
  {
    id: 'copilot',
    title: 'Copilot — the AI that edits the trip',
    icon: '✦',
    blurb: 'One door, everywhere in the app. It proposes; you apply.',
    video: { src: '/guide/copilot.mp4', poster: '/guide/copilot.jpg', length: '1:30' },
    steps: [
      {
        t: 'Open the dock',
        b: 'The floating ✦ button on the PLAN and PREP screens. A dot on it means a proposal is waiting.',
      },
      {
        t: 'Ask in plain language',
        b: '"Day 4 is too long — find me a bed two hours earlier", "add a good breakfast stop before the Beartooth", "we lost a rider, re-time everything from Cody".',
      },
      {
        t: 'It answers with a proposal, not an edit',
        b: 'You get prose plus a list of the exact changes it wants to make, in the app\'s own vocabulary — add this stop, move that day, set this departure. Apply it, or don\'t. Applied changes go on the undo stack like any other edit.',
      },
      {
        t: 'It reasons from the real numbers',
        b: 'Every request carries the routed mileage, the simulated timeline, the feasibility grades and the warnings — so "too long" means the measured day, not a guess.',
      },
      {
        t: 'It verifies the places it names',
        b: 'Fuel stops, lodging and restaurants in a proposal are looked up against Google Places after the model answers, and the reply tells you what was corrected.',
      },
      {
        t: 'Shortcuts into it',
        b: 'The PREP grade hero has "Ask the AI to fix it". A day panel has "✦ Ask Copilot" about that day, and "Find route opportunities" to search along the corridor you are already riding.',
      },
    ],
    tips: [
      'Ask for a variant and it can save the result as a separate Plan instead of overwriting today\'s: "give me a lower-mileage version, save it as Relaxed".',
      'Chat history is kept per trip, so a conversation you left last week is still there.',
    ],
  },
  {
    id: 'plans',
    title: 'Plans — saved versions of the trip',
    icon: '❒',
    blurb: 'Try a different idea without losing the one you have.',
    video: { src: '/guide/plans.mp4', poster: '/guide/plans.jpg', length: '1:10' },
    steps: [
      {
        t: 'The Plans strip sits at the top of the trip overview',
        b: 'A lit "Current" chip means you are on the working plan and nothing is saved yet. Tap it to name and save a snapshot.',
      },
      {
        t: 'A dot on the active chip means drift',
        b: 'You have edited since that plan was saved. Tapping the chip offers Update (write the edits into it) or Delete.',
      },
      {
        t: 'Loading a plan never loses your work',
        b: 'If the working plan matches no saved snapshot it is auto-stashed first. It is never a one-way door.',
      },
      {
        t: 'On a shared trip, loading forks the question',
        b: 'Every load door asks it plainly: "Load for the group" pushes the swap to every rider through the sync log, or "Just me — new trip" forks a personal copy and leaves the crew\'s plan alone.',
      },
      {
        t: 'Duplicate trip is the safe way to experiment',
        b: 'The ⑂ chip clones the current working trip into a separate, unshared trip in your library.',
      },
    ],
    tips: ['A day panel carries the same strip as a one-line pill, so you always know which plan you are looking at.'],
  },
  {
    id: 'templates',
    title: 'Templates — reuse a plan, or share it',
    icon: '❒',
    blurb: 'Keep a trip as a starting point, lay its days into another trip, or hand it to a friend as a file.',
    video: { src: '/guide/templates.mp4', poster: '/guide/templates.jpg', length: '1:20' },
    steps: [
      {
        t: 'Save any trip as a template',
        b: 'Open the trip, go to the TRIP overview, and in Trip settings press "Save as template". Name it for what it is — "Sturgis — early exit from Red Lodge" — and it lands on the home screen under Your templates. You stay in the trip you were in.',
      },
      {
        t: 'What a template keeps, and what it deliberately drops',
        b: 'Every day, stop, gate, meal, module and note travels. Booking state does not: nothing arrives marked as confirmed, because a copied plan claiming a bed nobody booked is the one lie a planning tool must not tell.',
      },
      {
        t: 'Start a new trip from one',
        b: 'Home → the template card, or New trip → the Template tab, which lists the bundled Sturgis trip alongside your own. Give it a name and a start date; every date re-pins from that day and every stop gets fresh identity, so the new trip and the template can be edited apart.',
      },
      {
        t: 'Or lay just some of its days into a trip you already have',
        b: 'This is the "use it on top of" case. In the TRIP overview, under Days, press "＋ Days from a template", pick the template, tick the days you want, and say where they go. It is one undoable change, and the calendar re-pins — inserted days take the slots they land in rather than dragging their old dates along.',
      },
      {
        t: 'Share it with a friend',
        b: 'Press Share on a template card and you get a .json file. Send it however you like; they open Roadbook → Import JSON and it lands on their shelf as a template, ready to copy. No account, no join code, no signal needed at either end.',
      },
      {
        t: 'Templates back up with your account',
        b: 'They ride along with the trip library, so signing in on a new phone brings your templates with your trips.',
      },
    ],
    tips: [
      'A template is a snapshot, not a link: editing the trip it came from does not change the template, and trips already made from it are untouched if you delete it.',
      'Sharing a template gives someone a copy to edit. To plan the SAME trip together in real time, share the trip itself with a join code — see "Ride with a crew".',
    ],
  },
  {
    id: 'prep',
    title: 'Prep — get the trip actually ready',
    icon: '☑',
    blurb: 'The map-less status board: grade, bookings, packing, budget, crew.',
    video: { src: '/guide/prep.mp4', poster: '/guide/prep.jpg', length: '1:20' },
    steps: [
      {
        t: 'The grade hero is the headline',
        b: 'A letter grade for the trip with its top issues listed underneath, and a button that hands them to Copilot. During a trip it grades only the days that are left.',
      },
      {
        t: 'Feasibility',
        b: 'Every day scored on miles, hours in the saddle, dwell, gates and daylight, with the warnings that produced the score. Tap through to the day to fix it.',
      },
      {
        t: 'Bookings',
        b: 'A checklist of what has to be reserved — beds, tours, ferries — that you add to and tick off. Ticking lodging as booked also locks it against replans.',
      },
      {
        t: 'Packing and budget',
        b: 'A packing list you can edit, and a budget estimate built from the trip\'s own nights, miles and fuel numbers.',
      },
      {
        t: 'Crew',
        b: 'Who is riding, sharing and invites — see the next chapter.',
      },
    ],
    tips: ['Entering a trip while it is running lands you on today automatically, and ridden days go quiet in the strip.'],
  },
  {
    id: 'ride',
    title: 'Ride mode',
    icon: '▶',
    blurb: 'Turn-by-turn built for a bike, with the plan riding along.',
    video: { src: '/guide/ride.mp4', poster: '/guide/ride.jpg', length: '2:15' },
    steps: [
      {
        t: 'Press ▶ RIDE',
        b: 'Full-screen navigation for the selected day: chase camera, heading puck matched to the road, cased route line that dims behind you and stays bright to your next stop.',
      },
      {
        t: 'The bottom bar leads with the leg you are on',
        b: 'Time remaining in this leg, then leg ETA and leg miles, with the whole day\'s figure pinned right, then the next stop. Tap the bar for the ride sheet.',
      },
      {
        t: 'The plan-aware chips are the part Google cannot do',
        b: 'Fuel-range countdown against your bike\'s comfortable range (it turns red past it) and your margin to the next hard gate. Dismiss a gate chip with its ✕; the fuel chip stays, because range is safety-critical.',
      },
      {
        t: 'Voice',
        b: 'Announcements at a mile, a quarter mile, and at the turn, plus arrivals and reroutes. The mute button is one tap. On an iPhone the first tap anywhere unlocks audio — and audio rides the media channel, so the silent switch will not kill it.',
      },
      {
        t: 'Skip, restore, go next',
        b: 'The ride sheet lists the stops ahead. Skip one and navigation stops dragging you back to it. Pass one accidentally and it auto-skips with a 60-second undo chip. "Go next" jumps to the following stop. A skipped fuel stop drops out of the fuel math.',
      },
      {
        t: 'It reroutes when you leave the line',
        b: 'Off route by about a tenth of a mile for three fixes and it re-routes from where you are, to the stops you have left, with your trip\'s own road preferences. Traffic is used to correct the ETA, never to quietly re-cut your route.',
      },
      {
        t: 'Add a stop mid-ride',
        b: 'The magnifier searches near the bike. Adding slots the stop geographically among the stops you have left, re-routes, and says so.',
      },
      {
        t: 'Know the limits',
        b: 'The tab has to stay in the foreground — there is no background GPS — and there are no offline tiles yet, so cache-warming only runs ahead of you while you have signal. Mount the phone and keep it awake; the screen lock is held while Ride is open.',
      },
    ],
    tips: [
      'The compass fab flips track-up and north-up. Pinch to zoom and it holds your zoom for about twelve seconds before breathing back.',
      'Posted speed limits come from OpenStreetMap and appear as a sign at the bottom-left when the road actually carries a limit tag.',
    ],
  },
  {
    id: 'crew',
    title: 'Ride with a crew',
    icon: '⚑',
    blurb: 'One shared plan, a road-captain\'s call, and no email required.',
    video: { src: '/guide/crew.mp4', poster: '/guide/crew.jpg', length: '1:30' },
    steps: [
      {
        t: 'Share the trip',
        b: 'PREP → Crew → share. You get a join code and a link. Riders type a name and join — no account, no confirmation email, works standing in a car park.',
      },
      {
        t: 'The captain owns the plan',
        b: 'The captain\'s working trip is the group plan and pushes automatically. Riders receive it and adopt it silently while they have no edits of their own.',
      },
      {
        t: 'A rider\'s edits are a sandbox',
        b: 'Changes a rider makes stack up locally and ship as a proposal — the same preview the AI produces. The captain applies or declines it.',
      },
      {
        t: 'Call the vote when it matters',
        b: 'Draft → review (riders vote in or raise a concern, with notes) → published. The tally is advisory; the call is the captain\'s. A published plan can be reopened.',
      },
      {
        t: 'A rider can always fork',
        b: 'Duplicate trip makes a private copy of the current plan that no longer follows the group.',
      },
    ],
    tips: [
      'The join code is a trip credential, not an account. Anyone with the code can see and edit the shared trip, so treat it like a door key.',
      'Two riders editing the same field at the same time resolve last-write-wins, not merged. Undo never reverts a co-rider\'s edit.',
    ],
  },
  {
    id: 'files',
    title: 'Exports, backup, and getting trips out',
    icon: '⇪',
    blurb: 'GPX to the GPS, ICS to the calendar, JSON to a friend.',
    video: { src: '/guide/files.mp4', poster: '/guide/files.jpg', length: '0:50' },
    steps: [
      { t: 'GPX', b: 'A day exports as GPX for a GPS or another nav app. Waypoint names carry the planned arrival times, so it doubles as a schedule check.' },
      { t: 'ICS', b: 'The trip exports to a calendar file. Set the trip\'s time zone in Trip settings first — the export uses it.' },
      { t: 'JSON', b: 'The whole trip, exactly as the app holds it. Import always creates a NEW trip rather than overwriting the one you are in, so a file from a friend can never eat your work.' },
      { t: 'Templates', b: 'A saved template exports as a .json file from its card on the home screen, and imports as a template on the other end — the simplest way to hand a whole plan to a friend. See the Templates chapter.' },
      { t: 'Cloud backup', b: 'With an account, the library backs up automatically and merges rather than overwrites when you sign in on a new device: the newer edit of a trip wins, and a trip you deleted stays deleted unless it was edited elsewhere afterwards.' },
    ],
    tips: ['The bundled Sturgis trip is a template, not your data — it is dropped rather than uploaded if you never edited it.'],
  },
  {
    id: 'trouble',
    title: 'When something looks wrong',
    icon: '⚠',
    blurb: 'The honest answers to the things that surprise people.',
    video: null,
    steps: [
      { t: 'A route went somewhere strange', b: 'The AI picks the places; the router picks the roads. If the line takes a tolled crossing or a city centre, change Route character or turn on Avoid tolls and re-plan — no prompt will out-argue a router\'s cost model.' },
      { t: 'A stop is flagged unverified', b: 'It means we searched Google Places and did not find it, not that it is definitely wrong. Re-pick it from search and the coordinates and identity are fixed.' },
      { t: 'Ride mode stopped following me', b: 'The tab has to be in front and the screen awake. If you panned the map, the re-centre pill brings you back; it also self-heals about twelve seconds after you stop touching it while you are moving.' },
      { t: 'A number looks off after an edit', b: 'Miles, times and grades are recomputed from the routed line, not from what was typed. If a day\'s written description no longer matches its stops, the panel flags it and offers to rewrite it.' },
      { t: 'My trips vanished', b: 'Trips live on the device unless you have an account. If the app was deleted or site data cleared without one, they are gone — which is the whole argument for signing up. If you do have an account, sign in and the library pulls back down.' },
      { t: 'A rider is not seeing the group plan', b: 'Have them leave the trip and rejoin with the code. The join path always adopts the current group snapshot.' },
    ],
    tips: [],
  },
];

export function findChapter(id) {
  return CHAPTERS.find((c) => c.id === id) ?? null;
}

// Plain-text haystack per chapter, for the guide's filter box.
export function searchChapters(q) {
  const needle = q.trim().toLowerCase();
  if (!needle) return CHAPTERS;
  return CHAPTERS.filter((c) => {
    const hay = [c.title, c.blurb, ...c.steps.flatMap((s) => [s.t, s.b]), ...(c.tips ?? [])]
      .join(' ').toLowerCase();
    return hay.includes(needle);
  });
}
