# Replay film v2 — "The reason is on the record"

This folder is the editable source for Replay's 82-second film. It is a deterministic HTML timeline rendered at 1920×1080, 30 frames per second, with an original score synthesised in Node. See [storyboard.md](storyboard.md) for the creative idea, the beat sheet, and the accuracy guardrails.

Everything is generated locally from the files here. No stock footage, third-party music, downloaded fonts, or external assets are used; the typefaces are the macOS system faces SF Pro Display, Iowan Old Style, and Menlo.

## Preview in a browser

Open `index.html?autoplay=1` in Chromium or Safari, or `index.html?t=38.4` to inspect a single instant. The page exposes `window.ReplayFilm.renderAt(seconds)`.

## Render review stills

```sh
node marketing/promo-video-v2/render.mjs --stills
```

Writes 24 stills and `output/contact-sheet.jpg`.

## Render the finished film

```sh
node marketing/promo-video-v2/soundtrack.mjs
node marketing/promo-video-v2/render.mjs
node marketing/promo-video-v2/render.mjs --poster
ffmpeg -y \
  -i marketing/promo-video-v2/output/replay-film-silent.mp4 \
  -i marketing/promo-video-v2/output/replay-film-score.wav \
  -filter:a "loudnorm=I=-14:TP=-1.5:LRA=9" \
  -map 0:v -map 1:a \
  -c:v copy -c:a aac -b:a 256k -ar 48000 \
  -movflags +faststart -shortest \
  marketing/promo-video-v2/output/replay-film-1080p.mp4
```

`render.mjs` expects Homebrew's ffmpeg at `/opt/homebrew/bin/ffmpeg`; set `FFMPEG` to override. The full render takes several minutes because every frame is a headless Chromium screenshot.

## Files

- `index.html` — the world (everything the camera moves through) and the HUD (everything fixed to the lens).
- `styles.css` — the design system for the film: dark Ivy palette, type, cards, strips, app mock.
- `timeline.js` — `renderAt(t)`: camera keyframes, every element's state as a pure function of time.
- `soundtrack.mjs` — the score and picture-locked sound design.
- `render.mjs` — stills, contact sheet, poster, and the silent master.
- `output/` — rendered files. Only the finished MP4 and poster are tracked in Git.
