{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.asetland;

  envFileArg = lib.optionalString (cfg.envFile != null) " --env-file ${cfg.envFile}";

  # `docker compose` resolves to the host's compose provider (podman-compose
  # on yi hosts via dockerCompat; the real plugin on docker hosts). Both are
  # on PATH so provider discovery works in the unit's minimal environment.
  compose = "${lib.getExe pkgs.docker} compose${envFileArg}";
in
{
  options.services.asetland = {
    # Compose stays the source of truth, brought up/down by hand; these units are
    # inert wrappers until autoStart / backupSchedule opt in.
    enable = lib.mkEnableOption "asetland systemd wrappers around the docker compose project";

    autoStart = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = ''
        Start the stack at boot. When false the unit only runs on an explicit
        `systemctl start asetland`, leaving manual `docker compose up/down` alone.
      '';
    };

    workingDir = lib.mkOption {
      type = lib.types.path;
      default = "/srv/asetland";
      description = ''
        Checkout of mc-aset-loveland (compose.yaml, scripts/, .backups/).
        The unit runs compose from here; backups land in .backups/.
      '';
    };

    envFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      description = ''
        Optional --env-file for compose (SECRET_KEY etc.). Wire to a sops
        template in the host config; when null, compose reads ./.env.
      '';
    };

    backupSchedule = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "daily";
      description = ''
        systemd OnCalendar value for world backups; null installs no timer
        (asetland-backup.service can still be started by hand).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    systemd = {
      services.asetland = {
        description = "asetland Minecraft server (compose up)";
        wantedBy = lib.optional cfg.autoStart "multi-user.target";
        after = [
          "network-online.target"
          "docker.service"
          "podman.service"
          "podman.socket"
        ];
        wants = [ "network-online.target" ];
        path = [
          pkgs.docker
          pkgs.podman-compose
        ];
        serviceConfig = {
          Type = "oneshot";
          RemainAfterExit = true;
          WorkingDirectory = cfg.workingDir;
          # image pulls on first start can be slow
          TimeoutStartSec = "10min";
          ExecStart = "${compose} up -d";
          ExecStop = "${compose} down";
        };
      };

      services.asetland-backup = {
        description = "asetland world backup (console freeze -> tar|zstd -> unfreeze)";
        # no `wants`: a backup must never start a manually stopped stack
        after = [ "asetland.service" ];
        path = [
          pkgs.docker
          pkgs.podman-compose
          pkgs.gnugrep
        ];
        serviceConfig = {
          Type = "oneshot";
          WorkingDirectory = cfg.workingDir;
          ExecStart = "${cfg.workingDir}/scripts/backup.sh";
        };
      };

      timers.asetland-backup = lib.mkIf (cfg.backupSchedule != null) {
        description = "asetland world backup schedule";
        wantedBy = [ "timers.target" ];
        timerConfig = {
          OnCalendar = cfg.backupSchedule;
          Persistent = true;
        };
      };
    };
  };
}
