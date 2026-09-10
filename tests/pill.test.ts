import { describe, expect, it } from "vitest";
import { pillReading } from "../shared/pill";

describe("pillReading", () => {
  it("shows both numbers, because they fail in different ways", () => {
    expect(pillReading(28, 41).text).toBe("28% · 41%");
  });

  it("rounds rather than showing a decimal in a space this small", () => {
    expect(pillReading(28.4, 41.6).text).toBe("28% · 42%");
  });

  it("stays calm when both readings are low", () => {
    expect(pillReading(20, 30).severity).toBe("good");
  });

  it("takes the worse of the two, so one colour can speak for both", () => {
    // CPU is fine, memory is not: the pill still warns.
    expect(pillReading(10, 95).severity).toBe("critical");
    expect(pillReading(95, 10).severity).toBe("critical");
  });

  it("warns on memory earlier than on CPU, since swapping hurts sooner", () => {
    expect(pillReading(75, 0).severity).toBe("warning");
    expect(pillReading(0, 85).severity).toBe("warning");
    expect(pillReading(0, 75).severity).toBe("good");
  });

  it("shows a dash rather than a zero when macOS reports no pressure", () => {
    const reading = pillReading(30, null);
    expect(reading.text).toBe("30% · —");
    expect(reading.severity).toBe("good");
  });

  it("says which number is which where there is room to", () => {
    expect(pillReading(28, 41).label).toBe("Machine load: CPU 28%, memory 41%");
  });
})
