#!/bin/sh
# Entrypoint for asetland-server. /opt/pack is the tree from install-pack
# (read-only). /data holds the world and mutable state. This script links the
# pack into /data and execs Java. It does not install or download.
set -eu

DATA_DIR="${DATA_DIR:-/data}"
JAVA_ROOT="${JAVA_ROOT:-/opt/java}"
PACK_DIR="${PACK_DIR:-/opt/pack}"
# Same path as /bin/mc-send-to-console.
PIPE=/tmp/minecraft-console-in

if [ ! -e "$PACK_DIR/server.jar" ]; then
  echo "No installed pack at $PACK_DIR (server.jar missing). Run: nix run .#install-pack -- DEST ARCHIVE" >&2
  exit 1
fi

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
    # mrpack-install bookkeeping, not server files.
    packstate.json | backups)
      ;;
    world | asetland | saves | logs | crash-reports | ops.json | whitelist.json | banned-players.json | banned-ips.json | usercache.json)
      echo "Skipping protected state entry in $PACK_DIR: $name" >&2
      ;;
    *)
      rm -rf "${DATA_DIR:?}/$name"
      ln -s "$src" "$DATA_DIR/$name"
      ;;
    esac
  done

  # overrides/<level>/datapacks ships a datapack without replacing the world.
  if [ -d "$PACK_DIR/$level_name/datapacks" ]; then
    mkdir -p "$DATA_DIR/$level_name/datapacks"
    cp -rf "$PACK_DIR/$level_name/datapacks/." "$DATA_DIR/$level_name/datapacks/"
  fi
}

stage_pack

# Host c2me.toml wins over the pack copy.
if [ -f /opt/host/c2me.toml ]; then
  mkdir -p "$DATA_DIR/config"
  cp /opt/host/c2me.toml "$DATA_DIR/config/c2me.toml"
fi

JAVA_BIN="$JAVA_ROOT/bin/java"
if [ ! -x "$JAVA_BIN" ]; then
  echo "JRE missing at $JAVA_BIN" >&2
  exit 1
fi
echo "Java: $JAVA_BIN"

cd "$DATA_DIR"

# 8G fits this 19GB host alongside other services. Equal Xms/Xmx avoids heap
# resize pauses; G1 flags match Aikar's <12GB profile.
HEAP="${MEMORY_ALLOCATION:-8G}"
echo "Memory allocation: $HEAP"

rm -f "$PIPE"
mkfifo "$PIPE"
# RDWR holds the fifo open so Java does not see EOF between command writers.
# Java reads the fifo itself; a tail pipeline would block-buffer stdin.
exec 3<>"$PIPE"

(
  while IFS= read -r line; do
    printf '%s\n' "$line" >"$PIPE"
  done
) &
stdin_pid=$!

trap 'printf "%s\n" stop >"$PIPE"' TERM INT

"$JAVA_BIN" \
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
  nogui <&3 &
java_pid=$!

while true; do
  status=0
  wait "$java_pid" || status=$?
  kill -0 "$java_pid" 2>/dev/null || break
done

kill "$stdin_pid" 2>/dev/null || true
exit "$status"
