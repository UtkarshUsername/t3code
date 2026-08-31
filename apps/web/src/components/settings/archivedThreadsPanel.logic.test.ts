import { describe, expect, it } from "vite-plus/test";
import {
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
