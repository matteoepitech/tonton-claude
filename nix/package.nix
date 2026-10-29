# One executable of a Tonton Claude release, as published on GitHub: the agent (`tonton`) or the relay (`tonton-relay`).
# They are built with Bun, which carries the program inside the executable: it is installed as it is, never stripped,
# and on Linux its interpreter and libraries are pointed at the Nix store.
{
  lib,
  stdenv,
  fetchurl,
  autoPatchelfHook,
  release,
  name,
  asset,
  description,
}:

stdenv.mkDerivation {
  pname = name;
  inherit (release) version;

  src = fetchurl {
    url = "https://github.com/matteoepitech/tonton-claude/releases/download/v${release.version}/${asset}";
    sha256 = release.sha256.${asset};
  };

  dontUnpack = true;
  # Stripping would cut the program Bun appended to the executable.
  dontStrip = true;
  dontPatchShebangs = true;

  nativeBuildInputs = lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];

  installPhase = ''
    runHook preInstall
    install -Dm755 $src $out/bin/${name}
    runHook postInstall
  '';

  meta = {
    inherit description;
    homepage = "https://github.com/matteoepitech/tonton-claude";
    license = lib.licenses.mit;
    mainProgram = name;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
    platforms = [
      "x86_64-linux"
      "aarch64-linux"
    ]
    ++ lib.optionals (name == "tonton") [
      "x86_64-darwin"
      "aarch64-darwin"
    ];
  };
}
