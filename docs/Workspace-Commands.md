# Workspace commands

Type `/` in the message composer to open the command menu. Use the arrow keys
to select a command, Enter to run it, Tab to complete its name, and Escape to
close the menu. Shift+Enter still inserts a newline. Commands work through the
same native session API as the buttons; they are not sent as agent prompts.

| Command | Action |
| --- | --- |
| `/plan` or `/plan on` | Use Plan mode for subsequent turns |
| `/plan off` or `/default` | Return to Agent mode (Interactive for Copilot) |
| `/model` | Open model selection |
| `/model MODEL_ID` | Select an exact catalog model ID or unique full name |
| `/effort` | Open Codex reasoning options |
| `/effort LEVEL` | Apply a reasoning level advertised for the current Codex model |
| `/mode` | Open native mode selection |
| `/mode MODE` | Select Default/Plan for Codex, or Interactive/Plan/Autopilot for Copilot |
| `/interrupt` | Interrupt the current running turn |
| `/new` | Open the new-agent dialog; creation still requires submission |
| `/status` | Open session, stream, and history details |
| `/terminal` | Open this managed agent’s Terminal view |
| `/help` | Show the command menu |

Mode IDs are lowercase: `default`, `plan`, `interactive`, and `autopilot`.
`/plan` takes only `on` or `off`; change mode first, then send a prompt separately.
Unrecognized commands, including unsupported native-TUI commands such as
`/compact`, show local guidance and preserve the draft. Prefix a command with
another slash to send it literally: `//plan` sends `/plan` as message text.
Workspace paths such as `/home/leo/project` remain ordinary messages.

The model name beside the composer opens the model picker directly. Choose a
model once to apply it; no separate Apply button is needed. The Reasoning tab
shows that model’s supported levels and descriptions. Current settings come
from host-reported native settings. Catalog defaults are labelled separately;
missing settings are never presented as an acknowledged default. A model change
does not silently change reasoning effort. If the retained effort is no longer
listed for the new model, the picker asks you to choose a supported level.

Codex model, reasoning, and mode choices affect subsequent turns. Changes made
while an agent is working leave that running turn’s settings intact. Switching a
setting never sends a prompt, resumes a stopped session, or clears an existing
capacity/error warning.

Text and attached images survive settings changes. A rejected setting keeps its
slash-command draft. A lost response retains the original command envelope;
**Check the original command** explicitly reconciles that same ID and request.
There is no automatic mutation retry. Settings remain unavailable for mutation
when the host is offline or the session is inactive.
