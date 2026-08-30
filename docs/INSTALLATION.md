# Install UME Presence on macOS

This is the supported Apple silicon core-installation contract plus optional
Character Pack onboarding. It uses the installed package only; no source
checkout is required after installation.

## Requirements and release truth

- Apple silicon Mac running macOS 14.2 or newer.
- One supplied UME Presence ZIP or DMG and its expected SHA-256.
- Node.js 24 or newer only if automatic Codex, Claude Code, or Antigravity
  speech is configured.
- Optionally, one external Character Pack transferred through a private,
  user-controlled channel.
- AivisSpeech and a compatible local voice model only for character-specific
  speech.

Consult the release notes beside the candidate. If its artifact hash,
architecture, or signing statement is absent, treat that item as unconfirmed.
A local or unsigned build must not be described as notarized.

Verify the supplied artifact before opening it:

```bash
shasum -a 256 '/path/to/UME-Presence-0.1.0-beta.0-macos-arm64.zip'
```

Compare the complete lowercase digest with the release evidence. Do not
continue if it differs.

## Install the application

Extract the ZIP or open the DMG, then copy `UME Presence.app` to `/Applications`.
The supported final path is exact:

```bash
APP='/Applications/UME Presence.app'
BIN="$APP/Contents/MacOS/UME Presence"

test -d "$APP"
test -x "$BIN"
```

If macOS reports that the candidate is unsigned or not notarized, compare that
warning with the exact release evidence. Do not bypass an unexpected warning
or use an artifact whose identity is unknown.

## Core launch with no Character Pack

No Character Pack is required to complete core installation. Launch the app
without copying or selecting a pack:

```bash
open "$APP"
```

The window must show the built-in neutral Default Presence. This is a
successful normal launch, not a degraded state and not a fabricated character
identity. Window and presence controls remain available. If the process-audio
listener is exercised, follow the System Audio Recording permission path
below.

The installed CLI is the character-availability observation surface:

```bash
"$BIN" --character=status
```

With no selection, `activeCharacterId:null` and `available:false` describe the
absence of a Character Pack; they do not make Default Presence unavailable.
MCP `get_status` does not project character availability. Supported MCP/client
integration is optional and remains an explicit additive setup described in
[Integrations](INTEGRATIONS.md).

Character-specific speech is unavailable until a valid selected Character
Pack supplies a validated profile for a registered provider. That bounded
speech limitation does not prevent the Default Presence visual experience.

## Optional Character Pack: install, validate, and select

This section is optional and is not part of core-install completion. Character
transfer is intentionally manual and private. `PACK_SOURCE` must be the
complete approved Character Pack directory, not a source-repository folder and
not a URL.

```bash
APP='/Applications/UME Presence.app'
BIN="$APP/Contents/MacOS/UME Presence"
PACK_ID='sample-character'
PACK_SOURCE="${PACK_SOURCE:?Set PACK_SOURCE to the approved Character Pack directory}"
PACK_ROOT="$HOME/Library/Application Support/Persona/characters"

test -d "$APP"
mkdir -p "$PACK_ROOT"
test ! -e "$PACK_ROOT/$PACK_ID"
ditto "$PACK_SOURCE" "$PACK_ROOT/$PACK_ID"
"$BIN" --character=validate --character-id="$PACK_ID"
"$BIN" --character=select --character-id="$PACK_ID"
"$BIN" --character=status
```

Each command prints one bounded JSON result and exits non-zero on failure.
Stop if validation or selection reports `ok: false`. Invalid packs fail closed
and do not replace the active selection.

Do not edit `character.json` or `character-selection.json` manually during
onboarding. The app validates hashes, dimensions, schema, ID, avatar, provider,
and profile before atomically selecting the pack. The new selection takes
effect only after UME Presence is restarted. No source edit, rebuild,
repackaging, or re-signing is required.

`distributionAllowed` controls whether the pack may be redistributed. Keep a
private pack set to `false`; local installation does not grant permission to
publish it.

## Optional character restart and speech dependency

After selecting a valid pack, quit and restart UME Presence so the character-
specific presentation becomes active. Explicitly request the existing
AivisSpeech lifecycle only when character-specific speech is wanted:

```bash
open "$APP" --args --speech-engine=start
```

Recheck the installed selection through the CLI:

```bash
"$BIN" --character=status
```

The tray and MCP `get_status` report bounded speech-engine states, but not
Character Pack availability:

| State | Meaning |
| --- | --- |
| `idle` | The managed speech engine has not been requested in this process. |
| `starting` | One bounded start/readiness operation is in progress. |
| `ready` | The local loopback engine is ready. |
| `requires-setup` | The fixed local dependency is missing or did not become ready. |
| `failed` | The local start or provider boundary failed. |

UME Presence checks only the supported local AivisSpeech application locations
and loopback port `10101`. It does not download, install, upgrade, configure,
or remove AivisSpeech or its voice models. When AivisSpeech is unavailable,
visual and window controls remain usable and the current visual surface is
preserved. With no active character, that surface is the built-in Default
Presence; with a valid selected Character Pack, the selected character remains
visible. Character-specific speech remains unavailable and fails without
blocking or retrying the client turn.

## Core macOS permission path

The native listener requests System Audio Recording permission when it needs
to observe a supported application's output level. Follow the macOS prompt and
review the UME Presence entry in **System Settings → Privacy & Security → Screen
& System Audio Recording**. A restart may be required after changing the
permission.

The listener processes amplitude in memory. It does not capture the
microphone, store audio, transcribe content, or send audio over the network.

## Next steps

- Connect only the supported clients in [Integrations](INTEGRATIONS.md).
- Enable startup only if wanted, using the reversible commands documented in
  this repository.
- Keep the original pack transfer and release artifact in a private recovery
  location chosen by the user; the app does not back them up.
