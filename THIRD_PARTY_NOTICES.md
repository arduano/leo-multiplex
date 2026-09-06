# Third-party notices

The personal React UI, gateway process supervision, and CLI client usage derive from Agent
Multiplex by Arduano, under its MIT license. Its browser dependency notices are retained in
`apps/web/THIRD_PARTY_LICENSES.txt` and shipped with the static assets.

Codex CLI is pinned independently to 0.152.0. Codex's Apache-2.0 license and NOTICE
ship in its upstream distribution and the Agent Multiplex Codex adapter package.
Node, node-pty, Iroh, and other native components retain their upstream licenses
in the dependency artifacts. Cloudflare integration uses the `jose` library for
JWT verification and `smol-toml` for local configuration parsing; their package
license files must remain in redistributed dependencies.

The optional NAS Cloudflare Compose deployment references separately distributed
cloudflare/cloudflared (Apache-2.0) and nginxinc/nginx-unprivileged images (Nginx
uses its BSD-style license). Their pinned upstream images retain their component
licenses. These images are deployment dependencies, not part of the Leo image.

No runtime credentials or configuration from Leo's machines are distribution
inputs. Nix and Docker builds consume code and immutable public artifacts only.

Android Web Push uses `web-push` 3.6.7 (MPL-2.0), `http_ece` 1.2.0 (MIT),
`asn1.js` 5.4.1 (MIT), and their pinned dependencies. Their license/source files
remain in redistributed `node_modules`; web-push source is unmodified. The new
Leo app icons are original vector-derived raster assets authored for this repo.
