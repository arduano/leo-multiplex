{
  description = "Leo's personal Agent Multiplex host and clients";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs { inherit system; };
  in {
    packages.${system} = rec {
      default = host;
      host = pkgs.callPackage ./nix/package.nix { };
    };
    homeManagerModules.default = import ./nix/home-module.nix self;
    checks.${system}.host = self.packages.${system}.host;
  };
}
