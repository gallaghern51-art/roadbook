// The early exit off the rally — the owner's own four-day variant, recovered
// from the shared Sturgis trip's op log and bundled as a second built-in
// template (owner, Sep 13 2026: "share the early exit template that has
// correct locations"). Every stop goes through tools/verify-seed.mjs like the
// field guide; the verified places live in earlyExitPlaces.js.
import { applySeedPlaces } from './seedTrip.js';
import { EARLY_EXIT_PLACES } from './earlyExitPlaces.js';

export const EARLY_EXIT_TRIP = {
  meta: {
    title: 'Early Exit — Sturgis to Missoula',
    subtitle: 'Lead · Bighorn Scenic Byway · Red Lodge · Beartooth · Lamar Valley · Bozeman · Missoula',
    summary: 'Leave the rally on Thursday and take the long, good way home: out of Lead on I-90 to Gillette for the mandatory fill, west over the Bighorn Scenic Byway (US-14 through Burgess Junction, ~9,000 ft) down to Shell, then Lovell and Belfry on MT-72 into Red Lodge, staying off I-90 and west of Billings. Friday is Beartooth Pass at dawn, Cooke City, the Lamar Valley wildlife corridor, Mammoth and Gardiner, then Livingston into Bozeman. A short I-90 transfer to Missoula on Saturday, and Sunday is the bike return and an afternoon flight. Built for one rider; scales to a group. Copy it onto a Sturgis trip, or ride it on its own.',
    templateNote: 'four days · the long way home from the rally, fuel and beds on every day',
    startDate: '2026-08-13',
    riders: 1,
    pace: 1,
    range: { mpg: 45, comfort: 180, absolute: 200 },
    fuelRule: 'fill at half tank on long stretches',
    roster: [],
  },
  days: [
    {
      id: 'sd1', dow: 'Thu', date: '2026-08-13', title: 'Lead → Red Lodge', phase: 'return',
      miles: 0, hours: 0, depart: '7:00 AM', arrive: '', anchor: false,
      summary: 'Interstate to Gillette for mandatory fuel, then west through the Bighorns via US-14 and Burgess Junction — the Bighorn Scenic Byway summit crossing — down to Shell, north through Lovell and Belfry on MT-72 into Red Lodge, staying west of Billings and off I-90.',
      constraints: [], gates: [], photos: [], modules: [], ops: [],
      meals: [
        { meal: 'lunch', name: 'Shell, WY roadside stop', where: 'Shell, WY', note: 'Bottom of the Bighorn descent — the honest lunch stop at that mile marker.', alt: '' },
        { meal: 'dinner', name: 'Carbon County Steakhouse', where: '121 W 11th St, Red Lodge', note: 'Montana beef, restored 1890s building.', alt: '' },
      ],
      lodging: { status: 'reserve', name: 'The Pollard Hotel, Red Lodge', where: 'Red Lodge, MT', note: 'One night — the solo run' },
      waypoints: [
        { id: 'sd1w0', kind: 'start', name: 'Cozy Court, Lead SD', lat: 44.3167185, lng: -103.7948687, mile: 0, note: 'Depart 7:00 AM. US-85 N to I-90 W toward Gillette.' },
        { id: 'sd1w1', kind: 'fuel', fuel: true, name: 'Flying J Travel Center — Gillette, WY', lat: 44.27744622588, lng: -105.4947627963214, mile: null, dwell: 15, note: 'Mandatory fuel — long stretch ahead through the Bighorns.' },
        { id: 'sd1w2', kind: 'via', fuel: true, name: 'Ranchester, WY', lat: 44.90838745848748, lng: -107.16984419260105, mile: null, dwell: 5, note: 'Left onto US-14 W — Bighorn Scenic Byway begins.' },
        { id: 'sd1w3', kind: 'photo', name: 'Burgess Junction', lat: 44.7699635, lng: -107.5198092, mile: null, note: 'Bighorn NF summit, ~9,000 ft. Cool even in August.' },
        { id: 'sd1w4', kind: 'via', name: 'Shell, WY', lat: 44.5391, lng: -107.7784, mile: null, note: 'Bottom of the descent. Lunch.' },
        { id: 'sd1w5', kind: 'via', name: 'Lovell, WY', lat: 44.8374532, lng: -108.3895614, mile: null, note: 'US-310 N, staying west of Billings.' },
        { id: 'sd1w6', kind: 'fuel', fuel: true, name: 'Belfry, MT', lat: 45.1418915, lng: -109.0054219, mile: null, note: 'Fuel before the final run — MT-72 into Red Lodge, no I-90/Billings.' },
        { id: 'sd1w7', kind: 'end', name: 'Red Lodge, MT', lat: 45.1866, lng: -109.2468, mile: null, note: 'Arrive via MT-72/US-212, Beartooth front rising ahead.' },
      ],
    },
    {
      id: 'sd2', dow: 'Fri', date: '2026-08-14', title: 'Red Lodge → Beartooth → Cooke City → Lamar Valley → Bozeman', phase: 'return',
      miles: 0, hours: 0, depart: '7:00 AM', arrive: '', anchor: false,
      summary: "Beartooth Pass at dawn, continuing west into Yellowstone's NE Entrance — Cooke City, the Lamar Valley wildlife corridor, Mammoth, Gardiner, then Livingston and I-90 into Bozeman.",
      constraints: [], gates: [], photos: [], modules: [], ops: [],
      meals: [
        { meal: 'lunch', name: 'Cooke City or trail snacks', where: 'Cooke City, MT', note: 'Services are thin — grab something in Cooke City before the park.', alt: '' },
        { meal: 'dinner', name: 'Downtown Bozeman, pick on arrival', where: 'Bozeman, MT', note: 'Montana Ale Works or similar — no reservation needed', alt: '' },
      ],
      lodging: { status: 'reserve', name: 'AC Hotel Bozeman Downtown', where: 'Bozeman, MT', note: 'Overnight, easy downtown access' },
      waypoints: [
        { id: 'sd2w0', kind: 'start', name: 'Red Lodge, MT', lat: 45.1866, lng: -109.2468, mile: 0, note: 'Depart 7:00 AM sharp. Thermal layers on. US-212 over Beartooth Pass.' },
        { id: 'sd2w1', kind: 'photo', name: 'Beartooth Pass summit, 10,947 ft', lat: 44.97, lng: -109.4665, mile: null, note: 'Alpine tundra, 38–45°F — full gear.' },
        { id: 'sd2w2', kind: 'fuel', fuel: true, name: 'Cooke City, MT', lat: 45.0089, lng: -109.9542, mile: null, dwell: 10, note: 'Fuel before the park entrance.' },
        { id: 'sd2w3', kind: 'photo', name: 'Lamar Valley, Yellowstone NP', lat: 44.9042, lng: -110.2098, mile: null, dwell: 90, note: 'Best wildlife corridor in the park — bison, budget real time here, not just miles.' },
        { id: 'sd2w4', kind: 'photo', name: 'Mammoth Hot Springs', lat: 44.9767, lng: -110.7031, mile: null, note: 'Terraces, quick stop.' },
        { id: 'sd2w5', kind: 'via', name: 'Gardiner, MT', lat: 45.0326, lng: -110.7006, mile: null, note: 'North entrance exit.' },
        { id: 'sd2w6', kind: 'fuel', fuel: true, name: 'Livingston, MT', lat: 45.6621, lng: -110.5605, mile: null, note: 'Fuel before Bozeman. US-89 N to I-90 W.' },
        { id: 'sd2w7', kind: 'end', name: 'Bozeman, MT', lat: 45.677, lng: -111.0429, mile: null, note: 'Overnight Bozeman.' },
      ],
    },
    {
      id: 'sd3', dow: 'Sat', date: '2026-08-15', title: 'Bozeman → Missoula', phase: 'return',
      miles: 0, hours: 0, depart: '9:00 AM', arrive: '', anchor: false,
      summary: 'Short transfer day, I-90 West through Butte to Missoula. Overnight, tanks not yet full.',
      constraints: [], gates: [], photos: [], modules: [], ops: [],
      meals: [{ meal: 'dinner', name: 'Missoula, casual', where: 'Missoula, MT', note: 'Last night — keep it easy.', alt: '' }],
      lodging: { status: 'reserve', name: 'Fairfield by Marriott Inn & Suites Missoula Airport', where: 'Missoula, MT', note: 'Near the dealer and MSO for an easy Sunday morning' },
      waypoints: [
        { id: 'sd3w0', kind: 'start', name: 'Bozeman, MT', lat: 45.677, lng: -111.0429, mile: 0, note: 'Depart 9:00 AM, I-90 West.' },
        { id: 'sd3w1', kind: 'fuel', fuel: true, name: 'Town Pump — Butte, MT', lat: 46.0050873, lng: -112.6118671, mile: null, note: '1000 Grizzly Trail. Splash-and-go.' },
        { id: 'sd3w2', kind: 'end', name: 'Missoula, MT', lat: 46.8701, lng: -113.9953, mile: null, note: 'Overnight Missoula.' },
      ],
    },
    {
      id: 'sd4', dow: 'Sun', date: '2026-08-16', title: 'Missoula · Bike Return · Fly PM', phase: 'return',
      miles: 0, hours: 0, depart: '9:00 AM', arrive: '', anchor: false,
      summary: 'Close-out: fill the tank, dealer drop-off, MSO for an afternoon flight — no early-morning gate pressure.',
      constraints: [], gates: [], photos: [], modules: [], ops: [],
      meals: [{ meal: 'breakfast', name: 'Missoula hotel or coffee downtown', where: 'Missoula, MT', note: 'Quick — flight is early afternoon.', alt: '' }],
      lodging: { status: 'none', name: 'Fly home', where: 'MSO', note: 'MSO, afternoon departure.' },
      waypoints: [
        { id: 'sd4w0', kind: 'start', name: 'Missoula, MT', lat: 46.8701, lng: -113.9953, mile: 0, note: 'Depart 9:00 AM.' },
        { id: 'sd4w1', kind: 'fuel', fuel: true, name: 'Cenex Zip Trip — Missoula, MT', lat: 46.8781912, lng: -114.0134015, mile: null, note: '1540 Toole Ave. Fill the tanks — the contract requires full before the dealer.' },
        { id: 'sd4w2', kind: 'end', name: 'Grizzly Harley-Davidson', lat: 46.9179, lng: -114.048, mile: null, note: '5106 Grizzly Ct. Bike return. Arrive late morning, ample margin for a PM flight.' },
      ],
    },
  ],
  reserveNow: [
    { id: 'sr1', done: false, name: 'The Pollard Hotel, Red Lodge — Thu', note: 'One night', when: '2026-08-13', where: 'Red Lodge, MT' },
    { id: 'sr2', done: false, name: 'AC Hotel Bozeman Downtown — Fri', note: 'Overnight', when: '2026-08-14', where: 'Bozeman, MT' },
    { id: 'sr3', done: false, name: 'Fairfield Missoula Airport — Sat', note: 'Near the dealer and MSO', when: '2026-08-15', where: 'Missoula, MT' },
  ],
};
applySeedPlaces(EARLY_EXIT_TRIP, EARLY_EXIT_PLACES);
