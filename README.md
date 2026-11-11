# mc-aset-loveland

Dockerized Minecraft server stack supporting Modrinth (`.mrpack`) and CurseForge (`.zip`) packs with Playit tunnel routing and compressed/incremental backups.

## Tech Stack

- Docker & Docker Compose
- NeoForge, Fabric, and Forge Minecraft servers
- TypeScript for Modrinth modpack `env` processing
- Playit.gg tunnel for external access
- Zstd + Restic for world backups

## Getting Started

```bash
git clone [repo-url]
cd mc-aset-loveland

# Default stack: bias (NeoForge) + Playit tunnel
docker compose up -d

# Local Fabric pack server on localhost:25565
docker compose --profile server up -d

# Legacy CurseForge serverpack on localhost:25566
docker compose --profile serverpack up -d
```

## How to Run

```bash
# Stop running services
docker compose down

# View logs (bias or profile service)
docker compose logs -f bias
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
Compression is `zstd -15 -T0 --long=27` (measured sweet spot: -19 bought 2%
for +28% time, `--ultra -22` took ~60min).

Policy: backups are NEVER auto-deleted — no retention pruning, no restic
forget. `.backups/` grows; curation is manual.

Other volumes: `BACKUP_VOLUME=mc-data BACKUP_SERVICE=server ./scripts/backup.sh`
(RCON freeze only works on itzg-based services; services without `rcon-cli` or
stopped volumes are backed up directly). The host script whitelist-parses `.env`
(compose syntax is not shell-safe to source), so `BACKUP_VOLUME`,
`BACKUP_SERVICE` and `RESTIC=1` can live there instead of inline prefixes.

## Incremental backups (restic, shadow)

Deduplicated snapshots alongside the tar.zst flow; dedup makes repeat
snapshots nearly free. Requires `RESTIC_PASSWORD` in `.env`.

```bash
RESTIC=1 ./scripts/backup.sh          # tar.zst + restic snapshot
docker compose --profile restic run --rm restic   # restic only
```

## World size

The world is large and stays that way — no chunk pruning. Backup economics
come from compression (tar.zst) and dedup (restic), not from shrinking the
world.

## Update Modpack

The pack is the only manual input. Minecraft, loader and Java versions are
read from it at build time (`scripts/install-pack.sh`): `.mrpack` via
mrpack-install, CurseForge instance zip (`ServerPack.zip`) via the Forge
installer. Mods/loader are linked from the image on every start, so the
volume only holds world and state.

1. Replace `the-modpack.mrpack` (or set `MODPACK_ARCHIVE` in `.env`)
2. Rebuild:
   ```bash
   docker compose --profile server build server
   docker compose --profile server up -d --force-recreate server
   ```

`bias` (itzg, `TYPE=MODRINTH`) reads its versions from `bias-processed.mrpack`;
replace it and `docker compose up -d --force-recreate bias`.

## Config

Edit `compose.yaml` / `.env`:

- `MEMORY_ALLOCATION`: Pack server RAM for `server` / `serverpack` (default: 8G)
- `MODPACK_ARCHIVE`: Fabric server pack (default: `the-modpack.mrpack`)

Server settings: `server.properties`

## Optional: Process Modpack

Updates `.mrpack` client/server `env` flags from Modrinth project metadata:

```bash
pnpm install
pnpm run process                 # bias.mrpack -> bias-processed.mrpack
pnpm run process the-modpack     # the-modpack.mrpack -> the-modpack-processed.mrpack
```
