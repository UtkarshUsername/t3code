import { describe, expect, it } from "vite-plus/test";
import {
  archivedThreadDateSectionLabel,
  archivedThreadKey,
  filterAndSortArchivedThreads,
  runArchivedThreadBulkAction,
  type ArchivedThreadListEntry,
} from "./archivedThreadsPanel.logic";

const entries = [
  {
    thread: {
      id: "older",
      environmentId: "local",
      title: "Fix reconnect loop",
      archivedAt: "2026-08-01T00:00:00.000Z",
      createdAt: "2026-07-01T00:00:00.000Z",
    },
    project: { id: "t3", environmentId: "local", name: "T3", cwd: "/dev/t3" },
  },
  {
    thread: {
      id: "newer",
      environmentId: "remote",
      title: "Pair mobile client",
      archivedAt: "2026-08-20T00:00:00.000Z",
      createdAt: "2026-06-01T00:00:00.000Z",
    },
    project: { id: "mobile", environmentId: "remote", name: "Mobile", cwd: "/dev/mobile" },
  },
] satisfies ArchivedThreadListEntry[];

describe("filterAndSortArchivedThreads", () => {
  it("searches thread, project, and workspace text", () => {
    for (const query of ["reconnect", "t3", "/dev/t3"]) {
      expect(
        filterAndSortArchivedThreads(entries, {
          query,
          environmentId: "all",
          projectKey: "all",
          sort: "archived-desc",
        }).map(archivedThreadKey),
      ).toEqual(["local:older"]);
    }
  });

  it("combines environment and project filters", () => {
    expect(
      filterAndSortArchivedThreads(entries, {
        query: "",
        environmentId: "remote",
        projectKey: "remote:mobile",
        sort: "archived-desc",
      }).map(archivedThreadKey),
    ).toEqual(["remote:newer"]);
  });

  it("supports archive and creation date ordering", () => {
    const keysFor = (sort: "archived-desc" | "archived-asc" | "created-desc") =>
      filterAndSortArchivedThreads(entries, {
        query: "",
        environmentId: "all",
        projectKey: "all",
        sort,
      }).map(archivedThreadKey);

    expect(keysFor("archived-desc")).toEqual(["remote:newer", "local:older"]);
    expect(keysFor("archived-asc")).toEqual(["local:older", "remote:newer"]);
    expect(keysFor("created-desc")).toEqual(["local:older", "remote:newer"]);
  });

  it("orders timestamps by instant when offsets differ", () => {
    const withOffsets = entries.map((entry, index) => ({
      ...entry,
      thread: {
        ...entry.thread,
        archivedAt: index === 0 ? "2026-08-20T01:00:00+02:00" : "2026-08-20T00:00:00.000Z",
      },
    }));
    expect(
      filterAndSortArchivedThreads(withOffsets, {
        query: "",
        environmentId: "all",
        projectKey: "all",
        sort: "archived-desc",
      }).map(archivedThreadKey),
    ).toEqual(["remote:newer", "local:older"]);
  });
});

describe("runArchivedThreadBulkAction", () => {
  it("bounds concurrency and reports failures", async () => {
    let active = 0;
    let peak = 0;
    const result = await runArchivedThreadBulkAction({
      entries: [1, 2, 3, 4, 5],
      concurrency: 2,
      isCancelled: () => false,
      action: async (entry) => {
        active += 1;
        peak = Math.max(peak, active);
        await Promise.resolve();
        active -= 1;
        return entry !== 3;
      },
    });

    expect(peak).toBe(2);
    expect(result).toEqual({ completedCount: 5, failedCount: 1, cancelled: false });
  });

  it("stops scheduling work after cancellation", async () => {
    let completed = 0;
    const result = await runArchivedThreadBulkAction({
      entries: [1, 2, 3, 4],
      concurrency: 1,
      isCancelled: () => completed === 2,
      action: async () => {
        completed += 1;
        return true;
      },
    });

    expect(result).toEqual({ completedCount: 2, failedCount: 0, cancelled: true });
  });
});

describe("archivedThreadDateSectionLabel", () => {
  const now = new Date(2026, 8, 20, 12);

  it.each([
    [new Date(2026, 8, 20, 1).toISOString(), "Today"],
    [new Date(2026, 8, 19, 1).toISOString(), "Yesterday"],
    [new Date(2026, 8, 2, 1).toISOString(), "Earlier this month"],
    [new Date(2026, 7, 31, 1).toISOString(), "August"],
    [new Date(2025, 11, 1, 1).toISOString(), "December 2025"],
  ])("groups %s under %s", (isoDate, label) => {
    expect(archivedThreadDateSectionLabel(isoDate, now, "en-US")).toBe(label);
  });

  it("does not group future timestamps under Today", () => {
    expect(
      archivedThreadDateSectionLabel(new Date(2026, 8, 21, 1).toISOString(), now, "en-US"),
    ).toBe("September 21");
  });
});
