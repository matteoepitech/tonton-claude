#!/bin/sh
# The island in a GNOME session on Wayland, for CI: GNOME's compositor (mutter) runs headless with XWayland, and the
# smoke test (main.cjs) runs in that session. The island must start again through XWayland, then show at the top center
# of the screen and stay above other windows: _NET_WM_STATE_ABOVE, which only an X11 window can ask GNOME for.
# Usage: gnome-wayland.sh <electron executable> <smoke folder>   (needs mutter, xwayland, x11-utils and dbus)
# TONTON_SMOKE_RELAY and TONTON_SMOKE_OUT are passed on to the smoke test.
set -eu
if [ "${1:-}" != --inside ]; then
  export XDG_RUNTIME_DIR="$(mktemp -d)"
  exec dbus-run-session -- sh "$0" --inside "$@"
fi
ELECTRON=$2
APP=$3
OUT=$TONTON_SMOKE_OUT
mkdir -p "$OUT"
WIDTH=1600

before=$(ls /tmp/.X11-unix 2>/dev/null || true)
mutter --headless --wayland --virtual-monitor "${WIDTH}x1000" >"$OUT/mutter.log" 2>&1 &
for _ in $(seq 100); do [ -S "$XDG_RUNTIME_DIR/wayland-0" ] && break; sleep 0.1; done
sleep 1
# What a GNOME session gives every app: its Wayland socket, and the X display and authority of its XWayland.
export XDG_SESSION_TYPE=wayland WAYLAND_DISPLAY=wayland-0
XAUTHORITY=$(ls "$XDG_RUNTIME_DIR"/.mutter-Xwaylandauth.* | head -1)
export XAUTHORITY
for socket in $(ls /tmp/.X11-unix); do
  case " $before " in *" $socket "*) continue ;; esac
  if xdpyinfo -display ":${socket#X}" >/dev/null 2>&1; then export DISPLAY=":${socket#X}" && break; fi
done
echo "gnome-wayland: WAYLAND_DISPLAY=$WAYLAND_DISPLAY DISPLAY=${DISPLAY:-none}"

TONTON_SMOKE_NAME=gnome-wayland "$ELECTRON" "$APP" >"$OUT/gnome-wayland-electron.log" 2>&1 &
seen=""
for _ in $(seq 600); do
  line=$(xwininfo -root -tree 2>/dev/null | grep '"Tonton Claude"' | head -1 || true)
  if [ -n "$line" ]; then
    state=$(xprop -id "$(echo "$line" | awk '{print $1}')" _NET_WM_STATE 2>/dev/null || true)
    [ "$line|$state" != "$seen" ] && echo "gnome-wayland: $line | $state" && seen="$line|$state"
    # The island's geometry, WxH+X+Y, centered at the top of the screen; and above the other windows.
    echo "$line" | awk -v width="$WIDTH" '{ for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+x[0-9]+\+[0-9-]+\+[0-9-]+$/) { split($i, g, /[x+]/); exit !(g[4] == 0 && g[3] + g[1] / 2 == width / 2) } exit 1 }' &&
      echo "$state" | grep -q _NET_WM_STATE_ABOVE && placed=yes
  fi
  [ -f "$OUT/gnome-wayland-result" ] && break
  sleep 0.1
done
cat "$OUT/gnome-wayland-smoke.log" 2>/dev/null || true
result=$(cat "$OUT/gnome-wayland-result" 2>/dev/null || echo "no result")
[ "$result" = ok ] || { echo "gnome-wayland: the smoke test failed: $result"; exit 1; }
[ "${placed:-}" = yes ] || { echo "gnome-wayland: the island never showed as an X11 window at the top center, above the others"; exit 1; }
echo "gnome-wayland: ok"
