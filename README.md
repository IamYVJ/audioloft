# AudioLoft

**Trim, split and join audio in your browser. Nothing is uploaded.**

AudioLoft is a static site: every edit happens in the page, using the browser's
own Web Audio decoder and on-device encoders (WAV, MP3, AAC). There is no
backend and your audio never leaves the device, so it can be hosted on GitHub
Pages and keeps working offline once it has been opened.

---

## Tools

| Tool | What it does |
| --- | --- |
| **Studio** | A multitrack editor. Every file gets its own lane and lanes play at the same time, so tracks can be layered (voice over music) as well as placed one after another. Drag clips in time and between lanes, trim them by their edges, split at the playhead, duplicate, fade and set clip volume. Each lane has volume, pan, mute and solo. Snapping, undo / redo, and a "line up" helper that places a lane's clips end to end with a gap or crossfade. Export the mix, one stem per lane (ZIP), or every clip (ZIP). Sessions save themselves in the browser and can be reopened later. |
| **Trim** | Select a range on the waveform (drag, type exact times, or set from the playhead) and either keep it or cut it out. Fade in / out, normalize to −1 dB, loop the selection, preview the result before saving. |
| **Split** | Place split points by hand, every N seconds, into N equal parts, or in the middle of silent gaps. Drag points to adjust, name each part, play or download parts one by one, or download them all as a ZIP. Optional silence trimming and short fades at each cut. |
| **Join** | Add any number of files in any supported format, reorder by drag and drop or the ↑ / ↓ buttons, preview each one. Join with no gap, a silent gap, or an equal-power crossfade. Mixed sample rates and channel layouts are matched automatically. |

Every tool exports:

| Format | Options | How |
| --- | --- | --- |
| **WAV** | 16-bit, 24-bit, 32-bit float | Hand-written encoder, lossless |
| **MP3** | 128, 192, 256, 320 kbps (CBR) | [lamejs](https://github.com/zhuker/lamejs) in a Web Worker, so long exports don't freeze the page |
| **AAC (.m4a)** | 96, 128, 192, 256 kbps | The browser's WebCodecs `AudioEncoder`, packed into an MP4 container by a small built-in writer. Offered only where the browser can encode AAC (Chrome and Edge; Safari and Firefox vary) |

MP3 and AAC take mono or stereo at up to 48 kHz; anything else is mixed down or
resampled first. The chosen format is remembered in the browser for next time.

Every tool has a **demo track** button, so it can be tried without a file.

---

## Supported input

Anything the browser can decode: MP3, WAV, FLAC, OGG Vorbis, Opus, M4A / AAC,
WebM and (in Safari) AIFF / CAF. Files up to 500 MB.

Audio is decoded at the file's own sample rate where the format allows it
(WAV, AIFF, FLAC, Ogg, MP3 and ADTS AAC are read from the header), so a WAV
in and a WAV out are sample-identical apart from the edit itself.

---

## Using the editor

- **Click** the waveform to move the playhead. **Ctrl / ⌘ + scroll** zooms at
  the pointer; **Shift + scroll** (or a horizontal swipe) scrolls when zoomed.
- **Trim:** drag to select, drag the amber edges to adjust, double-click to
  select everything. `I` / `O` set start / end at the playhead, `P` plays the
  selection, `L` loops it.
- **Studio:** drag a clip sideways to move it in time, up or down to change
  lane, or by its edges to trim it (snapping to other clips and the playhead;
  hold Alt to place freely). Click the ruler or an empty spot to move the
  playhead. Selecting a clip opens it below on its whole source file for
  precise trimming and fades. `Space` plays the mix, `S` splits at the
  playhead, `D` duplicates, `Delete` removes, `[` / `]` step between clips,
  `Ctrl+Z` / `Ctrl+Shift+Z` undo and redo. A focused clip moves with the arrow
  keys (Shift for bigger steps). Drop files on a lane to add them there.
  Live playback and export use the same mixing graph, so the WAV matches what
  you heard.
- **Studio sessions** save on their own a moment after each change (`Ctrl+S`
  saves at once). Rename one with the name above the toolbar; **All sessions**
  closes it and lists everything saved, newest first, to open or delete.
  Sessions live in this browser's IndexedDB: the original files are stored as
  they were dropped and decoded again on open, and the demo is rebuilt from a
  recipe. Undo history isn't kept between visits. Clearing site data, or the
  browser running short of space, removes them, so export anything you need
  to keep.
- **Split:** double-click to add a split point, drag one to move it,
  double-click it to remove it. `M` splits at the playhead.
- `Space` plays / pauses. With the waveform focused, `←` / `→` nudge the
  playhead (hold Shift for finer steps) and `+` / `−` zoom.

---

## Privacy

- **Your audio never leaves the device.** There is no server-side code. Files
  are decoded, edited and encoded inside the tab, and saved Studio sessions are
  kept in the browser's own storage; open DevTools → Network
  while editing and no audio is sent anywhere.
- **One third-party request: a GoatCounter pageview count.** Each page loads
  [GoatCounter](https://www.goatcounter.com/)'s `count.js`, which records a
  cookie-free pageview (path, referrer, screen size) and reads back the
  "N visitors" number in the footer. It never sees your files. Adblockers
  block it, and the site works the same without it. Nothing else is loaded
  from elsewhere: no CDNs or fonts, and the lamejs MP3 encoder is vendored in
  `lib/`. Each page's Content-Security-Policy allows only this site plus
  `gc.zgo.at` and `yvj.goatcounter.com`.
- **Offline.** A service worker caches the site after the first visit, and the
  web app manifest makes it installable.

---

## Live

The site is published at `https://iamyvj.github.io/audioloft/`.

---

## Project structure

```
audioloft/
├── index.html            # Landing page
├── trim.html             # Trim tool
├── split.html            # Split tool
├── join.html             # Join tool
├── studio.html           # Multitrack studio (trim, split, join, layer)
├── css/style.css         # All styles (design tokens at the top)
├── js/
│   ├── audio-core.js     # Decode, edit (slice, cut, concat, fades, resample),
│   │                     # silence detection, WAV encoder, ZIP writer
│   ├── encoders.js       # Format picker; MP3 / AAC encoding; .m4a writer
│   ├── mp3-worker.js     # Runs lamejs off the main thread
│   ├── player.js         # Web Audio playback of a clip or a range
│   ├── waveform.js       # Canvas waveform: ruler, zoom, selection, markers
│   ├── ui.js             # Drop zones, toasts, busy overlay, shortcuts
│   ├── trim.js / split.js / join.js
│   ├── studio.js         # Multitrack session: lanes, clips, timeline, undo
│   ├── mixer.js          # Web Audio mix graph for live playback and export
│   ├── session-store.js  # Saved Studio sessions (IndexedDB)
│   ├── home.js           # Landing-page hero animation
│   ├── visitor-count.js  # "N visitors" footer note (GoatCounter read-back)
│   └── sw-register.js
├── sw.js                 # Offline cache (network first)
├── manifest.webmanifest
├── icons/                # icon.svg (favicon) and PNG app icons
├── scripts/check-sw.mjs  # `node scripts/check-sw.mjs`: worker never caches analytics
└── lib/lame.min.js       # lamejs 1.2.1 MP3 encoder (LGPL-3.0), vendored
```

---

## Limits

- Decoded audio is held in memory as 32-bit float, roughly 21 MB per minute of
  stereo at 44.1 kHz. Very long files (several hours) can exceed what a tab is
  allowed to use; AudioLoft refuses those up front instead of crashing.
- AAC export depends on the browser's built-in encoder, so it isn't offered
  everywhere. MP3 and WAV work in every supported browser.

---

## License

MIT, see [LICENSE](LICENSE).

`lib/lame.min.js` is [lamejs](https://github.com/zhuker/lamejs) 1.2.1, a
JavaScript port of LAME, under the LGPL-3.0. It is shipped unmodified as a
separate file (see `lib/README.md`) and can be swapped for another build.

Built by [Yashvardhan Jain](https://iamyvj.github.io/).
