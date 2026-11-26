#!/bin/bash
# Builds Video Merger from source on macOS and puts it into ~/Applications.
#
#   curl -fsSL https://raw.githubusercontent.com/powervac/video-merger/main/build-mac.sh | bash
#
# Nothing is installed system-wide: if Node.js is missing, a temporary copy is downloaded
# and removed afterwards. VM_SOURCE=<folder> builds a local checkout, VM_NO_OPEN=1 does not start the app.

set -euo pipefail

REPO="powervac/video-merger"
APP="Video Merger.app"

say() { printf '\n==> %s\n' "$1"; }
fail() { printf '\nError: %s\n' "$1" >&2; exit 1; }

# Everything is inside main(), so a half-downloaded script does nothing.
main() {
  [ "$(uname -s)" = "Darwin" ] || fail "this script is for macOS"
  case "$(uname -m)" in
    arm64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) fail "unsupported processor: $(uname -m)" ;;
  esac

  work="$(mktemp -d "${TMPDIR:-/tmp}/video-merger.XXXXXX")"
  trap 'rm -rf "$work"' EXIT

  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]')" -ge 18 ]; then
    say "Using Node.js $(node -v)"
  else
    say "Node.js 18 or newer not found: downloading a temporary copy"
    base="https://nodejs.org/dist/latest-v22.x"
    curl -fsSL "$base/SHASUMS256.txt" -o "$work/SHASUMS256.txt"
    file="$(awk -v a="darwin-$arch.tar.gz" 'index($2, a) { print $2; exit }' "$work/SHASUMS256.txt")"
    [ -n "$file" ] || fail "no Node.js download for darwin-$arch"
    curl -fL --progress-bar "$base/$file" -o "$work/$file"
    (cd "$work" && grep "  $file\$" SHASUMS256.txt | shasum -a 256 -c - >/dev/null) || fail "Node.js checksum mismatch"
    tar -xzf "$work/$file" -C "$work"
    export PATH="$work/${file%.tar.gz}/bin:$PATH"
  fi

  mkdir "$work/src"
  if [ -n "${VM_SOURCE:-}" ]; then
    say "Copying sources from $VM_SOURCE"
    (cd "$VM_SOURCE" && tar --exclude=node_modules --exclude=dist -cf - .) | tar -xf - -C "$work/src"
  else
    say "Downloading sources from github.com/$REPO"
    curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar -xzf - -C "$work/src" --strip-components=1
  fi
  cd "$work/src"

  say "Installing build tools (a few minutes)"
  npm ci --no-audit --no-fund </dev/null

  say "Building the application"
  CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --dir "--$arch" --publish never </dev/null

  built="$(find dist -maxdepth 2 -type d -name "$APP" | head -n 1)"
  [ -n "$built" ] || fail "the build did not produce $APP"
  # Apple Silicon refuses to start unsigned programs: sign it locally (ad-hoc).
  codesign --force --deep --sign - "$built"

  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/$APP"
  ditto "$built" "$HOME/Applications/$APP"

  say "Done: $HOME/Applications/$APP"
  if [ -z "${VM_NO_OPEN:-}" ]; then
    open "$HOME/Applications/$APP"
  fi
}

main "$@"
