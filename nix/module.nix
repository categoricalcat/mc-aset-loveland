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
    enable = lib.mkEnableOption "asetland Minecraft server (docker compose project)";

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
      type = lib.types.str;
      default = "daily";
      description = "systemd OnCalendar value for world backups.";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.asetland = {
      description = "asetland Minecraft server (compose up)";
      wantedBy = [ "multi-user.target" ];
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

    systemd.services.asetland-backup = {
      description = "asetland world backup (RCON freeze -> tar|zstd -> unfreeze)";
      after = [ "asetland.service" ];
      wants = [ "asetland.service" ];
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

    systemd.timers.asetland-backup = {
      description = "asetland world backup schedule";
      wantedBy = [ "timers.target" ];
      timerConfig = {
        OnCalendar = cfg.backupSchedule;
        Persistent = true;
      };
    };
  };
}
