import { describe, expect, it } from "vitest";
import {
  appendHistory,
  buildMemory,
  downsample,
  parseBattery,
  parseDf,
  parseMemoryPressure,
  parseSwapUsage,
  parseThermal,
  parseVmStat,
  resetHistory,
  summarizeHistory,
  toHistorySample,
} from "../metrics.server";

/** Captured verbatim from macOS 27 on Apple Silicon. */
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    78720.
Pages active:                                 289641.
Pages inactive:                               302111.
Pages speculative:                              8199.
Pages throttled:                                   0.
Pages wired down:                             130300.
Pages purgeable:                                1402.
"Translation faults":                     8134761213.
Pages copy-on-write:                       529273835.
Pages zero filled:                        1764577196.
Pages reactivated:                        1215198919.
Pages purged:                               22022730.
File-backed pages:                            256692.
Anonymous pages:                              343259.
Pages stored in compressor:                   505200.
Pages occupied by compressor:                 200191.
Decompressions:                           2079030820.
Compressions:                             2152216447.
Pageins:                                   115581460.
Pageouts:                                     111710.
Swapins:                                     3875731.
Swapouts:                                    5576341.
`;

describe("parseVmStat", () => {
  it("reads the 16 KiB Apple Silicon page size from the header", () => {
    expect(parseVmStat(VM_STAT).pageSize).toBe(16384);
  });

  it("ignores the header line instead of treating it as a counter", () => {
    const { pages } = parseVmStat(VM_STAT);
    expect(pages["mach virtual memory statistics"]).toBeUndefined();
  });

  it("reads quoted keys such as \"Translation faults\"", () => {
    expect(parseVmStat(VM_STAT).pages["translation faults"]).toBe(8134761213);
  });

  it("reads the counters the memory model depends on", () => {
    const { pages } = parseVmStat(VM_STAT);
    expect(pages["pages wired down"]).toBe(130300);
    expect(pages["anonymous pages"]).toBe(343259);
    expect(pages["pages occupied by compressor"]).toBe(200191);
    expect(pages["file-backed pages"]).toBe(256692);
  });

  it("falls back to a 4 KiB page when the header is missing", () => {
    expect(parseVmStat("Pages free: 10.").pageSize).toBe(4096);
  });
});

describe("buildMemory", () => {
  const total = 17179869184;

  it("separates app, wired and compressed the way Activity Monitor does", () => {
    const memory = buildMemory(parseVmStat(VM_STAT), total, 67);
    // anonymous (343259) - purgeable (1402) = 341857 pages of 16 KiB
    expect(memory.appBytes).toBe(341857 * 16384);
    expect(memory.wiredBytes).toBe(130300 * 16384);
    expect(memory.compressedBytes).toBe(200191 * 16384);
    expect(memory.usedBytes).toBe(memory.appBytes + memory.wiredBytes + memory.compressedBytes);
  });

  it("never reports more used memory than the machine has", () => {
    const memory = buildMemory(parseVmStat(VM_STAT), total, 67);
    expect(memory.usedBytes).toBeLessThanOrEqual(total);
  });

  it("derives pressure from the free percentage macOS reports", () => {
    expect(buildMemory(parseVmStat(VM_STAT), total, 67).pressurePercent).toBe(33);
  });

  it("keeps pressure null when memory_pressure is unavailable", () => {
    const memory = buildMemory(parseVmStat(VM_STAT), total, null);
    expect(memory.pressurePercent).toBeNull();
    expect(memory.freePercent).toBeNull();
  });

  it("clamps app memory at zero when purgeable exceeds anonymous", () => {
    const skewed = parseVmStat("Anonymous pages: 10.\nPages purgeable: 99.");
    expect(buildMemory(skewed, total, null).appBytes).toBe(0);
  });
});

describe("parseSwapUsage", () => {
  it("expands the M suffix as mebibytes", () => {
    const swap = parseSwapUsage(
      "vm.swapusage: total = 2048.00M  used = 1187.94M  free = 860.06M  (encrypted)\n",
    );
    expect(swap.totalBytes).toBe(2048 * 1024 ** 2);
    expect(Math.round(swap.usedBytes)).toBe(Math.round(1187.94 * 1024 ** 2));
    expect(Math.round(swap.freeBytes)).toBe(Math.round(860.06 * 1024 ** 2));
  });

  it("handles a machine with swap disabled", () => {
    const swap = parseSwapUsage("vm.swapusage: total = 0.00M  used = 0.00M  free = 0.00M\n");
    expect(swap.totalBytes).toBe(0);
    expect(swap.usedBytes).toBe(0);
  });

  it("expands a G suffix", () => {
    expect(parseSwapUsage("total = 4.00G  used = 1.00G  free = 3.00G").totalBytes).toBe(4 * 1024 ** 3);
  });
});

describe("parseDf", () => {
  const DF = `Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1   482797652  24551896 151025228    14%    /
`;

  it("converts 1024-blocks to bytes", () => {
    const disk = parseDf(DF);
    expect(disk?.freeBytes).toBe(151025228 * 1024);
    expect(disk?.usedBytes).toBe(24551896 * 1024);
  });

  it("takes the percentage from df rather than computing used/total", () => {
    const disk = parseDf(DF);
    // APFS shares the container, so used/total would report 5% instead of 14%.
    expect(disk?.usedPercent).toBe(14);
  });

  it("keeps the mount point", () => {
    expect(parseDf(DF)?.mountedOn).toBe("/");
  });

  it("returns null when df produced no usable row", () => {
    expect(parseDf("Filesystem 1024-blocks Used Available Capacity Mounted on\n")).toBeNull();
  });
});

describe("parseBattery", () => {
  it("reads a semicolon-containing state on AC power", () => {
    const power = parseBattery(
      "Now drawing from 'AC Power'\n -InternalBattery-0 (id=23068771)\t80%; AC attached; not charging present: true\n",
    );
    expect(power.source).toBe("ac");
    expect(power.percent).toBe(80);
    expect(power.state).toBe("AC attached; not charging");
    expect(power.timeRemainingMinutes).toBeNull();
  });

  it("converts a remaining h:mm figure to minutes", () => {
    const power = parseBattery(
      "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=23068771)\t95%; discharging; 4:32 remaining present: true\n",
    );
    expect(power.source).toBe("battery");
    expect(power.timeRemainingMinutes).toBe(272);
  });

  it("reports a machine with no battery instead of inventing one", () => {
    const power = parseBattery("Now drawing from 'AC Power'\n");
    expect(power.source).toBe("ac");
    expect(power.percent).toBeNull();
  });

  it("falls back to unknown when pmset says nothing useful", () => {
    expect(parseBattery("").source).toBe("unknown");
  });
});

describe("parseThermal", () => {
  it("stays unknown when macOS has recorded no thermal level", () => {
    const thermal = parseThermal(
      "Note: No thermal warning level has been recorded\nNote: No performance warning level has been recorded\nNote: No CPU power status has been recorded\n",
    );
    expect(thermal.level).toBe("unknown");
    expect(thermal.cpuSpeedLimitPercent).toBeNull();
  });

  it("reads an unthrottled machine as nominal", () => {
    const thermal = parseThermal("CPU_Scheduler_Limit \t= 100\nCPU_Speed_Limit \t= 100\n");
    expect(thermal.level).toBe("nominal");
    expect(thermal.cpuSpeedLimitPercent).toBe(100);
  });

  it("escalates the level as the speed limit drops", () => {
    expect(parseThermal("CPU_Speed_Limit = 80").level).toBe("fair");
    expect(parseThermal("CPU_Speed_Limit = 60").level).toBe("serious");
    expect(parseThermal("CPU_Speed_Limit = 30").level).toBe("critical");
  });
});

describe("parseMemoryPressure", () => {
  it("reads the free percentage macOS reports", () => {
    expect(
      parseMemoryPressure(
        "The system has 17179869184 (1048576 pages with a page size of 16384).\nSystem-wide memory free percentage: 67%\n",
      ),
    ).toBe(67);
  });

  it("returns null when the line is absent", () => {
    expect(parseMemoryPressure("some other output")).toBeNull();
  });
});

describe("rolling history", () => {
  const sample = (at: string) => ({
    at,
    cpuLoadPercent: 10,
    pressurePercent: 20,
    appBytes: 1,
    wiredBytes: 2,
    compressedBytes: 3,
    swapUsedBytes: 4,
  });

  it("keeps samples in arrival order", () => {
    resetHistory();
    appendHistory(sample("a"));
    appendHistory(sample("b"));
    expect(appendHistory(sample("c")).map((entry) => entry.at)).toEqual(["a", "b", "c"]);
  });

  it("drops the oldest sample once the buffer is full", () => {
    resetHistory();
    for (let index = 0; index < 5; index += 1) appendHistory(sample(String(index)), 3);
    expect(appendHistory(sample("5"), 3).map((entry) => entry.at)).toEqual(["3", "4", "5"]);
  });

  it("never grows past the limit however often it is called", () => {
    resetHistory();
    for (let index = 0; index < 500; index += 1) appendHistory(sample(String(index)), 90);
    expect(appendHistory(sample("last"), 90)).toHaveLength(90);
  });

  it("projects a snapshot onto the compact sample the charts need", () => {
    const projected = toHistorySample({
      collectedAt: "2026-08-19T16:00:00.000Z",
      hostname: "h",
      platform: "p",
      uptimeSeconds: 1,
      cpu: { cores: 8, loadAvg1: 2, loadAvg5: 2, loadAvg15: 2, loadPercent: 25 },
      memory: {
        totalBytes: 16,
        appBytes: 5,
        wiredBytes: 2,
        compressedBytes: 3,
        cachedBytes: 4,
        usedBytes: 10,
        freePercent: 67,
        pressurePercent: 33,
      },
      swap: { totalBytes: 2, usedBytes: 1, freeBytes: 1 },
      disk: { mountedOn: "/", totalBytes: 9, usedBytes: 1, freeBytes: 8, usedPercent: 14 },
      power: { source: "ac", percent: 80, state: null, timeRemainingMinutes: null },
      thermal: { level: "unknown", cpuSpeedLimitPercent: null },
    });
    expect(projected).toEqual({
      at: "2026-08-19T16:00:00.000Z",
      cpuLoadPercent: 25,
      pressurePercent: 33,
      appBytes: 5,
      wiredBytes: 2,
      compressedBytes: 3,
      swapUsedBytes: 1,
    });
  });
});

describe("summarizeHistory", () => {
  const at = (seconds: number) => new Date(Date.UTC(2026, 7, 19, 16, 0, seconds)).toISOString();
  const sample = (seconds: number, cpu: number, pressure: number | null = 30) => ({
    at: at(seconds),
    cpuLoadPercent: cpu,
    pressurePercent: pressure,
    appBytes: 1,
    wiredBytes: 2,
    compressedBytes: 3,
    swapUsedBytes: seconds,
  });

  it("separates a spike from a sustained load, which one snapshot cannot", () => {
    const spike = summarizeHistory([sample(0, 10), sample(3, 95), sample(6, 12)]);
    expect(spike.cpuLoadPercent).toMatchObject({ min: 10, max: 95, last: 12 });
    // max far above last means it spiked and recovered.
    expect(spike.cpuLoadPercent!.max - spike.cpuLoadPercent!.last).toBeGreaterThan(50);
  });

  it("reports the real span between first and last sample", () => {
    expect(summarizeHistory([sample(0, 10), sample(90, 10)]).spanSeconds).toBe(90);
  });

  it("sums the three memory components into used memory", () => {
    expect(summarizeHistory([sample(0, 10)]).memoryUsedBytes).toMatchObject({ last: 6 });
  });

  it("skips missing pressure readings instead of counting them as zero", () => {
    const summary = summarizeHistory([sample(0, 10, null), sample(3, 10, 40)]);
    expect(summary.pressurePercent).toMatchObject({ min: 40, max: 40 });
  });

  it("returns nulls rather than NaN for an empty history", () => {
    const summary = summarizeHistory([]);
    expect(summary.samples).toBe(0);
    expect(summary.cpuLoadPercent).toBeNull();
    expect(summary.spanSeconds).toBe(0);
  });
});

describe("downsample", () => {
  const series = Array.from({ length: 90 }, (_, index) => index);

  it("keeps the first and last point", () => {
    const picked = downsample(series, 12);
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBe(89);
  });

  it("returns exactly the requested count", () => {
    expect(downsample(series, 12)).toHaveLength(12);
  });

  it("returns everything when the series is already short", () => {
    expect(downsample([1, 2, 3], 12)).toEqual([1, 2, 3]);
  });

  it("returns the newest point when asked for one", () => {
    expect(downsample(series, 1)).toEqual([89]);
  });

  it("returns nothing for a zero count", () => {
    expect(downsample(series, 0)).toEqual([]);
  });
});


