# AudioLoft

**Trim, split and join audio in your browser. Nothing is uploaded.**

AudioLoft is a static site: every edit happens in the page, using the browser's
own Web Audio decoder and a hand-written WAV encoder. There is no backend and
no third-party code, so it can be hosted on GitHub Pages and keeps working
offline once it has been opened.

---

## Tools

| Tool | What it does |
| --- | --- |
| **Studio** | All three in one place, for any number of tracks. Every file becomes a clip on a timeline. Select a clip to trim it (drag its edges or type times), split it at the playhead, duplicate or delete it, give it fades; drag clips into any order. Play the whole arrangement, then export it joined into one WAV (with optional gaps or crossfades) or export every clip separately as a ZIP. |
| **Trim** | Select a range on the waveform (drag, type exact times, or set from the playhead) and either keep it or cut it out. Fade in / out, normalize to −1 dB, loop the selection, preview the result before saving. |
| **Split** | Place split points by hand, every N seconds, into N equal parts, or in the middle of silent gaps. Drag points to adjust, name each part, play or download parts one by one, or download them all as a ZIP. Optional silence trimming and short fades at each cut. |
| **Join** | Add any number of files in any supported format, reorder by drag and drop or the ↑ / ↓ buttons, preview each one. Join with no gap, a silent gap, or an equal-power crossfade. Mixed sample rates and channel layouts are matched automatically. |

All three export **WAV** at 16-bit PCM, 24-bit PCM or 32-bit float.

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
- **Studio:** click a clip on the timeline to edit it. The source track is shown
  with the clip's range highlighted; drag its edges to trim. `S` splits the
  clip at the playhead, `C` plays the clip, `P` plays the whole arrangement,
  `[` / `]` step between clips, `Delete` removes the selected one. Clips only
  point at their source, so a trimmed clip can always be widened again.
- **Split:** double-click to add a split point, drag one to move it,
  double-click it to remove it. `M` splits at the playhead.
- `Space` plays / pauses. With the waveform focused, `←` / `→` nudge the
  playhead (hold Shift for finer steps) and `+` / `−` zoom.

---

## Privacy

- **No uploads.** There is no server-side code. Open DevTools → Network while
  editing: no requests are made.
- **No third-party code.** No CDNs, fonts, analytics or libraries. Every page
  declares `script-src 'self'` in its Content-Security-Policy.
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
├── studio.html           # Trim + split + join for multiple tracks
├── css/style.css         # All styles (design tokens at the top)
├── js/
│   ├── audio-core.js     # Decode, edit (slice, cut, concat, fades, resample),
│   │                     # silence detection, WAV encoder, ZIP writer
│   ├── player.js         # Web Audio playback of a clip or a range
│   ├── waveform.js       # Canvas waveform: ruler, zoom, selection, markers
│   ├── ui.js             # Drop zones, toasts, busy overlay, shortcuts
│   ├── trim.js / split.js / join.js
│   ├── studio.js         # Clip model: sources, clips, arrangement, export
│   ├── home.js           # Landing-page hero animation
│   └── sw-register.js
├── sw.js                 # Offline cache (network first)
├── manifest.webmanifest
└── icons/                # icon.svg (favicon) and PNG app icons
```

---

## Limits

- Decoded audio is held in memory as 32-bit float, roughly 21 MB per minute of
  stereo at 44.1 kHz. Very long files (several hours) can exceed what a tab is
  allowed to use; AudioLoft refuses those up front instead of crashing.
- Output is WAV only. Compressed export (MP3, AAC) would need an encoder
  library, which this project deliberately avoids.

---

## License

MIT, see [LICENSE](LICENSE).

Built by [Yashvardhan Jain](https://iamyvj.github.io/).
