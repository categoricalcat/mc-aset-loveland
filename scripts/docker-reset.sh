#!/usr/bin/env bash
# Sourced helper library, not executed directly:
#   source scripts/docker-reset.sh
#   prune     - nuke all docker data (system prune incl. volumes)
#   down_hard - compose down incl. images, volumes, orphans
#   up        - compose up

function prune() {
  docker system prune -af --volumes
}

function down_hard() {
  docker compose down --rmi all -v --remove-orphans
}

function up() {
  docker compose up
}
