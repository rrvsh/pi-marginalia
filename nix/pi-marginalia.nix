{ lib, ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      manifest = builtins.fromJSON (builtins.readFile ../package.json);
      pname = manifest.name;
      version = manifest.version;
      packageName = pname;
      packagePath = "lib/node_modules/${packageName}";
      package = pkgs.stdenvNoCC.mkDerivation {
        inherit pname version;
        src = lib.fileset.toSource {
          root = ../.;
          fileset = lib.fileset.unions [
            ../package.json
            ../README.md
            ../LICENSE
            ../extensions
          ];
        };

        installPhase = ''
          runHook preInstall
          mkdir -p "$out/${packagePath}"
          cp -R package.json README.md LICENSE extensions "$out/${packagePath}/"
          runHook postInstall
        '';

        doInstallCheck = true;
        nativeInstallCheckInputs = [ pkgs.nodejs_22 ];
        installCheckPhase = ''
          runHook preInstallCheck
          pkg="$out/${packagePath}"
          test -f "$pkg/package.json"
          test -f "$pkg/extensions/marginalia.ts"
          PNAME="${pname}" PVERSION="${version}" node - "$pkg/package.json" <<'NODE'
          const fs = require("fs");
          const [manifestPath] = process.argv.slice(2);
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
          if (manifest.name !== process.env.PNAME) throw new Error("unexpected package name: " + manifest.name);
          if (manifest.version !== process.env.PVERSION) throw new Error("unexpected package version: " + manifest.version);
          if (!manifest.keywords.includes("pi-package")) throw new Error("missing pi-package keyword");
          if (!Array.isArray(manifest.pi?.extensions) || !manifest.pi.extensions.includes("./extensions/marginalia.ts")) {
            throw new Error("missing Pi extension metadata for ./extensions/marginalia.ts");
          }
          NODE
          runHook postInstallCheck
        '';

        passthru.packagePath = "${placeholder "out"}/${packagePath}";

        meta = {
          description = "A shared human-agent review surface for source files in Pi";
          homepage = "https://github.com/rrvsh/pi-marginalia";
          license = lib.licenses.mit;
          platforms = [
            "aarch64-darwin"
            "x86_64-linux"
          ];
        };
      };
      packageWithPassthru = package.overrideAttrs (old: {
        passthru = (old.passthru or { }) // {
          packagePath = "${package}/${packagePath}";
        };
      });
    in
    {
      packages.pi-marginalia = packageWithPassthru;
      packages.default = packageWithPassthru;
      devShells.default = pkgs.mkShell {
        packages = [ pkgs.nodejs_22 ];
      };
    };
}
