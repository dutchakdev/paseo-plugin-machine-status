Machine Status shows what the daemon's machine is doing while your agents work, and which agent is doing it: CPU in use, memory pressure, swap, disk, battery and thermal state, the ports and background processes your agents started, and the Docker engine. It also clears developer caches and stops runaway processes, with a confirmation step for each.

## What you get

- **Machine screen**, opened from the sidebar or ⌘K. Overview has stat tiles that expand into detail, CPU and memory charts, a dev-cache scanner, and a process table. Ports & services lists listening ports and what runs behind them. Docker shows the engine, containers and disk usage.
- **Load pill** beside every agent's composer with CPU utilisation and memory pressure on macOS, or used RAM on Linux. Pressing it opens a compact card with the trend, the cores each agent keeps busy, the top CPU processes, and the development ports held by agents, so you can tell whether the machine is the problem without leaving the chat.
- **Who is using the CPU**, in the card and on the Overview: each agent, Paseo, the operating system and the rest, in cores. Processes an agent left running outside its tree still count as that agent's.
- **Per-core bars** with efficiency and performance cores apart, and a line that reads the pattern: a single-threaded step, background work, or a saturated machine.
- **Agent tools** on Paseo 0.14 and newer: `machine_status` gives an agent the machine's state, its own share and a line of guidance before heavy work; `machine_explain_process` explains one PID.
- On Paseo 0.11 and newer, ⌘K can open the screen straight on Ports & services or Docker.

## How it decides

- CPU is utilisation from the kernel's tick counters, never load average, so it cannot pass 100%. Load stays visible as threads per core.
- On macOS, memory follows Activity Monitor's split and uses the system pressure figure. On Linux, used RAM is total RAM less the amount the kernel says is available for new work.
- A process belongs to an agent when its environment, or an ancestor's, carries that agent's `PASEO_AGENT_ID`. The collector keeps only that ID from the environment.
- A busy process is called a fresh burst or a steady load by its CPU time over its whole life, not by its uptime. A port counts as a development port by its executable's path, not by its number. System ports are hidden until you choose **Show system**.
- Values the plugin cannot read are shown as missing rather than estimated.

## Setup

- A macOS or Linux daemon on Paseo 0.11 or newer. Linux uses procfs and sysfs, with `ps`, `df`, `getconf`, `du` and `ss` on the daemon PATH. Linux memory displays used RAM and the Overview reports CPU, memory and I/O stall time when PSI is available.
- The Docker tab needs a Docker CLI and a reachable engine. On Linux the daemon account needs access to its Docker context, and engine service controls live on the host.

## What it can change

- **Dev caches**: only a fixed list of caches that their tools recreate (npm, pnpm, Yarn, Bun, Turbo, Xcode DerivedData, Cargo, Go, pip, uv). The client sends a cache id, never a path; each path must resolve below your home directory, and only its contents are removed.
- **Processes**: SIGTERM first, and force kill only as a separate confirmed step. Paseo and its parent processes are protected and checked again on every kill.
- **Docker**: start, stop, restart and remove containers, quit or start the desktop engine on macOS, and prune stopped containers and dangling images. Volumes are never pruned.

Collection runs on the selected daemon. Metrics appear in connected Paseo clients. When agent tools are enabled, their results are visible to the calling agent and its model provider.

## Other plugins by dutchakdev

- [Account Switcher](https://paseo.sh/plugins/dutchakdev/account-switcher): several Claude and ChatGPT/Codex subscription accounts in Paseo, with an account per agent, switching of an existing chat, and every account's limits.
- [Mermaid](https://paseo.sh/plugins/dutchakdev/mermaid): draws Mermaid flowcharts and sequence diagrams from chat messages and `.mmd` files, on desktop and mobile.
- [secure-input](https://paseo.sh/plugins/dutchakdev/secure-input): agents ask you for secrets through a form, and each value lands in a short-lived file the agent moves without reading it.
