# mc-aset-loveland

Dockerized Minecraft server stack supporting Modrinth (`.mrpack`) and CurseForge (`.zip`) packs with Playit tunnel routing and compressed/incremental backups.

## Tech Stack

- Docker & Docker Compose
- Nix (flake) for the server and backup images
- Temurin 25, the only server JRE
- NeoForge, Fabric, and Forge Minecraft servers
- TypeScript for Modrinth modpack `env` processing
- Playit.gg tunnel for external access
- Zstd + Restic for world backups

## Getting Started

```bash
git clone [repo-url]
cd mc-aset-loveland

# Load every image into docker: Nix-built asetland-server / asetland-backup and
# digest-pinned playit-agent. Compose never builds or pulls; re-run after Nix
# or script changes. Bump the playit pin: new digest in nix/images.nix
# (`skopeo inspect docker://ghcr.io/playit-cloud/playit-agent:latest`), then
# fix the hash.
nix run .#load-images

# Install the live pack. The .mrpack stays a local file; this writes .packs/bias.
nix run .#install-pack -- .packs/bias bias-update-server.mrpack

# Default stack: bias + Playit tunnel
docker compose up -d
```

## How to Run

```bash
# Stop running services
docker compose down

# View logs (bias or profile service)
docker compose logs -f bias
docker compose logs -f server
```

## Admin (ops and whitelist)

RCON and the query listener are disabled; the server is whitelist-only. Run
console commands through the console pipe (no remote port, no password):

```bash
# Grant op / manage the whitelist (bias is whitelist-enforced)
docker compose exec bias mc-send-to-console op <player>
docker compose exec bias mc-send-to-console whitelist add <player>
docker compose exec bias mc-send-to-console whitelist reload

# Or attach to the live console (Ctrl-p Ctrl-q to detach without stopping)
docker attach "$(docker ps -qf label=com.docker.compose.service=bias)"
```

Ops bypass the whitelist, so seeding one op is enough to get in.

To bootstrap before first launch, seed `ops.json` and `whitelist.json` in the
world volume (`asetland`). `scripts/start-server.sh` leaves them in place
across pack updates.

## Backups

```bash
# Live backup, no downtime (freezes world saves via server console, backs up, unfreezes)
./scripts/backup.sh

# Restore from latest (per-volume latest-<volume>.tar.zst)
docker compose --profile restore run --rm restore read
```

Archives exclude `mods/`, `libraries/`, caches and jars — those are symlinks
to the installed pack, recreated on start. World, config and player data are
kept. A restore needs the matching `.packs` tree.

Compression is `zstd -15 -T0 --long=27` (measured sweet spot: -19 bought 2%
for +28% time, `--ultra -22` took ~60min).

Policy: backups are NEVER auto-deleted — no retention pruning, no restic
forget. `.backups/` grows; curation is manual.

Other volumes: `BACKUP_VOLUME=mc-data BACKUP_SERVICE=server ./scripts/backup.sh`
(console freeze runs when the container has `mc-send-to-console`; services
without it, or stopped volumes, are backed up directly). The host script whitelist-parses `.env`
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

- `<stem>-update-server.mrpack` — `install-pack` reads this and writes `.packs/bias`
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

Leave `saves` unchecked. The world is volume `asetland`
(`level-name=asetland`); an exported save overwrites it. Leave `logs` and
`crash-reports` unchecked. NeoForge 26 loads coremods from mod jars. World
datapacks belong in that volume at `asetland/datapacks/`. To ship one inside
the pack, place it at `overrides/asetland/datapacks/`.

```bash
pnpm install
pnpm run update # bias.mrpack -> bias-update-server.mrpack + bias-update-client.mrpack
nix run .#install-pack -- .packs/bias bias-update-server.mrpack
docker compose up -d --force-recreate bias
```

The first switch replaces `mods/`, `libraries/`, and jars on the volume with
symlinks into `.packs/bias`. The world is left as it is. A second
`install-pack` with the same archive sha256 does nothing. Restarting the
container does not reinstall.

`WORLD_VOLUME` selects the Docker volume (default `asetland`). Another pack
uses its own volume; installing a different archive into `.packs/bias` and
reusing the volume shares that volume's world with the new pack.

```bash
pnpm run update other
nix run .#install-pack -- .packs/bias other-update-server.mrpack
WORLD_VOLUME=mc-other docker compose up -d --force-recreate bias
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

Conflict check: before either pack is written, the run fails (exit 1, no
zip) on any declared conflict:

- a Modrinth `incompatible` dependency between two mods in the pack
  (whole project when `version_id` is null; that version when it is set)
- two `overrides/mods` jars from the same Modrinth project or with the same
  Fabric mod id
- a Fabric `breaks` entry with range `*` naming another override jar

Override jars are matched to Modrinth by sha1. A match whose project is
already in the index is removed. Unmatched jars fall back to the filename
prefix. Pinned `required` versions, `embedded` projects also shipped as their
own file, Fabric `conflicts` entries, and `breaks` entries with any other
range (not evaluated) are printed as warnings. Undeclared mixin or class
clashes are not detected.

### server / serverpack

Same image and the same Temurin 25 JRE as bias. `install-pack` does not pick
a Java version. It writes `.packs/server` from a `.mrpack`, or
`.packs/serverpack` from a CurseForge zip, using the Forge installer version
named in that zip. Packs that need an older JRE are not a supported runtime.

```bash
nix run .#install-pack -- .packs/server the-modpack.mrpack
docker compose --profile server up -d --force-recreate server

nix run .#install-pack -- .packs/serverpack ServerPack.zip
docker compose --profile serverpack up -d --force-recreate serverpack
```

## Config

Edit `compose.yaml` / `.env`:

- `MEMORY_ALLOCATION`: heap for `bias` / `server` / `serverpack` (default: `8G`)
- `WORLD_VOLUME`: bias world volume (default: `asetland`)

Server settings: `server.properties`

## Optional: Process Modpack

Rewrites `.mrpack` client/server `env` flags from Modrinth project metadata.
Versions stay as exported. `server=unsupported` files are omitted. bias is
installed from `<stem>-update-server.mrpack`, not this output.

```bash
pnpm install
pnpm run process                 # bias.mrpack -> bias-processed.mrpack
pnpm run process the-modpack     # the-modpack.mrpack -> the-modpack-processed.mrpack
```
