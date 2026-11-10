#!/usr/bin/env sh
# Dual-mode backup:
#   host:      ./scripts/backup.sh        freeze saves via RCON, back up, unfreeze
#   container: compose entrypoint sets OPERATION=write|read -> tar|zstd worker
set -e
# Fail the run if tar degrades (e.g. "file changed as we read it" on a live
# server) instead of letting the pipe report zstd's success. Not POSIX, but
# busybox ash (backup container) and bash (host) both support it.
# shellcheck disable=SC3040
set -o pipefail 2>/dev/null || true

OPERATION="${1:-${OPERATION:-}}"

# ---------------- host mode ----------------
if [ "$OPERATION" = "" ]; then
  SERVICE="${BACKUP_SERVICE:-bias}"
  VOLUME="${BACKUP_VOLUME:-mc-bias}"

  if docker compose ps --status running -q "$SERVICE" | grep -q .; then
    echo "Freezing world saves on $SERVICE..."
    docker compose exec -T "$SERVICE" rcon-cli save-all flush
    docker compose exec -T "$SERVICE" rcon-cli save-off
    # Always re-enable saving, even if the backup fails
    trap 'docker compose exec -T "$SERVICE" rcon-cli save-on' EXIT
  else
    echo "$SERVICE not running; backing up static volume $VOLUME."
  fi

  BACKUP_VOLUME="$VOLUME" docker compose --profile backup run --rm backup write
  exit 0
fi

# ---------------- container worker mode ----------------
BACKUP_DIR="${BACKUP_DIR:-/backup}"
DATA_DIR="${DATA_DIR:-/data}"
VOLUME_NAME="${BACKUP_VOLUME:-mc-data}"
ARCHIVE="${ARCHIVE:-${VOLUME_NAME}-$(date +%Y-%m-%d-%H-%M-%S).tar.zst}"
LATEST="latest-${VOLUME_NAME}.tar.zst"

# Reproducible content (mods, loader, jars) is re-installed from the modpack
# on boot — only world, config and player data are worth the archive space.
EXCLUDES="
  --exclude=./mods
  --exclude=./libraries
  --exclude=./cache
  --exclude=./.cache
  --exclude=./logs
  --exclude=./crash-reports
  --exclude=./versions
  --exclude=./*.jar
"

case "$OPERATION" in
write)
  echo "Starting backup of $VOLUME_NAME to $ARCHIVE..."
  # shellcheck disable=SC2086
  tar -C "$DATA_DIR" "$EXCLUDES" -cf - . |
    zstd -9 -T0 >"$BACKUP_DIR/$ARCHIVE"
  cp "$BACKUP_DIR/$ARCHIVE" "$BACKUP_DIR/$LATEST"
  echo "Backup completed! Archive stored at $BACKUP_DIR/$ARCHIVE"
  ;;
read)
  if [ ! -f "$BACKUP_DIR/$LATEST" ]; then
    echo "No backup archive found at $BACKUP_DIR/$LATEST"
    exit 1
  fi
  echo "Restoring $VOLUME_NAME from $BACKUP_DIR/$LATEST..."
  echo "Clearing existing data in $DATA_DIR..."
  rm -rf "${DATA_DIR:?}"/*
  mkdir -p "$DATA_DIR"
  zstd -d -c "$BACKUP_DIR/$LATEST" | tar -xf - -C "$DATA_DIR"
  echo "Restore completed!"
  ;;
*)
  echo "Usage: $0 {write|read}"
  exit 1
  ;;
esac
