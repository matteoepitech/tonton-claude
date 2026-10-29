# Nix and NixOS

`flake.nix` installs the agent and the relay of the latest release (`nix/release.json`), on Linux and macOS for the
agent, Linux for the relay. They are the executables published with each release, the ones `install.sh` and
`install-relay.sh` download.

## The agent on NixOS

Add the flake and turn the agent on:

```nix
{
  inputs.tonton-claude.url = "github:matteoepitech/tonton-claude";

  outputs = { nixpkgs, tonton-claude, ... }: {
    nixosConfigurations.my-machine = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        tonton-claude.nixosModules.agent
        { programs.tonton.enable = true; }
      ];
    };
  };
}
```

It turns on `nix-ld`, adds `tmux` (the sessions started from the notch and a pool's sessions run in it) and the
`tonton` command. Then, as each user, once: copy the install command from the Mac app (Settings › Machines), or run

```sh
TONTON_TOKEN='<token from the app>' tonton install
```

The agent sets itself up in your home as on any Linux: its copy in `~/.tonton/bin`, Claude Code's hooks, a user systemd
unit. **Update agent** in the app works too: it downloads the release's generic executable, which `nix-ld` runs.

Without NixOS, `nix run github:matteoepitech/tonton-claude -- install` does the same on Linux and macOS, with
`TONTON_TOKEN` set.

## The relay on NixOS

```nix
{
  imports = [ tonton-claude.nixosModules.relay ];

  services.tonton-relay = {
    enable = true;
    port = 7777;
    # closed: accounts only with TONTON_ADMIN_TOKEN, set in the file below.
    registration = "open";
    # Behind a reverse proxy that sets X-Forwarded-For.
    trustProxy = true;
    # Secrets out of the Nix store: TONTON_ADMIN_TOKEN, TONTON_METRICS_TOKEN, TONTON_APNS_*.
    environmentFile = "/run/secrets/tonton-relay.env";
  };
}
```

It runs as its own user, with its data in `/var/lib/tonton-relay` and the sandbox of `install-relay.sh`. Put it behind
your HTTPS reverse proxy as in [self-hosting](self-hosting.md); `services.caddy` or `services.nginx` with a WebSocket
proxy does it. `nix build github:matteoepitech/tonton-claude#tonton-relay` gives the executable alone.

## A new release

After each release, `bun scripts/nix-release.ts` writes the new version and the SHA-256 of each executable to
`nix/release.json`, from the release's `SHA256SUMS`. Commit it: the flake installs that version from then on.
