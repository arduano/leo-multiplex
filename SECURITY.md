# Security and ownership

This is a trusted personal control plane, not a multi-tenant sandbox. A signed-in
operator can run Codex and use a managed terminal with the host account's access.
The host runs YOLO sessions by design. No application setting grants extra root
privileges.

Select exactly one authentication mode. In Cloudflare mode, Access assertions are
verified at the origin using RS256, the configured issuer, application audience,
expiry, subject, and allowed email. WebSocket lifetime is limited by JWT expiry.

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

Report issues privately to the repository owner. Supply redacted versions and
reproduction steps using disposable state, not raw production logs or databases.
