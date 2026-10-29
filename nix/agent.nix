# The agent on NixOS. The agent installs itself in each user's home (~/.tonton/bin) and updates itself from the
# release when the app asks (Update agent), as on any Linux: generic executables, which NixOS runs through nix-ld. This
# module turns nix-ld on, adds tmux (the sessions started from the notch and a pool's sessions run in it) and the
# `tonton` command. Each user then runs the install command the app gives (Settings › Machines), or
# `TONTON_TOKEN=<token> tonton install`, once.
self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.programs.tonton;
in
{
  options.programs.tonton = {
    enable = lib.mkEnableOption "the Tonton Claude agent: this machine's Claude Code and OpenCode sessions in your notch";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.tonton;
      defaultText = lib.literalExpression "tonton-claude.packages.\${system}.tonton";
      description = "The agent the `tonton` command runs.";
    };
  };

  config = lib.mkIf cfg.enable {
    # The agent's own copy in ~/.tonton/bin, and the versions Update agent downloads, are generic Linux executables.
    programs.nix-ld.enable = true;
    environment.systemPackages = [
      cfg.package
      pkgs.tmux
    ];
  };
}
