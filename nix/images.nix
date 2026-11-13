{ lib, ... }:
{
  perSystem =
    {
      config,
      pkgs,
      system,
      ...
    }:
    let
      # pullImage hashes are per architecture; others fail with a hash mismatch
      # that prints the right value (`lib.fakeHash` fallback)
      pulledHashes =
        {
          x86_64-linux = {
            playit = "sha256-bfsRdpzBYNE8dal96xsx/FABl1IPADpgmFb3/qoJeSM=";
          };
        }
        .${system} or { };

      # `docker load` targets, in a fixed order
      loadable = with config.packages; [
        server-image
        backup-image
        playit-image
      ];

      # Live server is Minecraft 26. One current JRE; no per-version table.
      jre = pkgs.javaPackages.compiler.temurin-bin.jre-25;

      # nixpkgs mrpack-install is 0.16.10 and has no NeoForge provider.
      # 0.23.0 installs NeoForge as server.jar (ServerStarterJar), so the
      # entrypoint stays `java -jar server.jar`.
      mrpack-install = pkgs.buildGoModule (finalAttrs: {
        pname = "mrpack-install";
        version = "0.23.0";

        src = pkgs.fetchFromGitHub {
          owner = "nothub";
          repo = "mrpack-install";
          tag = "v${finalAttrs.version}";
          hash = "sha256-VoGUWN1AZRXGl/4MjoC0vNN2saWuOCS++Wl2M4zda+w=";
        };

        vendorHash = "sha256-cmVqOA1rKa7guwW0GEM4TLpreOVh8p7vI/z8SIsxtdI=";

        # e2e is a separate module. tools/ is not the installer.
        excludedPackages = [
          "e2e"
          "tools"
        ];

        meta.mainProgram = "mrpack-install";
      });

      install-pack = pkgs.writeShellApplication {
        name = "install-pack";
        runtimeInputs = [
          mrpack-install
          pkgs.jq
          pkgs.unzip
          pkgs.curl
          pkgs.cacert
          pkgs.coreutils
        ];
        text = ''
          export JAVA_ROOT=${jre}
          export SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt
          exec bash ${../scripts/install-pack.sh} "$@"
        '';
      };
    in
    {
      # compose never builds or pulls (pull_policy: never); `nix run .#load-images`
      # loads every image, then `docker compose up/down` stays manual
      apps.load-images.program = lib.getExe (
        pkgs.writeShellApplication {
          name = "load-images";
          # host docker (or podman dockerCompat), not a pinned client
          text = lib.concatMapStringsSep "\n" (
            image:
            # streamLayeredImage outputs a script; pullImage outputs a tarball
            if image.isExe or false then "${image} | docker load" else "docker load < ${image}"
          ) loadable;
        }
      );

      apps.install-pack.program = lib.getExe install-pack;

      packages = {
        inherit install-pack;
        # Registry image pinned by digest (skopeo digest of the multi-arch index).
        # Same name:tag as compose uses, so `image:` is unchanged.
        playit-image = pkgs.dockerTools.pullImage {
          imageName = "ghcr.io/playit-cloud/playit-agent";
          imageDigest = "sha256:29862011f13e6e30c20829261eb52aa9b334598892f1cf2be0790680691b90fd";
          hash = pulledHashes.playit or lib.fakeHash;
        };

        server-image = pkgs.dockerTools.streamLayeredImage {
          name = "asetland-server";
          tag = "latest";
          contents = [
            pkgs.busybox
            pkgs.mc-monitor
            (pkgs.writeScriptBin "mc-send-to-console" ''
              #!/bin/sh
              printf '%s\n' "$*" > /tmp/minecraft-console-in
            '')
            (pkgs.linkFarm "asetland-java" [
              {
                name = "opt/java";
                path = jre;
              }
            ])
          ];
          enableFakechroot = true;
          fakeRootCommands = ''
            mkdir -p data
            chown 65532:65532 data
            mkdir -m 1777 tmp
          '';
          config = {
            User = "65532:65532";
            WorkingDir = "/data";
            ExposedPorts."25564/tcp" = { };
            Env = [
              "JAVA_ROOT=/opt/java"
              "HOME=/data"
            ];
            Entrypoint = [
              "/bin/sh"
              "${../scripts/start-server.sh}"
            ];
          };
        };

        backup-image = pkgs.dockerTools.streamLayeredImage {
          name = "asetland-backup";
          tag = "latest";
          contents = [
            pkgs.dockerTools.binSh
            pkgs.coreutils
            pkgs.gnutar
            pkgs.zstd
            pkgs.pv
            pkgs.restic
          ];
          extraCommands = "mkdir -m 1777 tmp";
          # compose bind-mounts the script; OPERATION comes from compose env
          config.Entrypoint = [
            "/bin/sh"
            "/script/backup.sh"
          ];
        };
      };
    };
}
