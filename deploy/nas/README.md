# home-nas deployment

After the framework release is public and this repository's CI passes, run
the **Publish NAS image** workflow on `main`. It tests and publishes
`ghcr.io/arduano/leo-multiplex:sha-<commit>`; copy its immutable `@sha256:...`
reference from the workflow summary into `LEO_IMAGE`. Make the GHCR package
public on its first publication so the NAS can pull without a registry login.
The workflow does not deploy or change Cloudflare configuration.

Install this Compose project at `/home/arduano/host/leo-multiplex`. Create private
`config/` and `state/` directories owned by UID 1000, GID 100. Copy the host's
`gateway-pairing.json` to `config/` through SSH; never print or commit it.

Copy `.env.example` to `.env`, set an immutable image digest, and configure:

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
Access authentication. There is no unauthenticated production fallback.

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
