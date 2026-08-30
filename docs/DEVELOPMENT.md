# Developing UME Presence and Persona core

UME Presence is the product/distribution identity. Persona is the generic core
and compatibility identity. Character Packs are external local data, not a
core fallback or application asset.

## Architecture

Persona has five intentionally narrow layers:

1. Native listeners discover a supported voice process and calculate a
   normalized output level.
2. The character-pack store validates one external local pack and one active
   selection without exposing filesystem paths to the renderer.
3. The Electron main process owns lifecycle, window behavior, tray commands,
   URL handling, the provider registry, speech composition, and MCP controls.
4. The sandboxed preload exposes only normalized Persona events and one closed
   character payload.
5. React renders the selected 2D character and drives its bounded mouth
   geometry. Historical Three.js/VRM source modules are not the active
   character-pack contract or product media.

No renderer code has filesystem, process, or raw-audio access.

### Presence and ritual ownership

The renderer presence director owns selection and restoration of the five
presentation modes: `rest`, `attention`, `thinking`, `speaking`, and
`complete`. It accepts only the closed cue names `thinking`, `greeting`,
`complete`, `break`, and `clear`; speech and inactive transitions clear
transient cues, while `persona://thinking` is a distinct 30-second cue.

The main-process ritual controller owns the one-at-a-time busy state and fixed
completion timers: `greeting` is 2,600 ms, `work_complete` is 1,800 ms, and
`break` is 2,200 ms. It returns `busy` for a concurrent request, with no queue
and no retry. Rituals are visual-only and never automatically call
`speak_text`.

Bridge, URL-protocol, and MCP layers transport only closed ritual and cue names
between those owners. The event remains content-free: no raw audio, text, pack
code, or arbitrary timing crosses it. Source verification of this contract is
limited to repository commands and source behavior; it does not assert a
signed or installed runtime.

## Character-pack contract

The application core, provider adapters, and character packs have separate
responsibilities:

- Core owns the closed manifest envelope, bounded file reads, selection store,
  renderer payload, and speech lifecycle.
- Each provider adapter is reviewed source code and owns its strict profile
  schema and fixed transport. `electron/provider-registry.cjs` is an explicit
  allowlist, not a dynamic plugin loader.
- A character pack is external local data under Electron's `userData` path. It
  contains one `character.json` and one PNG or WebP avatar; it never enters the
  repository or application bundle.

On macOS the neutral test paths are:

```text
~/Library/Application Support/Persona/characters/sample-character/character.json
~/Library/Application Support/Persona/character-selection.json
```

Adding a pack and selecting it are distinct operations. `list`, `status`, and
`validate` are read-only. `select(id)` first validates the ID and whole pack,
then performs one same-directory atomic selection-file replacement with no
retry. Restart is required so the main process composes one immutable visual
and speech-profile pair. There is no default identity or profile fallback.

The manifest cannot name URLs, commands, executables, environment values,
credentials, prompts, arbitrary arguments, or provider modules. New characters
using the existing `aivis` provider are data-only additions. A new provider
requires a reviewed adapter/schema and explicit registry entry in core.

`scripts/check-no-bundled-character.cjs` is the first step in `npm run build`.
Missing or empty `public/local-character` passes silently; content fails with
one generic status, and an unverifiable slot fails with a distinct generic
status. No external Character Pack or authoring source belongs in the tracked
tree.

The portable guard uses bounded pre/post identity checks but cannot make the
exact `local-character` directory's `lstat` to `opendir` transition
descriptor-atomic in Node 24. Run the package gate in a controlled
worktree without a concurrent writer. This is a documented local build-time
limitation, not hostile-concurrency atomicity.

Production Vite configuration disables `public/` copying. Ignored local
VRM/VRMA files and other historical demo media are therefore excluded from
`dist` rather than treated as application assets. The macOS package inspector
independently rejects character manifests, private character media, VRM/VRMA, and
missing required resources in exact candidate bytes.

The optional leak-check CLI accepts only an explicitly supplied absolute
external manifest and a NUL-delimited repository-relative file list on stdin.
It emits only bounded relative paths, never matched values or content. For a
separately authorized audit, the public interface is:

```bash
git ls-files -z | node scripts/check-private-character-leaks.cjs \
  --manifest "$EXTERNAL_CHARACTER_MANIFEST"
```

Do not run that command without authority to read the external private
manifest. It is not part of ordinary source-only checks.

## MCP contract

`electron/mcp-server.cjs` owns the Codex-facing tool schemas and translates
validated tool calls into narrow main-process callbacks. It does not receive
the Electron application object, renderer access, arbitrary animation paths, or
shell execution.

The existing loopback server routes `POST /mcp` into a fresh stateless
Streamable HTTP transport for each request. This keeps the MCP layer
request-response only: Persona does not need sessions, server-initiated
notifications, or an additional listening port.

When extending the server:

- prefer a small product action over exposing an internal Electron primitive;
- validate every argument with a closed schema;
- mark read-only and side-effecting tools accurately;
- keep the server instructions self-contained; and
- add a protocol-level client test for discovery, valid calls, and rejected
  input.

## Listener contract

All operating systems implement:

- `onSession(active)` for coarse lifecycle;
- `onActivity("listening" | "speaking")`;
- `onLevel(0..1)` for lip movement; and
- `onStatus(...)` for diagnostics.

`AudioActivityGate` owns the shared short-silence behavior. Lips follow every
level immediately. The body remains in its talking motion for 900 ms of silence
before returning to listening, preventing sentence gaps from causing abrupt
animation changes.

Linux implements the contract directly with PipeWire commands. macOS and
Windows helpers write newline-delimited JSON to stdout:

```json
{"type":"ready","source":"Windows process audio"}
{"type":"level","level":0.21}
```

## Commands

```bash
npm run lint
npm test
npm run assets:check
npm run build
npm run native:build
npm run native:test
npm run inspect:mac-package -- --app '/absolute/path/UME Presence.app' \
  --output '/absolute/path/UME-Presence-package-manifest.json'
```

`npm run check` runs the platform-neutral checks together.

The native build command:

- does nothing on Linux because the runtime uses installed PipeWire commands;
- compiles Objective-C++ against Core Audio on macOS; and
- locates Visual Studio Build Tools and compiles C++ against WASAPI on Windows.

Linux packaging detects NixOS and runs `fpm` from `nixpkgs#fpm`, avoiding the
upstream bundled FPM wrapper's `/bin/bash` assumption. Other distributions use
electron-builder's bundled packaging tool.

## Test coverage

The Node suite covers character manifests/store/runtime, the explicit provider
registry, MCP discovery and tool calls, the bridge boundary, URL protocol,
Hyprland rules, PipeWire selection and PCM normalization, process discovery on
macOS and Windows, native NDJSON parsing, shared pause smoothing, listener
lifecycle, bundle/leak guards, package inspection, asset safety, and release
checksums.

Vitest covers generic 2D character rendering, mouth behavior, speech playback,
and the retained stable animation contract. GitHub Actions then compiles and
self-tests the native helper on its real operating system and builds the
renderer on all three platforms.

Headless CI cannot create a real client voice call or approve operating-system
audio permissions. Before a binary release, run the exact-candidate procedure
in [RELEASING.md](RELEASING.md). Do not claim manual acceptance for a platform
that was not exercised.

## Native API references

- Apple: [Capturing system audio with Core Audio taps](https://developer.apple.com/documentation/coreaudio/capturing-system-audio-with-core-audio-taps)
- Microsoft: [Application loopback audio capture](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
