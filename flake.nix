# Tonton Claude for Nix and NixOS: the agent and the relay of the latest release (nix/release.json), and NixOS modules
# that run them. See docs/nix.md.
{
  description = "Tonton Claude: the Claude Code and OpenCode sessions of all your machines, in your Mac's notch";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      release = builtins.fromJSON (builtins.readFile ./nix/release.json);
      # The name each system's executables carry in the release.
      targets = {
        x86_64-linux = "linux-x64";
        aarch64-linux = "linux-arm64";
        x86_64-darwin = "darwin-x64";
        aarch64-darwin = "darwin-arm64";
      };
      forEachSystem = f: nixpkgs.lib.genAttrs (builtins.attrNames targets) (system: f system nixpkgs.legacyPackages.${system});
    in
    {
      packages = forEachSystem (
        system: pkgs:
        let
          target = targets.${system};
          executable =
            name: description:
            pkgs.callPackage ./nix/package.nix {
              inherit release name description;
              asset = "${name}-${target}";
            };
        in
        {
          tonton = executable "tonton" "Tonton Claude's agent: streams this machine's Claude Code and OpenCode sessions to your relay";
          default = self.packages.${system}.tonton;
        }
        // nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          tonton-relay = executable "tonton-relay" "Tonton Claude's relay: accounts, machines and sealed sessions, and the website";
        }
      );

      apps = forEachSystem (
        system: _: {
          default = {
            type = "app";
            program = "${self.packages.${system}.tonton}/bin/tonton";
          };
        }
      );

      nixosModules = {
        relay = import ./nix/relay.nix self;
        agent = import ./nix/agent.nix self;
        default = {
          imports = [
            self.nixosModules.relay
            self.nixosModules.agent
          ];
        };
      };
    };
}
