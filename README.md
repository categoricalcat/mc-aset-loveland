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

## Admin (ops and bans)

RCON and the query listener are disabled; the whitelist is off in
`server.properties` (`white-list=false`, `enforce-whitelist=false`), so any
Mojang-authenticated player (`online-mode=true`) can join. Run console commands
through the console pipe (no remote port, no password):

```bash
# Grant op / manage bans (or re-enable whitelist in server.properties)
docker compose exec bias mc-send-to-console op <player>
docker compose exec bias mc-send-to-console ban <player>

# Or attach to the live console (Ctrl-p Ctrl-q to detach without stopping)
docker attach "$(docker ps -qf label=com.docker.compose.service=bias)"
```

To bootstrap ops before first launch, seed `ops.json` in the world volume
(`asetland`). `scripts/start-server.sh` leaves `ops.json`, `whitelist.json`, and
ban lists in place across pack updates.

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

`pnpm run update` turns a Prism `.mrpack` export into a server pack and a
client pack for one Minecraft version (default 26.3). Each mod moves to its
newest build for that version, required dependencies are added, and declared
conflicts are checked before anything is written.

#### 1. Export from Prism

Check:

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

Save the export in the repository root as `bias.mrpack`, or as `<name>.mrpack`
for another pack.

#### 2. Run the update

```bash
pnpm install
pnpm run update                 # bias.mrpack -> bias-update-server.mrpack + bias-update-client.mrpack
pnpm run update other           # other.mrpack -> other-update-server.mrpack + other-update-client.mrpack
pnpm run update --game 26.4     # update to another Minecraft version
pnpm run update:preserve other  # keep mods that have no build for that version
pnpm run update --help
```

Usage: `pnpm run update [--game <version>] [pack]`. `pnpm run update:preserve`
takes the same arguments.

- `pack` — default `bias`. A name (`other` reads `other.mrpack`) or a path
  ending in `.mrpack`; outputs use the file name without `.mrpack`. pnpm runs
  scripts from the repository root, so paths are relative to it and the
  outputs land there.
- `--game <version>` — default `26.3`. The Minecraft version to update to. The
  loader is pinned to its latest build for that version.

Put arguments straight after the script name, without `--`. pnpm passes a `--`
on unchanged, so `pnpm run update -- --game 26.4` reads `--game` as the pack
name and fails. `pnpm run pack` takes the subcommand explicitly:
`pnpm run pack update --preserve --game 26.4 other`.

A successful run writes:

- `<name>-update-server.mrpack` — `install-pack` reads this and writes
  `.packs/bias`
- `<name>-update-client.mrpack` — import this in Prism. Same loader and the
  same updated jars as the server pack, plus client-only mods, resource packs,
  shader packs, and `overrides/mods`
- `errors.log` — problems that did not stop the run (see below); deleted when
  there are none

`.backups/<name>/` holds the extracted pack and is wiped at the start of each
run. Modrinth responses are cached on disk in `.backups/modrinth_cache/`:
project metadata and version lists expire after 24 hours, while version and
sha1 hash lookups never expire. Delete that directory to force a fully fresh
run. Requests are throttled to 4 per second (80% of Modrinth's limit), so the
first run against a cold cache takes a few minutes. A run also deletes a
leftover `bias-updated.mrpack`.

#### 3. Install on the server

```bash
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

#### What the update changes

Both packs get:

- NeoForge when the index lists `neoforge`, otherwise Fabric, pinned to the
  latest loader build for the target version
- Each mod replaced by its newest release for the target version and loader
  (any build when no release exists); required Modrinth dependencies are
  added, and an exact required version pin is selected instead of a newer
  project release
- client/server `env` carried over from the exported pack; newly added
  dependencies are required on both sides

Mods without a compatible build:

- `pnpm run update` drops a known Modrinth mod with no compatible build and
  lists it under `Removed` in the log.
- `pnpm run update:preserve` keeps that mod at its exported version, along
  with the dependencies it needs. Exact pins stay at their pinned version
  unless an updated mod also requires that project and the pin is
  incompatible; unpinned dependencies prefer a compatible build before falling
  back to an exported root version. If a preserved mod's exported version is
  gone from Modrinth, it is kept as exported without dependency checks —
  deleting a working mod because its metadata vanished is worse than
  shipping it unchecked.
- Entries kept at an exported or pinned version are listed under `Preserved`
  in the log. They keep their exported `env` and stay in
  required-dependency checks and override deduplication.

When exact pins conflict, a required dependency has no compatible build, or
pins keep flipping each other's versions, either command searches compatible
releases of the directly and transitively implicated roots. The search tries
at most 128 root-version states, then names projects to replace or remove; it
never guesses a pin.

An unrecognised root file, or a resource pack or shader pack with no build for
that loader, stays at the exported file. Exact pins such a pack declares on
mod projects are ignored, so those mods still update. If Modrinth no longer
has the pack's exported version, it is kept without dependency checks.

The server pack omits `server=unsupported` files. `overrides/mods` is only in
the client pack. Newly resolved entries and fetched preserved dependencies use
Modrinth URLs and SHA-1/SHA-512 hashes; preserved root entries keep their
exported paths, URLs, and hashes. The updater does not vendor mod JARs.

#### Failures and errors.log

A failed run exits 1 and leaves the previous output pair in place: both
archives are staged and replace the old ones only after every check passes.
Common messages:

- `... Replace or remove: <projects>` — no combination of compatible releases
  satisfies the pins and required dependencies. Replace or remove those
  projects in Prism, export again, and rerun.
- `mod conflicts; no pack written` — the conflict check below found a declared
  conflict.
- `no Fabric loader for <version>` or `no NeoForge build for <version>` — the
  target version has no loader build yet.
- `HTTP <status>` — a request to Modrinth or to the loader metadata server
  failed. Rerun once it responds.
- `cannot preserve <project>@<version>: no download` — a preserved or pinned
  version still exists on Modrinth but has no downloadable file.

Problems that do not stop the run go to `errors.log`: a required dependency
with no Modrinth project or version id (an external file), and a resource or
shader pack kept without metadata. Each successful run rewrites the file, or
deletes it when there is nothing to report, and prints the count. A failed run
leaves it untouched.

Conflict check: before either pack is written, the run fails on any declared
conflict. The client and server packs install different file sets, so each
side is checked against the files it actually installs:

- a Modrinth `incompatible` dependency between two mods in the pack
  (whole project when `version_id` is null; that version when it is set)
- a required Modrinth dependency of a shipped mod is absent from the entire
  pack
- two `overrides/mods` jars from the same Modrinth project or with the same
  Fabric mod id
- a Fabric `breaks` entry with range `*` naming another override jar

A required dependency with no Modrinth id is not a conflict; it goes to
`errors.log`. Also warnings, not conflicts: a dependency shipped only on the
other side, a dependency whose project has no builds for the pack's loader, a
pinned version that resolves to a different shipped version, and any required
dependency of a resource or shader pack.

Override jars are matched to Modrinth by sha1. A match whose project is
already in the index is removed. Unmatched jars fall back to the filename
prefix. An `embedded` project also shipped as its own explicit file is retained
and printed as an informational warning: third-party nested JARs are not
rewritten, and the standalone copy can satisfy another dependency. Fabric
`conflicts` entries and `breaks` entries with any other range (not evaluated)
are warnings. Undeclared mixin or class clashes are not detected.

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

Repacks a `.mrpack` without updating any packages: override jars already in
the index are removed, and the same conflict check as `update` runs before
either pack is published. Versions, loader pins, and client/server `env`
flags stay as exported — that is the only difference from `pnpm run update`.
`server=unsupported` files are omitted from the server pack only, conflicts
abort before replacing the output archives, and non-fatal problems go to
`errors.log`. bias is installed from `<stem>-update-server.mrpack`, not this
output.

Requires `zip` and `unzip` on PATH (both in the nix dev shell).

```bash
pnpm install
pnpm run process                 # bias.mrpack -> bias-process-client.mrpack + bias-process-server.mrpack
pnpm run process the-modpack     # the-modpack.mrpack -> the-modpack-process-client.mrpack + the-modpack-process-server.mrpack
pnpm run process --write-index the-modpack
```
