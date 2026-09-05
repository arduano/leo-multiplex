# home-nas deployment

## Tailscale first

Use `compose.tailscale.yaml` as the standalone Compose file. Copy
`.env.tailscale.example` to `.env` and set the immutable image, exact HTTPS
Tailscale origin, and allowed Tailscale login. Do not combine the two Compose
files. This mode needs no Cloudflare account configuration.

```sh
docker compose -f compose.tailscale.yaml config --quiet
docker compose -f compose.tailscale.yaml up -d
tailscale serve --bg --https=8443 http://127.0.0.1:4328
```

The gateway uses host networking but binds HTTP only to `127.0.0.1:4328`.
Tailscale Serve terminates HTTPS and supplies its authenticated user identity.
The app checks the exact allowed login and browser origin. It rejects requests
without Serve identity and requests arriving through a non-loopback connection.
Do not expose the backend on a Docker bridge, LAN, or public address, and do not
enable Funnel. Local NAS processes are inside this trusted personal boundary.
See [Serve identity headers](https://tailscale.com/kb/1312/serve#identity-headers).

Port 8443 is dedicated to this application; preserve any existing Serve listener
on 443. Stop only this route with `tailscale serve --https=8443 off` when migrating
to Cloudflare. Never run `tailscale serve reset` as part of this deployment.

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
