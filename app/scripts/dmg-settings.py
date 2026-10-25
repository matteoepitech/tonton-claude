# Layout of the installer window, read by dmgbuild (see make-dmg.sh). Sizes and icon centers come from
# scripts/dmg-layout.json, which scripts/make-dmg-background.swift draws the background from.
import json

app = defines["app"]  # noqa: F821, provided by dmgbuild
with open(defines["layout"]) as f:  # noqa: F821
    layout = json.load(f)

files = [(app, "Tonton Claude.app")]
symlinks = {"Applications": "/Applications"}
hide_extensions = ["Tonton Claude.app"]
icon = defines["icon"]  # noqa: F821

background = defines["background"]  # noqa: F821
# The layout plus Finder's title bar (32 pt on macOS 26). The background runs past the layout, so a shorter title bar
# uncovers more backdrop rather than the window color.
window_rect = ((200, 160), (layout["width"], layout["height"] + 32))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False

icon_size = layout["iconSize"]
text_size = layout["textSize"]
icon_locations = {
    "Tonton Claude.app": tuple(layout["app"]),
    "Applications": tuple(layout["applications"]),
}

format = "UDZO"
filesystem = "HFS+"
