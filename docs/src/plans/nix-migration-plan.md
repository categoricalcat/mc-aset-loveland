# asetland Nix Migration Plan

Status: Phase 1 done. Phase 2 (runtime image, host pack install, bias on
asetland-server) implemented; runtime test pending. Phase 3 specified, not
implemented. Compose stays manual.

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
- `nix/images.nix`: `packages.server-image` / `packages.backup-image`
  (`dockerTools.streamLayeredImage`), digest-pinned `playit-image`
  (`dockerTools.pullImage`, x86_64-linux hash), `apps.load-images` (loads the
  three images), and `apps.install-pack`. `mrpack-install` 0.23.0 is built
  here; nixpkgs is 0.16.10 and cannot install NeoForge. Compose uses only
  these images (`pull_policy: never`, no `build:`).
- `scripts/install-pack.sh` reads a local archive and writes `.packs/`
  (gitignored). `.mrpack` goes through `mrpack-install` (Fabric, Quilt,
  NeoForge, Forge). A CurseForge `.zip` downloads the Forge installer version
  named in the zip. The archive sha256 skips a repeat run. `.sha256` is
  written last.
- `scripts/start-server.sh` links `/opt/pack` into `/data`, copies
  `level-name` datapacks, and runs Temurin 25. It does not download or choose a JRE. `mc-send-to-console` writes to
  the console fifo. bias, server, and serverpack share `asetland-server`.
- `nix/module.nix` (`services.asetland`) wraps the compose project in systemd
  units but is inert by default: `autoStart = false` (no `wantedBy`),
  `backupSchedule = null` (no timer), and `asetland-backup` never `wants` the
  stack. Images must be loaded before `systemctl start asetland`.
- Still outside Nix: plain `server.properties` / `c2me.toml` / `DistantHorizons.toml` / `eula.txt`, and
  secrets in host `.env`. bias uses `mc-egress` for Mojang auth.
- `*.mrpack` is gitignored. The runtime JRE is Temurin 25 only; the live
  server is Minecraft 26. `bias-update-server.mrpack` is Fabric (MC 26.3,
  fabric-loader 0.20.1). Older archives are not a supported runtime.

## Decisions

1. **Compose stays manual.** No phase may auto-start, stop, or recreate the
   stack. Nix builds images; the user loads them (`nix run .#load-images`)
   and runs `docker compose up/down` by hand.
2. **Packs are user-managed and installed by an impure run.** A pack archive
   is a local file. It is not committed, not a flake input, not `requireFile`,
   and not hashed into `flake.lock`. `nix run .#install-pack -- DEST ARCHIVE`
   writes the server tree (`.packs/` is gitignored). The container only links
   that tree. `pnpm run update` stays the impure producer of the `.mrpack`.
   Build-time consumption was rejected: a pure build would need a hash of the
   archive, and the pack is not uploaded anywhere.
3. **One JRE: Temurin 25.** The live server is Minecraft 26. No version
   table and no extra JREs. Other pinned `nixpkgs` packages: `mc-monitor`,
   `zstd`, `restic`, `pv`, `coreutils`, `gnutar`, `curl`, `jq`, `unzip`,
   `cacert`, `busybox`. `mrpack-install` is the exception: 0.23.0, built in
   `nix/images.nix`, because nixpkgs 0.16.10 has no NeoForge provider.
4. **Native systemd only behind an option**, modeled on nixpkgs
   `minecraft-server.nix` (`ListenFIFO` console, `CapabilityBoundingSet = [ "" ]`,
   `DynamicUser`), never replacing compose implicitly.
5. **Both host targets.** Nix OCI images for the compose host, and native
   units under `services.asetland.instances`. Compose image names stay
   `latest`. bias, server, and serverpack share `asetland-server`. playit
   stays digest-pinned. itzg is not used.
6. **`mrpack-install` 0.23.0 installs Modrinth packs, including NeoForge.**
   CurseForge `.zip` packs use the Forge installer version named in the zip,
   downloaded when `install-pack` runs. No `nix-minecraft` input and no Maven
   lock.
7. **`playit-agent` is packaged from source and opt-in** for native units.
   Compose uses the digest-pinned upstream image.
8. **No Dockerfiles.** `Dockerfile`, `backup.dockerfile`, and
   `scripts/docker-reset.sh` are retired. `scripts/install-pack.sh` is the
   host installer.

## Phases

### Phase 1 — devShell + checks (done)

`devShells.default` added; lint checks already run via `checks.treefmt`.

### Phase 2 — runtime image + host pack install (implemented, runtime test pending)

See Current state. Remaining: runtime test of bias (install runs, log shows
`Done`, `mc-send-to-console` works, a restart skips reinstall).

### Phase 3 — native instances + playit + secrets docs

- `nix/playit.nix`: `packages.playit-agent` via `rustPlatform.buildRustPackage`
  of `playit-cloud/playit-agent` v2.0.2, `cargoHash` pinned.
- `services.asetland.instances.<name>` (empty by default). Options: `pack`
  (string path, not a store path), `memory` (`8G`), `port` (`25564`, bind
  `127.0.0.1`), `serverProperties` (`formats.javaProperties`; empty falls back
  to the repo file), `c2meConfig` (`formats.toml`; empty falls back to the
  repo file), `autoStart` (`false`), `backupSchedule` (`null`).
  - `asetland-<name>.service`: thin `start-server.sh` with the installed pack
    directory read-only, `DATA_DIR=/var/lib/asetland/<name>`, `JAVA_ROOT` the
    Temurin 25 JRE.
    `DynamicUser`, `StateDirectory`, `CapabilityBoundingSet = [ "" ]`,
    `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
    `RestrictAddressFamilies`, `SystemCallFilter=@system-service`,
    `ReadOnlyPaths` of the pack's directory.
  - `asetland-<name>.socket`: `ListenFIFO=/run/asetland-<name>.stdin`.
  - `asetland-<name>-backup.service` (+ timer when `backupSchedule` is set):
    `save-off` then `save-all flush` into the FIFO, `backup.sh write` with host
    `DATA_DIR` / `BACKUP_DIR` and the Nix tools on `path`, `save-on` from a trap.
- `services.asetland.tunnel.enable` (`false`): native `playit-agent` unit,
  `DynamicUser`, `SECRET_KEY` from `envFile`.
- Existing compose wrappers in `nix/module.nix` stay as they are.
- README: an example instance, and a `sops-nix` snippet that maps a template
  to `services.asetland.envFile`. Paths only; do not run `sops` or read a
  secret. `compose.yaml` stays while manual up/down is wanted.

## Rollout order

1. Finish the Phase 2 runtime test, then Phase 3. Each lands as an opt-in
   package or `services.asetland` option.
2. Native instances are verified by NixOS module eval only. Switching the host
   is manual.
3. Delete this plan when Phase 3 is implemented and verified.

## Open questions

1. **Whitelist and ops:** declarative in Nix, or mutable files in the data dir
   (console), as today?
