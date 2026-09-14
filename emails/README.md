# Roadbook emails

Hand-written HTML, inline styles, tables — the landing page's design (dark
asphalt, the Roadbook wordmark, one orange button, the chapters with their
instruments) rebuilt for mail clients. No images, so Gmail, Apple Mail and
Outlook render the same thing.

- `roadbook-invite.html` — the invitation ("Plan the ride. Then ride the
  plan."): the story the landing tells, addressed to one rider. Replace the
  greeting line and the sign-off before sending. Sent from
  `Roadbook <roadbook@calaf.ai>` through Resend.

The auth emails (confirmation, reset…) live in `supabase/templates/`.
