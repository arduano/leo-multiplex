# Read-only integration evaluation. Neither the dotfiles nor running units change.
{ dotfilesPath ? "/home/arduano/.dotfiles"
, leoPath ? "/home/arduano/programming/leo-multiplex"
}:
let
  dotfiles = builtins.getFlake dotfilesPath;
  leo = builtins.getFlake ("git+file://" + leoPath);
  evaluated = dotfiles.nixosConfigurations.main-pc.extendModules {
    modules = [{
      home-manager.users.arduano = {
        imports = [ leo.homeManagerModules.default ];
        services.leo-host.enable = true;
      };
    }];
  };
  home = evaluated.config.home-manager.users.arduano;
in {
  services = builtins.mapAttrs (_: value: {
    inherit (value) Unit Service Install;
  }) {
    inherit (home.systemd.user.services) leo-control leo-runtime;
  };
  target = home.systemd.user.targets.leo-host;
}
