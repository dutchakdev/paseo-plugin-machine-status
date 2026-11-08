<p align="center">
  <img src="docs/banner.png" alt="Machine Status for Paseo. Every core counted, every agent named. The pill beside the chat reads 99% · 66%; its card shows CPU and memory with their trend and splits the busy CPU between two agents, Paseo, macOS and other processes; an agent reads the same through machine_status." width="920">
</p>

<h1 align="center">paseo-plugin-machine-status</h1>

<p align="center">
  What the machine behind your agents is doing, and which agent is doing it, inside <a href="https://paseo.sh">Paseo</a>.<br>
  CPU, memory, disk and battery; the cores each agent keeps busy; what listens on the network and who started it;<br>
  Docker; and the caches and runaway processes you can clear without leaving the app.
</p>

<p align="center">
  <a href="https://github.com/dutchakdev/paseo-plugin-machine-status/actions/workflows/ci.yml"><img src="https://github.com/dutchakdev/paseo-plugin-machine-status/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <a href="https://www.npmjs.com/package/paseo-plugin-machine-status"><img src="https://img.shields.io/npm/v/paseo-plugin-machine-status" alt="npm"></a>
  <img src="https://img.shields.io/badge/Paseo-0.11%2B-3987e5" alt="Supports Paseo 0.11 and newer, including betas">
  <img src="https://img.shields.io/badge/macOS-only-9aa1a6" alt="macOS only">
  <img src="https://img.shields.io/badge/dependencies-none-c98500" alt="No runtime dependencies">
  <img src="https://img.shields.io/badge/license-MIT-9aa1a6" alt="MIT licensed">
</p>

One sidebar item, three tabs, a pill beside the message box, and two tools your agents can call.

> Requires macOS. Metrics come from `vm_stat`, `sysctl`, `df`, `pmset` and
> `memory_pressure`. On any other platform the panel reports that it cannot
> collect metrics rather than showing wrong numbers.

## Install

Plugins must be enabled daemon-wide first, under **Settings → Plugins → Enable
plugins** (the root `pluginsEnabled` field in `~/.paseo/config.json`). Then pick the
source that matches your Paseo:

| Paseo | Source | Command |
| ----- | ------ | ------- |
| 0.11 and newer | [Plugin directory](https://paseo.sh/plugins), the reviewed version | `paseo plugin add dutchakdev/machine-status` |
| 0.11 and newer | npm, the newest release before the directory approves it | `paseo plugin install npm:paseo-plugin-machine-status` |
| 0.8 to 0.10, 0.11.0 betas | GitHub, release 0.2.3, the last one for these versions | `paseo plugin add dutchakdev/paseo-plugin-machine-status --ref v0.2.3` |

`paseo plugin ls` should then show `machine-status` as `running`, and
`paseo plugin update machine-status` pulls later releases from the same source. From
Paseo 0.11 a bare `owner/name` names a directory entry, so a GitHub source there needs
the `git:` prefix: `git:dutchakdev/paseo-plugin-machine-status`.

The plugin supports **Paseo 0.11 and newer, including betas**, on both the
daemon, which runs its collectors, and the app, which runs its screens.

The manifest asks for `>=0.11.0` because it declares the icon shown in the plugin
directory, and Paseo 0.8 to 0.10 refuse a manifest with a field they do not know.
Paseo also checks a prerelease's stable version core, so the betas of later releases satisfy
this range. The 0.11.0 betas pass that check but predate the `icon` field, so they
refuse the manifest as well and need the release named in the install table; see
[version requirements](https://paseo.sh/docs/plugins/reference#requirements).

To work on it locally instead:

```bash
git clone https://github.com/dutchakdev/paseo-plugin-machine-status.git
cd paseo-plugin-machine-status
npm install
npm run typecheck && npm test
paseo plugin install "$PWD"
paseo plugin ls          # expect: running
```

Open it from the **Machine** sidebar item, or ⌘K → "Machine status". On Paseo 0.11
and newer, ⌘K also offers "Machine: ports & services" and "Machine: Docker", which
open straight on that tab, and the tab travels in the screen's link (`?tab=services`,
`?tab=docker`), so reload and back keep it.

## The screen

```mermaid
flowchart LR
  subgraph app["Paseo app: client/"]
    S["Machine screen: tiles, charts, cores, processes"]
    PC["Pill and its card"]
  end
  subgraph agents["Agents on Paseo 0.14+"]
    T["machine_status · machine_explain_process"]
  end
  subgraph server["Daemon subprocess: server/"]
    M["metrics: tick-counter CPU, memory, disk"]
    A["attribution: CPU by agent"]
    E["explain: one process, with evidence"]
    R["processes · cleanup · services · docker"]
  end
  OS["os.cpus · ioreg · vm_stat · ps -E · lsof · docker"]

  S & PC -- "Zod RPC, validated both ways" --> M & A & E & R
  T -- "agent.session_open hook" --> M & A & E
  M & A & E & R --> OS
```

**Overview** — top to bottom: a header with a live indicator and a **Pause**
control, a row of four stat tiles (CPU, memory, swap, disk) that expand into
detail when tapped, CPU-over-time and memory-over-time charts, a disk/swap/power
card, the dev-cache scanner, and the process table.

**Ports & services** — every listening socket on the left, and what is running on
the right. Only the visible tab is mounted, so the port collection does not run
while you are looking at the overview.

## The pill above the composer

The dashboard answers "what is this machine doing" when you go and ask. The pill
answers it without being asked: two percentages beside the message box, CPU in
use and memory pressure, its icon coloured by whichever of the two is worse.

Those are the two numbers that move while an agent works, and they fail in
different ways — one saturates, the other swaps — so both are shown. The colour
follows the worse one, because a pill has room for a single colour and you need
to know something is wrong before you need to know which one. A number that
cannot be read shows as `—` rather than as zero.

One poll every ten seconds feeds every open agent's pill at once. Paseo draws
the label, so the numbers reach each pill through its `update`; the icon is the
plugin's own and takes the warning colour when either reading turns serious.
Pressing the pill opens a compact card instead of leaving the chat: both
readings with their recent trend and their severity in words, who the busy CPU
belongs to, the three processes using the most CPU right now, and any
development ports held by an agent or by a process an agent started. **Open Machine** at the bottom leads to
the full tab. On a phone the card is a bottom sheet.

## Reading the dashboard

**CPU** is utilisation: the share of time the cores spent busy, from the
kernel's own tick counters (`os.cpus()`, which reads `host_processor_info`), the
figure Activity Monitor and `top` show. It cannot pass 100%. Load average sits
under it as threads per core, because load counts threads waiting for a core
too: on 2026-11-08 it read 659 on 8 cores, which the pill used to print as
"6337%".

The first read opens a 250 ms window of its own. After that each read measures
the time since the previous one, so the 3 s and 10 s polls cost nothing extra;
a read more than 15 s after the last opens a fresh window.

Tap the CPU tile for one bar per core. On Apple Silicon the bars split into
efficiency and performance cores, as `ioreg` labels them, and a line under them
reads the pattern:

| Pattern | Meaning |
| ------- | ------- |
| One or two cores pinned, the rest idle | The slow step runs on one thread; more cores would not help it |
| Only efficiency cores busy | macOS background work (Spotlight, backups); your foreground work keeps the performance cores |
| Every core busy | More work than cores; everything waits its turn |

**Memory** follows Activity Monitor's split rather than "free vs used":

| Row | Meaning |
| --- | ------- |
| App | Anonymous pages minus purgeable — what your programs actually hold |
| Wired | Kernel memory that cannot be paged out |
| Compressed | RAM reclaimed by compressing inactive pages |
| Cached files | File-backed pages, reclaimed automatically when needed |

The pressure figure is macOS's own, read from `memory_pressure -Q`, not a value
this plugin invents. Cached files are deliberately excluded from "Used": the
kernel gives them back on demand, so counting them as consumed is misleading.

**Thermal** reads "Not reported" on a healthy machine — macOS records a level only
once it has throttled something. That is honest rather than a failure.

## Who is using the CPU

The card and the Overview split the busy CPU into each agent, Paseo itself,
macOS and other processes, in cores (`ps` %CPU / 100).

```mermaid
flowchart TD
  P["busy process"] --> ENV{"PASEO_AGENT_ID in its environment?"}
  ENV -- "yes, and Paseo lists that agent" --> AG["that agent"]
  ENV -- "no" --> UP{"an ancestor carries one?"}
  UP -- "yes" --> AG
  UP -- "no" --> PS{"under the daemon or Paseo.app?"}
  PS -- "yes" --> PA["Paseo"]
  PS -- "no" --> SYS{"binary under /System, /usr/libexec, /usr/sbin, /sbin?"}
  SYS -- "yes" --> MAC["macOS"]
  SYS -- "no" --> OT["Other"]
```

Paseo starts every agent with `PASEO_AGENT_ID` set, and everything the agent
starts inherits it. That catches what the process tree loses: helpers an agent
started with `nohup` or as a daemon, now children of launchd. On the machine this
was built on, 143 such processes carried an agent's id, some of them 78 days old.

Two cases need care, and the tests pin both:

- A daemon started from an agent's terminal passes that agent's id to every
  plugin host. The plugin ignores the id it inherited itself.
- Paseo may start an agent through a launcher called `node`, which binary-name
  matching cannot pair with `claude`. The id names the agent exactly.

`ps -wwE` prints the whole environment, secrets included. The plugin keeps the
agent id from each line and drops the rest in the daemon subprocess; nothing else
is stored, logged or sent to the app.

## History and the charts

History accumulates **as a side effect of being read** — there is no background
timer. A plugin that sampled forever would keep the machine awake in order to
report on how busy the machine is. The cost is that history only covers the time
someone was watching, which is why every chart caption reports the real span
between its first and last sample ("last 4 min") instead of claiming a fixed
window. The buffer holds 90 samples and lives in the daemon subprocess, so
closing and reopening the tab does not lose it.

React Native has no SVG, and a Paseo client bundle may import only `react`,
`react-native`, `@tanstack/react-query`, `zod` and `@getpaseo/plugin`. Every chart
here is therefore built from `View`s: lines and areas are a column per sample, and
the disk ring is a **meter**. The meter is not a consolation prize — for a single
ratio against a limit it is the better form, and a donut comparing close values is
a documented anti-pattern.

### Colour

<p align="center">
  <img src="docs/preview.png" alt="The dashboard drawn from sample data: KPI tiles, a CPU usage chart, memory breakdown and disk usage" width="920">
</p>

<p align="center"><sub>Generated by <code>npm run preview</code> from sample data and the plugin&apos;s own palette, thresholds and chart geometry, so the colours cannot drift from the code.</sub></p>

Chrome (backgrounds, text, borders) comes from Paseo's six theme tokens. Series
colour does not: a categorical hue has to stay the same hue across themes or it
stops identifying anything. Paseo never says which theme is active, so the plugin
measures the relative luminance of `surface0` and picks the matching column.

Both columns are the reference categorical order and were checked with the
validator against their own surface — not chosen by eye:

| Check | Dark | Light |
| ----- | ---- | ----- |
| Worst adjacent CVD ΔE | 8.4 | 9.1 |
| Worst adjacent normal-vision ΔE | 19.8 | 22.9 |
| Contrast vs surface | all ≥ 3:1 | aqua and yellow under 3:1 |

The light-mode shortfall is covered by the relief rule: every series carries a
visible label and value, so nothing is identified by colour alone. Status colours
(warning, critical) are a separate fixed set and always ship beside a word —
`High`, `Critical` — never as hue on its own.

## Ports & services

### Where the port list comes from

`netstat` sees every listener on the machine; `lsof` sees only what this user may
inspect. On this machine that is 56 sockets against 39. So `netstat` defines the
list and `lsof` fills in the process — a root-owned port is reported as belonging
to another user rather than quietly dropped, and the count of those appears as a
note under the service list.

The dot beside each port is computed from the bind address, not guessed from the
port number: a wildcard bind (`*`, `0.0.0.0`, `::`) is reachable from the network,
a loopback bind is not, and a bind to one interface address is neither.

One process bound to the same port on IPv4 and IPv6 is shown once — that is one
service, and `kubectl port-forward` produces the pair every time. Sockets with no
visible owner are never merged, because without a PID there is no evidence they
belong together.

### Development ports only, by default

Most of what a Mac listens on has nothing to do with development. On this machine
the split is 30 development ports against 44 system ones: AirPlay on 5000 and
7000, Remote Desktop on 3283, Handoff, SMB, Kerberos, and a long tail of
ephemeral UDP. The list shows development ports and keeps the rest behind a
**Show system** toggle with its count — classified, never discarded.

Relevance is decided by evidence, because port ranges cannot separate these
cases: 7000 here is AirPlay, while 49165 is a coding agent.

| Rule | Result |
| ---- | ------ |
| Attributed to an agent, an agent's child, or a container | development |
| Owner not inspectable (root, another account) | system |
| Executable under `/System/`, `/usr/libexec/`, `/usr/sbin/`, `/Library/Apple/` | system |
| A known runtime — node, bun, python, kubectl, next-server, postgres, … | development |
| Anything else under `$HOME`, except `~/Library/` | development |
| Otherwise | system |

The executable path comes from `ps`, not from `lsof`, whose command column is a
bare name: the path is what separates `/System/Library/…/ControlCenter` from
`~/dev/analytics-tool/.venv/bin/python`.

### Attributing background processes to agents

Coding agents leave things running. A single `claude` agent on this machine had
three MCP servers alive under it — `@playwright/mcp`, `chrome-devtools-mcp` and
`prisma mcp` — none of which is obvious from a process list.

Matching agents by name does not work. A substring search for the providers
Paseo supports finds `AMPDeviceDiscoveryAgent`, `Campo` and `CursorUIViewService`
on a stock macOS install. The signal used instead is structural:

1. Paseo starts each agent as a **direct child of the daemon**, and the plugin's
   own parent *is* the daemon — so `process.ppid` gives the root for free.
2. Each daemon child is confirmed against `paseo.agents.list()`, by the
   `PASEO_AGENT_ID` in its environment first (see
   [Who is using the CPU](#who-is-using-the-cpu)). A child without one must match
   the provider's binary **as a whole word**, and its `cwd` (read through
   `lsof -d cwd`) must match the agent's. Anything else under the daemon —
   `esbuild`, Paseo's helpers, this plugin — is left out.
3. `cwd` also tells two agents of the same provider apart, which is the ordinary
   case when the same model runs in two workspaces.
4. Everything below a confirmed agent is its background process.
5. A listening socket is attributed by walking its owner's parents until an agent
   root appears — so a dev server three levels down still names the agent that
   started it.

If `paseo.agents.list()` is unavailable or changes shape, the panel says
attribution is off and still lists the ports. It never falls back to guessing by
name.

## Docker

The third tab manages the container engine and what runs on it.

**The engine itself.** The card at the top separates three states, because they
need different offers: running shows the server version and a guarded `Quit`,
stopped shows a **Start** button, and missing says which app to install and shows
no button at all. Starting is a launch rather than a daemon command — Docker
Desktop brings up its own VM over tens of seconds — so the panel polls every 3
seconds instead of 10 until the daemon answers.

**Containers.** Right-click any row for logs, `Open http://127.0.0.1:<port>` for
each published port, restart, stop, start and remove. Destructive actions confirm
in a second menu.

**Disk.** `docker system df` broken out by images, containers, volumes and build
cache, each with what it reclaims. Two prune actions are offered and both are
narrow on purpose:

- stopped containers
- **dangling** images only, never `-a`, which would delete every image without a
  running container and cost gigabytes of re-pulling

Volumes are never offered. They are usually the largest reclaimable number on a
development machine and they hold container data, so the panel labels that number
`but this is container data` and gives it no button.

## Quick actions

Both actions are two-step. The first press states what will happen and what it
costs; the second carries it out. An armed button disarms itself after six
seconds so it cannot be triggered later by a stray tap.

### Dev caches

Scanning walks the directories with `du`, so it runs only when asked. Every
candidate is a cache its own tool recreates; clearing one costs a re-download or a
rebuild, never data.

| Target | Path | Cost of clearing |
| ------ | ---- | ---------------- |
| npm cache | `~/.npm/_cacache` | Re-download on next install |
| pnpm store | `~/Library/pnpm/store` | Rebuilt on next install |
| Yarn cache | `~/Library/Caches/Yarn` | Re-download on next install |
| Bun install cache | `~/.bun/install/cache` | Re-download on next install |
| Turbo cache | `~/.cache/turbo` | Next run rebuilds instead of replaying |
| Xcode DerivedData | `~/Library/Developer/Xcode/DerivedData` | Next build is a full rebuild |
| Cargo registry cache | `~/.cargo/registry/cache` | Re-download on next build |
| Go build cache | `~/Library/Caches/go-build` | Next build is a full rebuild |
| pip cache | `~/Library/Caches/pip` | Re-download on next install |
| uv cache | `~/.cache/uv` | Re-download on next sync |

`~/Library/Caches` as a whole is deliberately absent: it also holds application
state that does not regenerate.

Three guards stand between the plugin and `fs.rm`:

1. Only paths in the table above can ever be touched — the plugin takes a target
   id, never a path from the client.
2. Each path is resolved through `realpath` and must land at least two levels
   below the real home directory. A symlink planted inside a cache cannot
   redirect the deletion outside it.
3. Only the directory's contents are removed; the directory itself stays, because
   several tools expect it to exist.

### Top processes

The list refreshes every five seconds and pauses while a process is selected — a
list that reorders under your finger is how the wrong PID gets terminated. Each
row carries a CPU bar scaled to the heaviest process on screen.

**AVG** is the process's CPU time over its whole life (`ps -o time,etime`). Far
below the CPU column, it says the process became busy recently. Finder read 99%
with an AVG of 5% after three days up, so it could not have been busy for more
than four of those hours. **Explain** uses the same arithmetic and says so in
words instead of reading uptime as load.

Paseo and its parent processes are greyed out and marked `protected`. The plugin
walks its own parent chain to build that set and recomputes it from a fresh `ps`
on every kill, so a stale or forged PID from the client cannot get through.

SIGTERM is sent first and the result is reported honestly: a process that ignores
it is reported as still running, and force kill becomes a separate, separately
confirmed step.

## For agents

On Paseo 0.14 and newer every agent gets two read-only tools. Older daemons send
no tool list, and the plugin adds nothing there.

| Tool | Returns |
| ---- | ------- |
| `machine_status` | CPU in use, load, the core pattern, memory pressure, disk, the cores the calling agent's processes use, who else uses the CPU, and one line of guidance: hold off parallel work, memory is tight, or there is headroom |
| `machine_explain_process` | The Explain verdict for one PID: what it is, which agent started it, burst or steady, what to do |

Ask an agent to call `machine_status` before a large build or test run, or tell it
so in your project instructions. The tools reach the agent through the
`agent.session_open` hook, which can stop an agent from starting if it throws.
This one cannot: any error inside it returns the request untouched, and the agent
starts without the tools.

## Development

```bash
npm run check                         # typecheck, then the tests
paseo plugin reload machine-status    # source edits need an explicit reload
paseo plugin logs machine-status
npm run preview                       # regenerates docs/preview.svg from the real palette
npm run banner                        # regenerates docs/banner.svg, the README's opening image
./scripts/preview-png.sh [banner]     # renders docs/preview.svg (or banner.svg) to PNG at 2x
```

Tests cover the command-output parsers against captured real output (including
`os.cpus()` tick pairs, `ioreg` core clusters and `ps -E` lines with the
environment trimmed to harmless keys), the path and
PID guards, the rolling history buffer, the palette and chart geometry, the
port parsers against captured `netstat`/`lsof`/`docker` output, the agent-matching
rules including the real false positives above, and a
round-trip of every handler result through its own Zod contract — the drift that
would otherwise surface as an RPC rejection at runtime. The live tests never
mutate anything: cleanup is only planned, and the kill tests assert refusals,
including a refusal to terminate the test runner itself.

### Paseo versions

The SDK stays pinned to 0.11.4 for typechecking and tests, so the compiler proves
the plugin uses only the 0.11 API, which every supported release still provides.
Paseo supplies the runtime instances on every supported release line, so none of
it ships with the plugin.

Paseo 0.11 replaced surfaces with screens and kept the old calls as deprecated
aliases. Up to 0.2.3 the manifest admitted 0.8, and each connected app evaluates the
client entry against its own version, so `client/compat.tsx` describes the 0.11
additions locally and calls them only after checking that the app has them. Since the
manifest asks for 0.11, every app that loads the plugin takes the first row; the
fallback stays in the code until it is removed on its own:

| App version | Screen | Sidebar | Opens with | Tab shortcuts in ⌘K |
| ----------- | ------ | ------- | ---------- | ------------------- |
| 0.11 and newer | `addScreen` | `addSidebarHeaderItem` + `SidebarRow` | `openScreen`, with `?tab=` | yes |
| 0.8 to 0.10 | `addSurface` | `addSidebarItem` | `openSurface`, overview tab | not offered |

Both paths register under the id `main`, so saved `/plugin/machine-status/main`
links open the same screen after an upgrade. `tests/compat.test.ts` pins both
paths, including a half-present API, which falls back rather than mixing the two.
The daemon half uses `server.handle`, unchanged since 0.8, and `server.before`
for the agent tools. The tool shape is mirrored in `server/agent-tools.ts`, so it
builds against the 0.11 SDK, and the tools appear only when the session-open
request carries a `tools` list, which Paseo sends from 0.14.

Releases are cut from tags by GitHub Actions; see [CONTRIBUTING.md](CONTRIBUTING.md)
for the flow and [CHANGELOG.md](CHANGELOG.md) for what changed.

## Troubleshooting

| Symptom | Check |
| ------- | ----- |
| Sidebar item missing | `paseo plugin ls` reports `running`, the client is on this host, and on 0.11+ the item is not hidden in **Settings → Sidebar** |
| "Metrics unavailable" | The daemon is not on macOS, or a `/usr/bin` tool is missing |
| Charts look empty | History starts empty; it fills as the tab stays open |
| A port shows "another user" | It belongs to root or another account; `lsof` cannot inspect it unprivileged |
| No agent attribution | `paseo.agents.list()` failed — the note under the service list says so |
| An agent's CPU shows under Paseo | The daemon was started from that agent's terminal, so its id is the one every plugin inherits and proves nothing; restart the daemon from the app |
| Agents have no `machine_status` | The daemon is older than 0.14, or Paseo's tools are off for agents: `paseo daemon config set daemon.mcp.injectIntoAgents true` |
| A port you expected is missing | It was classified as a system port; use **Show system** |
| Docker containers missing | Docker is not installed or not running; the note says so |
| A cache shows "not present" | The tool is not installed, or it moved its cache |
| Edits do not appear | `npm run typecheck`, then `paseo plugin reload machine-status` |

## Other plugins by dutchakdev

- [Account Switcher](https://paseo.sh/plugins/dutchakdev/account-switcher) ([source](https://github.com/dutchakdev/paseo-plugin-account-switcher)): several Claude and ChatGPT/Codex subscription accounts in Paseo, with an account per agent, switching of an existing chat, and every account's limits.
- [Mermaid](https://paseo.sh/plugins/dutchakdev/mermaid) ([source](https://github.com/dutchakdev/paseo-plugin-mermaid)): draws Mermaid flowcharts and sequence diagrams from chat messages and `.mmd` files, on desktop and mobile.
- [secure-input](https://paseo.sh/plugins/dutchakdev/secure-input) ([source](https://github.com/dutchakdev/paseo-plugin-secure-input)): agents ask you for secrets through a form, and each value lands in a short-lived file the agent moves without reading it.

## License

MIT
