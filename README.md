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

### bias (live)

`pnpm run update <stem>` reads `<stem>.mrpack` (default `bias.mrpack`) and
writes two packs from that resolution:

- `<stem>-update-server.mrpack` — compose mounts this into itzg (`TYPE=MODRINTH`)
- `<stem>-update-client.mrpack` — import this in Prism. Same loader and the same
  updated jars as the server pack, plus client-only mods, resource packs,
  shader packs, and `overrides/mods`

Prism export, check:

- `mods` — index entries. Install each mod from Modrinth in Prism. Jars Prism
  cannot link land in `overrides/mods`. The client pack keeps that directory,
  except a jar whose mod is already in the index (the index file is the
  updated one). The server pack does not include it.
- `config` — kept as `overrides/config`.
- `resourcepacks` and `shaderpacks` — kept on the client pack.

Leave `saves` unchecked. The world is volume `mc-bias`
(`level-name=asetland`); an exported save overwrites it. Leave `logs` and
`crash-reports` unchecked. NeoForge 26 loads coremods from mod jars. World
datapacks belong in that volume at `asetland/datapacks/`. To ship one inside
the pack, place it at `overrides/asetland/datapacks/`.

```bash
pnpm install
pnpm run update          # bias.mrpack -> bias-update-server.mrpack + bias-update-client.mrpack
pnpm run update other    # other.mrpack -> other-update-server.mrpack + other-update-client.mrpack
docker compose up -d --force-recreate bias
```

`PACK_STEM` selects which server pack `bias` mounts (default `bias`).
`WORLD_VOLUME` selects its Docker volume (default `mc-bias`). A second pack
uses its own volume; the same volume shares `mods/` and config with the
previous pack.

```bash
PACK_STEM=other WORLD_VOLUME=mc-other docker compose up -d --force-recreate bias
```

`pnpm run update` targets Minecraft 26.3. Both packs get:

- NeoForge when the index lists `neoforge`, otherwise Fabric, pinned to the
  latest 26.3 loader build
- Each mod replaced by its newest 26.3 release for that loader (any build
  when no release exists); required Modrinth dependencies are added
- client/server `env` rewritten from Modrinth

Mods with no 26.3 build are dropped from both (`Removed` in the log). A
resource pack or shader pack with no build for that loader stays at the
exported file. The server pack then omits `server=unsupported` files.
`overrides/mods` is only in the client pack. A run also deletes a leftover
`bias-updated.mrpack`.

### server / serverpack (image)

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

## Config

Edit `compose.yaml` / `.env`:

- `MEMORY_ALLOCATION`: Pack server RAM for `server` / `serverpack` (default: 8G)
- `MODPACK_ARCHIVE`: Fabric server pack (default: `the-modpack.mrpack`)
- `PACK_STEM`: itzg pack stem (default: `bias` → `bias-update-server.mrpack`)
- `WORLD_VOLUME`: itzg world volume (default: `mc-bias`)

Server settings: `server.properties`

## Optional: Process Modpack

Rewrites `.mrpack` client/server `env` flags from Modrinth project metadata.
Versions stay as exported. `server=unsupported` files are omitted. bias
mounts `<stem>-update-server.mrpack`, not this output.

```bash
pnpm install
pnpm run process                 # bias.mrpack -> bias-processed.mrpack
pnpm run process the-modpack     # the-modpack.mrpack -> the-modpack-processed.mrpack
```
