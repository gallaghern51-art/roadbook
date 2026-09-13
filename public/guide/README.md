# Walkthrough videos

Drop a screen recording here and it appears in the in-app guide with no code
change. The guide (Home → "How to use Roadbook", Settings → About, or
`/#help`) names the file each chapter wants; until the file exists that chapter
shows a placeholder and its written directions, which are the guide either way.

| file | chapter |
|---|---|
| `start.mp4` | Start here |
| `build-ai.mp4` | Build a trip with the AI builder |
| `plan.mp4` | Plan mode — days, stops, and the map |
| `route.mp4` | Shaping the route |
| `copilot.mp4` | Copilot |
| `plans.mp4` | Plans — saved versions of the trip |
| `prep.mp4` | Prep |
| `ride.mp4` | Ride mode |
| `crew.mp4` | Ride with a crew |
| `files.mp4` | Exports, backup, and getting trips out |

An optional poster frame of the same name (`ride.jpg`) is used before play.

Recording convention — the repo's own QA widths:

* phone clips at 375×812, desktop clips at 1280×800
* MP4 (H.264 + AAC) or WebM, under about 8 MB, 30–90 seconds
* no narration needed; the written steps carry the words
* keep real account details, join codes and home addresses out of frame

A chapter can also point at a hosted clip instead: set its `video.src` in
`src/data/guide.js` to a YouTube or Vimeo *embed* URL and it renders in an
iframe. Local files are preferred — they work offline, which is the point of
the rest of the app.
