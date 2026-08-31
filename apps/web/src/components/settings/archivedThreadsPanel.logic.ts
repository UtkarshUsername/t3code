export type ArchivedThreadSort = "archived-desc" | "archived-asc" | "created-desc";

export interface ArchivedThreadListEntry {
  readonly thread: {
    readonly id: string;
    readonly environmentId: string;
    readonly title: string;
    readonly archivedAt: string | null;
    readonly createdAt: string;
  };
  readonly project: {
    readonly id: string;
    readonly environmentId: string;
    readonly name: string;
    readonly cwd: string;
  };
}

export interface ArchivedThreadListFilters {
  readonly query: string;
  readonly environmentId: string;
  readonly projectKey: string;
  readonly sort: ArchivedThreadSort;
}

export function archivedThreadKey(entry: ArchivedThreadListEntry): string {
  return `${entry.thread.environmentId}:${entry.thread.id}`;
}

export function archivedProjectKey(entry: ArchivedThreadListEntry): string {
  return `${entry.project.environmentId}:${entry.project.id}`;
}

export function filterAndSortArchivedThreads<T extends ArchivedThreadListEntry>(
  entries: readonly T[],
  filters: ArchivedThreadListFilters,
): T[] {
  const query = filters.query.trim().toLocaleLowerCase();
  return entries
    .filter(
      (entry) =>
        (filters.environmentId === "all" || entry.thread.environmentId === filters.environmentId) &&
        (filters.projectKey === "all" || archivedProjectKey(entry) === filters.projectKey) &&
        (!query ||
          entry.thread.title.toLocaleLowerCase().includes(query) ||
          entry.project.name.toLocaleLowerCase().includes(query) ||
          entry.project.cwd.toLocaleLowerCase().includes(query)),
    )
    .toSorted((left, right) => {
      const leftDate =
        filters.sort === "created-desc"
          ? left.thread.createdAt
          : (left.thread.archivedAt ?? left.thread.createdAt);
      const rightDate =
        filters.sort === "created-desc"
          ? right.thread.createdAt
          : (right.thread.archivedAt ?? right.thread.createdAt);
      const direction = filters.sort === "archived-asc" ? 1 : -1;
      return (
        direction * leftDate.localeCompare(rightDate) ||
        right.thread.id.localeCompare(left.thread.id)
      );
    });
}

export function archivedThreadDateSectionLabel(isoDate: string, now = new Date()): string {
  const date = new Date(isoDate);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  if (date >= today) return "Today";
  if (date >= yesterday) return "Yesterday";
  if (date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth()) {
    return "Earlier this month";
  }
  return new Intl.DateTimeFormat(undefined, {
    month: "long",
    year: date.getFullYear() === now.getFullYear() ? undefined : "numeric",
  }).format(date);
}
