# Changelog

## Unreleased

### Added

- On Paseo 0.11 and newer, ⌘K offers "Machine: ports & services" and "Machine: Docker",
  which open the Machine screen on that tab. The tab is part of the screen's link, so
  reload and back keep it.

### Changed

- On Paseo 0.11 and newer, Machine is a screen with a sidebar header item, the API that
  replaced surfaces. Paseo 0.8 to 0.10 keep the surface and sidebar item they had.
  Both use the id `main`, so saved links open the same screen after an upgrade.
- The npm package includes `OVERVIEW.md`, which the Paseo plugin directory shows on the
  plugin's page.
- npm releases are published from GitHub Actions with provenance, so you can trace a
  package version to the commit and workflow that built it.

## 0.1.1 - 2026-10-05

### Added

- A load pill beside every agent's composer shows CPU load and memory pressure from one
  shared poll. Pressing it opens a compact card with both readings and their trend, the
  top CPU processes, and the development ports held by agents; **Open Machine** leads to
  the full screen.
- Published to npm as `paseo-plugin-machine-status`.

### Changed

- Requires Paseo 0.8 or newer: the plugin is split into `index.server.ts` and
  `index.client.tsx` runtime entries, and the manifest declares `requirements.paseo`.
  Paseo 0.9, 0.10 and 0.11 are supported.
- The pill, the card and the dashboard share one set of severity thresholds, so the same
  memory pressure no longer reads High in one place and OK in another.

### Fixed

- Starting Docker Desktop and reading a container's logs from the Docker tab failed with
  an RPC rejection, because neither handler was registered.

## 0.1.0 - 2026-08-28

### Added

- The Machine dashboard for macOS daemons: CPU, memory, swap, disk, battery and thermal
  state, with what cannot be measured reported as such rather than estimated.
- Ports and services: listening ports classified by the executable's path, and
  background processes attributed to the agent that started them through the process
  tree.
- Docker containers with start, stop and logs; cache cleanup with a plan before anything
  is removed; stopping a process with guards on PIDs and paths.
