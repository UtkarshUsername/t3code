import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
  ProjectId,
  ScopedProjectRef,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentThreadShell } from "./models.ts";
import { scopeThreadShell } from "./models.ts";
import type { EnvironmentCatalogState } from "./connections.ts";
import {
  arrayElementsEqual,
  parseProjectRefCollectionKey,
  parseThreadKey,
  projectRefCollectionKey,
  threadKey,
  threadRefsEqual,
} from "./entities.ts";

const EMPTY_THREADS: ReadonlyArray<OrchestrationThreadShell> = Object.freeze([]);
const EMPTY_SCOPED_THREAD_REFS: ReadonlyArray<ScopedThreadRef> = Object.freeze([]);
const EMPTY_THREAD_INDEX: ReadonlyMap<ThreadId, OrchestrationThreadShell> = new Map();
const EMPTY_THREAD_REFS_BY_PROJECT: ReadonlyMap<
  ProjectId,
  ReadonlyArray<ScopedThreadRef>
> = new Map();

// Single fridge note for rename optimism. Every shell reader shadows through
// it, so sidebar rows, search, header, and dialogs all show the just-committed
// title without per surface plumbing. Chain tracks every committed title from
// the baseline through the final value so an intermediate store frame (A -> B
// -> C) does not flash B. Entry retires when the store reaches the final
// title or leaves the chain (racing regeneration).
export type OptimisticThreadTitle = {
  readonly title: string;
  readonly baseline: string;
  readonly chain: ReadonlyArray<string>;
};

export function nextOptimisticThreadTitles(
  current: ReadonlyMap<string, OptimisticThreadTitle>,
  key: string,
  title: string,
  displayedTitle: string,
): ReadonlyMap<string, OptimisticThreadTitle> {
  const existing = current.get(key);
  const chain = existing ? [...existing.chain, title] : [displayedTitle, title];
  const baseline = chain[0] ?? displayedTitle;
  const next = new Map(current);
  next.set(key, { title, baseline, chain });
  return next;
}

export function withoutOptimisticThreadTitle(
  current: ReadonlyMap<string, OptimisticThreadTitle>,
  key: string,
  title: string,
): ReadonlyMap<string, OptimisticThreadTitle> {
  if (current.get(key)?.title !== title) return current;
  const next = new Map(current);
  next.delete(key);
  return next;
}

export function createEnvironmentThreadShellAtoms(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly snapshotAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<OrchestrationShellSnapshot | null>;
}) {
  const environmentThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationThreadShell> =>
        get(input.snapshotAtom(environmentId))?.threads ?? EMPTY_THREADS,
    ).pipe(Atom.withLabel(`environment-threads:${environmentId}`)),
  );

  const environmentThreadIndexAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): ReadonlyMap<ThreadId, OrchestrationThreadShell> => {
      const threads = get(environmentThreadsAtom(environmentId));
      if (threads.length === 0) {
        return EMPTY_THREAD_INDEX;
      }
      return new Map(threads.map((thread) => [thread.id, thread] as const));
    }).pipe(Atom.withLabel(`environment-thread-index:${environmentId}`)),
  );

  const rawOptimisticTitlesAtom = Atom.make<ReadonlyMap<string, OptimisticThreadTitle>>(
    new Map(),
  ).pipe(Atom.withLabel("optimistic-thread-titles:raw"));

  // Filter out entries that have fulfilled (store reached final title) or
  // diverged (store left the chain via regenerate-title or another client).
  // Derived view hides stale entries immediately, and schedules a write-back
  // so the raw map is actually pruned. Without the write-back a later store
  // title that re-enters the chain (e.g. another client renaming back to the
  // baseline) would revive a stale optimistic value.
  const filteredOptimisticTitlesAtom = Atom.make(
    (get): ReadonlyMap<string, OptimisticThreadTitle> => {
      const raw = get(rawOptimisticTitlesAtom);
      if (raw.size === 0) return raw;
      let pruned: Map<string, OptimisticThreadTitle> | null = null;
      for (const [key, entry] of raw) {
        const ref = parseThreadKey(key);
        const source = get(environmentThreadIndexAtom(ref.environmentId)).get(ref.threadId);
        if (source === undefined) {
          pruned ??= new Map(raw);
          pruned.delete(key);
          continue;
        }
        const chain = entry.chain ?? [entry.baseline, entry.title];
        if (!chain.includes(source.title) || source.title === entry.title) {
          pruned ??= new Map(raw);
          pruned.delete(key);
        }
      }
      if (pruned !== null) {
        const { registry } = get;
        const next = pruned;
        queueMicrotask(() => registry.set(rawOptimisticTitlesAtom, next));
        return pruned;
      }
      return raw;
    },
  ).pipe(Atom.withLabel("optimistic-thread-titles:filtered"));

  const optimisticTitlesAtom = Atom.writable(
    (get) => get(filteredOptimisticTitlesAtom),
    (ctx, value: ReadonlyMap<string, OptimisticThreadTitle>) =>
      ctx.set(rawOptimisticTitlesAtom, value),
  ).pipe(Atom.withLabel("optimistic-thread-titles"));

  // Named helpers so call sites do not duplicate registry plumbing.
  const setOptimisticThreadTitle = (
    registry: { get: (a: Atom.Atom<any>) => any; set: (a: any, v: any) => void },
    key: string,
    title: string,
    displayedTitle: string,
  ): void => {
    const current = registry.get(optimisticTitlesAtom) as ReadonlyMap<
      string,
      OptimisticThreadTitle
    >;
    registry.set(
      optimisticTitlesAtom,
      nextOptimisticThreadTitles(current, key, title, displayedTitle),
    );
  };

  const clearOptimisticThreadTitle = (
    registry: { get: (a: Atom.Atom<any>) => any; set: (a: any, v: any) => void },
    key: string,
    title: string,
  ): void => {
    const current = registry.get(optimisticTitlesAtom) as ReadonlyMap<
      string,
      OptimisticThreadTitle
    >;
    registry.set(optimisticTitlesAtom, withoutOptimisticThreadTitle(current, key, title));
  };

  const environmentThreadRefsAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyArray<ScopedThreadRef> = [];
    return Atom.make((get) => {
      const next = get(environmentThreadsAtom(environmentId)).map((thread) => ({
        environmentId,
        threadId: thread.id,
      }));
      if (threadRefsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return next;
    }).pipe(Atom.withLabel(`environment-thread-refs:${environmentId}`));
  });

  const environmentThreadRefsByProjectAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: ReadonlyMap<
      ProjectId,
      ReadonlyArray<ScopedThreadRef>
    > = EMPTY_THREAD_REFS_BY_PROJECT;
    return Atom.make((get) => {
      const grouped = new Map<ProjectId, ScopedThreadRef[]>();
      for (const thread of get(environmentThreadsAtom(environmentId))) {
        const refs = grouped.get(thread.projectId);
        const ref = { environmentId, threadId: thread.id };
        if (refs === undefined) {
          grouped.set(thread.projectId, [ref]);
        } else {
          refs.push(ref);
        }
      }
      if (grouped.size === 0) {
        previous = EMPTY_THREAD_REFS_BY_PROJECT;
        return previous;
      }
      const next = new Map<ProjectId, ReadonlyArray<ScopedThreadRef>>();
      for (const [projectId, refs] of grouped) {
        const previousRefs = previous.get(projectId);
        next.set(
          projectId,
          previousRefs !== undefined && threadRefsEqual(previousRefs, refs) ? previousRefs : refs,
        );
      }
      previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-thread-refs-by-project:${environmentId}`));
  });

  const threadShellAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previousSource: OrchestrationThreadShell | null = null;
    let previousOptimisticTitle: string | undefined = undefined;
    let previousOptimisticBaseline: string | undefined = undefined;
    let previousOptimisticChain: ReadonlyArray<string> | undefined = undefined;
    let previousValue: EnvironmentThreadShell | null = null;
    return Atom.make((get) => {
      const source = get(environmentThreadIndexAtom(ref.environmentId)).get(ref.threadId) ?? null;
      const optimistic = get(optimisticTitlesAtom).get(key);
      const chain = optimistic?.chain;
      if (
        source === previousSource &&
        optimistic?.title === previousOptimisticTitle &&
        optimistic?.baseline === previousOptimisticBaseline &&
        chain === previousOptimisticChain
      ) {
        return previousValue;
      }
      previousSource = source;
      previousOptimisticTitle = optimistic?.title;
      previousOptimisticBaseline = optimistic?.baseline;
      previousOptimisticChain = chain;
      if (source === null) {
        previousValue = null;
      } else if (optimistic !== undefined) {
        // Filtered view guarantees this entry is still pending or
        // is an intermediate of a chained rename (A->B->C while store
        // still at A or B). Show the final title.
        previousValue = scopeThreadShell(ref.environmentId, {
          ...source,
          title: optimistic.title,
        });
      } else {
        previousValue = scopeThreadShell(ref.environmentId, source);
      }
      return previousValue;
    }).pipe(Atom.withLabel(`environment-thread-shell:${key}`));
  });

  const threadShellsForProjectRefsAtomFamily = Atom.family((key: string) => {
    const projectRefs = parseProjectRefCollectionKey(key);
    let previous: ReadonlyArray<EnvironmentThreadShell> = [];
    return Atom.make((get) => {
      const next: EnvironmentThreadShell[] = [];
      const seen = new Set<string>();
      for (const projectRef of projectRefs) {
        const refs =
          get(environmentThreadRefsByProjectAtom(projectRef.environmentId)).get(
            projectRef.projectId,
          ) ?? EMPTY_SCOPED_THREAD_REFS;
        for (const ref of refs) {
          const key = threadKey(ref);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          const thread = get(threadShellAtomFamily(key));
          if (thread !== null) {
            next.push(thread);
          }
        }
      }
      if (arrayElementsEqual(previous, next)) {
        return previous;
      }
      previous = next;
      return previous;
    }).pipe(Atom.withLabel(`environment-thread-shells-for-projects:${key}`));
  });

  let previousThreadRefs: ReadonlyArray<ScopedThreadRef> = [];
  const threadRefsAtom = Atom.make((get) => {
    const refs: ScopedThreadRef[] = [];
    for (const environmentId of get(input.catalogValueAtom).entries.keys()) {
      refs.push(...get(environmentThreadRefsAtom(environmentId)));
    }
    if (threadRefsEqual(previousThreadRefs, refs)) {
      return previousThreadRefs;
    }
    previousThreadRefs = refs;
    return refs;
  }).pipe(Atom.withLabel("environment-thread-refs"));

  let previousThreadShells: ReadonlyArray<EnvironmentThreadShell> = [];
  const threadShellsAtom = Atom.make((get) => {
    const next = get(threadRefsAtom).flatMap((ref) => {
      const thread = get(threadShellAtomFamily(threadKey(ref)));
      return thread === null ? [] : [thread];
    });
    if (arrayElementsEqual(previousThreadShells, next)) {
      return previousThreadShells;
    }
    previousThreadShells = next;
    return previousThreadShells;
  }).pipe(Atom.withLabel("environment-thread-shell-list"));

  return {
    environmentThreadsAtom,
    environmentThreadIndexAtom,
    environmentThreadRefsAtom,
    environmentThreadRefsByProjectAtom,
    threadRefsAtom,
    threadShellsAtom,
    threadShellsForProjectRefsAtom: (refs: ReadonlyArray<ScopedProjectRef>) =>
      threadShellsForProjectRefsAtomFamily(projectRefCollectionKey(refs)),
    threadShellAtom: (ref: ScopedThreadRef) => threadShellAtomFamily(threadKey(ref)),
    optimisticTitlesAtom,
    setOptimisticThreadTitle,
    clearOptimisticThreadTitle,
  };
}
