# Security and ownership

This is a trusted personal control plane, not a multi-tenant sandbox. A signed-in
operator can run Codex and use a managed terminal with the host account's access.
The host runs YOLO sessions by design. No application setting grants extra root
privileges.

Cloudflare Access assertions are verified at the origin using RS256, the fixed
configured issuer, the application audience, expiry, subject, and allowed email.
Unsigned forwarding headers never confer identity. HTTP mutations and WebSocket
upgrades require the configured browser origin. Missing authentication fails
closed. WebSocket lifetime is limited by the assertion expiry.

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
