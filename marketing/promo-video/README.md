# Replay promo video

This folder contains the editable source for Replay's 74-second launch film. It is a deterministic HTML timeline rendered at 1920×1080 and 24 frames per second.

## Render review stills

```sh
node marketing/promo-video/render.mjs --stills
```

## Render the finished film

```sh
node marketing/promo-video/soundtrack.mjs
node marketing/promo-video/render.mjs
ffmpeg -y \
  -i marketing/promo-video/output/replay-promo-silent.mp4 \
  -i marketing/promo-video/output/replay-promo-score.wav \
  -filter:a "loudnorm=I=-14:TP=-1.5:LRA=7" \
  -map 0:v -map 1:a \
  -c:v copy -c:a aac -b:a 256k -ar 48000 \
  -movflags +faststart -shortest \
  marketing/promo-video/output/replay-promo-1080p.mp4
```

The soundtrack is original and generated locally by `soundtrack.mjs`. No stock footage, third-party music, or external fonts are included.
