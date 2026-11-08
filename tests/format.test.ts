import { describe, expect, it } from "vitest";
import { formatCores, formatLoad } from "../shared/format";

describe("formatLoad", () => {
  it("keeps two decimals for the loads a quiet machine shows", () => {
    expect(formatLoad(2.3125)).toBe("2.31");
  });

  it("drops decimals as the number grows, so a swamped machine reads cleanly", () => {
    expect(formatLoad(42.36)).toBe("42.4");
    // Read off this machine on 2026-11-08: 659.41 on 8 cores.
    expect(formatLoad(659.40771484375)).toBe("659");
  });

  it("shows a dash for a value that cannot be a load", () => {
    expect(formatLoad(Number.NaN)).toBe("—");
    expect(formatLoad(-1)).toBe("—");
  });
});

describe("formatCores", () => {
  it("reads ps %CPU as cores", () => {
    expect(formatCores(107.4)).toBe("1.1 cores");
    expect(formatCores(100)).toBe("1.0 core");
    expect(formatCores(2.3)).toBe("0.0 cores");
  });
});
