import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createCpuSampler, usageBetween, type CoreTimes } from "../server/cpu";

const fixture = JSON.parse(
  readFileSync(path.join(__dirname, "fixtures", "os-cpus-m1pro.json"), "utf8"),
) as { before: CoreTimes[]; after: CoreTimes[] };

const core = (busy: number, idle: number): CoreTimes => ({ user: busy, nice: 0, sys: 0, idle, irq: 0 });

describe("usageBetween", () => {
  it("measures the share of tick time spent not idle, on a real M1 Pro capture", () => {
    const usage = usageBetween(fixture.before, fixture.after);
    // Captured while top reported about 70% busy for a neighbouring second.
    expect(usage.overall).toBeCloseTo(76.1, 1);
    // Computed independently by the capture script at the time.
    expect(usage.perCore.map((value) => Number(value!.toFixed(1)))).toEqual([
      51.5, 49, 98, 90.9, 91, 74.7, 83, 70.4,
    ]);
  });

  it("stays within 0–100 however loaded the machine is, unlike load average", () => {
    // Load average on the same machine read 659 on 8 cores, which the old pill
    // turned into 8240%. Utilisation cannot exceed every core being busy.
    const usage = usageBetween([core(0, 0), core(0, 0)], [core(1000, 0), core(1000, 0)]);
    expect(usage.overall).toBe(100);
  });

  it("weights cores by their ticks, so the overall figure is not a mean of means", () => {
    const usage = usageBetween([core(0, 0), core(0, 0)], [core(100, 0), core(0, 300)]);
    expect(usage.perCore).toEqual([100, 0]);
    expect(usage.overall).toBe(25);
  });

  it("reports nothing rather than zero when no ticks passed", () => {
    const usage = usageBetween([core(5, 5)], [core(5, 5)]);
    expect(usage.overall).toBeNull();
    expect(usage.perCore).toEqual([null]);
  });

  it("drops a core whose counters went backwards instead of reporting a negative share", () => {
    const usage = usageBetween([core(500, 500), core(0, 0)], [core(100, 100), core(50, 50)]);
    expect(usage.perCore).toEqual([null, 50]);
    expect(usage.overall).toBe(50);
  });

  it("refuses to pair readings with different core counts", () => {
    const usage = usageBetween([core(0, 0)], [core(10, 10), core(10, 10)]);
    expect(usage.overall).toBeNull();
    expect(usage.perCore).toEqual([]);
  });

  it("has nothing to say about a machine that lists no cores", () => {
    expect(usageBetween([], [])).toEqual({ overall: null, perCore: [] });
  });
});

/**
 * A fake machine: every tick of the clock advances each core's counters by the
 * same busy/idle split, so the expected utilisation is known exactly.
 */
function fakeMachine(busyShare: number, cores = 2) {
  let clock = 1_000_000;
  let share = busyShare;
  const times = Array.from({ length: cores }, () => core(0, 0));
  const waits: number[] = [];
  const advance = (ms: number) => {
    clock += ms;
    for (const entry of times) {
      entry.user += ms * share;
      entry.idle += ms * (1 - share);
    }
  };
  return {
    waits,
    advance,
    setShare: (next: number) => {
      share = next;
    },
    sampler: createCpuSampler({
      read: () => times.map((entry) => ({ ...entry })),
      now: () => clock,
      wait: async (ms) => {
        waits.push(ms);
        advance(ms);
      },
    }),
  };
}

describe("createCpuSampler", () => {
  it("opens a short window of its own on the first read, since a delta needs two readings", async () => {
    const machine = fakeMachine(0.4);
    const usage = await machine.sampler();
    expect(machine.waits).toEqual([250]);
    expect(usage.overall).toBeCloseTo(40);
    expect(usage.windowMs).toBe(250);
  });

  it("measures since the previous read when that read is recent, without waiting", async () => {
    const machine = fakeMachine(0.4);
    await machine.sampler();
    machine.setShare(0.9);
    machine.advance(3_000);
    const usage = await machine.sampler();
    expect(machine.waits).toEqual([250]);
    expect(usage.overall).toBeCloseTo(90);
    expect(usage.windowMs).toBe(3_000);
  });

  it("answers reads that crowd together with the last figure instead of a noisy sliver", async () => {
    const machine = fakeMachine(0.4);
    await machine.sampler();
    machine.advance(3_000);
    const first = await machine.sampler();
    machine.setShare(1);
    machine.advance(100);
    expect(await machine.sampler()).toEqual(first);
    // The baseline did not move, so the next proper read still covers the full span.
    machine.advance(1_000);
    expect((await machine.sampler()).windowMs).toBe(1_100);
  });

  it("opens a fresh window when the last read is too old to describe now", async () => {
    const machine = fakeMachine(0.2);
    await machine.sampler();
    machine.setShare(0.8);
    machine.advance(60_000);
    const usage = await machine.sampler();
    expect(machine.waits).toEqual([250, 250]);
    // A minute-long average would read 79.95%; the fresh window reads the present.
    expect(usage.overall).toBeCloseTo(80);
    expect(usage.windowMs).toBe(250);
  });

  it("shares one window between reads that arrive while it is open", async () => {
    const machine = fakeMachine(0.5);
    const [a, b] = await Promise.all([machine.sampler(), machine.sampler()]);
    expect(machine.waits).toEqual([250]);
    expect(a).toEqual(b);
  });

  it("reports unavailable rather than guessing when the platform lists no cores", async () => {
    const sampler = createCpuSampler({ read: () => [], now: () => 0, wait: async () => {} });
    expect(await sampler()).toEqual({ overall: null, perCore: [], windowMs: 0 });
  });
});
