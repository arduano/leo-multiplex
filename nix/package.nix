{ lib, stdenv, buildNpmPackage, importNpmLock, nodejs_24, fetchurl, autoPatchelfHook, makeWrapper, python3, pkg-config, ncurses }:
let
  source = lib.cleanSourceWith {
    src = ../.;
    filter = path: type: !(builtins.elem (baseNameOf path) [ ".git" ".cache" "node_modules" "dist" "receipts" "result" ]);
  };
  codex = stdenv.mkDerivation {
    pname = "leo-codex";
    version = "0.153.4";
    src = fetchurl {
      url = "https://registry.npmjs.org/@openai/codex/-/codex-0.153.4-linux-x64.tgz";
      hash = "sha512-x1EcwBlY3AObM1VTUHNM2AzAJQsyreGdagpF+qFiYi/Oa30VBktvvG0C6tLtCzqW6hjZNWkGZQWmeVk7MuJKWg==";
    };
    nativeBuildInputs = [ autoPatchelfHook ];
    buildInputs = [ stdenv.cc.cc.lib ncurses ];
    dontBuild = true;
    installPhase = ''
      mkdir -p $out/bin $out/share/leo-codex
      cp -r vendor $out/share/leo-codex/
      ln -s $out/share/leo-codex/vendor/x86_64-unknown-linux-musl/bin/codex $out/bin/leo-codex
      cp -f README.md $out/share/leo-codex/ 2>/dev/null || true
    '';
  };
in buildNpmPackage {
  pname = "leo-multiplex";
  version = "0.1.0";
  src = source;
  nodejs = nodejs_24;
  npmDeps = importNpmLock {
    npmRoot = source;
    # importNpmLock rewrites locked URLs to store paths. npm overrides must
    # follow those direct specifications instead of retaining network URLs.
    package = let original = builtins.fromJSON (builtins.readFile (source + "/package.json")); in original // {
      overrides = lib.mapAttrs (name: value: if builtins.hasAttr name original.dependencies then "$" + name else value) original.overrides;
    };
  };
  npmConfigHook = importNpmLock.npmConfigHook;
  nativeBuildInputs = [ autoPatchelfHook makeWrapper python3 pkg-config ];
  buildInputs = [ stdenv.cc.cc.lib ];
  npmBuildScript = "build";
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/leo-multiplex $out/bin
    cp -r dist node_modules package.json LICENSE THIRD_PARTY_NOTICES.md $out/lib/leo-multiplex/
    # This is a Codex-only, glibc host. Copilot's optional desktop webview and
    # koffi's musl alternative are never loaded here; do not pull a GUI or a
    # second libc into the closure just to patch those inactive binaries.
    rm -rf \
      $out/lib/leo-multiplex/node_modules/@github/copilot-linux-x64/webview/node_modules/@webviewjs/webview-linux-x64-gnu \
      $out/lib/leo-multiplex/node_modules/@koromix/koffi-linux-x64/musl_x64
    # Reuse the independently patched, exact-version Codex payload, including
    # its zsh resource's ncurses dependency, instead of shipping a second copy.
    rm -rf $out/lib/leo-multiplex/node_modules/@openai/codex-linux-x64/vendor
    ln -s ${codex}/share/leo-codex/vendor \
      $out/lib/leo-multiplex/node_modules/@openai/codex-linux-x64/vendor
    for role in host control; do
      entry=main
      if [ "$role" = control ]; then entry=control; fi
      makeWrapper ${nodejs_24}/bin/node $out/bin/leo-$role \
        --add-flags "$out/lib/leo-multiplex/dist/apps/host/src/$entry.js" \
        --set LEO_CODEX_BINARY ${codex}/bin/leo-codex
    done
    ln -s ${codex}/bin/leo-codex $out/bin/leo-codex
    runHook postInstall
  '';
  passthru = { inherit codex; };
  meta = { description = "Leo's personal Codex control and runtime"; license = lib.licenses.mit; platforms = [ "x86_64-linux" ]; };
}
