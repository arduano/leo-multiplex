# Security and ownership

This is a trusted personal control plane, not a multi-tenant sandbox. A signed-in
operator can run Codex and use a managed terminal with the host account's access.
The host runs YOLO sessions by design. No application setting grants extra root
privileges.

Select exactly one authentication mode per listener. In Cloudflare mode, Access assertions are
verified at the origin using RS256, the configured issuer, application audience,
expiry, subject, and allowed email. WebSocket lifetime is limited by JWT expiry.

The combined NAS deployment has two independently authenticated HTTP surfaces
over one gateway projection, identity, store and transport. Tailscale remains on
host loopback; Cloudflare uses an owner-only Unix socket in a private directory.
A dedicated bridged Nginx origin exposes that socket to cloudflared using Compose
service-name DNS. Neither container receives the Tailscale listener, pairing
configuration or gateway state. No host port is published for Cloudflare.
Authentication is selected by listener configuration, never by Host, forwarded
headers, socket reachability, or falling back after another method rejects a
request. The proxy preserves JWT and Origin headers, disables request logging
and response buffering, and forwards WebSocket upgrades.

The tunnel token is an owner-only file mounted read-only into cloudflared alone.
The connector and proxy images are pinned by digest, run without root or Linux
capabilities, and use read-only root filesystems. The socket directory is shared
only between the gateway and proxy; access to it does not replace JWT validation.

In Tailscale mode, the origin requires the allowed `Tailscale-User-Login` and a
loopback socket peer. Tailscale Serve strips client-supplied identity headers and
supplies its authenticated user's login. Serve connects directly to the gateway
on `127.0.0.1:4328`; the container uses host networking and the application rejects
non-loopback bind configuration. Never put this listener behind a LAN/public
forwarder or bridge-network port mapping that disguises remote peers as loopback.
Trusted NAS-local processes can reach the listener and assert an identity; they
are explicitly inside the trust boundary. The application does not trust
forwarded IPs, display names, or Cloudflare headers as a Tailscale identity
fallback. LAN, tailnet, and Docker socket peers fail authentication.

Tailscale public origins may use HTTPS, or HTTP only with a canonical IPv4
address in `100.64.0.0/10`. HTTP hostnames, LAN/public addresses, alternate IP
spellings, and URLs containing credentials or extra components are rejected.
Tailscale Serve's tailnet connection remains WireGuard encrypted for HTTP access;
the browser nevertheless sees a non-secure context. The HTTP exception does not
apply to Cloudflare mode, and neither socket-peer nor identity validation changes.

Tailscale WebSockets reconnect at least every five minutes to recheck Serve
identity and the email allowlist. Tagged clients and Funnel requests without
user identity fail closed. This mode supports ASCII Tailscale login addresses.
See [Tailscale authentication](docs/Tailscale-Authentication.md) for configuration.

In both modes, HTTP mutations and WebSocket upgrades require the exact configured
browser origin; requests supplying another origin are rejected even for GETs.
Duplicate authentication headers are rejected. Missing authentication fails
closed and switching modes never enables unauthenticated access.

The NAS transport binds to its configured Tailscale address instead of
automatically advertising all Docker bridge interfaces. This is a local socket
choice; source endpoint pins, enrollment, shared-secret authentication, and
zero-authority projection remain enforced by the published framework packages.

The gateway receives operator scopes at two boundaries: its control-source grant
and each authenticated request. Neither grants catalog authority. Host endpoint
pins and a private shared secret authenticate transport. Close enrollment after
pairing. Keep the control's UDP address stable and its private identity durable.

Managed Codex has a separate home, database, socket and process. Bootstrap reads
the selected provider configuration from the ordinary CLI config without changing
it or executing its credential helper. The native runtime then reuses that helper
under the same account. Do not symlink the full CLI home or config into managed
state. Do not use terminal scrollback or vendor files as canonical history.

Treat configuration, state, pairing files, backups, and native terminal output as
private. Never commit or publish credential contents, provider URLs, auth commands,
native homes, tickets, identities or transport secrets. The managed and ordinary
Codex processes share an OS account; configuration separation is an ownership
boundary, not protection from malicious code running with that account.

The agent CLI authenticates through the same gateway and uses the same operator
scopes. A process permitted to use the owner's Tailscale identity can control
managed agents with the owner's host-account access; it is not a restricted
agent sandbox. Its operation ledger contains exact prompt/native request inputs
in owned private files, committed before mutation dispatch. Retain that ledger
privately across runner restarts; explicit retries preserve the saved IDs and
binding fences. Optional Cloudflare assertions are read from a private file,
never URL parameters. Image downloads use scoped runtime APIs and exclusive
owner-only destination files. See [the CLI runbook](docs/Agent-CLI.md).

Report issues privately to the repository owner. Supply redacted versions and
reproduction steps using disposable state, not raw production logs or databases.

The Android PWA caches only a build-owned static shell, hashed assets and icons.
Authenticated HTML/CSP nonces, auth responses, RPC traffic, runtime images and
transcripts are excluded. Offline HTML receives a fresh stylesheet nonce and
restrictive CSP. Updates wait for explicit activation after durable draft flush.
Local drafts and exact pending action inputs are intentionally private durable
browser data (IndexedDB); browser origin isolation and an opaque gateway/owner
scope partition them. They are available offline to anyone with access to this
browser profile and are not separately encrypted or remotely erased by logout.
Quota and concurrent-editor failures block dispatch and preserve work; there is
no automatic offline command queue. Never share an unlocked installed app or
browser profile containing private drafts.

Background notifications require explicit permission, a registered device and
an explicitly watched agent. Their title/status payloads omit transcript and
path fields, but the agent title itself appears on the lock screen. VAPID keys
and push subscriptions are credentials and remain in private gateway state;
client storage retains only the opaque device identity. Notification REST routes
use the same owner authentication and origin checks as all gateway mutations.
Push delivery permits only canonical HTTPS FCM endpoints, validates P-256 keys,
never follows redirects, and bounds delivery bytes, retries, pending work and
deduplication. Push failures do not interrupt domain-stream ingestion. Revoke
lost devices from App settings. See [Android app](docs/Mobile-PWA.md).
