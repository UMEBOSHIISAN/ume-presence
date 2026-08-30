# UME Presence security

## Reporting

Report security issues through the private reporting channel on the
`UMEBOSHIISAN/ume-presence` repository. Do not include character assets, voice
models, credentials, private profiles, or matched private content in a public
issue or chat transcript.

Upstream provenance remains preserved in `LICENSE` and `NOTICE`.

## Product and data boundary

UME Presence is a human-facing presentation layer. Persona core displays,
speaks, animates, and exposes bounded controls. It is not an authority holder,
autonomous worker, router, execution governor, knowledge source of truth,
ume-harness replacement, or Mothership replacement.

Automatic listeners calculate a numeric output level in memory. They do not
capture the microphone, write audio to disk, transcribe it, or send it over the
network.

The integration server binds only to `127.0.0.1`, rejects non-loopback `Host`
headers, restricts browser origins, and bounds request bodies. Its event API
accepts only normalized state, level, animation, and presentation cues. Persona
MCP exposes only closed animation, ritual, window, speech, and status schemas;
it cannot execute commands or access arbitrary files.

The loopback MCP endpoint does not require authentication. Other processes
running as the same user can invoke those presentation controls. Sensitive
data tools, system execution, routing, and broader filesystem access are
outside the product boundary.

The renderer is sandboxed with context isolation and no Node.js integration. A
restrictive content security policy applies, popups are denied, and navigation
outside the local renderer entry is blocked.

## Character and hook boundary

Character packs are external local data. Their closed schema rejects unknown
fields, code, URLs, commands, environment expansion, traversal, and symlinks.
Pack media, voice models, names, likenesses, and profiles retain separate
rights and never become MIT-licensed merely by installation.

Automatic completion hooks are local, best-effort, non-blocking, and
zero-retry. They suppress code, logs, paths, hashes, secrets, internal
reasoning, and routine progress by default. Hook failure must never fail or
retry a Codex, Claude Code, or Antigravity turn.

## Supported versions

No binary release is claimed by this source snapshot. Signing, notarization,
platform, and clean-machine status are supported only to the extent recorded
for an exact, separately published artifact.
