#!/usr/bin/env sh
# Single backup entry point, two environments:
#   host:      ./scripts/backup.sh   freeze saves via RCON, back up, unfreeze
#   container: compose entrypoint sets OPERATION=write|read|restic
# Reproducible content (mods, loader, jars) is excluded everywhere — it is
# re-installed from the modpack on boot; only world/config/player data is kept.
set -e
# Fail the run if tar degrades (e.g. "file changed as we read it" on a live
# server) instead of letting the pipe report zstd's success. Not POSIX, but
# busybox ash (backup container) and bash (host) both support it.
# shellcheck disable=SC3040
set -o pipefail 2>/dev/null || true

OPERATION="${1:-${OPERATION:-}}"

# ---------------- host mode ----------------
if [ "$OPERATION" = "" ]; then
  # pick up BACKUP_VOLUME, BACKUP_SERVICE, RESTIC from .env if present.
  # Whitelist parse: .env is compose syntax, NOT shell (values may contain
  # spaces) — sourcing it executes garbage like "1.1.mrpack".
  if [ -f .env ]; then
    while IFS='=' read -r k v; do
      # strip matching surrounding quotes (compose tolerates them, we don't)
      case "$v" in
      \"*\" | \'*\')
        v=${v#?}
        v=${v%?}
        ;;
      esac
      case "$k" in
      BACKUP_VOLUME) BACKUP_VOLUME="$v" ;;
      BACKUP_SERVICE) BACKUP_SERVICE="$v" ;;
      RESTIC) RESTIC="$v" ;;
      esac
    done <.env
  fi

  SERVICE="${BACKUP_SERVICE:-bias}"
  VOLUME="${BACKUP_VOLUME:-mc-bias}"

  # portable running-check: `compose ps --status` is unsupported by podman-compose
  CID=$(docker compose ps -q "$SERVICE" 2>/dev/null || true)
  if [ "$CID" != "" ] && [ "$(docker inspect -f '{{.State.Running}}' "$CID" 2>/dev/null)" = "true" ]; then
    echo "Freezing world saves on $SERVICE..."
    docker compose exec -T "$SERVICE" rcon-cli save-all flush
    docker compose exec -T "$SERVICE" rcon-cli save-off
    # Always re-enable saving, even if the backup fails
    trap 'docker compose exec -T "$SERVICE" rcon-cli save-on' EXIT
  else
    echo "$SERVICE not running; backing up static volume $VOLUME."
  fi

  BACKUP_VOLUME="$VOLUME" docker compose --profile backup run --rm backup write

  # shadow incremental run (becomes the primary once restore-tested)
  if [ "${RESTIC:-0}" = "1" ]; then
    BACKUP_VOLUME="$VOLUME" docker compose --profile restic run --rm restic
  fi
  exit 0
fi

# ---------------- container worker mode ----------------
BACKUP_DIR="${BACKUP_DIR:-/backup}"
DATA_DIR="${DATA_DIR:-/data}"
VOLUME_NAME="${BACKUP_VOLUME:-mc-data}"

# Exclude FILE (not a split string): shellharden must not break word-splitting.
# $1 = path prefix ("." for tar -C, "$DATA_DIR" for restic)
write_exclude_file() {
  f="$(mktemp)"
  {
    for d in mods libraries cache .cache logs crash-reports versions; do
      echo "$1/$d"
    done
    echo "$1/*.jar"
    if [ "$OPERATION" = "restic" ]; then
      echo "$1/modpacks"
    fi
  } >"$f"
  echo "$f"
}

# progress: animated bar on a TTY; newline percentages through log muxes
# (compose up/podman-compose swallow \r updates and show only the last)
pv_progress() {
  if [ -t 2 ]; then
    pv -fs "$1" -N backup
  else
    pv -fns "$1" -i 10
  fi
}

case "$OPERATION" in
write)
  ARCHIVE="${ARCHIVE:-${VOLUME_NAME}-$(date +%Y-%m-%d-%H-%M-%S).tar.zst}"
  LATEST="latest-${VOLUME_NAME}.tar.zst"
  EXCLUDE_FILE="$(write_exclude_file .)"

  echo "Starting backup of $VOLUME_NAME to $ARCHIVE..."
  # size estimate for pv's ETA; same exclusions as the tar.
  # (cd so exclude patterns like ./mods match du's printed paths)
  SIZE=$(cd "$DATA_DIR" && du -sb --exclude-from="$EXCLUDE_FILE" . | cut -f1)
  # -15: region data is already dense; -19 bought 2% for +28% time,
  # --ultra -22 measured ~60min. -15 is the speed/size sweet spot.
  tar -C "$DATA_DIR" --exclude-from="$EXCLUDE_FILE" -cf - . |
    pv_progress "$SIZE" |
    zstd -15 -T0 --long=27 >"$BACKUP_DIR/$ARCHIVE"
  cp "$BACKUP_DIR/$ARCHIVE" "$BACKUP_DIR/$LATEST"
  echo "Backup completed! Archive stored at $BACKUP_DIR/$ARCHIVE"
  ;;
read)
  LATEST="latest-${VOLUME_NAME}.tar.zst"
  if [ ! -f "$BACKUP_DIR/$LATEST" ]; then
    echo "No backup archive found at $BACKUP_DIR/$LATEST"
    exit 1
  fi
  echo "Restoring $VOLUME_NAME from $BACKUP_DIR/$LATEST..."
  echo "Clearing existing data in $DATA_DIR..."
  rm -rf "${DATA_DIR:?}"/*
  mkdir -p "$DATA_DIR"
  zstd -d --long=27 -c "$BACKUP_DIR/$LATEST" | tar -xf - -C "$DATA_DIR"
  echo "Restore completed!"
  ;;
restic)
  # Incremental dedup snapshots; NOTHING is ever forgotten or pruned.
  : "${RESTIC_PASSWORD:?RESTIC_PASSWORD required — set it in .env}"
  export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-/repo}"
  EXCLUDE_FILE="$(write_exclude_file "$DATA_DIR")"

  # config file present = repo exists; avoids re-init on wrong password
  if [ ! -f "$RESTIC_REPOSITORY/config" ]; then
    echo "Initializing restic repo at $RESTIC_REPOSITORY..."
    restic init
  fi
  echo "Starting restic backup of $VOLUME_NAME..."
  restic backup "$DATA_DIR" --tag "$VOLUME_NAME" --exclude-file="$EXCLUDE_FILE"
  echo "Restic snapshot completed."
  restic snapshots --latest 1
  ;;
*)
  echo "Usage: $0 {write|read|restic}"
  exit 1
  ;;
esac
