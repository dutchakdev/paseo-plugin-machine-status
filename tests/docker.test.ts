import { describe, expect, it } from "vitest";
import {
  parseContainers,
  parseDockerSize,
  parseImages,
  parseReclaimed,
  parseSystemDf,
} from "../docker.server";

/** Captured verbatim from this machine. */
const PS = `82df267c4414\thl-search-pg\tpostgres:16\trunning\tUp 3 days\t0.0.0.0:5653->5432/tcp, [::]:5653->5432/tcp
80b34c5ac21a\thl-covers-minio\tminio/minio:latest\texited\tExited (0) 4 days ago\t
35dbfab92aa5\tcrm-delivery-test-redis\tvalkey/valkey:8-alpine\trunning\tUp 4 days\t0.0.0.0:6599->6379/tcp, [::]:6599->6379/tcp
`;

const DF = `TYPE            TOTAL     ACTIVE    SIZE      RECLAIMABLE
Images          16        4         5.874GB   3.823GB (65%)
Containers      32        12        9.941MB   9.322MB (93%)
Local Volumes   89        22        21.19GB   15.16GB (71%)
Build Cache     0         0         0B        0B
`;

describe("parseContainers", () => {
  it("reads the published port, not the container port", () => {
    expect(parseContainers(PS)[0].ports).toEqual([5653]);
  });

  it("keeps stopped containers, which is where the reclaimable space is", () => {
    const stopped = parseContainers(PS).filter((container) => !container.running);
    expect(stopped.map((container) => container.name)).toEqual(["hl-covers-minio"]);
  });

  it("keeps Docker's own status wording rather than paraphrasing it", () => {
    expect(parseContainers(PS)[1].status).toBe("Exited (0) 4 days ago");
  });

  it("handles a container with no ports", () => {
    expect(parseContainers(PS)[1].ports).toEqual([]);
  });

  it("ignores blank lines", () => {
    expect(parseContainers("\n\n")).toEqual([]);
  });
});

describe("parseDockerSize", () => {
  it("reads the SI units system df prints", () => {
    expect(parseDockerSize("5.874GB")).toBeCloseTo(5.874e9, 0);
    expect(parseDockerSize("9.941MB")).toBeCloseTo(9.941e6, 0);
  });

  it("reads the binary units stats prints", () => {
    expect(parseDockerSize("31.39MiB")).toBeCloseTo(31.39 * 1024 ** 2, 0);
  });

  it("reads a bare zero", () => {
    expect(parseDockerSize("0B")).toBe(0);
  });

  it("returns zero rather than NaN for something unparseable", () => {
    expect(parseDockerSize("unknown")).toBe(0);
  });
});

describe("parseSystemDf", () => {
  const rows = parseSystemDf(DF);

  it("reads the two-word row label", () => {
    expect(rows.map((row) => row.label)).toEqual([
      "Images",
      "Containers",
      "Local Volumes",
      "Build Cache",
    ]);
  });

  it("separates size from reclaimable", () => {
    const images = rows.find((row) => row.label === "Images");
    expect(images?.sizeBytes).toBeCloseTo(5.874e9, 0);
    expect(images?.reclaimableBytes).toBeCloseTo(3.823e9, 0);
  });

  it("marks volumes as unsafe to reclaim, because they are container data", () => {
    // 15 GB of "reclaimable" volumes on this machine is databases someone wants.
    expect(rows.find((row) => row.label === "Local Volumes")?.safeToReclaim).toBe(false);
    expect(rows.find((row) => row.label === "Images")?.safeToReclaim).toBe(true);
  });

  it("reads the active-of-total counts", () => {
    const containers = rows.find((row) => row.label === "Containers");
    expect(containers).toMatchObject({ total: 32, active: 12 });
  });

  it("skips the header", () => {
    expect(rows.some((row) => row.label === "TYPE")).toBe(false);
  });
});

describe("parseReclaimed", () => {
  it("reads what a prune actually freed", () => {
    expect(parseReclaimed("deleted: sha256:abc\nTotal reclaimed space: 1.234GB\n")).toBeCloseTo(1.234e9, 0);
  });

  it("returns zero when nothing was freed", () => {
    expect(parseReclaimed("Total reclaimed space: 0B")).toBe(0);
    expect(parseReclaimed("")).toBe(0);
  });
});

describe("parseImages", () => {
  /** Captured verbatim from this machine. */
  const IMAGES = `61736dcb7ce8\theylove-admin:ci\t430MB\t3 days ago
3ca86cc6b633\theylove-api:ci\t1.15GB\t3 days ago
aa11bb22cc33\t<none>:<none>\t112MB\t2 weeks ago
`;

  it("reads the reference and size", () => {
    const images = parseImages(IMAGES);
    expect(images[0].reference).toBe("heylove-admin:ci");
    expect(images[1].sizeBytes).toBeCloseTo(1.15e9, 0);
  });

  it("marks an untagged image as dangling, which is what prune targets", () => {
    const images = parseImages(IMAGES);
    expect(images[2].dangling).toBe(true);
    expect(images[0].dangling).toBe(false);
  });

  it("keeps the human age Docker prints rather than reformatting it", () => {
    expect(parseImages(IMAGES)[0].created).toBe("3 days ago");
  });

  it("ignores blank lines", () => {
    expect(parseImages("\n\n")).toEqual([]);
  });
});
