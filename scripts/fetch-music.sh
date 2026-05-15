#!/usr/bin/env bash
# Download the default royalty-free background track (Kevin MacLeod —
# "Reverie (small theme)", CC BY 4.0) to assets/music.mp3.
#
# Idempotent: skips the download if the file already exists.
# See assets/music-attribution.md for the required credit.

set -euo pipefail

DEST="assets/music.mp3"
URL="https://incompetech.com/music/royalty-free/mp3-royaltyfree/Reverie%20(small%20theme).mp3"

if [[ -f "$DEST" ]]; then
  echo "[fetch-music] $DEST already present — skipping download."
  exit 0
fi

mkdir -p "$(dirname "$DEST")"

echo "[fetch-music] Downloading $URL ..."
if command -v curl >/dev/null 2>&1; then
  curl --fail --location --silent --show-error -o "$DEST" "$URL"
elif command -v wget >/dev/null 2>&1; then
  wget -q -O "$DEST" "$URL"
else
  echo "[fetch-music] Neither curl nor wget is available; cannot download." >&2
  exit 1
fi

echo "[fetch-music] Saved to $DEST"
echo "[fetch-music] Remember the CC BY 4.0 credit — see assets/music-attribution.md"
