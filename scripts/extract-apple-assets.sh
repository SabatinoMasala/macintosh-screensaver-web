#!/usr/bin/env bash
# Extract Apple's resources for the Macintosh screensaver into assets/apple/.
#
# The scene scripts, images, fonts and cursors the player needs belong to Apple
# and ship with macOS 26 inside WallpaperMacintoshExtension.appex. They are not
# part of this repository (assets/apple/ is gitignored): this script copies them
# from a local copy of the extension. Never commit or redistribute the result.
#
# Usage:
#   scripts/extract-apple-assets.sh [path-to-appex]   copy the resources
#   scripts/extract-apple-assets.sh --check           only verify assets/apple/
#
# The appex path is, in order: the positional argument, $MACINTOSH_APPEX, then
# /System/Library/ExtensionKit/Extensions/WallpaperMacintoshExtension.appex.
#
# Files are copied by explicit allow-list (exact names), so a macOS version with
# extra files still produces the same layout; a missing file is reported and
# makes the script exit non-zero. Running it again overwrites the same files.
#
# Needs bash, coreutils and plutil only. If python3 and llvm-dis (LLVM 20) are
# available it also regenerates the shader disassembly in assets/apple/shaders/.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/assets/apple"
DEFAULT_APPEX="/System/Library/ExtensionKit/Extensions/WallpaperMacintoshExtension.appex"
BINARY="WallpaperMacintoshExtension"

# Keep these lists in step with APPLE_PROGRAMS / APPLE_IMAGES / FONTS / CURS_IDS /
# ACUR_IDS in src/resources.js.
PROGRAMS=(
    StartupHappyMac StartupWelcome Finder IconGarden IconGardenWallpaper MacPaint MacPaintHello
    MacWrite MacWriteTextInput MacWriteStyleMenu System1ControlPanel System6ControlPanel
    DeskAccessories AlertSounds QuitDialog
)
IMAGES=(
    AlertSounds Bomb CancelButton Clarus CloseBox DeskAccessories Disks FinderTrash
    FinderWindow FolderIcon HappyMac IconGarden MacPaint MacPaintHello MacWrite1984
    MacWriteCrazyOnes MacWriteEmpty MacWriteStyleMenu PuzzleTiles QuitDialog RadioButton
    RadioButtonSystem1Number0 RadioButtonSystem1Number1 ResEdit Slider StartupDesktop
    StartupIcons StartupWelcome System1ControlPanel System6ControlPanel Trash TrashIcon
)
FONTS=(Chicago12 Geneva12 Geneva9 Monaco9)
CURS_IDS=(0 1 2 4 128 129 130 131 132 133 134 135 136 2400 2401 2402 2403 2404 2405 2406
    25001 25002 25003 25004 25005 25006 25007 25008 -20709 -20710 -20711 -20712 -20713 -20714)
ACUR_IDS=(128 640 2400 -20714)
CATEGORIES=(programs images fonts cursors)

usage() {
    sed -n '2,21p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# The file names of one category, one per line.
files_of() {
    local n
    case "$1" in
        programs) for n in "${PROGRAMS[@]}"; do echo "$n.program"; done ;;
        images) for n in "${IMAGES[@]}"; do echo "$n.png"; done ;;
        fonts) for n in "${FONTS[@]}"; do echo "$n.bin"; done ;;
        cursors)
            for n in "${CURS_IDS[@]}"; do echo "CURS_$n.bin"; done
            for n in "${ACUR_IDS[@]}"; do echo "acur_$n.bin"; done
            ;;
    esac
}

warn() { echo "warning: $*" >&2; }
die() { echo "error: $*" >&2; exit 2; }

# ---- arguments
CHECK=0
APPEX_ARG=""
while [ $# -gt 0 ]; do
    case "$1" in
        --check) CHECK=1 ;;
        -h|--help) usage; exit 0 ;;
        -*) die "unknown option $1 (see --help)" ;;
        *)
            [ -z "$APPEX_ARG" ] || die "only one appex path may be given"
            APPEX_ARG="$1"
            ;;
    esac
    shift
done

# ---- --check: verify what is installed, touch nothing
if [ "$CHECK" = 1 ]; then
    missing=0
    echo "Checking $DEST"
    for cat in "${CATEGORIES[@]}"; do
        have=0 total=0
        while IFS= read -r f; do
            total=$((total + 1))
            if [ -f "$DEST/$cat/$f" ]; then have=$((have + 1)); else warn "missing $cat/$f"; missing=$((missing + 1)); fi
        done < <(files_of "$cat")
        printf '  %-9s %3d/%d\n' "$cat" "$have" "$total"
    done
    for f in "original/$BINARY" "original/Resources/default.metallib"; do
        if [ -f "$DEST/$f" ]; then printf '  %-9s %s\n' original "$f"; else warn "missing $f"; missing=$((missing + 1)); fi
    done
    shaders=$(ls "$DEST/shaders/"*.ll 2>/dev/null | wc -l | tr -d ' ')
    printf '  %-9s %3d (optional)\n' shaders "$shaders"
    if [ "$missing" -gt 0 ]; then
        echo "$missing file(s) missing: run scripts/extract-apple-assets.sh" >&2
        exit 1
    fi
    echo "OK: Apple's resources are installed."
    exit 0
fi

# ---- extraction
APPEX="${APPEX_ARG:-${MACINTOSH_APPEX:-$DEFAULT_APPEX}}"
APPEX="${APPEX%/}"
RES="$APPEX/Contents/Resources"
[ -d "$APPEX" ] || die "no such appex: $APPEX
  Pass the path to a copy of WallpaperMacintoshExtension.appex (macOS 26), e.g.
  MACINTOSH_APPEX=/Volumes/Macintosh\\ HD/System/Library/ExtensionKit/Extensions/WallpaperMacintoshExtension.appex $0"
[ -d "$RES" ] || die "$APPEX has no Contents/Resources: not the Macintosh wallpaper extension?"
[ -f "$APPEX/Contents/MacOS/$BINARY" ] || die "$APPEX has no Contents/MacOS/$BINARY: not the Macintosh wallpaper extension?"

version="unknown"
if [ -f "$APPEX/Contents/Info.plist" ] && command -v plutil >/dev/null 2>&1; then
    short=$(plutil -extract CFBundleShortVersionString raw -o - "$APPEX/Contents/Info.plist" 2>/dev/null || true)
    build=$(plutil -extract CFBundleVersion raw -o - "$APPEX/Contents/Info.plist" 2>/dev/null || true)
    version="${short:-?} (build ${build:-?})"
fi

echo "Extracting from $APPEX"
echo "  bundle version $version"
missing=0
summary=""
for cat in "${CATEGORIES[@]}"; do
    mkdir -p "$DEST/$cat" || die "cannot create $DEST/$cat"
    have=0 total=0
    while IFS= read -r f; do
        total=$((total + 1))
        if [ -f "$RES/$f" ]; then
            cp -f "$RES/$f" "$DEST/$cat/$f" || die "cannot copy $f"
            have=$((have + 1))
        else
            warn "missing in the appex: $f"
            missing=$((missing + 1))
        fi
    done < <(files_of "$cat")
    summary="$summary$(printf '  %-9s %3d/%d' "$cat" "$have" "$total")"$'\n'
done

# The untouched binary + Resources, for reference (NOTES.md, tools/). Built in a
# staging directory and swapped in, so an interrupted run leaves no half copy.
stage="$DEST/.original.tmp"
rm -rf "$stage"
mkdir -p "$stage" || die "cannot create $stage"
cp -f "$APPEX/Contents/MacOS/$BINARY" "$stage/$BINARY" || die "cannot copy the binary"
cp -R "$RES" "$stage/Resources" || die "cannot copy Contents/Resources"
rm -rf "$DEST/original"
mv "$stage" "$DEST/original" || die "cannot move $stage into place"
if [ -f "$DEST/original/Resources/default.metallib" ]; then
    summary="$summary  original  binary + Resources (default.metallib included)"$'\n'
else
    warn "missing in the appex: default.metallib"
    missing=$((missing + 1))
    summary="$summary  original  binary + Resources (NO default.metallib)"$'\n'
fi

# Optional: the shader disassembly (tools/metallib_split.py + LLVM's llvm-dis).
LLVM_DIS=""
for c in "$(command -v llvm-dis 2>/dev/null)" /opt/homebrew/opt/llvm/bin/llvm-dis /opt/homebrew/opt/llvm@20/bin/llvm-dis /usr/local/opt/llvm/bin/llvm-dis; do
    if [ -n "$c" ] && [ -x "$c" ]; then LLVM_DIS="$c"; break; fi
done
if [ ! -f "$DEST/original/Resources/default.metallib" ]; then
    summary="$summary  shaders   skipped (no default.metallib)"$'\n'
elif ! command -v python3 >/dev/null 2>&1 || [ -z "$LLVM_DIS" ]; then
    summary="$summary  shaders   skipped (needs python3 + llvm-dis, e.g. brew install llvm; optional)"$'\n'
else
    tmp=$(mktemp -d "${TMPDIR:-/tmp}/macintosh-shaders.XXXXXX")
    shaders=0
    if python3 -I "$ROOT/tools/metallib_split.py" "$DEST/original/Resources/default.metallib" "$tmp" >/dev/null; then
        mkdir -p "$DEST/shaders"
        # run from the split directory so the ModuleID line is just "<name>.bc"
        for bc in "$tmp"/*.bc; do
            name=$(basename "$bc" .bc)
            if (cd "$tmp" && "$LLVM_DIS" "$name.bc" -o "$DEST/shaders/$name.ll"); then
                shaders=$((shaders + 1))
            else
                warn "llvm-dis failed on $name.bc"
            fi
        done
    else
        warn "tools/metallib_split.py failed"
    fi
    rm -rf "$tmp"
    summary="$summary$(printf '  %-9s %3d disassembled with %s' shaders "$shaders" "$LLVM_DIS")"$'\n'
fi

echo "Installed into $DEST:"
printf '%s' "$summary"
if [ "$missing" -gt 0 ]; then
    echo "$missing required file(s) missing: the scenes that need them will be skipped." >&2
    exit 1
fi
echo "Done. These files are Apple's: they are gitignored, never commit or redistribute them."
