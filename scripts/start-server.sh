#!/usr/bin/env sh

set -e

# Change to the minecraft server directory.
# /data is the serverpack layout; the Fabric image sets SERVER_DIR=/opt/minecraft/mc.
cd "${SERVER_DIR:-/data}"

if [ "${PATH_TO_JAR:-}" = "" ]; then
  # serverpack default; the Fabric image sets PATH_TO_JAR=server.jar
  PATH_TO_JAR="server-1.16.5.jar"
fi

echo "Starting server..."
echo "Memory allocation: ${MEMORY_ALLOCATION:-6G}"
echo "Fabric launcher jar: ${PATH_TO_JAR}"
echo "Server directory: $PWD"

# list the directory
ls -la

exec java \
  -Xmx"${MEMORY_ALLOCATION:-6G}" \
  -Xms2G \
  -jar "$PATH_TO_JAR" \
  nogui
