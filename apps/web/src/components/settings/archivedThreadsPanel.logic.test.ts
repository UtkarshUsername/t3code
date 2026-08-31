import { describe, expect, it } from "vite-plus/test";
import {
  archivedThreadDateSectionLabel,
  archivedThreadKey,
  filterAndSortArchivedThreads,
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
    expect(archivedThreadDateSectionLabel(isoDate, now)).toBe(label);
  });
});
