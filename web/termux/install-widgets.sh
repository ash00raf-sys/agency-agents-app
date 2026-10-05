#!/data/data/com.termux/files/usr/bin/bash
#
# Install Agency Agents Termux:Widget shortcuts into ~/.shortcuts/.
#
# Usage:  bash web/termux/install-widgets.sh
#
# Requires the Termux:Widget app (F-Droid) — the same one DevForge uses.
# After running this, add the widget: home screen → widgets → Termux:Widget
# (small) → both shortcuts appear. Tapping "Agency Agents" starts the server
# (if needed) and opens the app.
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$HERE/../.." && pwd)"
SHORTCUTS="$HOME/.shortcuts"

[ -d "$APP_DIR/web" ] || { echo "Run this from the repo: bash web/termux/install-widgets.sh" >&2; exit 1; }

mkdir -p "$SHORTCUTS"

mk() { # mk <template> <name>
  sed "s|__APP_DIR__|$APP_DIR|g" "$HERE/$1" > "$SHORTCUTS/$2"
  chmod +x "$SHORTCUTS/$2"
}

mk widget-entry.sh "Agency Agents"
mk widget-stop.sh "Agency Agents stop"

echo "Installed:"
ls -1 "$SHORTCUTS" | sed 's/^/  ~\/.shortcuts\//'
echo
echo "Next (one time, if not already done):"
echo "  1. Install Termux:Widget from F-Droid (DevForge users already have it)."
echo "  2. Home screen → Widgets → Termux:Widget → add it."
echo "  3. Tap \"Agency Agents\" — server starts, then the app opens."
echo
echo "For the app-like launcher instead: open http://localhost:8787 in Chrome"
echo "→ menu ⋮ → \"Add to Home screen\" / \"Install app\" (it's a PWA)."
