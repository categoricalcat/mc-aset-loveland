{
  description = "asetland — dockerized Minecraft server, modpack tooling and backups";

  outputs =
    inputs@{ flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
      imports = [
        inputs.treefmt-nix.flakeModule
        ./nix/treefmt.nix
      ];
      flake.nixosModules.asetland = ./nix/module.nix;
    };

  inputs = {
    # pinned to the revs locked in ../nixos/flake.lock — already in the local
    # store, so no re-download; bump alongside that repo
    nixpkgs.url = "github:NixOS/nixpkgs/151fa4e8ddfdd8dd25d945ad94ed54a13de9f6e4";

    flake-parts.url = "github:hercules-ci/flake-parts/ea2630b7470978622c7689a1ff75d2b389175399";

    treefmt-nix = {
      url = "github:numtide/treefmt-nix/0d6d739a833ba9a9c93034862e4a7b061a062a1c";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };
}
