#!/usr/bin/env bash
# Install a user-managed pack into DEST. The archive is not a Nix input.
#   .mrpack            mrpack-install (Fabric, Quilt, NeoForge, Forge)
#   CurseForge .zip    Forge installer version named by minecraftinstance.json
# Re-runs only when the archive sha256 changes. .sha256 is written last.
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: install-pack DEST ARCHIVE" >&2
  exit 1
fi

dest=$1
archive=$2

case "$dest" in
/ | . | "")
  echo "refusing to install into $dest" >&2
  exit 1
  ;;
esac

if [ ! -f "$archive" ]; then
  echo "Pack archive not found: $archive" >&2
  exit 1
fi

: "${JAVA_ROOT:?JAVA_ROOT is unset}"
if [ ! -x "$JAVA_ROOT/bin/java" ]; then
  echo "JRE missing at $JAVA_ROOT/bin/java" >&2
  exit 1
fi
PATH="$JAVA_ROOT/bin:$PATH"

sum="$(sha256sum "$archive" | cut -d' ' -f1)"
if [ "$(cat "$dest/.sha256" 2>/dev/null || true)" = "$sum" ]; then
  echo "Up to date: $dest"
  exit 0
fi

if unzip -l "$archive" modrinth.index.json >/dev/null 2>&1; then
  format=mrpack
elif unzip -l "$archive" minecraftinstance.json >/dev/null 2>&1; then
  format=curseforge
else
  echo "Unrecognized pack archive (missing modrinth.index.json or minecraftinstance.json): $archive" >&2
  exit 1
fi

echo "Installing $archive into $dest..."
rm -rf "$dest"
mkdir -p "$dest"

if [ "$format" = mrpack ]; then
  mrpack-install "$archive" --server-dir "$dest" --server-file server.jar
else
  manifest="$(unzip -p "$archive" minecraftinstance.json)"
  mc="$(printf '%s\n' "$manifest" | jq -er '.gameVersion')"
  forge="$(printf '%s\n' "$manifest" | jq -er '.baseModLoader.forgeVersion')"
  forge_id="$mc-$forge"
  installer="$(mktemp)"
  trap 'rm -f "$installer"' EXIT
  curl -fsSL -o "$installer" \
    "https://maven.minecraftforge.net/net/minecraftforge/forge/${forge_id}/forge-${forge_id}-installer.jar"
  (cd "$dest" && java -jar "$installer" --installServer)
  mv "$dest/forge-${forge_id}.jar" "$dest/server.jar"
  rm -f "$dest"/*.log
  for dir in mods config defaultconfigs scripts kubejs; do
    if unzip -l "$archive" "${dir}/*" >/dev/null 2>&1; then
      unzip -qo "$archive" "${dir}/*" -d "$dest"
    fi
  done
fi

chmod -R a+rX "$dest"
printf '%s\n' "$sum" >"$dest/.sha256"
