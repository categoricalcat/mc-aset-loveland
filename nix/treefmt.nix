{ lib, ... }:
{
  perSystem =
    { pkgs, ... }:
    {
      treefmt = {
        projectRootFile = "flake.nix";
        programs = {
          deadnix = {
            enable = true;
            priority = 1;
          };
          statix = {
            enable = true;
            priority = 2;
          };
          nixfmt = {
            enable = true;
            priority = 3;
          };
          shfmt = {
            enable = true;
            indent_size = 2;
            priority = 2;
          };
          shellcheck = {
            enable = true;
            priority = 3;
          };
          # repo's existing formatter for TS/JSON/YAML/MD (config in package.json)
          prettier.enable = true;
        };
        settings = {
          global.excludes = [
            "pnpm-lock.yaml"
            ".backups/*"
            "home/*"
            "node_modules/*"
            "*.mrpack"
            "result"
          ];
          formatter = {
            shellharden = {
              command = "${pkgs.shellharden}/bin/shellharden";
              options = [ "--replace" ];
              includes = [ "*.sh" ];
              priority = 1;
            };
            # repo-local eslint (flat config via jiti); runs after prettier,
            # eslint-config-prettier keeps it away from formatting rules
            eslint = {
              command = lib.getExe (
                pkgs.writeShellApplication {
                  name = "eslint-fix";
                  runtimeInputs = [ pkgs.nodejs ];
                  text = ''exec ./node_modules/.bin/eslint --fix "$@"'';
                }
              );
              includes = [
                "*.ts"
                "*.js"
              ];
              priority = 5;
            };
          };
        };
      };
    };
}
