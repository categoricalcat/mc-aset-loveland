#!/usr/bin/env sh
# Unified backup entrypoint:
#   host mode (default):   ./scripts/backup.sh   console freeze -> backup -> unfreeze
#   worker mode (compose): OPERATION=write|read|restic (or $1) inside container
# Reproducible content (mods, libraries, caches, jars) is excluded everywhere.
set -eu
# Fail pipelines if tar degrades on a live volume; supported by ash and bash.
# shellcheck disable=SC3040
set -o pipefail 2>/dev/null || true

DEFAULT_VOLUME="asetland"
DEFAULT_SERVICE="bias"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-asetland}"
BACKUP_DIR="${BACKUP_DIR:-/backup}"
DATA_DIR="${DATA_DIR:-/data}"
MODE="${1:-${OPERATION:-host}}"

# Whitelist-parse .env (compose .env allows unquoted spaces, unsafe to source).
load_host_env() {
  [ -f .env ] || return 0
  cr="$(printf '\r')"
  while IFS='=' read -r key val || [ "$key" != "" ]; do
    val="${val%"$cr"}"
    case "$val" in
    \"*\" | \'*\')
      val="${val#?}"
      val="${val%?}"
      ;;
    esac
    case "$key" in
    BACKUP_VOLUME) : "${BACKUP_VOLUME:=$val}" ;;
    BACKUP_SERVICE) : "${BACKUP_SERVICE:=$val}" ;;
    RESTIC) : "${RESTIC:=$val}" ;;
    esac
  done <.env
}

# Query running container via compose labels directly: `podman-compose ps`
# rejects service arguments and `compose exec` requires `--profile` flags.
find_running_container() {
  cid="$(
    docker ps -q \
      --filter "label=com.docker.compose.project=$PROJECT_NAME" \
      --filter "label=com.docker.compose.service=$SERVICE" \
      --filter "status=running" 2>/dev/null || true
  )"
  printf '%s\n' "${cid%%
*}"
}

freeze_saves_if_supported() {
  FROZEN_CID="$(find_running_container)"
  if [ "$FROZEN_CID" = "" ]; then
    echo "$SERVICE not running; backing up static volume $VOLUME."
    return
  fi

  # RCON is disabled server-side; drive the console pipe instead.
  if ! docker exec "$FROZEN_CID" sh -c 'command -v mc-send-to-console >/dev/null 2>&1' 2>/dev/null; then
    echo "$SERVICE has no mc-send-to-console; backing up live volume $VOLUME without console freeze." >&2
    return
  fi

  echo "Freezing world saves on $SERVICE..."
  # mc-send-to-console is fire-and-forget: disable auto-save, force a flush, then
  # let the server drain pending region writes before the archive reads /data.
  # Trap first so an interrupt mid-flush still re-enables saves.
  trap 'docker exec "$FROZEN_CID" mc-send-to-console save-on' EXIT
  docker exec "$FROZEN_CID" mc-send-to-console save-off
  docker exec "$FROZEN_CID" mc-send-to-console save-all flush
  sleep 5
}

run_host_backup() {
  load_host_env
  SERVICE="${BACKUP_SERVICE:-$DEFAULT_SERVICE}"
  VOLUME="${BACKUP_VOLUME:-$DEFAULT_VOLUME}"

  freeze_saves_if_supported

  BACKUP_VOLUME="$VOLUME" docker compose --profile backup run --rm backup write
  if [ "${RESTIC:-0}" = "1" ]; then
    BACKUP_VOLUME="$VOLUME" docker compose --profile restic run --rm restic
  fi
}

# Generate exclude file for pack-linked content (mods, libraries, jars).
# $1 = path prefix ("." for tar -C, "$DATA_DIR" for restic)
write_exclude_file() {
  exclude_file="$(mktemp)"
  {
    for dir in mods libraries cache .cache logs crash-reports versions; do
      echo "$1/$dir"
    done
    echo "$1/*.jar"
    if [ "$MODE" = "restic" ]; then
      echo "$1/modpacks"
    fi
  } >"$exclude_file"
  echo "$exclude_file"
}

# Animated progress bar on TTY; periodic newline percentages through log muxes.
pv_progress() {
  if [ -t 2 ]; then
    pv -fs "$1" -N backup
  else
    pv -fns "$1" -i 10
  fi
}

backup_tar() {
  volume="${BACKUP_VOLUME:-$DEFAULT_VOLUME}"
  archive="${ARCHIVE:-${volume}-$(date +%Y-%m-%d-%H-%M-%S).tar.zst}"
  latest="latest-${volume}.tar.zst"
  exclude_file="$(write_exclude_file .)"

  echo "Starting backup of $volume to $archive..."
  # Run du from $DATA_DIR so ./<dir> exclude patterns match printed paths.
  size="$(cd "$DATA_DIR" && du -sb --exclude-from="$exclude_file" . | cut -f1)"
  # zstd -15: measured speed/size sweet spot on region data (-19 gained 2% for +28% time).
  tar -C "$DATA_DIR" --exclude-from="$exclude_file" -cf - . |
    pv_progress "$size" |
    zstd -15 -T0 --long=27 >"$BACKUP_DIR/$archive"
  cp "$BACKUP_DIR/$archive" "$BACKUP_DIR/$latest"
  echo "Backup completed: $BACKUP_DIR/$archive"
}

restore_tar() {
  volume="${BACKUP_VOLUME:-$DEFAULT_VOLUME}"
  latest="latest-${volume}.tar.zst"
  if [ ! -f "$BACKUP_DIR/$latest" ]; then
    echo "No backup archive found at $BACKUP_DIR/$latest" >&2
    exit 1
  fi

  echo "Restoring $volume from $BACKUP_DIR/$latest..."
  echo "Clearing existing data in $DATA_DIR..."
  rm -rf "${DATA_DIR:?}"/*
  mkdir -p "$DATA_DIR"
  zstd -d --long=27 -c "$BACKUP_DIR/$latest" | tar -xf - -C "$DATA_DIR"
  echo "Restore completed."
}

backup_restic() {
  # Incremental dedup snapshots; nothing is ever forgotten or pruned.
  : "${RESTIC_PASSWORD:?RESTIC_PASSWORD required — set it in .env}"
  export RESTIC_REPOSITORY="${RESTIC_REPOSITORY:-/repo}"
  volume="${BACKUP_VOLUME:-$DEFAULT_VOLUME}"
  exclude_file="$(write_exclude_file "$DATA_DIR")"

  # Check config file directly so a wrong password never triggers re-init.
  if [ ! -f "$RESTIC_REPOSITORY/config" ]; then
    echo "Initializing restic repo at $RESTIC_REPOSITORY..."
    restic init
  fi

  echo "Starting restic backup of $volume..."
  restic backup "$DATA_DIR" --tag "$volume" --exclude-file="$exclude_file"
  echo "Restic snapshot completed."
  restic snapshots --latest 1
}

case "$MODE" in
host) run_host_backup ;;
write) backup_tar ;;
read) restore_tar ;;
restic) backup_restic ;;
*)
  echo "Usage: $0 [write|read|restic]" >&2
  exit 1
  ;;
esac
