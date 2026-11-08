import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { alignCoreKinds, parseCoreKinds } from "../server/cpu";
import { coreBalance } from "../shared/cores";

/** `ioreg -rd1 -c IOPlatformDevice -k cluster-type` on an M1 Pro, 2026-11-08, unedited. */
const IOREG = readFileSync(path.join(__dirname, "fixtures", "ioreg-cpus-m1pro.txt"), "utf8");

describe("parseCoreKinds", () => {
  it("reads each core's cluster type by its logical id", () => {
    const kinds = parseCoreKinds(IOREG);
    expect(kinds.size).toBe(8);
    expect([0, 1].map((id) => kinds.get(id))).toEqual(["efficiency", "efficiency"]);
    expect([2, 3, 4, 5, 6, 7].every((id) => kinds.get(id) === "performance")).toBe(true);
  });

  it("agrees with sysctl's own count of 6 performance and 2 efficiency cores", () => {
    const values = [...parseCoreKinds(IOREG).values()];
    expect(values.filter((kind) => kind === "performance")).toHaveLength(6);
    expect(values.filter((kind) => kind === "efficiency")).toHaveLength(2);
  });

  it("finds nothing on a machine without clusters, such as an Intel Mac", () => {
    expect(parseCoreKinds("").size).toBe(0);
    expect(parseCoreKinds('+-o cpu0@0  <class IOPlatformDevice>\n    {\n      "logical-cpu-id" = 0\n    }\n').size).toBe(0);
  });
});

describe("alignCoreKinds", () => {
  const kinds = parseCoreKinds(IOREG);

  it("labels the cores in the order os.cpus() lists them", () => {
    expect(alignCoreKinds(kinds, 8)).toEqual([
      "efficiency", "efficiency", "performance", "performance",
      "performance", "performance", "performance", "performance",
    ]);
  });

  it("labels nothing when the counts disagree, rather than shifting every label", () => {
    expect(alignCoreKinds(kinds, 10)).toEqual(new Array(10).fill(null));
  });
});

describe("coreBalance", () => {
  const P = "performance" as const;
  const E = "efficiency" as const;

  it("spots one pinned core on an otherwise quiet machine: single-threaded work", () => {
    const balance = coreBalance([5, 4, 100, 3, 2, 6, 4, 3], [E, E, P, P, P, P, P, P]);
    expect(balance.verdict).toBe("serial");
    expect(balance.busiest).toEqual({ index: 2, percent: 100, kind: P });
  });

  it("calls it saturated when every core is busy, as on 2026-11-08", () => {
    expect(coreBalance([51.5, 49, 98, 90.9, 91, 74.7, 83, 70.4], [E, E, P, P, P, P, P, P]).verdict).toBe("busy");
    expect(coreBalance([99, 98, 100, 97, 99, 100, 98, 99], []).verdict).toBe("saturated");
  });

  it("tells background work on the efficiency cores from a single-threaded bottleneck", () => {
    expect(coreBalance([95, 97, 10, 12, 8, 9, 11, 10], [E, E, P, P, P, P, P, P]).verdict).toBe("background");
    expect(coreBalance([95, 97, 10, 12, 8, 9, 11, 10], []).verdict).toBe("serial");
  });

  it("calls an even, moderate load spread", () => {
    expect(coreBalance([30, 35, 40, 38, 33, 36, 31, 37], []).verdict).toBe("spread");
  });

  it("calls a quiet machine idle", () => {
    expect(coreBalance([2, 1, 3, 0, 1, 2, 1, 0], []).verdict).toBe("idle");
  });

  it("counts cores by kind when the kinds are known", () => {
    const balance = coreBalance([90, 92, 10, 12, 8, 9, 11, 10], [E, E, P, P, P, P, P, P]);
    expect(balance.byKind).toEqual({
      efficiency: { cores: 2, percent: 91 },
      performance: { cores: 6, percent: 10 },
    });
  });

  it("ignores cores with no reading and says nothing about an empty list", () => {
    expect(coreBalance([null, 50], []).busiest?.index).toBe(1);
    expect(coreBalance([], []).verdict).toBe("unknown");
  });
});
