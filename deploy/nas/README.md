# home-nas deployment

## Tailscale IP access

Use `compose.tailscale.yaml` as the standalone Compose file. Copy
`.env.tailscale.example` to `.env`, set the immutable image and allowed Tailscale
login, and use the NAS address from `tailscale ip -4` for these settings:

```dotenv
LEO_PUBLIC_ORIGIN=http://100.YOUR_NAS_IP:8444
LEO_GATEWAY_P2P_BIND=100.YOUR_NAS_IP:0
```

The deployed personal address is **http://100.82.173.47:8444/**. Access goes through
Tailscale Serve's authenticated HTTP listener, with WireGuard encryption across
the tailnet. MagicDNS and HTTPS certificates are not required for this address.
The app still checks the owner login, actual loopback proxy connection, and exact
browser origin. The backend remains inaccessible directly over the LAN/tailnet.

Copy `tailscale-ip.py` into this NAS project and run it as the configured Tailscale
operator. It adds only the dedicated HTTP port 8444 and its hostname/IP handlers:

```sh
docker compose -f compose.tailscale.yaml config --quiet
docker compose -f compose.tailscale.yaml up -d
python3 tailscale-ip.py
```

Tailscale 1.102 HTTP Serve appends the tailnet suffix to an IP Host header during
routing. The script installs that alias through the LocalAPI using the existing
configuration's ETag. It preserves unrelated routes, rejects conflicting handlers
and Funnel, and never retries a concurrent configuration overwrite. The ordinary
`tailscale serve --http=8444` command creates only the hostname route. The gateway
container does not receive the LocalAPI socket.

The gateway uses host networking and binds HTTP only to `127.0.0.1:4328`. Its
transport binds to the configured Tailscale address to avoid advertising the
NAS's many Docker bridges. Personal process composition uses the published source
clients and projection APIs; package versions and transport security are unchanged.
Trusted NAS-local processes remain inside the authentication boundary. Do not
expose the backend through another proxy or Docker bridge mapping, or enable Funnel.

For optional HTTPS later, enable MagicDNS/certificates, change the exact public
origin to the NAS HTTPS hostname, and use
`tailscale serve --bg --https=8443 http://127.0.0.1:4328`. Preserve the existing
port 443 route. Remove only the IP route with `python3 tailscale-ip.py --remove`,
or only the project's HTTPS route with `tailscale serve --https=8443 off`.
Never run `tailscale serve reset` for this project. See
[Tailscale authentication](../../docs/Tailscale-Authentication.md) for the trust
boundary and HTTP browser behavior.

## Image and common state

After the framework release is public and this repository's CI passes, run
the **Publish NAS image** workflow on `main`. It tests and publishes
`ghcr.io/arduano/leo-multiplex:sha-<commit>`; copy its immutable `@sha256:...`
reference from the workflow summary into `LEO_IMAGE`. Make the GHCR package
public on its first publication so the NAS can pull without a registry login.
The workflow does not deploy or change Cloudflare configuration.

Install this Compose project at `/home/arduano/host/leo-multiplex`. Create private
`config/` and `state/` directories owned by UID 1000, GID 100. Copy the host's
`gateway-pairing.json` to `config/` through SSH; never print or commit it.

Copy `.env.example` to `.env` and set an immutable image digest. For Tailscale,
follow [the Serve/loopback authentication setup](../../docs/Tailscale-Authentication.md).
It requires `LEO_AUTH_MODE=tailscale`, public origin, owner email, and the separate
host-network Compose file; Cloudflare settings are not used in this mode.

For Cloudflare mode (`LEO_AUTH_MODE=cloudflare`, also the default), configure:

- `LEO_PUBLIC_ORIGIN`: the exact HTTPS site origin, without a trailing slash.
- `LEO_ACCESS_TEAM_DOMAIN`: `https://<team>.cloudflareaccess.com`.
- `LEO_ACCESS_AUDIENCE`: the Access application's AUD.
- `LEO_ACCESS_EMAIL`: Leo's allowed sign-in email.

These are application settings. Create the Cloudflare Tunnel, DNS, Access app,
and identity policy separately. A remembered MFA-protected identity-provider
login provides low-friction access. Choose the Access session duration there.

The origin is `http://web:4318` on Docker network `leo-multiplex-access`.
Cloudflared can join that network, or a host-level connector can use
`http://127.0.0.1:4328`. No LAN/public wildcard host port is published.
`GET /healthz` returns only `{ok:true}`; every other application route requires
the configured authentication mode. There is no unauthenticated production fallback.

```sh
docker compose --env-file .env config --quiet
docker compose --env-file .env up -d
docker compose ps
```

Open gateway/runtime enrollment on the **new Leo control service** only during
initial pairing. Start the runtime and gateway, confirm the host is selected,
then close both enrollment flags. Keep the host's stable UDP binding and its
endpoint identity; restarting with a new ephemeral address breaks old tickets.

Do not run commands against other Compose projects. Never use a global Docker
prune or restart another service as part of this deployment.

Update only the image digest and run `docker compose up -d`. Gateway updates do
not restart host Codex processes. Back up `config/`, `state/`, and `.env` privately;
they include transport credentials and identity. Public support reports should
contain only version, health, and redacted errors.
