# UME Presence

A human-facing local presence for AI-assisted work.

UME Presence is a visible, local presentation surface; its authority is none.

![Source-built Default Presence renderer](docs/images/default-presence.png)

_This is a source-built renderer capture with no Character Pack. It is not a
signed binary capture or clean-machine acceptance proof._

**Status: Source Preview**

**Binary release: Not yet published (HOLD).**

## Source quick start (macOS / Node.js 24)

The current public surface is source-first. On macOS, the following are
required: Node.js 24 and Xcode Command Line Tools with the macOS SDK.

```bash
npm ci
npm run native:build
npm run native:test
npm run demo
```

`npm run demo` builds and starts the current source checkout. It does not create
a signed, notarized, packaged, or clean-machine-accepted binary release.

## Product boundary and limitations

- **Core product:** UME Presence with a built-in neutral Default Presence
- **Optional Character Pack:** installed separately as external local data

The binary release remains **HOLD** until exact artifacts pass package
inspection, signing/notarization policy, and clean-machine acceptance.

UME Presence displays a local visual presence and offers bounded presentation
controls to supported local clients. With no Character Pack, launch succeeds
in the built-in Default Presence; this is the normal core product state, not a
degraded or error state. A validated external Character Pack can add a
character-specific identity and speech profile. UME Presence is not an AI
model, autonomous worker, router, execution governor, knowledge source of
truth, Mothership replacement, or ume-harness replacement. Its authority is
none: it never receives decision or execution authority.

## Future binary lifecycle

No ZIP or DMG is currently published. If a future binary release passes the
separate release gates, the primary Freeze target is Apple silicon macOS 14.2
or newer. That future installed-app workflow may require:

- a released UME Presence ZIP or DMG with a published SHA-256;
- Node.js 24 or newer only when a source-based integration step requires it;
- optionally, an external Character Pack transferred separately; and
- AivisSpeech plus the pack's compatible local voice model only when
  character-specific speech is required. AivisSpeech is external and is not
  installed or removed by UME Presence.

After a binary is published, install the app as
`/Applications/UME Presence.app`, then follow
[Installation and optional character onboarding](docs/INSTALLATION.md). Core
installation ends successfully when the built-in Default Presence appears.
The optional pack workflow is copy, validate, select, and restart—never a
source rebuild or manual JSON edit.

```bash
APP='/Applications/UME Presence.app'
BIN="$APP/Contents/MacOS/UME Presence"

open "$APP"
"$BIN" --character=status
"$BIN" --character=list
```

Start the speech engine only after selecting a valid Character Pack when
character-specific speech is wanted; the core no-pack launch does not require
it.

The app asks for macOS System Audio Recording permission when its process-audio
listener is used. It does not capture the microphone, save audio, transcribe
content, or send audio over the network.

## Connect a supported client

While UME Presence is running, Codex and Claude Code can connect to the same
loopback-only Persona MCP endpoint:

```bash
codex mcp add persona --url http://127.0.0.1:47831/mcp
claude mcp add --scope user --transport http persona http://127.0.0.1:47831/mcp
```

Automatic final-reply speech is supported only for Codex notify, Claude Code
Stop, and Antigravity Stop. Configure the hook shipped inside the installed
app; a source checkout is not part of the installed contract:

```bash
APP='/Applications/UME Presence.app'
HOOK="$APP/Contents/Resources/integrations/persona-auto-speech-hook.cjs"
test -f "$HOOK"
```

Client configuration remains an explicit, additive manual operation so the
application never becomes a configuration authority. See
[Integration contracts](docs/INTEGRATIONS.md) for setup and exact disconnect
steps. Speech is best-effort, zero-retry, and non-blocking: failure cannot fail
or retry the client turn.

## Your local data and lifecycle

Persona compatibility identifiers intentionally remain stable:

```text
~/Library/Application Support/Persona/characters/<character-id>/
~/Library/Application Support/Persona/character-selection.json
~/.persona_mute
```

Mute automatic speech with `touch "$HOME/.persona_mute"`; unmute by removing
that file. Hide the window from the tray without stopping the app, or choose
**Quit UME Presence** to stop the app and its loopback MCP server.

Startup is explicit and reversible through the installed executable:

```bash
"$BIN" --login-startup=enable
"$BIN" --login-startup=status
"$BIN" --login-startup=disable
```

Before removing the app, disable startup and remove only the named MCP/hook
entries. Character packs are preserved by default; AivisSpeech is always
preserved. See [Releasing](docs/RELEASING.md) for the source and artifact
boundaries.

## Character-pack contract

Character Packs are optional external local data. The built-in Default
Presence is visual and presentation-only, carries no character identity, and
is not a Character Pack or a substitute pack. No pack is required for window,
presence, listener, or other bounded core presentation behavior. Character-
specific presentation and speech require a valid selected pack and, for
speech, its validated profile and registered provider.

A pack is external local data: one closed `character.json`, one bounded PNG or
WebP avatar, and one validated data-only speech profile. The pack directory
name and manifest `id` must match. IDs use lowercase ASCII letters, digits, and
internal hyphens.

Unknown fields, symlinks, traversal, URLs, commands, executable paths,
arbitrary arguments, prompts, credentials, and environment expansion fail
closed. A pack chooses a provider already reviewed and registered in Persona
core; it cannot load code or add a provider. Selection is written atomically
only after full validation and becomes active on the next process start.

`distributionAllowed` is app safety metadata used to fail closed when a pack
is not marked for distribution. It is not proof of ownership, license,
consent, or redistribution rights, and it grants none of those rights. A pack
still needs separately reviewed provenance, permission, and release terms.

## Presentation controls

Persona MCP exposes only these bounded controls:

| Tool | Effect |
| --- | --- |
| `play_animation` | Play one closed presentation animation. |
| `play_ritual` | Play one closed visual ritual with no speech side effect. |
| `control_window` | Show, hide, or toggle the desktop window. |
| `speak_text` | Play one short local line through the selected profile. |
| `get_status` | Read bounded window, voice, listener, and speech-engine state. |

MCP `get_status` does not expose Character Pack availability. Inspect the
selected pack independently with the installed CLI command
`"$BIN" --character=status`, which returns `activeCharacterId` and `available`.

Speech accepts one operation at a time, queues nothing, retries zero times,
and keeps synthesized WAV data in memory. Code, commands, logs, paths, hashes,
long lists, secrets, internal reasoning, and routine progress are not spoken by
the automatic hook.

## Platform and build status

| Platform | Listener/build contract | Manual Freeze acceptance |
| --- | --- | --- |
| macOS 14.2+ | Core Audio process tap; DMG/ZIP build | Apple silicon is the primary target |
| Linux | PipeWire process-stream capture; AppImage/DEB build | Not claimed unless separately recorded |
| Windows 10 build 20348+ | WASAPI process loopback; NSIS build | Not claimed unless separately recorded |

Linux requires `pw-dump` and `pw-record` on `PATH`. Windows requires Visual
Studio Build Tools for native packaging. Automated tests and CI preserve the
existing cross-platform contracts, but they do not by themselves claim a
signed artifact, clean-machine acceptance, or a binary release.

## Develop Persona core

```bash
npm ci
npm run lint
npm test
npm run assets:check
npm run build
npm run native:build
npm run native:test
```

Production builds copy no Vite `public/` directory. Character packs, legacy
VRM/VRMA media, and local character manifests must not enter the release tree
or application package. Package inspection is a separate mandatory gate.

More detail:

- [Installation](docs/INSTALLATION.md)
- [Integrations](docs/INTEGRATIONS.md)
- [Architecture and development](docs/DEVELOPMENT.md)
- [Release process](docs/RELEASING.md)
- [Security policy](SECURITY.md)

The Persona application core is MIT-licensed with upstream provenance
preserved in [LICENSE](LICENSE) and [NOTICE](NOTICE). UME Presence is the
UMEBOSHIISAN product/distribution identity. External character packs and
character IP remain legally and technically separate.
