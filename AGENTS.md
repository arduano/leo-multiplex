# Leo Multiplex

Personal applications built on the published Agent Multiplex protocol-v5 packages.

- Control and runtime state belong to each host. NAS gateways have no catalog authority.
- Never stop, adopt, migrate, or modify pre-existing Codex/tmux sessions without explicit authorization.
- Managed Codex uses its own home and copies selected provider configuration from ~/.codex/config.toml at runtime; the original stays read-only. Never publish credentials, provider URLs/configuration, tickets, or state.
- No real model calls without a fresh explicit allowance. Use disposable state for tests.
- Keep dependencies pinned to published artifacts; no sibling imports or file dependencies in a deployment.
- UI: preserve the conversation-first React workspace, native semantics, image support, accessibility, and mobile behavior.
- Run npm run typecheck, npm test, npm run build. Check Nix and Docker when changed.
