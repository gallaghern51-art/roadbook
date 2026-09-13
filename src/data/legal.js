// Roadbook's legal pages. Roadbook is a product of Calaf, Inc. (a Delaware
// corporation); the corporate facts below match Calaf's own legal pages and
// are written down in one place. Like the guide, this prose is English-only:
// it is neither chrome (the ES dictionary) nor trip content.
//
// Every statement about data here describes what the app ACTUALLY does — the
// Sep 13, 2026 data-flow audit of src/ and netlify/. Change the code, change
// the words.

export const COMPANY = 'Calaf, Inc.';
export const POSTAL_ADDRESS = '169 Madison Ave STE 51707, New York, NY 10016, United States';
export const REGISTERED_AGENT = 'Legalinc Corporate Services Inc., 131 Continental Dr, Suite 305, Newark, DE 19713, United States';
export const SUPPORT = 'support@calaf.ai';
export const LEGAL_EFFECTIVE_DATE = 'September 13, 2026';
export const SITE = 'roadbook-app.netlify.app';

// [{ h, p: [paragraphs], ul: [items] }]
export const PRIVACY = {
  title: 'Privacy Policy',
  intro: `This Privacy Policy describes how ${COMPANY}, a Delaware corporation (“Calaf”, “we”, or “us”), collects, uses, shares and protects information when you use Roadbook — the app at ${SITE}, installed to a home screen, and the services behind it. Roadbook is built to keep your riding on your own device first; this page says exactly where anything leaves it.`,
  sections: [
    { h: 'What Roadbook keeps on your device', p: [
      'Your trips, plans, templates, settings, quick rides, chat history with the Copilot and cached routes live in your browser’s local storage on this device. Without an account, nothing about your trips is sent to us or stored by us. Deleting the app, clearing the browser or losing the phone deletes them — which is the reason an account exists.',
    ] },
    { h: 'What we collect if you create an account', p: [
      'An account is optional. If you create one we store your email address, the name you enter for your crew, a password hash, and a backup of your trip library (trips, plans, templates, and your Copilot chat per trip) so it can be restored on another device. Your rider profile — saved places including a home address if you enter one, your bike, its range, pace and road-style preferences, and stated taste such as dietary needs — is stored with the account.',
      'Roadbook also records a small history of which places the AI planner offered you and which you selected, replaced or confirmed, keyed by the place’s Google identifier and broad tags we author. That history ranks later suggestions for you only. We do not copy live business details — names, ratings, hours, prices or addresses — from Google into our storage.',
      'Accounts, authentication and this storage run on Supabase. Authentication emails are sent through Resend from roadbook@calaf.ai.',
    ] },
    { h: 'Crews and shared trips', p: [
      'When you share a trip with a code, the trip’s contents — every stop, note, booking status and the name you entered — become visible to anyone who joins with that code, and their edits become visible to you. Sharing a trip creates a session on our authentication service even without an account. Do not put anything in a shared trip you would not want the whole crew to see.',
    ] },
    { h: 'Location', p: [
      'Ride Mode reads your device’s location to navigate. Fixes are processed on your device. Your current coordinates and heading are sent to routing providers only when the app needs a route from where you are: a live reroute, a traffic-aware arrival estimate, or a search for places ahead of you. We do not record or store your location history.',
    ] },
    { h: 'The AI planner', p: [
      'When you plan or edit with the AI, the text you type, your trip (stops, dates, constraints, riders, range, preferences) and the conversation so far are sent through our servers to Anthropic, whose model produces the answer, under Anthropic’s commercial API terms. Do not include information in a planning conversation that you do not want processed by that service. The planner also looks places up on your behalf (below).',
    ] },
    { h: 'Service providers that receive data to make the app work', ul: [
      'Mapbox — draws the maps. Map loads send your device’s IP address and the map area you view to Mapbox; the Mapbox map library also reports anonymous usage telemetry to Mapbox.',
      'Google — verifies places and, for traffic-aware arrival times, routes. Place searches send the search text and the coordinates being searched around; route requests send the coordinates of the stops.',
      'Valhalla (a public instance run by FOSSGIS on OpenStreetMap data) and OSRM — route your days and turn-by-turn directions. They receive the coordinates of your stops and, when rerouting, your current position.',
      'OpenStreetMap services (Overpass, Nominatim) — posted speed limits near your position in Ride Mode and address search. Open-Meteo — weather along your route, from the route’s coordinates.',
      'Netlify — hosts the app and runs its server functions, with ordinary hosting logs. Wikimedia Commons — highway shield artwork.',
      'None of these providers receives your name or email from us. Each is bound by its own terms and privacy policy.',
    ] },
    { h: 'What we do not do', ul: [
      'No advertising, no ad networks, and no sale or rental of personal information.',
      'No third-party analytics and no tracking cookies. Roadbook uses local storage for your own data and a session token for your own login.',
      'No location history, no ride recording, and no access to your contacts, photos or other apps.',
    ] },
    { h: 'How we use information', p: [
      'To run the product: keep your library, restore it on a new device, plan and route trips, navigate, share trips with a crew and send the emails an account needs (confirmation, password reset, email change). To keep it safe: prevent abuse and enforce the Terms. To improve it: aggregate, non-identifying usage of features. We do not use your trips to train models.',
    ] },
    { h: 'Retention and deletion', p: [
      'Data on your device stays until you delete it or the app. Account data stays while the account exists. You can export any trip as a file from the app at any time. To delete your account and everything stored with it, email ' + SUPPORT + ' from the account’s address; we delete within 30 days except where the law requires us to keep a record.',
    ] },
    { h: 'Your rights', p: [
      'Depending on where you live you may have the right to access, correct, export, restrict or delete personal information, and to object to certain processing. Email ' + SUPPORT + ' and we will respond within the time the applicable law allows. We will not discriminate against you for exercising a right.',
    ] },
    { h: 'Security', p: [
      'Account data is transmitted over TLS and stored with row-level access rules that limit each account to its own records. No system is perfectly secure; keep your password private and tell us at ' + SUPPORT + ' if you believe your account has been accessed without permission.',
    ] },
    { h: 'Children', p: ['Roadbook is for licensed riders and is not directed to children under 18. We do not knowingly collect personal information from children.'] },
    { h: 'International use', p: ['Roadbook is operated from the United States and its providers process data there and elsewhere. By using it you consent to that transfer.'] },
    { h: 'Changes', p: ['We may update this Policy as the product or the law changes. The effective date at the top will change, and we will give additional notice when the law requires it.'] },
    { h: 'Contact', p: [`This Policy is issued by ${COMPANY}, a Delaware corporation, at ${POSTAL_ADDRESS}. For privacy questions, rights requests or complaints, email ${SUPPORT}. Legal process may be served through Calaf’s registered agent in Delaware: ${REGISTERED_AGENT}.`] },
  ],
};

export const TERMS = {
  title: 'Terms of Service',
  intro: `These Terms of Service are a binding agreement between you and ${COMPANY}, a Delaware corporation (“Calaf”, “we”, or “us”), governing your use of Roadbook — the app at ${SITE}, installed to a home screen, and the services behind it. By using Roadbook you accept these Terms and the Privacy Policy.`,
  sections: [
    { h: 'Who may use Roadbook', p: ['You must be at least 18 years old and legally able to enter this agreement. If you create an account you are responsible for keeping its password private and for everything done with it.'] },
    { h: 'Ride at your own risk', p: [
      'Roadbook plans and navigates motorcycle trips. It is an aid to your judgment, not a substitute for it. Roads, weather, closures, fuel availability, business hours and traffic change without notice, and any of the information Roadbook shows — routes, distances, times, grades, fuel gaps, arrival estimates, place details, speed limits and AI suggestions — can be wrong, out of date or incomplete. You are solely responsible for riding safely and lawfully: obey traffic laws and posted limits, do not operate the phone while the motorcycle is moving, mount the device securely, and verify anything you are relying on before you rely on it. Calaf does not warrant that a route is safe, legal, open, paved or suitable for your motorcycle or your skill.',
    ] },
    { h: 'AI-generated content', p: ['Trip plans, route options, place suggestions, day descriptions and Copilot proposals are generated by an AI model from the information you give it and from third-party data. They may be inaccurate, and the model may name a place that does not exist or is closed; Roadbook flags places it could not verify, but the check can fail. Nothing generated is professional, legal, safety or travel advice.'] },
    { h: 'Your content', p: ['You own the trips, notes and other content you create. You grant Calaf the license needed to store, back up, display, route, share with the crews you choose and otherwise operate Roadbook for you. When you share a trip by code or hand a template file to someone, you grant those people the right to view and copy it. Do not upload content you do not have the right to share, and do not put other people’s personal information in a trip without their permission.'] },
    { h: 'Acceptable use', ul: [
      'No use that violates a law, a third party’s rights, or a provider’s terms (including Google Maps Platform and Mapbox terms for the data they supply).',
      'No scraping, bulk extraction or automated querying of Roadbook or the place, map and routing data it displays; no reverse engineering except where the law permits it regardless of this term.',
      'No attempts to access other riders’ data, to defeat access controls, or to overload or disrupt the service.',
      'No use of the AI planner to generate content that is unlawful, harmful or abusive.',
    ] },
    { h: 'Third-party services', p: ['Roadbook is built on services from Mapbox, Google, Anthropic, Supabase, Netlify, Resend, OpenStreetMap contributors and public Valhalla and OSRM instances. Those services may change or become unavailable, which can degrade or interrupt Roadbook, and their content is subject to their own terms. Map data is © Mapbox and © OpenStreetMap contributors; place facts and photos are from Google.'] },
    { h: 'Accounts, sharing and offline use', p: ['Your library is stored on your device first; an account backs it up. Calaf is not responsible for data lost from a device without an account, or for edits made to a shared trip by other members of a crew. The join code is the credential for a shared trip: anyone you give it to can read and propose changes to that trip.'] },
    { h: 'Intellectual property', p: ['Roadbook — its software, design, written content, prompts and other materials — is owned by Calaf and its licensors and protected by intellectual-property law. These Terms grant you a personal, non-transferable, revocable license to use Roadbook as intended. No other license is granted. Highway shield artwork is used under its respective licenses.'] },
    { h: 'Termination', p: ['You may stop using Roadbook at any time and may ask us to delete your account. Calaf may suspend or terminate access when reasonably necessary to address a violation of these Terms, a legal demand, a security risk or harm. Provisions that by their nature should survive — ownership, disclaimers, limits of liability, indemnity, governing law — survive termination.'] },
    { h: 'Disclaimers', p: ['To the fullest extent permitted by law, Roadbook is provided “as is” and “as available”. Calaf disclaims implied warranties of merchantability, fitness for a particular purpose, title and non-infringement, and does not warrant that Roadbook will be accurate, uninterrupted, error-free or secure. Some jurisdictions do not permit certain disclaimers, so they apply only to the extent permitted by law.'] },
    { h: 'Limitation of liability', p: ['To the fullest extent permitted by law, Calaf and its suppliers will not be liable for indirect, incidental, special, consequential, exemplary or punitive damages, or for personal injury, property damage, lost time or lost data arising from your use of Roadbook or your reliance on anything it shows. To the fullest extent permitted by law, Calaf’s aggregate liability arising from or related to Roadbook will not exceed the greater of $100 or the amount you paid Calaf for Roadbook in the six months before the event giving rise to the claim.'] },
    { h: 'Indemnity', p: ['To the extent permitted by law, you will defend, indemnify and hold Calaf and its service providers harmless from third-party claims, damages, losses and reasonable costs arising from your riding, your content, your crew’s use of a trip you shared, or your violation of these Terms or of the law.'] },
    { h: 'Governing law and disputes', p: ['These Terms, and any dispute arising out of or relating to them or to Roadbook, are governed by the laws of the State of Delaware and applicable United States federal law, without regard to conflict-of-laws rules. Before filing a formal claim, you agree to send a description to ' + SUPPORT + ' and attempt in good faith to resolve the dispute for at least 30 days.'] },
    { h: 'Changes and notices', p: ['Calaf may update these Terms as the product or the law changes; the revised Terms will show a new effective date, and continuing to use Roadbook after they take effect means you accept them. Calaf communicates with you electronically: in the app, by email to your account address, and by posting notices on ' + SITE + '.'] },
    { h: 'Contact', p: [`Roadbook is operated by ${COMPANY}, a Delaware corporation, at ${POSTAL_ADDRESS}. Questions may be sent to ${SUPPORT}. Legal process may be served through Calaf’s registered agent in Delaware: ${REGISTERED_AGENT}.`] },
  ],
};
