{
  description = "Agon dev shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        caBundle = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_22
            typescript-go
            cacert
            jq
            git
            ripgrep
          ];

          # Ensure workerd (spawned by wrangler) can validate TLS certs on NixOS.
          shellHook = ''
            export SSL_CERT_FILE="${caBundle}"
          '';
        };
      });
}
