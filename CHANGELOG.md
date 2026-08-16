# Changelog

## 1.0.0 — 2026-08-16

### Added

- Concurrent GitHub Copilot and Claude Code session discovery.
- Main-agent and subagent hierarchy with provider, workspace, activity, tool, target, and timestamps.
- Shared Python broker with snapshot and server-sent-event endpoints for multiple extension hosts.
- Local authenticated hooks for GitHub Copilot and Claude Code.
- code-server-compatible user-data discovery and extension-managed state storage.
- Native Webview activity panel alongside the pixel-art office.

### Changed

- Renamed the extension and all settings, commands, storage paths, and hook identifiers to the independent `multiAgentPixelOffice` namespace.
- Replaced deployment-specific paths with cross-platform user and extension storage paths.
- Hook installation now preserves all entries owned by other tools, including the upstream extension.
- Dynamic agent data is rendered with DOM APIs instead of HTML string injection.

### Security

- Broker listens only on loopback.
- All broker endpoints require a random local token.
- Payload, response, agent, tool, cache, and transcript-tail sizes are bounded.
- Displayed tool targets are sanitized and common credential formats are suppressed.

### Attribution

- Retains the MIT License and copyright notice from Copilot Pixel Agents by Clesley Oliveira.
- Retains attribution for pixel-art assets derived from `pablodelucca/pixel-agents` and the “JIK-A-4, Metro City” tileset.
- `Install Hooks` command generates hook scripts and config
