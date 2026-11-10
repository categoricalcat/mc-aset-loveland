# mc-aset-loveland

A Dockerized Minecraft server running Fabric 1.21.5 with automated modpack installation and backups.

## Tech Stack

- Docker & Docker Compose
- Fabric-powered Minecraft server
- TypeScript for modpack processing
- Playit.gg tunnel for external access
- Zstd compression for backups

## Getting Started

```bash
git clone [repo-url]
cd mc-aset-loveland
docker compose up -d
```

That's it. Connect to `localhost:25565`.

## How to Run

```bash
# Start server
docker compose up -d

# Stop server
docker compose down

# View logs
docker compose logs -f server
```

## Backups

```bash
# Live backup, no downtime (freezes world saves via RCON, backs up, unfreezes)
./scripts/backup.sh

# Restore from latest (per-volume latest-<volume>.tar.zst)
docker compose --profile restore run --rm restore read
```

Archives exclude `mods/`, `libraries/`, caches and jars — those are
re-installed from the modpack on boot. World, config and player data are kept.

Other volumes: `BACKUP_VOLUME=mc-data BACKUP_SERVICE=server ./scripts/backup.sh`
(RCON freeze only works on itzg-based services; a stopped/static volume is
backed up directly).

## Update Modpack

1. Replace `the-modpack.mrpack`
2. Rebuild:
   ```bash
   docker compose build server
   docker compose up -d --force-recreate server
   ```

## Config

Edit `docker-compose.yaml`:

- `MEMORY_ALLOCATION`: Server RAM (default: 16G)
- `FABRIC_VERSION`: Minecraft version (1.21.5)

Server settings: `server.properties`

## Optional: Process Modpack

Enriches modpack with metadata from Modrinth:

```bash
pnpm install
pnpm run process
```

Creates `the-modpack-processed.mrpack` with enhanced mod info.
