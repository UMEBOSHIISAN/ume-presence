# UME Presence asset and character rights

The MIT license covers Persona application-core source subject to the
provenance in `LICENSE` and `NOTICE`. It does not grant rights to external
character packs, character IP, voice models, or historical local media.

## External character packs

Character packs are local user data outside the source repository and
application bundle. Their avatar, likeness, voice model, provider profile,
manifest, and provenance retain their own rights. Installation does not
relicense them under MIT.

`distributionAllowed` is authoritative for pack redistribution. Private brand
packs keep it `false` and must not be committed, packaged, uploaded, or used
as public examples. A separately redistributed pack needs its own reviewed
license, provenance, validation, and release channel; it still remains
external to UME Presence.

## Application package

The UME Presence product candidate contains no bundled character identity and
no Vite `public/` media. The production build disables public-directory
copying, and the package inspector rejects:

- private character-specific image, audio, or model paths;
- VRM and VRMA files;
- `character.json` pack manifests;
- `public/local-character` content; and
- missing core provenance or required installed resources.

`public/local-character` remains an empty-only historical source guard, not an
installation interface. An external pack must be copied to the Persona
compatibility data directory and validated through the installed executable.

## Historical legacy/demo media

Historical source references to VRM/VRMA demo slots and local rights records do
not describe current product bytes. Local ignored media under `public/assets`
is never copied by the production Vite build. It must not be published,
packaged, or represented as covered by MIT.

The historical `assets:release` rights gate remains a conservative source
check, but it does not override the current package exclusion rule or prove
history safety, signing, notarization, installation, or clean-machine
acceptance.
