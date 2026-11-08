import { describe, expect, it } from "vitest";
import {
  ancestorsOf,
  burstCeilingSeconds,
  guardedPids,
  lifetimeCpuPercent,
  parseCpuTime,
  parseElapsedSeconds,
  parsePsTable,
  processName,
  sortEntries,
  toEntries,
  type RawProcess,
} from "../server/processes";

/** Captured verbatim from `ps -Ao pid=,ppid=,pcpu=,rss=,comm=` on macOS. */
const PS_OUTPUT = `  965     1  42.2  41056 /Applications/BetterDisplay.app/Contents/MacOS/BetterDisplay
  447     1   4.1  27968 /System/Library/PrivateFrameworks/SkyLight.framework/Resources/WindowServer
88054 45907   3.9  43744 gh
45907 45906   3.2 284256 Paseo Daemon
45906     1   0.1  10240 node
   49805     1   2.1 1403840 /System/Library/Frameworks/Virtualization.framework/Versions/A/XPCServices/com.apple.Virtualization.VirtualMachine.xpc/Contents/MacOS/com.apple.Virtualization.VirtualMachine
`;

describe("parsePsTable", () => {
  it("keeps spaces in the command column", () => {
    const daemon = parsePsTable(PS_OUTPUT).find((entry) => entry.pid === 45907);
    expect(daemon?.command).toBe("Paseo Daemon");
  });

  it("keeps full executable paths intact", () => {
    const table = parsePsTable(PS_OUTPUT);
    expect(table[0].command).toBe("/Applications/BetterDisplay.app/Contents/MacOS/BetterDisplay");
  });

  it("converts the RSS column from KiB to bytes", () => {
    expect(parsePsTable(PS_OUTPUT)[0].memoryBytes).toBe(41056 * 1024);
  });

  it("reads fractional CPU percentages", () => {
    expect(parsePsTable(PS_OUTPUT)[0].cpuPercent).toBeCloseTo(42.2);
  });

  it("tolerates leading whitespace from right-aligned PID columns", () => {
    expect(parsePsTable(PS_OUTPUT).some((entry) => entry.pid === 49805)).toBe(true);
  });

  it("skips lines that are not process rows", () => {
    expect(parsePsTable("  PID  PPID %CPU   RSS COMMAND\n\n")).toHaveLength(0);
  });
});

/**
 * Captured verbatim from `ps -Ao pid=,ppid=,pcpu=,rss=,time=,etime=,comm=` on an
 * M1 Pro on 2026-11-08 (two runs a minute apart; every line is unedited).
 */
const PS_TIMED = `    1     0   0.1  18176 3387:08.30 80-20:56:52 /sbin/launchd
 1835     1   0.0    992   0:00.12       24:30 /System/Library/PrivateFrameworks/AssetCacheServices.framework/Versions/A/XPCServices/AssetCacheLocatorService.xpc/Contents/MacOS/AssetCacheLocatorService
17365     1   0.0  11840   6:35.69 11-05:17:30 Paseo Supervisor
23231 17365  43.1 640912 214:14.20 07-00:13:17 Paseo Daemon
53542     1  99.1 366080 231:53.55 03-05:15:40 /System/Library/CoreServices/Finder.app/Contents/MacOS/Finder
59130  3635 358.3 1293664   0:06.68       00:01 kicad-cli
`;

describe("parsePsTable with CPU time and elapsed time", () => {
  const table = parsePsTable(PS_TIMED);
  const row = (pid: number) => table.find((entry) => entry.pid === pid)!;

  it("reads every row, including commands with spaces", () => {
    expect(table).toHaveLength(6);
    expect(row(23231).command).toBe("Paseo Daemon");
    expect(row(17365).command).toBe("Paseo Supervisor");
  });

  it("reads cumulative CPU time, which macOS prints as minutes past sixty", () => {
    // 3387 minutes is 56 hours; there is no hours field to rely on.
    expect(row(1).cpuSeconds).toBeCloseTo(3387 * 60 + 8.3);
    expect(row(1835).cpuSeconds).toBeCloseTo(0.12);
  });

  it("reads elapsed time in every width ps uses", () => {
    expect(row(1).elapsedSeconds).toBe(80 * 86_400 + 20 * 3_600 + 56 * 60 + 52);
    expect(row(1835).elapsedSeconds).toBe(24 * 60 + 30);
    expect(row(59130).elapsedSeconds).toBe(1);
  });

  it("still reads the five-column table, without the time fields", () => {
    const old = parsePsTable(PS_OUTPUT)[0];
    expect(old.cpuSeconds).toBeUndefined();
    expect(old.elapsedSeconds).toBeUndefined();
  });
});

describe("parseCpuTime", () => {
  it("reads minutes, seconds and hundredths", () => {
    expect(parseCpuTime("231:53.55")).toBeCloseTo(231 * 60 + 53.55);
    expect(parseCpuTime("0:06.68")).toBeCloseTo(6.68);
  });

  it("rejects what it was not shown", () => {
    expect(parseCpuTime("01-02:03:04")).toBeNull();
    expect(parseCpuTime("")).toBeNull();
  });
});

describe("lifetimeCpuPercent", () => {
  const table = parsePsTable(PS_TIMED);
  const life = (pid: number) => {
    const entry = table.find((row) => row.pid === pid)!;
    return lifetimeCpuPercent(entry.cpuSeconds ?? null, entry.elapsedSeconds ?? null);
  };

  it("tells a recent burst from a process that always runs hot", () => {
    // Finder read 99% that minute, yet averaged 5% over three days.
    expect(life(53542)).toBeCloseTo(4.98, 1);
  });

  it("can exceed 100% for a process that keeps several cores busy, like pcpu", () => {
    expect(life(59130)).toBeCloseTo(668, 0);
  });

  it("has nothing to say without both readings, or before any time has passed", () => {
    expect(lifetimeCpuPercent(null, 100)).toBeNull();
    expect(lifetimeCpuPercent(5, null)).toBeNull();
    expect(lifetimeCpuPercent(5, 0)).toBeNull();
  });
});

describe("burstCeilingSeconds", () => {
  it("bounds how long a process can have run at its current rate by the CPU time it has", () => {
    // Finder: 13,913.55 s of CPU in total. At 99.1% that is at most 3.9 hours,
    // whatever its three-day elapsed time suggests.
    expect(burstCeilingSeconds(231 * 60 + 53.55, 99.1)! / 3_600).toBeCloseTo(3.9, 1);
  });

  it("does not divide by an idle reading", () => {
    expect(burstCeilingSeconds(100, 0)).toBeNull();
    expect(burstCeilingSeconds(null, 50)).toBeNull();
  });
});

describe("ancestorsOf", () => {
  const table = parsePsTable(PS_OUTPUT);

  it("includes the process itself and every parent up the chain", () => {
    expect([...ancestorsOf(88054, table)].sort((a, b) => a - b)).toEqual([45906, 45907, 88054]);
  });

  it("stops when the parent is absent from the table", () => {
    // launchd is not a row in this fixture, so the walk ends at the last known parent.
    expect([...ancestorsOf(965, table)].sort((a, b) => a - b)).toEqual([965]);
  });

  it("reaches launchd when the table contains it, as a real ps -A does", () => {
    const withLaunchd = [
      { pid: 1, ppid: 0, cpuPercent: 0, memoryBytes: 0, command: "/sbin/launchd" },
      ...table,
    ];
    expect([...ancestorsOf(88054, withLaunchd)].sort((a, b) => a - b)).toEqual([
      1, 45906, 45907, 88054,
    ]);
  });

  it("terminates on a cycle instead of looping forever", () => {
    const cyclic: RawProcess[] = [
      { pid: 10, ppid: 11, cpuPercent: 0, memoryBytes: 0, command: "a" },
      { pid: 11, ppid: 10, cpuPercent: 0, memoryBytes: 0, command: "b" },
    ];
    expect([...ancestorsOf(10, cyclic).values()].sort((a, b) => a - b)).toEqual([10, 11]);
  });

  it("returns nothing for an unknown pid", () => {
    expect(ancestorsOf(999999, table).size).toBe(0);
  });
});

describe("guardedPids", () => {
  const table = parsePsTable(PS_OUTPUT);

  it("guards the whole chain that keeps Paseo alive", () => {
    // A plugin running as pid 88054 must not be able to kill the daemon at 45907.
    const guarded = guardedPids(table, 88054);
    expect(guarded.has(45907)).toBe(true);
    expect(guarded.has(45906)).toBe(true);
    expect(guarded.has(88054)).toBe(true);
  });

  it("always guards pid 0 and launchd", () => {
    const guarded = guardedPids(table, 88054);
    expect(guarded.has(0)).toBe(true);
    expect(guarded.has(1)).toBe(true);
  });

  it("leaves unrelated processes killable", () => {
    expect(guardedPids(table, 88054).has(965)).toBe(false);
  });
});

describe("processName", () => {
  it("reduces a full path to the executable name", () => {
    expect(processName("/Applications/BetterDisplay.app/Contents/MacOS/BetterDisplay")).toBe(
      "BetterDisplay",
    );
  });

  it("leaves a spaced command name alone", () => {
    expect(processName("Paseo Daemon")).toBe("Paseo Daemon");
  });
});

describe("sortEntries", () => {
  const entries = toEntries(parsePsTable(PS_OUTPUT), guardedPids(parsePsTable(PS_OUTPUT), 88054));

  it("ranks by CPU when asked", () => {
    expect(sortEntries(entries, "cpu")[0].pid).toBe(965);
  });

  it("ranks by memory when asked", () => {
    expect(sortEntries(entries, "memory")[0].pid).toBe(49805);
  });

  it("does not mutate the input order", () => {
    const before = entries.map((entry) => entry.pid);
    sortEntries(entries, "memory");
    expect(entries.map((entry) => entry.pid)).toEqual(before);
  });
});

describe("parseElapsedSeconds", () => {
  it("reads the MM:SS form a freshly started process shows", () => {
    // XProtectRemediatorPirrit was 20 seconds old while spiking to 84.9% CPU.
    expect(parseElapsedSeconds("00:20")).toBe(20);
  });

  it("reads the HH:MM:SS form", () => {
    expect(parseElapsedSeconds("13:22:42")).toBe(13 * 3600 + 22 * 60 + 42);
  });

  it("reads the DD-HH:MM:SS form a long-lived daemon shows", () => {
    expect(parseElapsedSeconds("05-10:26:26")).toBe(5 * 86400 + 10 * 3600 + 26 * 60 + 26);
  });

  it("tolerates the leading whitespace ps pads with", () => {
    expect(parseElapsedSeconds("      00:20")).toBe(20);
  });

  it("returns null rather than a wrong number for an unexpected format", () => {
    expect(parseElapsedSeconds("yesterday")).toBeNull();
    expect(parseElapsedSeconds("")).toBeNull();
  });
});
