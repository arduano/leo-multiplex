# Third-party notices

The personal React UI, gateway process supervision, and CLI client usage derive from Agent
Multiplex by Arduano, under its MIT license. Its browser dependency notices are retained in
`apps/web/THIRD_PARTY_LICENSES.txt` and shipped with the static assets.

The personal Nix host pins Codex CLI independently to 0.153.4. Codex's Apache-2.0 license and NOTICE
ship in its upstream distribution and the Agent Multiplex Codex adapter package.
Node, node-pty, Iroh, and other native components retain their upstream licenses
in the dependency artifacts. Cloudflare integration uses the `jose` library for
JWT verification and `smol-toml` for local configuration parsing; their package
license files must remain in redistributed dependencies.

Corporate Copilot composition directly pins `@github/copilot-sdk` 1.0.11 (MIT)
and `@github/copilot` 1.0.81, whose upstream license is in its `LICENSE.md`.
Their existing dependency graph and native platform packages remain unmodified;
redistribution retains those notices. Windows ACL validation uses installed
Windows PowerShell/.NET system components, which are not bundled by Leo.
The laptop installers use the operator's existing Git, Node/npm, Windows
PowerShell or WSL Bash installations. They do not redistribute those tools or
download a separate unpinned Copilot executable.
The work-command sidecar uses the already pinned p2prpc transport, tRPC, Zod and
framework SQLite package. Its original Windows shell helper invokes installed
PowerShell/.NET and Windows kernel job APIs; WSL invokes installed Bash. No new
binary, service dependency or third-party source is redistributed for this path.
The optional Windows background task uses installed Windows Task Scheduler,
PowerShell and Node.js; no separate service manager is bundled.

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
