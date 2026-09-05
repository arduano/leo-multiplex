# Tailscale authentication

Select Tailscale mode to use the workspace through the NAS's HTTPS Serve address.
Cloudflare configuration is unnecessary in this mode and remains supported for
later use.

The required request path is:

```text
Allowed Tailscale user
  -> Tailscale Serve HTTPS
  -> 127.0.0.1:4328
  -> Leo application in a Docker host-network container
```

Serve replaces client-supplied Tailscale identity headers with the authenticated
user's identity. The application checks that the actual socket peer is loopback
and that exactly one `Tailscale-User-Login` matches the configured owner. It never
uses forwarded IP headers to make this decision. Trusted NAS-local processes are
inside this boundary and can assert an identity when connecting to the loopback
listener.

Configure the application with:

```dotenv
LEO_AUTH_MODE=tailscale
LEO_PUBLIC_ORIGIN=https://YOUR_NAS.YOUR_TAILNET.ts.net
LEO_ACCESS_EMAIL=YOUR_TAILSCALE_LOGIN_EMAIL
LEO_HTTP_BIND=127.0.0.1
LEO_HTTP_PORT=4328
```

The public origin must be the exact HTTPS origin, including a nondefault port
when applicable, without a path or trailing slash. The allowed email is the
ASCII Tailscale login address, not a display name. There is no application token
or extra proxy secret to provision.

Use the standalone `deploy/nas/compose.tailscale.yaml` with `network_mode: host`,
not the bridge-network Compose file. The application must bind only to the NAS
loopback address. Startup rejects wildcard, LAN, and tailnet bind addresses in
Tailscale mode. Request authentication also rejects non-loopback socket peers.
Configure Tailscale Serve to target `http://127.0.0.1:4328`.

Never expose this listener through another LAN/public proxy, port forward, or
Docker port mapping that would make remote requests appear to come from loopback.
Other NAS users and local services are trusted; do not use this deployment model
on a machine with untrusted local processes. A process with Docker administrative
access is already inside the NAS trust boundary. Access to the tailscaled
LocalAPI socket is unnecessary.

Use Serve, not Funnel. Tagged clients do not supply a user login and are rejected.
Shared-device users still need to match the application's allowed email.

Every request is authenticated. Only `GET /healthz` is public and it contains no
catalog or identity data. Mutation requests and WebSocket upgrades require the
exact public origin. Authenticated `GET /auth/session` returns only the selected
authentication method for the UI; it exposes no identity or configuration.
WebSockets reconnect every five minutes so a long-running connection periodically
rechecks the tailnet path and current application policy.

For verification, confirm that an allowed user reaches the app through Serve,
another user is rejected, and the application listens exclusively on loopback.
Direct LAN/tailnet requests must not reach the listener. A local request without
`Tailscale-User-Login` receives 401; a local process intentionally supplying the
allowed login is trusted by this configuration. Gateway restarts do not require
restarting host Codex sessions.

To switch later, set `LEO_AUTH_MODE=cloudflare` and provide the existing
`LEO_ACCESS_TEAM_DOMAIN`, `LEO_ACCESS_AUDIENCE`, `LEO_ACCESS_EMAIL`, and
`LEO_PUBLIC_ORIGIN` configuration. The default remains Cloudflare when the mode is
omitted. Missing configuration fails startup; there is no unauthenticated mode.

The upstream [Tailscale Serve documentation](https://tailscale.com/kb/1312/serve)
describes identity-header replacement, local listener requirements, shared users,
and tagged-device/Funnel limitations.
