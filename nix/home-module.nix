self: { config, lib, pkgs, ... }:
let
  cfg = config.services.leo-host;
  common = {
    Unit = { After = [ "network-online.target" ]; PartOf = [ "leo-host.target" ]; };
    Service = {
      Type = "simple";
      Restart = "on-failure";
      RestartSec = 5;
      TimeoutStopSec = 120;
      UMask = "0077";
      Environment = [
        "LEO_STATE_DIR=${cfg.stateDirectory}"
        "LEO_CODEX_CONFIG_FILE=${cfg.codexConfigFile}"
        "LEO_HOST_NAME=${cfg.hostName}"
        "LEO_CONTROL_HTTP_PORT=${toString cfg.controlPort}"
        "LEO_CONTROL_P2P_BIND=${cfg.p2pBind}"
        "LEO_ENROLL_GATEWAYS=${if cfg.enrollGateways then "1" else "0"}"
        "LEO_ENROLL_RUNTIMES=${if cfg.enrollRuntimes then "1" else "0"}"
        "LEO_CODEX_BINARY=${cfg.package}/bin/leo-codex"
        "PATH=${config.home.homeDirectory}/.nix-profile/bin:/etc/profiles/per-user/${config.home.username}/bin:/run/current-system/sw/bin:${config.home.homeDirectory}/.local/bin:${config.home.homeDirectory}/.bun/bin:${lib.makeBinPath cfg.extraPackages}"
      ];
    };
    Install.WantedBy = [ "leo-host.target" ];
  };
in {
  options.services.leo-host = {
    enable = lib.mkEnableOption "Leo's personal full-access Codex host";
    package = lib.mkOption { type = lib.types.package; default = self.packages.${pkgs.stdenv.hostPlatform.system}.host; };
    hostName = lib.mkOption { type = lib.types.str; default = "main-pc"; };
    stateDirectory = lib.mkOption { type = lib.types.str; default = "${config.xdg.stateHome}/leo-multiplex"; };
    codexConfigFile = lib.mkOption { type = lib.types.str; default = "${config.home.homeDirectory}/.codex/config.toml"; };
    controlPort = lib.mkOption { type = lib.types.port; default = 4327; };
    p2pBind = lib.mkOption { type = lib.types.str; default = "0.0.0.0:49117"; };
    enrollGateways = lib.mkOption { type = lib.types.bool; default = false; description = "Open only while pairing the personal gateway."; };
    enrollRuntimes = lib.mkOption { type = lib.types.bool; default = false; description = "Open only while pairing the personal runtime."; };
    extraPackages = lib.mkOption { type = lib.types.listOf lib.types.package; default = [ pkgs.git pkgs.bash pkgs.nodejs_24 pkgs.ripgrep ]; };
  };
  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.package ];
    systemd.user.targets.leo-host = {
      Unit = { Description = "Leo Multiplex host"; Wants = [ "leo-control.service" "leo-runtime.service" ]; };
      Install.WantedBy = [ "default.target" ];
    };
    systemd.user.services.leo-control = lib.recursiveUpdate common {
      Unit.Description = "Leo Multiplex canonical host catalog";
      Service.ExecStart = "${cfg.package}/bin/leo-control";
    };
    systemd.user.services.leo-runtime = lib.recursiveUpdate common {
      Unit = { Description = "Leo Multiplex Codex runtime"; After = [ "network-online.target" "leo-control.service" ]; };
      Service.ExecStart = "${cfg.package}/bin/leo-host";
    };
  };
}
