# The relay as a NixOS service, as scripts/install-relay.sh sets it up elsewhere: its own user, its data in
# /var/lib/tonton-relay, and the same sandbox. Secrets (the admin token, the metrics token, an APNs key) go in
# `environmentFile`, out of the Nix store.
self:
{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.tonton-relay;
in
{
  options.services.tonton-relay = {
    enable = lib.mkEnableOption "the Tonton Claude relay";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.tonton-relay;
      defaultText = lib.literalExpression "tonton-claude.packages.\${system}.tonton-relay";
      description = "The relay to run.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 7777;
      description = "Where it listens, behind your HTTPS reverse proxy.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open the port in the firewall. Leave it closed behind a reverse proxy on the same machine.";
    };

    registration = lib.mkOption {
      type = lib.types.enum [
        "open"
        "closed"
      ];
      default = "open";
      description = "`open`: anyone can create an account. `closed`: only with TONTON_ADMIN_TOKEN, set in `environmentFile`.";
    };

    trustProxy = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Read client addresses from X-Forwarded-For: only behind a reverse proxy that sets it.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/tonton-relay.env";
      description = "Settings kept out of the Nix store: TONTON_ADMIN_TOKEN, TONTON_METRICS_TOKEN, the TONTON_APNS_* keys.";
    };

    settings = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = {
        TONTON_REGION = "eu";
      };
      description = "Any other setting of the relay, as environment variables (docs/self-hosting.md).";
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.tonton-relay = {
      description = "Tonton Claude relay";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];
      environment = {
        PORT = toString cfg.port;
        TONTON_DATA_DIR = "/var/lib/tonton-relay";
        TONTON_REGISTRATION = cfg.registration;
        TONTON_TRUST_PROXY = if cfg.trustProxy then "1" else "0";
      }
      // cfg.settings;
      serviceConfig = {
        ExecStart = lib.getExe cfg.package;
        EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;
        DynamicUser = true;
        StateDirectory = "tonton-relay";
        StateDirectoryMode = "0700";
        WorkingDirectory = "/var/lib/tonton-relay";
        Restart = "always";
        RestartSec = 2;
        # The sandbox of scripts/install-relay.sh: the relay only needs its data and its sockets.
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        PrivateDevices = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectKernelLogs = true;
        ProtectControlGroups = true;
        ProtectClock = true;
        ProtectHostname = true;
        ProtectProc = "invisible";
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
        ];
        RestrictNamespaces = true;
        RestrictRealtime = true;
        RestrictSUIDSGID = true;
        LockPersonality = true;
        SystemCallArchitectures = "native";
        # Only to bind a port below 1024, if it is one.
        CapabilityBoundingSet = lib.optional (cfg.port < 1024) "CAP_NET_BIND_SERVICE";
        AmbientCapabilities = lib.optional (cfg.port < 1024) "CAP_NET_BIND_SERVICE";
        UMask = "0077";
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}
