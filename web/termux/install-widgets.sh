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

# Remove stale Agency Agents shortcuts from previous installs (any name,
# any port) BEFORE writing the fresh ones. Only ours: the name contains
# "Agency Agents"/"agency-agents", or the script points into one of our
# clone paths (agency-agents-app / agency-agents-js). DevForge's and
# FullTrader's widgets never match and are left alone.
clean_stale() { # clean_stale <dir>
  [ -d "$1" ] || return 0
  for f in "$1"/*; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    case "$base" in
      *"Agency Agents"*|*"agency-agents"*|*"agency agents"*) rm -f -- "$f" ;;
      *)
        if grep -qE "agency-agents-(app|js)" "$f" 2>/dev/null; then
          rm -f -- "$f"
        fi
        ;;
    esac
  done
}
clean_stale "$SHORTCUTS"
clean_stale "$SHORTCUTS/tiles" 2>/dev/null || true

mk() { # mk <template> <name>
  sed "s|__APP_DIR__|$APP_DIR|g" "$HERE/$1" > "$SHORTCUTS/$2"
  chmod +x "$SHORTCUTS/$2"
}

mk widget-entry.sh "Agency Agents"
mk widget-stop.sh "Agency Agents stop"

echo "Installed:"
ls -1 "$SHORTCUTS" | sed 's/^/  ~\/.shortcuts\//'
echo
echo "If the home-screen widget still shows old buttons: long-press it →"
echo "Remove, then add the Termux:Widget again — it lists ~/.shortcuts live."
echo
echo "Next (one time, if not already done):"
echo "  1. Install Termux:Widget from F-Droid (DevForge users already have it)."
echo "  2. Home screen → Widgets → Termux:Widget → add it."
echo "  3. Tap \"Agency Agents\" — server starts, then the app opens."
echo
echo "For the app-like launcher instead: open http://localhost:8788 in Chrome"
echo "→ menu ⋮ → \"Add to Home screen\" / \"Install app\" (it's a PWA)."
