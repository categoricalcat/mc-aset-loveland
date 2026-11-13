#!/usr/bin/env bash
# Build-time pack installer. Reads /tmp/pack, installs matching Adoptium JRE to
# /opt/java, and stages the server loader + mods/config into /opt/pack.
#   - Modrinth (.mrpack -> modrinth.index.json): installed via mrpack-install
#   - CurseForge (.zip -> minecraftinstance.json): Forge installer + pack dirs
set -euo pipefail

PACK="${1:-/tmp/pack}"

detect_arch() {
  local arch
  arch="${TARGETARCH:-$(uname -m)}"
  case "$arch" in
  amd64 | x86_64)
    MRPACK_ARCH="linux"
    JAVA_ARCH="x64"
    ;;
  arm64 | aarch64)
    MRPACK_ARCH="linux-arm64"
    JAVA_ARCH="aarch64"
    ;;
  *)
    echo "Unsupported architecture: $arch" >&2
    exit 1
    ;;
  esac
}

read_pack_metadata() {
  if unzip -l "$PACK" modrinth.index.json >/dev/null 2>&1; then
    PACK_FORMAT="mrpack"
    MC_VERSION="$(unzip -p "$PACK" modrinth.index.json | jq -er '.dependencies.minecraft')"
    FORGE_VERSION=""
  elif unzip -l "$PACK" minecraftinstance.json >/dev/null 2>&1; then
    PACK_FORMAT="curseforge"
    local manifest
    manifest="$(unzip -p "$PACK" minecraftinstance.json)"
    MC_VERSION="$(printf '%s\n' "$manifest" | jq -er '.gameVersion')"
    FORGE_VERSION="$(printf '%s\n' "$manifest" | jq -er '.baseModLoader.forgeVersion')"
  else
    echo "Unrecognized pack archive (missing modrinth.index.json or minecraftinstance.json): $PACK" >&2
    exit 1
  fi
}

install_jre() {
  local version_url java_major jre_meta jre_url jre_sha256

  version_url="$(
    curl -fsSL https://piston-meta.mojang.com/mc/game/version_manifest_v2.json |
      jq -er --arg v "$MC_VERSION" 'first(.versions[] | select(.id == $v) | .url)'
  )"
  java_major="$(
    curl -fsSL "$version_url" |
      jq -er '.javaVersion.majorVersion // 8'
  )"
  echo "Resolved Minecraft $MC_VERSION (format: $PACK_FORMAT, Forge: ${FORGE_VERSION:-none}, Java: $java_major)"

  jre_meta="$(
    curl -fsSL "https://api.adoptium.net/v3/assets/latest/${java_major}/hotspot?architecture=${JAVA_ARCH}&image_type=jre&os=linux&vendor=eclipse" |
      jq -er '.[0].binary.package'
  )"
  jre_url="$(printf '%s\n' "$jre_meta" | jq -er '.link')"
  jre_sha256="$(printf '%s\n' "$jre_meta" | jq -er '.checksum')"

  curl -fsSL "$jre_url" -o /tmp/jre.tar.gz
  printf '%s  /tmp/jre.tar.gz\n' "${jre_sha256%%[[:space:]]*}" | sha256sum -c -

  mkdir -p /opt/java
  tar -xzf /tmp/jre.tar.gz -C /opt/java --strip-components=1
  export PATH="/opt/java/bin:$PATH"
}

install_curseforge_pack() {
  # mrpack-install has no Forge provider; run the official Forge server installer.
  local forge_id="${MC_VERSION}-${FORGE_VERSION}"
  local forge_url="https://maven.minecraftforge.net/net/minecraftforge/forge/${forge_id}/forge-${forge_id}-installer.jar"
  local forge_sha1 dir

  curl -fsSL "$forge_url" -o /tmp/forge-installer.jar
  forge_sha1="$(curl -fsSL "${forge_url}.sha1")"
  printf '%s  /tmp/forge-installer.jar\n' "${forge_sha1%%[[:space:]]*}" | sha1sum -c -

  mkdir -p /opt/pack
  (cd /opt/pack && java -jar /tmp/forge-installer.jar --installServer)
  mv "/opt/pack/forge-${forge_id}.jar" /opt/pack/server.jar
  rm -f /opt/pack/*.log

  for dir in mods config defaultconfigs scripts kubejs; do
    if unzip -l "$PACK" "${dir}/*" >/dev/null 2>&1; then
      unzip -qo "$PACK" "${dir}/*" -d /opt/pack
    fi
  done
}

install_mrpack() {
  : "${MRPACK_INSTALL_VERSION:?set via Dockerfile ARG MRPACK_INSTALL_VERSION}"
  local base bin expected
  base="https://github.com/nothub/mrpack-install/releases/download/v${MRPACK_INSTALL_VERSION}"
  bin="mrpack-install-${MRPACK_ARCH}"

  curl -fsSL "$base/$bin" -o /usr/local/bin/mrpack-install
  # Verify against the release's published checksums (goreleaser checksums.txt),
  # same fail-closed pattern as the JRE (sha256) and Forge (sha1) downloads.
  curl -fsSL "$base/checksums.txt" -o /tmp/mrpack-checksums.txt
  expected="$(awk -v f="$bin" '{sub(/\r$/, "")} $2 == f {print $1}' /tmp/mrpack-checksums.txt)"
  [ "$expected" != "" ] || {
    echo "no checksum for $bin in $base/checksums.txt" >&2
    exit 1
  }
  printf '%s  /usr/local/bin/mrpack-install\n' "$expected" | sha256sum -c -

  chmod +x /usr/local/bin/mrpack-install
  mrpack-install "$PACK" --server-dir /opt/pack --server-file server.jar
}

detect_arch
read_pack_metadata
install_jre

case "$PACK_FORMAT" in
curseforge) install_curseforge_pack ;;
mrpack) install_mrpack ;;
esac
