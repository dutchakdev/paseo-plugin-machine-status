# Changelog

## Unreleased

### Changed

- Paseo 0.14 checked, including its betas: a 0.14 daemon loads the plugin, and the plugin typechecks and passes its tests against the 0.14 SDK. 0.14 changes only the server half of the SDK, in hooks and agent tools this plugin does not use, so the plugin itself did not need changes.

## 0.3.0 - 2026-10-26

### Added

- A plugin icon, a gauge, which the Paseo plugin directory shows on the listing. The manifest declares it as `assets/icon.png`, and the package check fails when the tarball lacks the icon the manifest names.

### Changed

- Requires Paseo 0.11 or newer, on the daemon and in the app. Paseo 0.8 to 0.10 and the 0.11.0 betas refuse a manifest with an `icon` field. Those versions can stay on 0.2.3: `paseo plugin add dutchakdev/paseo-plugin-machine-status --ref v0.2.3`.

## 0.2.3 - 2026-10-22

### Changed

- The README opens with a screenshot of the Machine screen, and its install section lists
  the plugin directory, npm and GitHub sources by Paseo version.

### Fixed

- Removing a Docker image from the Docker tab failed with an RPC rejection, because the
  daemon never registered its handler. A test now fails for any client action without a
  handler, which also caught this one.
- Docker actions take only the hex ids the plugin itself lists. An id that Docker would
  read as an option, such as `--force`, is refused before any command runs.

## 0.2.2 - 2026-10-22

### Changed

- Paseo 0.13 checked, including its betas: a 0.13 daemon loads the plugin, and the plugin typechecks and passes its tests against the 0.13 SDK. The plugin keeps importing UI from `@getpaseo/plugin/client/react-native`, which 0.13 deprecates in favor of `client/ui` but still serves; only the old path works on every supported app from 0.8.

## 0.2.1 - 2026-10-17

### Changed

- Paseo 0.12 checked, including its betas: a 0.12 daemon loads the plugin, and the plugin typechecks and passes its tests against the 0.12 SDK. The plugin itself did not need changes.

## 0.2.0 - 2026-10-15

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
