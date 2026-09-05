# Third-party notices

The personal React UI and gateway process supervision derive from Agent
Multiplex by Arduano, under its MIT license. Its browser dependency notices are retained in
`apps/web/THIRD_PARTY_LICENSES.txt` and shipped with the static assets.

Codex CLI is pinned independently to 0.152.0. Codex's Apache-2.0 license and NOTICE
ship in its upstream distribution and the Agent Multiplex Codex adapter package.
Node, node-pty, Iroh, and other native components retain their upstream licenses
in the dependency artifacts. Cloudflare integration uses the `jose` library for
JWT verification and `smol-toml` for local configuration parsing; their package
license files must remain in redistributed dependencies.

No runtime credentials or configuration from Leo's machines are distribution
inputs. Nix and Docker builds consume code and immutable public artifacts only.
