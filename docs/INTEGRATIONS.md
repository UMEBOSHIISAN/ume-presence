# UME Presence integrations

UME Presence uses the Persona core compatibility name for MCP, local protocol,
port, and installed resource filenames. Integrations expose presentation only:
they do not grant conversation, routing, decision, execution, configuration,
or persistence authority.

All examples use the installed package:

```bash
APP='/Applications/UME Presence.app'
HOOK="$APP/Contents/Resources/integrations/persona-auto-speech-hook.cjs"
NODE_BIN="$(command -v node)"

test -d "$APP"
test -f "$HOOK"
test -n "$NODE_BIN"
```

Shell variables do not expand inside TOML or JSON configuration. Substitute
the literal output of `command -v node` when editing a client file.

## Persona MCP

UME Presence serves a Streamable HTTP MCP endpoint on loopback while the app is
running. Register only the name `persona`:

```bash
codex mcp add persona --url http://127.0.0.1:47831/mcp
codex mcp get persona

claude mcp add --scope user --transport http persona http://127.0.0.1:47831/mcp
claude mcp get persona
```

Start a new client session after registration. Disconnect only this
registration with:

```bash
codex mcp remove persona
claude mcp remove persona
```

Persona MCP exposes these closed tools:

| Tool | Input | Effect |
| --- | --- | --- |
| `play_animation` | `idle`, `greeting`, `talk`, `celebrate`, or `dance` | Shows the window and plays one presentation animation. |
| `play_ritual` | `greeting`, `work_complete`, or `break` | Plays one visual-only ritual. |
| `control_window` | `show`, `hide`, or `toggle` | Controls the desktop window. |
| `speak_text` | One non-blank string, at most 240 Unicode characters | Synthesizes and plays one local line. |
| `get_status` | None | Reads bounded window, voice, listener, and speech-engine state. |

Exactly one speech operation may be active. A second returns `busy`; there is
no queue and no retry. Synthesized WAV data stays in memory. AivisSpeech uses
only loopback port `10101` and the selected pack's validated profile.

Rituals are also one-at-a-time and visual-only. They never call `speak_text`.
Pack data cannot name tool implementations, commands, URLs, modules, or
animation files.

## Automatic final-reply speech

The installed hook supports exactly three client events:

- Codex notify `agent-turn-complete`;
- Claude Code `Stop`; and
- Antigravity lifecycle `Stop`.

Configuration is manual and additive. Before editing, preserve a copy or exact
text of the affected entry. Do not replace unrelated notifications or hooks.
There is no automatic configuration mutator.

The hook considers only the first eligible prose paragraph and speaks at most
160 Unicode code points. It skips unsafe opening paragraphs and routine
progress. Code, commands, logs, paths, hashes, long lists, secrets, internal
reasoning, and later detail blocks are silent by default.

The hook makes one bounded handoff and one bounded Persona request, with zero
retry. Every speech failure is contained: the Codex, Claude Code, or
Antigravity completion result remains authoritative and is never failed by
Persona.

### Mute

Mute all three automatic hook modes without editing client configuration:

```bash
touch "$HOME/.persona_mute"
```

Unmute explicitly:

```bash
rm "$HOME/.persona_mute"
```

### Codex notify

Codex supplies the final event payload as the last argument. The installed
hook is a one-target fan-out: it forwards the original notification once while
handling optional speech independently.

If Codex has no existing `notify`, this bounded example uses `/usr/bin/true` as
the no-op downstream target:

```toml
notify = [
  "/absolute/path/reported-by-command-v-node",
  "/Applications/UME Presence.app/Contents/Resources/integrations/persona-auto-speech-hook.cjs",
  "codex",
  "/usr/bin/true",
  "turn-ended",
]
```

If a current Codex notify target already uses one executable followed by
`turn-ended`, place that executable in the fourth slot instead of
`/usr/bin/true`. Keep an exact copy of the prior `notify` array. More complex
notify chains are not silently rewritten or treated as supported.

Disconnect by restoring the exact pre-install `notify` array. If no `notify`
existed before installation, remove only this array.

### Claude Code Stop

Append this command hook to the existing `Stop` list; do not replace the list:

```json
{
  "hooks": [
    {
      "type": "command",
      "command": "'/absolute/path/reported-by-command-v-node' '/Applications/UME Presence.app/Contents/Resources/integrations/persona-auto-speech-hook.cjs' claude",
      "timeout": 5
    }
  ]
}
```

The shown object is the command entry to append under Claude Code's existing
`hooks.Stop` structure. Disconnect by removing only the entry whose command
contains the installed hook path; preserve every other Stop hook.

### Antigravity Stop

Add only this named entry to `~/.gemini/config/hooks.json`:

```json
{
  "persona-auto-speech": {
    "Stop": [
      {
        "type": "command",
        "command": "'/absolute/path/reported-by-command-v-node' '/Applications/UME Presence.app/Contents/Resources/integrations/persona-auto-speech-hook.cjs' antigravity",
        "timeout": 5
      }
    ]
  }
}
```

Merge the named object without replacing other top-level entries. Disconnect
by removing only `persona-auto-speech`.

## External character packs

Pack and selection compatibility paths remain:

```text
~/Library/Application Support/Persona/characters/<character-id>/character.json
~/Library/Application Support/Persona/character-selection.json
```

Use the installed no-window commands:

```bash
BIN="$APP/Contents/MacOS/UME Presence"

"$BIN" --character=list
"$BIN" --character=status
"$BIN" --character=validate --character-id='<character-id>'
"$BIN" --character=select --character-id='<character-id>'
```

Selection validates the full closed pack before one atomic record replacement.
Restart UME Presence to activate the selected visual/profile pair. Pack changes
require no client reconfiguration, source checkout, rebuild, or signing.

## Local presentation transports

### URL protocol

Installed packages retain `persona://` compatibility:

| URL | Effect |
| --- | --- |
| `persona://show` | Show and focus the window. |
| `persona://hide` | Hide without quitting. |
| `persona://toggle` | Toggle visibility. |
| `persona://listening` | Present listening state. |
| `persona://thinking` | Present the bounded thinking cue. |
| `persona://speaking?level=0.3` | Present speaking with a clamped level. |
| `persona://inactive` | End voice activity without hiding. |
| `persona://ritual/greeting` | Start the greeting ritual. |
| `persona://ritual/work-complete` | Start the completion ritual. |
| `persona://ritual/break` | Start the break ritual. |

Open a URL with `open` on macOS, `xdg-open` on Linux, or `start` on Windows.

### Loopback HTTP

Persona binds `127.0.0.1:47831` by default. Browser origins and `Host` headers
are restricted to supported local values, and request bodies are bounded.
`GET /health` exposes no user content. `POST /events` accepts only normalized
voice state, clamped audio level, closed animation, and closed presentation
cue messages.

The loopback endpoint has no authentication. Other processes running as the
same user can invoke presentation controls, so broader or sensitive tools do
not belong in Persona MCP.

## Automatic process-audio listeners

The listener transports amplitude only; the renderer never receives raw audio,
transcripts, prompts, credentials, or host-application internals.

- macOS 14.2+ uses a private Core Audio process tap and requires System Audio
  Recording permission.
- Windows 10 build 20348+ uses WASAPI application loopback for a target process
  tree.
- Linux uses `pw-dump` and `pw-record` to attach to a supported PipeWire
  playback stream.

The listener does not capture the microphone, store audio, transcribe content,
or send audio over the network. AivisSpeech is included in the fixed local
process match so local playback can drive the same in-memory animation path.

## Boundary summary

- Persona port `47831` and AivisSpeech port `10101` remain separate failure
  domains.
- Speech and visuals are optional presentation outputs, never client-turn
  authority.
- There is no automatic retry, hidden queue, daemon, cloud backend, account,
  telemetry, or configuration authority.
- Automatic client support is frozen at Codex, Claude Code, and Antigravity.
