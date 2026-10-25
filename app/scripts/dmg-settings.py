# Layout of the installer window, read by dmgbuild (see make-dmg.sh).
# Icon positions are icon centers and must match scripts/make-dmg-background.swift.
app = defines["app"]  # noqa: F821, provided by dmgbuild
resources = defines["resources"]  # noqa: F821

files = [(app, "Tonton Claude.app")]
symlinks = {"Applications": "/Applications"}
hide_extensions = ["Tonton Claude.app"]
icon = f"{resources}/AppIcon.icns"

background = f"{resources}/dmg-background.png"
# 640×400 of content plus the title bar.
window_rect = ((200, 160), (640, 432))
default_view = "icon-view"
show_status_bar = False
show_tab_view = False
show_toolbar = False
show_pathbar = False
show_sidebar = False

icon_size = 104
text_size = 13
icon_locations = {
    "Tonton Claude.app": (180, 190),
    "Applications": (460, 190),
}

format = "UDZO"
filesystem = "HFS+"
