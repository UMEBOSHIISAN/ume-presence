# Changelog

## 0.1.0-beta.0 - Freeze candidate

- Established `UME Presence` as the product/distribution identity while
  retaining Persona core protocol, MCP, resource, and user-data compatibility.
- Preserved upstream MIT provenance in `LICENSE` and `NOTICE` and separated the
  application core from external character IP.
- Kept character packs external and data-only with fail-closed validation,
  atomic selection, restart persistence, and no bundled default identity.
- Removed private character-specific renderer media and all Vite
  public-directory media
  from product builds.
- Retained bounded local presentation controls, native process-audio listeners,
  AivisSpeech integration, and zero-retry completion hooks for Codex, Claude
  Code, and Antigravity.
- Documented installed-package onboarding, reversible startup, recovery,
  disconnect, state retention, and uninstall.
- Added exact macOS package inventory, required-resource checks, private-media
  exclusion, and SHA-256 manifest generation.

Signing, notarization, clean-machine acceptance, lifecycle results, and release
status are stated only after they are measured against exact candidate bytes.
