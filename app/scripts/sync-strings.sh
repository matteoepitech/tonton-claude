#!/bin/sh
# Keeps Resources/Localizable.xcstrings in step with the code, as Xcode does when it builds a project: the compiler lists
# the strings given to the APIs that translate them (Text, Button, String(localized:), String(core:)…), and xcstringstool
# adds the new ones to the catalog and marks those the code no longer has as stale. Translate the new ones and delete the
# stale ones; the catalog tests (LocalizationTests) fail until both are done.
#   --check  change nothing, and fail when the catalog is not in step (CI)
# Needs Xcode, for xcstringstool.
set -e
cd "$(dirname "$0")/.."

CHECK=0
for arg in "$@"; do
  case $arg in
    --check) CHECK=1 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

CATALOG=Resources/Localizable.xcstrings
BUILD=.build/strings
# Each file's list is named after it, all in one folder: two files of the same name would share one.
SAME=$(find Sources -name '*.swift' -exec basename {} \; | sort | uniq -d)
[ -z "$SAME" ] || { echo "two source files are called $SAME: rename one, or its strings are left out" >&2; exit 1; }
swift build --scratch-path "$BUILD" -Xswiftc -emit-localized-strings -Xswiftc -emit-localized-strings-path -Xswiftc "$PWD/$BUILD/lists"

# A file's list stays behind when the file goes away: keep only those of files still there. The list of a file that did
# not change since the last run is still right, so an incremental build is enough.
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT
find "$BUILD/lists" -name '*.stringsdata' > "$OUT/lists"
set --
while read -r list; do
  source=$(plutil -extract source raw -o - "$list")
  if [ -f "$source" ]; then set -- "$@" "$list"; fi
done < "$OUT/lists"
[ $# -gt 0 ] || { echo "the build listed no strings" >&2; exit 1; }

# One run with every list: a run only sees its own, and marks the strings of the others stale.
cp "$CATALOG" "$OUT/Localizable.xcstrings"
xcrun xcstringstool sync "$OUT/Localizable.xcstrings" --stringsdata "$@"

if cmp -s "$CATALOG" "$OUT/Localizable.xcstrings"; then
  echo "OK: $CATALOG is in step with the code"
  exit 0
fi
if [ $CHECK = 1 ]; then
  diff -u "$CATALOG" "$OUT/Localizable.xcstrings" || true
  echo "$CATALOG is not in step with the code: run app/scripts/sync-strings.sh, then translate the new strings and delete the stale ones" >&2
  exit 1
fi
cp "$OUT/Localizable.xcstrings" "$CATALOG"
echo "Updated $CATALOG: translate the new strings and delete the stale ones (swift test lists them)"
