# home-nas deployment

## Cloudflare and Tailscale together

Use `compose.cloudflare.yaml` as the standalone Compose entrypoint for both
access paths. It extends the existing Tailscale service, preserving its image
identity, state, host networking, loopback listener, and Tailscale transport bind.
The additional containers use an ordinary Compose bridge:

```text
https://agents.arduano.io → Cloudflare Access → cloudflared
  → http://multiplex-gatreway:8444 (Compose service-name DNS)
  → private Unix socket → gateway Cloudflare JWT authentication

http://100.82.173.47:8444 → Tailscale Serve
  → 127.0.0.1:4328 → gateway Tailscale authentication
```

The spelling `multiplex-gatreway` matches the remotely configured tunnel.
The origin proxy forwards only to `/run/leo-cloudflare/access.sock`, never to
the Tailscale listener. It preserves WebSocket upgrades, Origin and assertion
headers, and streaming responses. No extra host mappings, static Docker IPs,
published Cloudflare ports, additional gateway enrollment, or host rebuild are
needed. Both HTTP surfaces share one projection and gateway lifecycle.
The NAS has exhausted Docker's default network pools, so this project's bridge
uses `10.203.82.0/24`. Container IPs remain dynamically allocated. On another
machine, set `LEO_CLOUDFLARE_SUBNET` to an unused private subnet after checking
its Docker networks and LAN/tailnet routes.

Copy `compose.cloudflare.yaml`, `compose.tailscale.yaml` and
`cloudflare-origin.conf` into this project. Preserve the existing `.env`; use
`.env.cloudflare.example` as the list of required settings. Add the Access
team domain and this application's AUD. The existing allowed owner email is
also required in signed Access assertions. The second listener has its own exact
HTTPS origin; the primary listener retains its existing Tailscale origin.

Create `secrets/` and `run/cloudflare/` as private directories owned by UID 1000,
GID 100, mode 0700. Install the raw tunnel token as
`secrets/cloudflare-token`, owned by the same user, mode 0600. Only cloudflared
mounts the token. The gateway and origin proxy share the socket directory; the
gateway requires private ownership and creates an owner-only socket. Never put
tokens into Compose variables or print resolved production configuration.

```sh
docker compose -f compose.cloudflare.yaml config --quiet
docker compose -f compose.cloudflare.yaml up -d
docker compose -f compose.cloudflare.yaml ps
```

The gateway health check covers both surfaces, and the proxy checks the actual
socket upstream. Confirm connector readiness locally, then sign in at the public
URL and verify `/auth/session`, host availability, conversation/image reads and
WebSocket connection. An unauthenticated request to the public URL should go to
Access login; an unauthenticated request to the proxy must receive 401. Access
expiry requires browser reauthentication and closes its WebSocket. The Tailscale
URL and owner-authenticated agent CLI continue to work during a tunnel outage.
Cloudflare service-token CLI authentication is not part of this deployment.
CI runs `python3 scripts/cloudflare-proxy-smoke.py <built-image>` against the
pinned proxy on an isolated Docker network, using only disposable signing keys.

For an update, change `LEO_IMAGE` to the tested immutable digest and run the same
combined Compose command. Back up the previous image reference and `.env`
privately first. To roll back, stop only this project's `cloudflared` and
`multiplex-gatreway` services, restore the prior `.env`, then run
`docker compose -f compose.tailscale.yaml up -d --no-deps web`. Do not run two
gateway processes against the same state. A gateway restart does not restart
the host's control, runtime, or Codex sessions.

### Hosts that sleep or disconnect

Treat Windows and WSL on the same laptop as two independent hosts: each needs
its own persistent control/runtime state and transport identity, and its own
entry in the gateway's pairing document. Preserve existing source entries when
adding either host. The current `scripts/pair-nas.sh` replaces that document;
it is an initial single-host delivery helper, not a multi-host merge operation.
The gateway currently uses one configured transport enrollment secret for its
sources; prepare new hosts with the matching trust configuration privately.

Each source reconnects independently with backoff capped at 30 seconds after
failure detection, then refreshes its canonical projection. Two sleeping laptop
sources do not transfer authority or change routing for the always-on hosts.
Keep host state and endpoint identities across restarts; never create a new
catalog or pairing identity just because the laptop woke on another network.

An open browser retains unavailable sessions and drafts, disables their agent
actions, and restores observation as the source returns. A chosen launch host
stays selected while offline; the form cannot silently target another machine.
No prompt, resume or uncertain command is automatically dispatched on reconnect.
Durable local drafts survive browser suspension/reload; native history is not
persisted for cold offline viewing. See [offline behavior](../../docs/Mobile-PWA.md#saved-work-and-offline-behavior).
Physical laptop suspend/wake and Windows/WSL network changes need a device check
after installation; the four-host fixtures exercise the UI and routing behavior
without changing production sessions.

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
host-network Compose file. The combined recipe adds a separately authenticated
Cloudflare socket without changing this primary listener's mode.

For Cloudflare mode (`LEO_AUTH_MODE=cloudflare`, also the default), configure:

- `LEO_PUBLIC_ORIGIN`: the exact HTTPS site origin, without a trailing slash.
- `LEO_ACCESS_TEAM_DOMAIN`: `https://<team>.cloudflareaccess.com`.
- `LEO_ACCESS_AUDIENCE`: the Access application's AUD.
- `LEO_ACCESS_EMAIL`: Leo's allowed sign-in email.

These are application settings. Create the Cloudflare Tunnel, DNS, Access app,
and identity policy separately. A remembered MFA-protected identity-provider
login provides low-friction access. Choose the Access session duration there.

For the alternative Cloudflare-only `compose.yaml`, the origin is
`http://web:4318` on Docker network `leo-multiplex-access`.
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
