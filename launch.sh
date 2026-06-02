#!/usr/bin/env bash
# Stream Chat Overlay — launcher GNOME/Wayland
# Utilise XWayland pour pouvoir piquer la fenêtre "toujours au-dessus" via xdotool

set -e
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"

# Fermer proprement toute instance existante (Chromium + serveur Bun)
pkill -9 -f "user-data-dir=.*chromium-stream-chat" 2>/dev/null || true
fuser -k 7432/tcp 2>/dev/null || true
sleep 0.8

# Démarrer le serveur Bun en arrière-plan
cd "$SCRIPT_DIR"
bun run server.ts &
BUN_PID=$!
echo "Serveur démarré (PID $BUN_PID)"

# Attendre que le serveur réponde
for i in $(seq 1 25); do
  curl -sf http://localhost:7432/ > /dev/null 2>&1 && break
  sleep 0.3
done

# Profil dédié à l'overlay (évite le conflit avec Chromium déjà ouvert)
# On copie les cookies du profil principal pour garder la session YouTube
OVERLAY_PROFILE="$HOME/.config/chromium-stream-chat"
if [ ! -d "$OVERLAY_PROFILE" ]; then
  mkdir -p "$OVERLAY_PROFILE/Default"
  # Copie des cookies pour que YouTube soit connecté
  if [ -f "$HOME/.config/chromium/Default/Cookies" ]; then
    cp "$HOME/.config/chromium/Default/Cookies" "$OVERLAY_PROFILE/Default/Cookies" 2>/dev/null || true
  fi
fi

# Ouvrir Chromium en mode app via XWayland (--ozone-platform=x11)
# pour que xdotool puisse interagir avec la fenêtre
chromium \
  --app=http://localhost:7432 \
  --class=StreamChat \
  --window-size=420,650 \
  --user-data-dir="$OVERLAY_PROFILE" \
  --ozone-platform=x11 \
  --no-first-run \
  --disable-background-timer-throttling &
CHROMIUM_PID=$!

echo "Attente de la fenêtre Chromium..."
for i in $(seq 1 20); do
  WID=$(xdotool search --class "StreamChat" 2>/dev/null | tail -1)
  [ -n "$WID" ] && break
  sleep 0.5
done

if [ -n "$WID" ]; then
  # Toujours au-dessus
  xdotool windowstate --add ABOVE "$WID"
  # Transparence 80% — 0xCCCCCCCC = 3435973836 en décimal
  xprop -id "$WID" -f _NET_WM_WINDOW_OPACITY 32c -set _NET_WM_WINDOW_OPACITY 3435973836 2>/dev/null \
    && echo "✓ Fenêtre épinglée + transparence 80% (ID: $WID)" \
    || echo "✓ Fenêtre épinglée (xprop non disponible)"
else
  echo "⚠ Fenêtre non trouvée"
fi

echo "Stream Chat opérationnel sur http://localhost:7432"

# Quand Chromium se ferme → tuer le serveur Bun
wait $CHROMIUM_PID 2>/dev/null || true
kill $BUN_PID 2>/dev/null || true
echo "Serveur arrêté."
