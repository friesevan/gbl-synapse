#!/usr/bin/env bash
# One-command overnight YouTube harvest: discover -> metadata -> download -> Meta Extractor.
#   bash web/scripts/yt-harvest/overnight.sh                 # 9 h, defaults
#   bash web/scripts/yt-harvest/overnight.sh --hours 8 --no-extract
# Progress: tail -f "$HOME/Desktop/Projects/PoGo Recorder/src/yt-harvest/harvest.log"
# Stop safely: Ctrl-C, or: touch "$HOME/Desktop/Projects/PoGo Recorder/src/yt-harvest/STOP"
# Re-running resumes from the state database (nothing done is fetched again).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV="${YT_HARVEST_VENV:-$HOME/.cache/gbl-synapse/venv}"
export PATH="/opt/homebrew/bin:$PATH"

if [ ! -x "$VENV/bin/python" ]; then
  echo "creating venv $VENV"
  mkdir -p "$(dirname "$VENV")"
  python3 -I -m venv "$VENV"
fi
# Install / refresh yt-dlp (YouTube changes often; a stale yt-dlp is the most common failure).
"$VENV/bin/python" -I -m pip install -q --disable-pip-version-check -U "yt-dlp[default]" deno 2>&1 | tail -2 || true
"$VENV/bin/python" -I -c "import yt_dlp" || { echo "yt-dlp install failed"; exit 1; }

WORK="${YT_HARVEST_WORK:-$HOME/Desktop/Projects/PoGo Recorder/src/yt-harvest}"
# harvest.py clears STOP only after acquiring its exclusive lifecycle lock.
if command -v caffeinate >/dev/null 2>&1; then
  exec caffeinate -i "$VENV/bin/python" -I "$HERE/harvest.py" overnight "$@"
fi
exec "$VENV/bin/python" -I "$HERE/harvest.py" overnight "$@"
