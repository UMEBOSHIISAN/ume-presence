# Releasing UME Presence

The public source repository for this project is
`UMEBOSHIISAN/ume-presence`. UME Presence is the product/distribution identity;
Persona remains the compatibility identity. Upstream provenance is preserved in `LICENSE` and `NOTICE`; external
character packs and character IP are separate artifacts.

This procedure creates evidence. It does not authorize a tag, push, upload,
publication, signing identity, or public-history disclosure.

## Freeze boundary

A UME Presence application candidate must contain none of the following:

- an external character pack or `character.json`;
- private character media;
- a private avatar, AIVM, voice profile, or character hash;
- VRM or VRMA media;
- `public/local-character` content; or
- an author-specific path.

Production Vite builds set `publicDir: false`; ignored legacy `public/assets`
files therefore do not enter `dist`. The portable no-bundled-character guard
still fails closed if `public/local-character` is non-empty or unverifiable.
The package inspector independently verifies final ASAR and Resources bytes.

Private history is not a release artifact. The public source snapshot is
generated from an explicit path closure at one exact private canonical commit
and starts a fresh public history. Private assets, private-only paths, and
private commit history are not copied into that snapshot.

## Candidate source

Start from one clean committed revision in a fresh detached worktree. Record
the commit before installing dependencies:

```bash
git status --short
git rev-parse HEAD
git rev-parse HEAD^{tree}
git ls-files --others --exclude-standard
```

Both status and untracked-file output must be empty. Then record the toolchain
and platform:

```bash
node --version
npm --version
sw_vers
uname -m
```

Install exactly from the lockfile and run the complete source gates:

```bash
npm ci
npm run lint
npm test
npm run assets:check
npm run audit:production
npm run build
npm run native:build
npm run native:test
```

Do not suppress warnings in the evidence. A failing audit, guard, test, build,
or native self-test is a `BLOCKER`.

## Public source identity

Only the private canonical repository may stage a public snapshot:

```bash
node scripts/stage-public-release.cjs --output '<empty-output-directory>'
```

The command requires a clean commit descended from the trusted final-freeze
base, copies only the exact sorted paths in `PUBLIC_RELEASE_PATHS.txt`, rejects
symlinks and private tokens, and writes `PUBLIC_RELEASE_IDENTITY.json` with the
private canonical source commit, trusted final-freeze ancestor
`ef97c6bad8328443fc2cd540ac9ae47d71630c78`, fresh-history marker, binary
release status `HOLD`, physical acceptance status `NOT_RUN`, and the normalized
Git mode, byte length, and SHA-256 identity of every public payload file. The
independent verifier rejects missing, malformed, or altered identity metadata
and reports those trusted identity truths on success.

From the generated snapshot, verify the exact bytes independently:

```bash
npm run identity:verify
```

The verifier is read-only. A mismatch, extra file, symlink, or malformed
identity is a `BLOCKER`.

## macOS Apple silicon package

The primary Freeze candidate is built on Apple silicon with signing identity
auto-discovery disabled unless a separately authorized and documented signing
identity is intentionally supplied:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac -- --arm64
```

Outputs belong under `release/`. An artifact built with identity auto-discovery
disabled must be measured and described exactly; it is not signed or notarized
merely because electron-builder completed. Verify with `codesign` and Gatekeeper
commands and record their exit statuses rather than inferring a state.

Do not claim Developer ID signing or notarization unless both are actually
performed and the exact final artifact passes their verification. Current
production signing credentials are not assumed by this repository.

## Inspect exact package bytes

Compute SHA-256 and byte size for each candidate artifact:

```bash
shasum -a 256 release/UME-Presence-0.1.0-beta.0-macos-arm64.zip
shasum -a 256 release/UME-Presence-0.1.0-beta.0-macos-arm64.dmg
stat -f '%z %N' release/UME-Presence-0.1.0-beta.0-macos-arm64.zip
stat -f '%z %N' release/UME-Presence-0.1.0-beta.0-macos-arm64.dmg
```

Extract the exact ZIP without rebuilding it:

```bash
mkdir -p release/extracted
ditto -x -k \
  release/UME-Presence-0.1.0-beta.0-macos-arm64.zip \
  release/extracted
```

Generate the package inventory and critical-file hashes:

```bash
CANDIDATE_ROOT="$(pwd -P)"
APP="$CANDIDATE_ROOT/release/extracted/UME Presence.app"
MANIFEST="$CANDIDATE_ROOT/release/UME-Presence-package-manifest.json"

node scripts/inspect-macos-package.cjs \
  --app "$APP" \
  --output "$MANIFEST"

shasum -a 256 "$MANIFEST"
```

The inspector must print `UME_PERSONA_PACKAGE_INSPECTION_OK`. It requires
`LICENSE`, `NOTICE`, renderer output, package metadata, the Darwin listener, and
both generic installed integration resources. It fails closed on private
character media,
VRM/VRMA, character manifests, local-character content, symlinks, malformed
inventory, or missing required resources.

Inspect signing and architecture against the extracted candidate:

```bash
APP='release/extracted/UME Presence.app'
codesign --verify --deep --strict --verbose=2 "$APP"
codesign -dv --verbose=4 "$APP"
spctl --assess --type execute --verbose=4 "$APP"
file "$APP/Contents/MacOS/UME Presence"
file "$APP/Contents/Resources/native/darwin/persona-audio-listener"
```

Record exact exit codes and output in the evidence file. A rejected unsigned
candidate may be an explicit release limitation, but it is never relabeled as
signed or notarized.

## Exercise installed resources

Tests against source adapters do not prove the packaged resource. From the
extracted or clean-machine installed app, hash the installed hook and selector,
then exercise the hook's Codex, Claude Code, and Antigravity modes with safe
fixture payloads. Confirm mute behavior and a missing Persona/AivisSpeech
failure without retry or client failure.

The acceptance setup must point at:

```text
/Applications/UME Presence.app/Contents/Resources/integrations/persona-auto-speech-hook.cjs
```

No client configuration may reference the source checkout.

## Clean-machine acceptance

Complete a clean-machine acceptance worksheet with the exact ZIP bytes on an
Apple silicon Mac that starts with no app, no selection,
no source checkout dependency, and no author-specific integration path.

Record CORE and OPTIONAL CHARACTER as separate acceptance tracks. CORE is the
required product lifecycle and has no Character Pack prerequisite:

```text
install
→ launch with no Character Pack
→ confirm the built-in Default Presence
→ permission guidance and the System Audio path
→ visual and window behavior
→ supported MCP/client integration and installed completion hooks when included
→ AivisSpeech-absent behavior where applicable
→ mute
→ enable/status/disable startup
→ disconnect
→ uninstall
→ no dangling references
```

OPTIONAL CHARACTER is recorded separately after CORE for the same exact
artifacts. A private example pack may be used, but it is not required for CORE:

```text
transfer an external Character Pack
→ validate and select
→ restart
→ confirm the selected character remains visible
→ exercise AivisSpeech/profile unavailable and available behavior
→ confirm character-specific speech and visual activity when dependencies exist
→ verify pack and selection retention through uninstall and recovery
```

Speech dependency availability does not choose the renderer identity. With no
active character, the visual surface is the built-in Default Presence; with a
valid selected Character Pack, the selected character remains visible while
character-specific speech fails in a bounded way when its dependency is
unavailable.

An author-host reinstall or isolated user-data rehearsal is not clean-machine
proof. Linux and Windows automated CI/build contracts remain relevant, but no
cross-platform manual acceptance claim is made unless it is separately
performed and recorded.

## Release evidence

Write a release-evidence document only after measurements exist. Record:

- source commit and tree;
- Node, npm, Electron, macOS, and architecture;
- exact commands and exit results;
- artifact filenames, sizes, and SHA-256;
- package-manifest filename and SHA-256;
- package inclusion and private-media exclusion results;
- signing/notarization truth;
- source tests and exact-candidate checks;
- author-host rehearsal separately from clean-machine results;
- lifecycle and no-dangling-reference results; and
- final `CONFIRMED`, `ACCEPTED_LIMITATION`, and `BLOCKER` counts.

Do not copy private path contents, pack hashes, profile values, or character
assets into release evidence. Do not upgrade an unperformed check to a claim.

## Tag and publication

Version tags must match `package.json`, and any CI workflow must rerun the same
guards. This Freeze does not choose or authorize a tag/push destination. Do not
publish private source history or upload artifacts without a separate explicit
release authorization.

The public source closure intentionally contains no tag-triggered publication
workflow. No binary publication path or successful tag publication is claimed
here. Adding or changing CI/CD publication behavior requires its own explicit
execution-gate approval.

If a separately redistributable character pack is ever supplied, it keeps its
own license, provenance, validation record, and release channel. It remains
external even when its own `distributionAllowed` value is `true`.
