# UME Presence architecture

Date: 2026-07-29 JST
Updated: 2026-08-26 JST
Status: built-in Default Presence active without a pack; optional external Character Pack boundary enforced

## Purpose

UME Presence is the human-facing presence and presentation layer for local AI
clients. It receives narrow local state, level, and animation events and
turns them into a built-in neutral visual presence or optional character
behavior. It does not decide, plan, transcribe, or hold authority. Speech is
limited to text explicitly supplied to the selected local TTS adapter and requires
a valid selected Character Pack profile/provider.

## UME Stack boundary

The UME Stack separates three product planes:

```text
UME Presence = Human-facing Presence Plane
UME-HARNESS  = Local Work Plane
Mothership   = Consequential Authority Plane
```

There is no automatic runtime dependency between these products. This
repository defines presentation contracts only; cross-plane composition and
operational policy remain outside the public Presence core.

```text
approved local state/level source        optional external Character Pack
                 |                          character.json + image/profile
                 v                                     |
      loopback bridge / native listener                 v
                 |                            strict pack loader
                 +------------------+------------------+
                                    v
                      UME Presence main process
                     (Persona compatibility runtime)
                             |             |
                  closed renderer IPC   provider registry
                     |             |             |
                     v             v             v
          built-in Default   generic 2D view  fixed loopback TTS adapter
              Presence       (selected pack)  (selected profile only)
```

## Repository boundaries

| Repository | Responsibility | Authority |
| --- | --- | --- |
| `UMEBOSHIISAN/ume-presence` | Electron application, renderer, native output-level listener, loopback ingress, URL protocol | Visual presentation only |
| external Character Pack | Separately transferred data-only manifest, image, rights record, and optional speech profile | Local presentation customization only |

The application repository does not import external decision or worker runtime
logic. Character authoring sources do not become application source-of-truth
when a validated pack is installed in the external user-data store.

## OSS core, provider adapter, and private pack boundary

The application core owns validation, selection, bounded IPC, rendering,
speech lifecycle, and provider registration. A provider adapter is reviewed
source code in the frozen allowlist; the current `aivis` adapter owns its
strict profile schema and fixed loopback behavior. A pack may name only an
allowlisted provider ID and data-only profile. It cannot load a module, command,
URL, executable path, environment value, credential, prompt, or arbitrary
argument.

The pack store is `<userData>/characters`. On macOS that resolves to:

```text
~/Library/Application Support/Persona/characters/<character-id>/character.json
~/Library/Application Support/Persona/character-selection.json
```

Each pack directory contains one closed `character.json` and one bounded PNG
or WebP avatar. The directory basename must equal the validated lowercase ID.
The loader rejects unknown keys, unsafe labels, traversal, symlinks, unsupported
providers, invalid profiles, invalid image headers/dimensions, and digest
mismatches. It returns copied bytes and a deeply frozen manifest; no unchecked
path reaches the renderer.

Adding a directory only makes a pack available. Selection validates the ID and
pack before one same-directory atomic replacement of the closed selection
record. The selected pack is loaded once at process composition, and its visual
payload and speech profile remain one consistent pair until restart. No
fallback character identity is invented when no valid selected pack is loaded.
Instead, the renderer uses the built-in neutral Default Presence as its visual
surface for the no-selection state and the existing bounded missing-selection
path. Character-specific speech remains unavailable with bounded
`CHARACTER_UNAVAILABLE` behavior while the Default Presence, bridge, tray, and
listener remain alive.

Default Presence is presentation-only core UI. It is not a Character Pack,
does not supply a character identity or speech profile, and does not create a
second presence state machine: it consumes the same `PresenceDirector` mode,
cue, and bounded audio-level projection as the character renderer. Malformed
or invalid packs still fail closed during validation. When a valid selected
character payload reaches the renderer but its avatar asset cannot be drawn,
the existing `CharacterAssetFallback` diagnostic is used. Default Presence is
not `CharacterAssetFallback`.

Character selection and availability are observable through the installed CLI
`--character=status`, which returns `activeCharacterId` and `available`. MCP
`get_status` projects window visibility, voice state, listener state, and the
speech-engine state only; it does not expose Character Pack availability.

Adding or selecting a pack that uses an existing provider requires no source
edit, rebuild, packaging, or signing. Adding a new provider is intentionally a
core-code change: one reviewed adapter/schema plus one explicit registry entry.
Character packs themselves remain outside the repository and signed bundle.

The tracked tree contains no source character media. `npm run build` runs the
read-only exclusion guard before TypeScript/Vite, and each distribution path
reaches that guarded build exactly once. The two generic automatic-speech
modules are package resources under `integrations/`. These source facts do not
claim an installed app, signature, clean-machine acceptance, audible speech,
mouth motion, or binary release.

## Bundled asset exclusion

Production builds must not contain Character Packs, character manifests,
private avatars, voice profiles, VRM/VRMA media, or local-character content.
Legacy paths such as the following remain exclusion targets, not supported
package slots:

```text
public/assets/model.vrm
public/assets/animations/idle.vrma
public/assets/animations/talk1.vrma
public/assets/animations/talk2.vrma
public/assets/animations/talk3.vrma
public/assets/animations/greeting.vrma
public/assets/animations/celebrate1.vrma
public/assets/animations/celebrate2.vrma
public/assets/animations/dance1.vrma
public/assets/animations/dance2.vrma
```

The build uses `publicDir: false`, and the portable exclusion guard fails closed
if these files or a non-empty `public/local-character` tree enter the source
closure. External Character Packs remain separate local data even when their
own rights record permits redistribution.

## Loopback interfaces

Default bind address and port:

```text
127.0.0.1:47831
```

Frozen application endpoints:

- `POST /events` accepts the closed state, normalized audio-level, animation,
  and visual-indicator messages defined below.
- `GET /health` returns application health and last visual state without user
  content.
- `POST /mcp` exposes Persona's narrow animation, window, and status tools.
- `speak_text` on the MCP surface performs fixed loopback synthesis and private
  renderer playback; synthesized bytes never enter `POST /events`.

The frozen event shapes are:

```text
state:       { type, state: { phase, activity, microphoneMuted, outputMuted } }
audio-level: { type, level }
animation:   { type, animation }
indicator:   { type, indicator: warning | error | clear }
```

Each object is closed. Unknown top-level or nested fields are rejected, and
audio-level events do not accept `bands`. This prevents transcripts, metadata,
or other arbitrary content from crossing the visual boundary.

## Local speech boundary

The `speak_text` path is deliberately separate from the public event contract:

```text
MCP caller -> AivisSpeech Engine 127.0.0.1:10101
           -> in-memory WAV -> bounded Electron IPC
           -> Web Audio analyser -> existing mouth-level input
```

Input is a closed object with one non-blank `text` field and a 240-code-point
limit. One operation may run at a time. Provider requests and renderer playback
have bounded timeouts, zero retries, no queue, no transcript history, and no WAV
file output. Renderer playback temporarily takes precedence over external
listener levels; the native listener remains configured and resumes normally.

The transport is portable across supported hosts because it depends only
on loopback HTTP, Electron IPC, and Web Audio. Core Default Presence does not
require these speech dependencies. For character-specific speech, the
destination Mac must separately install AivisSpeech, a compatible local voice
model, and an external selected pack. The selected pack supplies the validated
profile to the code-owned adapter. The code does not depend on a
machine-specific filesystem path, machine identifier, credential, or cloud TTS
service.
Deployment, login items, and automatic startup are outside this boundary.

`warning` is a yellow/amber visual outline and glow; `error` remains red, and
`clear` removes either outline. Indicator events do not alter voice state or
body animation. `NOTICE` is not a Persona indicator value and remains a
bridge-side compatibility mapping to the existing `GREETING` animation.

The adapter must use existing upstream messages when possible. UME-only states
are reduced in the adapter and must not break or widen the upstream schema.
Non-loopback `Host` values remain rejected. Browser origins remain restricted.

## URL protocol

The frozen scheme is:

```text
persona://
```

Existing actions include show, hide, toggle, listening, thinking, speaking,
inactive, greeting, celebrate, and dance. The bridge may use these only as a
backward-compatible local control path; HTTP events remain the structured
adapter interface.

## Voice level boundary

Automatic native output-level detection may select a process with:

```text
PERSONA_TARGET_PROCESS_PATTERN
```

Only normalized level and coarse lifecycle/activity enter the renderer. Raw
audio, microphone samples, transcripts, prompts, credentials, customer data,
personal message bodies, and chain of thought are forbidden.

macOS System Audio Recording permission is human-controlled. No fallback may
bypass it.

The native helper is attempted at most once for an unchanged discovered
process-discovery session. A helper error or non-zero exit is visible in
listener status and latches capture; polling does not respawn it merely because
the PID set changes, and an active capture is not replaced during PID churn.
Any unexpected helper exit, including exit zero, latches the session. A new
attempt is allowed only after discovery first observes no matching processes,
or after an explicit UME Presence restart. This is fail-closed and does not create
hidden retry authority.

## Build and verification commands

The frozen application checks are:

```text
npm run check
npm run native:build
npm run native:test
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
```

The source tree may create unsigned local artifacts with publication disabled.
Signing, notarization, tag creation, upload, installation, and deployment
require separate authority.

The character-exclusion guard is the first production-build step and fails
closed with bounded generic output. Its portable Node implementation performs bounded before/after
identity checks, but it is not descriptor-atomic against a concurrent writer
that swaps and restores the exact `local-character` directory during the
`lstat` to `opendir` interval. Run the package gate only in a controlled
worktree with no concurrent writer; do not describe it as hostile-concurrency
atomic.

## Rights state

Bundled character-media distribution is disabled. `docs/ASSET_RIGHTS_GATE.json` is
`CANDIDATE_EVIDENCE_ONLY`, and `public/assets/manifest.json` also has
`distributionAllowed: false`.

No media may be published until required provenance fields, fixed source
identity, downloaded and embedded metadata hashes, attribution, intended use,
implementer verification, independent verification, and manifest agreement
all pass.

## Failure isolation

- If the bridge stops, UME Presence's standalone renderer and native listener may
  continue.
- If UME Presence stops, its local clients continue without visual presence.
- Missing or partial runtime media fails asset validation and must not be
  represented as a working character package.
- Missing or unselected external packs yield no invented character identity;
  the built-in Default Presence remains available while character-specific
  speech fails in a bounded way. Malformed packs remain validation failures.
- Expired bridge events are discarded by the adapter; dedupe must not create
  retry authority or autonomous persistence.

## Out of scope without a new gate

- Production deployment or host mutation.
- Scheduler, login item, automatic startup, or service definition.
- Secret access, auth changes, microphone capture, recording, or
  transcription.
- Final character promotion or redistribution of unverified media.
- External authority or worker runtime-path changes.
