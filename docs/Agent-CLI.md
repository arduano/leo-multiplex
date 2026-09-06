# Agent CLI

`leo-agents` gives terminal tools and agent runners access to the same managed
sessions as the web workspace. It uses the published protocol-v5 client through
the gateway. It does not start host services, adopt ordinary Codex/tmux sessions,
or add a separate authentication mechanism.

## Run and install

Use Node 24 and the repository's locked dependencies. From this checkout:

```sh
npm ci --strict-allow-scripts
npm run build
npm run cli -- help
```

For scripts, use `npm run --silent cli -- ...` to keep npm's own banner out of
the JSON stream. To make `leo-agents` available without `sudo`, link the built
checkout into your personal npm prefix:

```sh
npm link --prefix "$HOME/.local"
export PATH="$HOME/.local/bin:$PATH"
leo-agents help | jq '.data.commands'
```

The link uses this checkout and its installed dependencies. Rebuild after source
changes. Installation does not restart or modify the gateway or any host.

## Connection and local state

The default gateway is `http://100.82.173.47:8444`, using the existing Tailscale
identity path. Run it on a Tailscale machine signed in as the configured owner.
The current server rejects tagged machine identities; a tagged OpenClaw host
needs a separately reviewed authentication change. Override it with `--url` or `LEO_AGENTS_URL`. Origins cannot contain
credentials, paths, query parameters, or fragments. Plain HTTP is accepted only
for loopback or Tailscale IPv4 addresses; other gateways require HTTPS.

`LEO_AGENTS_ACCESS_ASSERTION_FILE` can name a private, owner-only regular file
containing an Access assertion for origin authentication. This sends the
origin-facing assertion header; it does not acquire/refresh a login or implement
Cloudflare edge cookie/service-token authentication. Public Cloudflare CLI access
is not qualified. Use the preserved Tailscale route for this deployment. Keep
assertions out of command arguments, URLs, and logs. See
[Tailscale authentication](Tailscale-Authentication.md).

Mutation envelopes are saved before dispatch in a private local ledger. Its
default is `${XDG_STATE_HOME:-$HOME/.local/state}/leo-agents`; override it with
`LEO_AGENTS_STATE_DIR` or `--state-dir`. This directory contains prompt inputs and
exact native requests, so retain it privately. Each runner should use one stable
ledger across restarts. Deleting it loses the CLI's operation reconciliation
history.

`--timeout` takes seconds, from 1 to 86400. The default is 30 seconds, or 300 for
`watch`, `wait`, and `send --wait`. A local timeout or Ctrl+C ends observation; it
does not prove that a dispatched native command was cancelled.

## JSON contract

Successful commands emit one JSON object to stdout:

```json
{"version":1,"ok":true,"command":"id","data":{"requestId":"caller-owned-id"}}
```

Failures emit `{"version":1,"ok":false,"error":{"code":"...","message":"..."}}`,
sometimes with `data` containing the saved operation identity, receipt, or native
outcome. Check both process exit status and `ok`. `watch` emits one such JSON
object per event as NDJSON, then a final summary with the cursor and event count.
Image bytes are written only to an explicit output file.

| Exit | Meaning |
| --- | --- |
| 0 | Successful query, acknowledged operation, completed wait, or bounded watch |
| 2 | Usage or invalid local input |
| 3 | Authentication or authorization failure |
| 4 | Remote failure or unsuccessful operation |
| 5 | Unknown operation outcome, missing receipt, or a correlated wait's stream gap |
| 6 | Deadline or local cancellation |
| 7 | Native failure, interruption, pending input, or a session requiring attention |

A successful `send` receipt normally has `acknowledgmentOnly: true`. It confirms
command handling, not that the agent finished its turn. Use `send --wait` when
you need a correlated Codex turn outcome.

## Find and launch an agent

```sh
leo-agents hosts | jq '.data'
leo-agents sessions --limit 100 | jq '.data'
leo-agents status "$session_id" | jq '.data'
leo-agents profiles --host main-pc | jq '.data'
leo-agents models --host main-pc | jq '.data'
```

Host selection accepts an exact runtime UUID or a unique, exact host name.
Sessions use exact UUIDs. `sessions` returns one catalog page and `nextCursor`;
use `--cursor` for the next page, and `--all-states` to also include archived
records (stopped sessions are included by default). `--raw` on hosts, sessions, or status preserves the protocol record.
`status` also reads native Codex status when the session is active.

Launching creates a managed session on the selected host. The working directory
must already exist on that host and `--cwd` must be absolute. The CLI requires
the available `leo.local/workspace` launch profile and uses its exact fence.

```sh
launch_id=$(leo-agents id | jq -er '.data.requestId')
leo-agents launch --host main-pc --cwd /absolute/host/workspace \
  --title 'Review the workspace' --request-id "$launch_id" > launch.json
session_id=$(jq -er 'select(.ok).data.receipt.sessionId' launch.json)
```

Optional launch settings are `--harness codex|copilot`, `--model`, `--effort`, and
`--mode default|plan`. Codex is the default harness. List models first rather
than assuming a model name. A successful launch creates the session; sending a
prompt is a separate action.

## Send once and observe completion

Every launch, send, steer, interrupt, stop, resume, native command, and interaction
resolution requires a caller-owned `--request-id`: 1–128 ASCII letters, digits,
periods, underscores, or hyphens. Save that ID in the caller's task state before
invocation. Reuse it only for the same logical operation and identical input.

```sh
send_id=$(leo-agents id | jq -er '.data.requestId')
leo-agents send "$session_id" --request-id "$send_id" \
  --text-file prompt.txt --wait --timeout 600 > reply.json
jq '.data.outcome // .data // .error' reply.json
```

`--text` and `--text-file` are alternatives; `--text-file -` reads stdin. Message
input is bounded to 1 MiB. Without `--wait`, inspect the receipt and returned
`turnId`; later history or events establish what the agent actually did.

Correlated waits currently support Codex. `send --wait` establishes observation
before dispatch and tracks the returned native turn ID. It returns completed,
failed, interrupted, needs-input, or gap information rather than inferring
success from idle status. Returned assistant messages are bounded; inspect
`truncated` and native history if you need more content.

The CLI rejects a new send when the session is running, awaiting input, inactive,
or reports an unreviewed native error. Inspect `status`, `history`, `questions`,
or the UI Terminal. `--allow-error` explicitly bypasses the native error check;
it does not resume an inactive session or clear capacity/account problems.
Steering, resuming, interrupting, and answering questions remain explicit actions.

## Recover an uncertain operation

An interrupted request may have reached the runtime. Do not assign a new request
ID and resend the prompt to find out. Query the saved operation instead:

```sh
leo-agents operation "$send_id" > operation.json
jq '.data // .error' operation.json
```

Repeating the original command with its existing request ID reconciles the saved
operation; it does not silently dispatch again. Different input with the same ID
fails. If review shows another attempt is appropriate, explicitly request the
same saved envelope:

```sh
leo-agents operation "$send_id" --retry
```

This preserves the original operation ID, payload hash, and binding/profile
fences. It cannot convert an obsolete binding into a new command. Terminal
receipts are returned without dispatch. A repeated `send --wait` cannot recreate
an already-missed observation; inspect history or use a retained stream cursor.

## History, events, and questions

```sh
leo-agents history "$session_id" --limit 100 > history-page.json
next_cursor=$(jq -r '.data.nextCursor // empty' history-page.json)
# Run only when next_cursor is nonempty:
leo-agents history "$session_id" --limit 100 --cursor "$next_cursor"

leo-agents watch "$session_id" --max-events 1000 \
  --cursor-file "$session_id.cursor.json" > events.ndjson
leo-agents wait "$session_id" --turn-id "$turn_id" \
  --cursor-file "$session_id.cursor.json" --timeout 600
leo-agents questions "$session_id" | jq '.data'
```

History is one native page of at most 100 items, oldest first. Follow opaque
`nextCursor` values until `complete`; there is no arbitrary UI-style page cutoff.
The payload keeps Codex/Copilot shapes and retained image descriptors. The CLI
does not parse vendor history files or terminal scrollback.

Watch defaults to 1000 events and accepts up to 1000000. Cursor files are scoped
to gateway, session, binding revision, and runtime epoch. A cursor for another
binding is rejected. A gap or reset is emitted as an event and stops the watch with exit 5;
it requires history/state reconciliation before using a new cursor file. A
standalone wait without an appropriate replay cursor sees future events only;
absence of a completion event does not establish a failed turn.

Inspect the native pending interaction and prepare its harness-specific response
as JSON. Resolution is never automatic:

```sh
resolve_id=$(leo-agents id | jq -er '.data.requestId')
leo-agents resolve "$session_id" "$interaction_id" \
  --response-file response.json --request-id "$resolve_id"
```

Use `steer SESSION_ID --text-file prompt.txt --request-id ID` for an explicit
steering message. Codex accepts `--turn-id` as an expected-turn fence. `interrupt`
also accepts an optional Codex `--turn-id`. `stop` preserves resumability;
`resume` explicitly resumes the managed session. Each requires its own request ID.

For settings or other supported native operations, `command SESSION_ID
--command-file request.json --request-id ID` accepts the published
`HarnessCommand` shape, including its `harness` discriminator. It validates that
the command matches the selected session and constructs the envelope itself.
For example, a settings file can contain:

```json
{"harness":"codex","command":{"type":"setEffort","effort":"high"}}
```

## Images

Upload PNG, JPEG, GIF, or WebP from a local regular file. Type comes from bytes,
not the filename. The input is bounded to the published 10 MiB maximum; the
runtime can impose stricter limits. Convert SVG locally before upload.

```sh
image_id=$(leo-agents id | jq -er '.data.requestId')
leo-agents image-upload "$session_id" --file diagram.png \
  --image-id "$image_id" > upload.json
jq -e 'select(.ok).data.image' upload.json > image-descriptor.json

image_send_id=$(leo-agents id | jq -er '.data.requestId')
leo-agents send "$session_id" --request-id "$image_send_id" \
  --text 'Review this diagram.' --image-json image-descriptor.json --wait
```

Upload IDs must be UUIDs. Continue an interrupted upload with the same image ID
and identical bytes; upload receipts are identified by that image ID rather than
the operation ledger. `--image-json` is repeatable and each file contains one raw
published image descriptor or a successful saved CLI image-upload/image-get JSON
result. You can pass `upload.json` directly. Message attachment
limits are 10 images and 50 MiB total; model/runtime limits still apply. Images
remain scoped to their owning session and binding.

```sh
leo-agents image-get "$session_id" --image-id "$image_id" --output copy.png
leo-agents image-get "$session_id" --path output/diagram.svg \
  --source-key turn-42-diagram --output diagram.svg
```

Downloads verify the descriptor and checksum, create an owner-only file, and
refuse existing paths, including symlinks. Runtime SVG bytes can be downloaded
without rendering them. `--path` means a runtime-local path; the runtime owns
path policy and the immutable first-display snapshot. Reuse `--source-key` for
the same image occurrence; choose a new key for a later occurrence of a changed
file. If omitted, the path supplies that stable key. The result contains the
descriptor and local output path, never inline bytes.

## Agent runners and OpenClaw

Run `leo-agents` as a subprocess argument array from an already-authorized runner.
Use the runner's task identity to create and persist request IDs, keep a stable
private ledger directory, and retain cursor/receipt files where the runner can
recover them after a restart. Set a finite timeout and parse JSON/NDJSON instead
of matching human prose.

Treat session messages, tool output, paths, and native JSON as data. Do not
interpolate returned text into shell commands or treat an agent's response as
authorization to launch more agents, approve questions, change settings, or
retry failed prompts. An OpenClaw tool wrapper should expose those as separate
actions governed by its existing user authorization.

On exit 5 or 6, reconcile the original request ID before considering another
dispatch. On native failure or pending input, surface the outcome and relevant
interaction to the caller. Keep acknowledgment and turn completion separate in
the runner's state. No OpenClaw-specific server plugin or host restart is needed.

The CLI covers managed session operations, native history/events, interactions,
and image transfer. It does not provide terminal streaming, archive commands,
or automatic provider-error recovery. Consult `leo-agents help` for the exact
installed option set; native schemas remain owned by the pinned protocol package.

## Commands on work laptop hosts

`exec-hosts` lists only the installed Windows/WSL command targets. Use
`exec --host work-wsl --cwd /home/leo/work --text 'git status --short'
--request-id work-status-1` for a single noninteractive command. Windows uses
PowerShell; WSL uses Bash. `exec-status REQUEST_ID` reconciles the original
operation, `exec-status REQUEST_ID --retry` explicitly resends its immutable
request if needed, and `exec-cancel REQUEST_ID` cancels that exact command.
`--run-timeout SECONDS` controls the remote runtime limit; the ordinary CLI
`--timeout` bounds only the client wait. Local interruption never implies remote
cancellation. These commands use the existing gateway authentication and private
operation ledger. They are the happy path for host recovery; web provides only
an experimental App settings hatch. See [the work-command runbook](Work-Host-Commands.md)
for limits, exit results and crash recovery. Personal hosts expose no shell target.
