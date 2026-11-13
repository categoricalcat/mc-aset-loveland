# asetland Nix Migration Plan

Status: Phase 1 done. Phase 2 (runtime packs) specified, not implemented.
Compose stays manual.

## Objective

Move images, tool fetches, and runtime services in `mc-aset-loveland` to
declarative Nix (`flake.nix` + `nix/`) when it pays off, without taking manual
`docker compose up/down` away. Modpacks stay local files the user manages; Nix
never fetches or hashes them.

## Current state

- `flake.nix` exposes `formatter` + `checks.treefmt` (shared
  `inputs.nixos.flakeModules.treefmt`: shellcheck, shfmt, statix, deadnix,
  prettier, eslint), `devShells.default` (treefmt tools + `nodejs`, `pnpm`), and
  `nixosModules.asetland`.
- `nix/module.nix` (`services.asetland`) wraps the compose project in systemd
  units but is inert by default: `autoStart = false` (no `wantedBy`),
  `backupSchedule = null` (no timer), and `asetland-backup` never `wants` the
  stack.
- Still outside Nix: `Dockerfile` + `scripts/install-pack.sh` (online JRE /
  Forge / `mrpack-install` + mod downloads), `backup.dockerfile`
  (`apk add`), itzg `bias` (runtime mod pulls over `mc-egress`), `playit-agent`,
  plain `server.properties` / `c2me.toml` / `eula.txt`, and secrets in host
  `.env`.
- `*.mrpack` is gitignored. `bias-update-server.mrpack` is Fabric (MC 26.3,
  fabric-loader 0.20.1), not NeoForge. `the-modpack.mrpack` is Fabric 1.21.5.

## Decisions

1. **Compose stays manual.** No phase may auto-start, stop, or recreate the
   stack. New Nix behavior is opt-in through `services.asetland` options or
   flake packages the user loads by hand.
2. **Packs are user-managed and installed at runtime.** A `.mrpack` is a local
   file. It is not committed, not a flake input, not `requireFile`, and not
   hashed into `flake.lock`. Nix ships JREs, `mrpack-install`, and
   `mc-monitor`. `start-server.sh` runs `mrpack-install` when `MRPACK` is set
   and the file's sha256 differs from `$DATA_DIR/.pack/.sha256`. `pnpm run
   update` stays the impure producer of that file. Build-time consumption was
   rejected: a pure build would need a hash of the archive, and the pack is
   not uploaded anywhere.
3. **Prefer pinned `nixpkgs` packages**: `mrpack-install`, `mc-monitor`,
   `javaPackages.compiler.temurin-bin.jre-{8,17,21,25}`, `zstd`, `restic`,
   `pv`, `coreutils`, `gnutar`, `curl`, `jq`, `unzip`, `cacert`, `busybox`.
4. **Native systemd only behind an option**, modeled on nixpkgs
   `minecraft-server.nix` (`ListenFIFO` console, `CapabilityBoundingSet = [ "" ]`,
   `DynamicUser`), never replacing compose implicitly.
5. **Both host targets.** Nix OCI images for the compose host, and native
   units under `services.asetland.instances`. Compose image names stay
   `latest`; `bias` stays on itzg `latest`.
6. **`mrpack-install` is the loader.** It installs Fabric, Quilt, Forge, and
   NeoForge, so there is no `nix-minecraft` input and no Maven lock.
7. **`playit-agent` is packaged from source and opt-in.** Compose keeps
   `ghcr.io/playit-cloud/playit-agent:latest`.

## Phases

### Phase 1 — devShell + checks (done)

`devShells.default` added; lint checks already run via `checks.treefmt`.

### Phase 2 — runtime pack + OCI images

- `scripts/start-server.sh`: when `MRPACK` is unset, keep today's `/opt/pack`
  behavior. When set, sha256 the file against `$DATA_DIR/.pack/.sha256`, and
  on mismatch wipe `.pack` and run
  `mrpack-install "$MRPACK" --server-dir "$DATA_DIR/.pack" --server-file server.jar`.
  Read `dependencies.minecraft`, look up `javaVersion.majorVersion` in
  piston-meta (same lookup as `install-pack.sh`), cache it in `.pack/.java`,
  and set `JAVA_BIN` to `$JAVA_ROOT/$major/bin/java` when that tree exists.
  Existing `stage_pack` and JVM flags stay.
- `scripts/backup.sh`: add `.pack` to `write_exclude_file` (reproducible).
- `nix/images.nix` (flake-parts module imported from `flake.nix`):
  - `packages.server-image`: `dockerTools.buildLayeredImage`, name
    `asetland-server`, tag `latest`. Contents: `busybox`, `curl`, `jq`,
    `unzip`, `cacert`, `mrpack-install`, `mc-monitor`, and
    `temurin-bin.jre-{8,17,21,25}` linked under `/opt/java/<major>`
    (`JAVA_ROOT=/opt/java`). `/data` owned `65532:65532`, `/tmp` mode 1777,
    `User = "65532:65532"`, port 25564, entrypoint matches `Dockerfile`.
  - `packages.backup-image`: name `asetland-backup`, tag `latest`. Contents:
    `dockerTools.binSh`, `coreutils`, `gnutar`, `zstd`, `pv`, `restic`, `/tmp`.
    Entrypoint matches `backup.dockerfile`.
  - Neither package is a `check`; both are built on demand.
- `compose.yaml` `server`: `image: asetland-server` so a `docker load` wins and
  the Dockerfile stays the fallback. Mount
  `./${MODPACK_ARCHIVE:-the-modpack.mrpack}:/modpacks/pack.mrpack:ro`. Set
  `MRPACK` only through `MRPACK: ${SERVER_MRPACK:-}` so the current Dockerfile
  image ignores the mount. `bias` and `tunnel` unchanged.

### Phase 3 — native instances + playit + secrets docs

- `nix/playit.nix`: `packages.playit-agent` via `rustPlatform.buildRustPackage`
  of `playit-cloud/playit-agent` v2.0.2, `cargoHash` pinned.
- `services.asetland.instances.<name>` (empty by default). Options: `mrpack`
  (string path, not a store path), `memory` (`8G`), `port` (`25564`, bind
  `127.0.0.1`), `serverProperties` (`formats.javaProperties`; empty falls back
  to the repo file), `c2meConfig` (`formats.toml`; empty falls back to the
  repo file), `autoStart` (`false`), `backupSchedule` (`null`).
  - `asetland-<name>.service`: same `start-server.sh` with `MRPACK`,
    `DATA_DIR=/var/lib/asetland/<name>`, `JAVA_ROOT` a `linkFarm` of the JREs.
    `DynamicUser`, `StateDirectory`, `CapabilityBoundingSet = [ "" ]`,
    `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
    `RestrictAddressFamilies`, `SystemCallFilter=@system-service`,
    `ReadOnlyPaths` of the mrpack's directory.
  - `asetland-<name>.socket`: `ListenFIFO=/run/asetland-<name>.stdin`.
  - `asetland-<name>-backup.service` (+ timer when `backupSchedule` is set):
    `save-off` then `save-all flush` into the FIFO, `backup.sh write` with host
    `DATA_DIR` / `BACKUP_DIR` and the Nix tools on `path`, `save-on` from a trap.
- `services.asetland.tunnel.enable` (`false`): native `playit-agent` unit,
  `DynamicUser`, `SECRET_KEY` from `envFile`.
- Existing compose wrappers in `nix/module.nix` stay as they are.
- README: how to build and `docker load` the images, `SERVER_MRPACK`, an
  example instance, and a `sops-nix` snippet that maps a template to
  `services.asetland.envFile`. Paths only; do not run `sops` or read a secret.
- `Dockerfile`, `backup.dockerfile`, and `install-pack.sh` stay until a soak
  test. `compose.yaml` stays while manual up/down is wanted.

## Rollout order

1. Phase 2, then Phase 3. Each lands as an opt-in package or
   `services.asetland` option.
2. Verify the server image against a world copy: install runs, healthcheck
   goes healthy, log shows `Done`, a restart skips reinstall. Stack ends down.
3. Native instances are verified by NixOS module eval only. Switching the host
   is manual.
4. Retire `Dockerfile` / `backup.dockerfile` / `install-pack.sh` only after the
   Nix images are soak-tested. Delete this plan in that same change.

## Open questions

1. **Whitelist and ops:** declarative in Nix, or mutable files in the data dir
   (console), as today?
