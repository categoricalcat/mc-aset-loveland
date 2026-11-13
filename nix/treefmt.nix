{ inputs, lib, ... }:
{
  imports = [ inputs.nixos.flakeModules.treefmt ];

  perSystem =
    { pkgs, ... }:
    {
      # repo formatters layered on the shared policy (ts via prettier + eslint)
      treefmt = {
        programs = {
          # ts/js/json/yaml/md; config in package.json. prettier owns markdown.
          prettier.enable = true;
          # prettier rewrites YAML 1.1 merge keys (`<<:`) to `!!merge`.
          prettier.excludes = [ "compose.yaml" ];
          mdformat.enable = lib.mkForce false;
          # VS Code JSON is JSONC. jsonfmt is encoding/json and rejects `//`.
          jsonfmt.excludes = [ ".vscode/*.json" ];
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
          formatter.eslint = {
            command = lib.getExe (
              pkgs.writeShellApplication {
                name = "eslint-fix";
                runtimeInputs = [ pkgs.nodejs ];
                # node_modules is absent in the `nix flake check` sandbox; lint there is `pnpm run lint`
                text = ''
                  if [ ! -x ./node_modules/.bin/eslint ]; then
                    echo "eslint-fix: node_modules missing, skipping" >&2
                    exit 0
                  fi
                  exec ./node_modules/.bin/eslint --fix "$@"
                '';
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
}
