#!/usr/bin/env sh
# Entrypoint for pack-based servers (/busybox/sh in distroless runner).
# /data (volume) holds world + mutable runtime state; /opt/pack (image) holds
# immutable loader, libraries, mods, and pack-shipped config defaults.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
PACK_DIR="${PACK_DIR:-/opt/pack}"

read_level_name() {
  if [ -f "$DATA_DIR/server.properties" ]; then
    level="$(sed -n 's/^level-name=//p' "$DATA_DIR/server.properties" | tr -d '\r')"
    if [ "$level" != "" ]; then
      printf '%s\n' "$level"
      return
    fi
  fi
  printf 'world\n'
}

stage_pack() {
  level_name="$(read_level_name)"

  for src in "$PACK_DIR"/*; do
    [ -e "$src" ] || continue
    name="${src##*/}"

    if [ "$name" = "$level_name" ]; then
      echo "Skipping protected world entry in $PACK_DIR: $name" >&2
      continue
    fi

    case "$name" in
    config)
      # Pack-shipped configs overwrite matching files so pack updates apply;
      # runtime-only mod configs in $DATA_DIR/config remain untouched.
      if [ -L "$DATA_DIR/config" ]; then
        rm -f "$DATA_DIR/config"
      fi
      mkdir -p "$DATA_DIR/config"
      cp -rf "$src/." "$DATA_DIR/config/"
      ;;
    eula.txt | server.properties | server-icon.png)
      # Bind-mounted read-only by compose.yaml.
      ;;
    world | asetland | saves | logs | crash-reports | backups | ops.json | whitelist.json | banned-players.json | banned-ips.json | usercache.json)
      echo "Skipping protected state entry in $PACK_DIR: $name" >&2
      ;;
    *)
      rm -rf "${DATA_DIR:?}/$name"
      ln -s "$src" "$DATA_DIR/$name"
      ;;
    esac
  done
}

cd "$DATA_DIR"
stage_pack

# 8G fits this 19GB host alongside other services. Equal Xms/Xmx avoids heap
# resize pauses; G1 flags match Aikar's <12GB profile (itzg USE_AIKAR_FLAGS).
HEAP="${MEMORY_ALLOCATION:-8G}"
echo "Memory allocation: $HEAP"

exec "${JAVA_BIN:-java}" \
  -Xms"$HEAP" \
  -Xmx"$HEAP" \
  -XX:+UseG1GC \
  -XX:+ParallelRefProcEnabled \
  -XX:MaxGCPauseMillis=200 \
  -XX:+UnlockExperimentalVMOptions \
  -XX:+DisableExplicitGC \
  -XX:+AlwaysPreTouch \
  -XX:G1NewSizePercent=30 \
  -XX:G1MaxNewSizePercent=40 \
  -XX:G1HeapRegionSize=8M \
  -XX:G1ReservePercent=20 \
  -XX:G1HeapWastePercent=5 \
  -XX:G1MixedGCCountTarget=4 \
  -XX:InitiatingHeapOccupancyPercent=15 \
  -XX:G1MixedGCLiveThresholdPercent=90 \
  -XX:G1RSetUpdatingPauseTimePercent=5 \
  -XX:SurvivorRatio=32 \
  -XX:+PerfDisableSharedMem \
  -XX:MaxTenuringThreshold=1 \
  -XX:+UseTransparentHugePages \
  -jar server.jar \
  nogui
