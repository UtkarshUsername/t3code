# plugin runtime

internal effect service for t3 product plugins.

it uses a deterministic, stack-safe reconciliation planner and one effect child scope per active plugin. `PluginRuntime` is provided through `layer()`, so the composing effect scope owns shutdown. updates stage changed plugins and their dependents, publish contributions atomically, and roll back without replacing the live composition when activation fails.

cordis is not a dependency. a pure-only executor was rejected because plugin lifetimes and async cleanup should be owned by effect scopes.

## dependencies

`requires` capabilities block activation when no active provider exists. `optional` capabilities order an available provider before the consumer but do not block activation when absent; optional edges that would create a cycle are ignored deterministically. required cycles and duplicate capability providers reject before publication.

activation code reads required capabilities with `resolve(...)` and optional capabilities with `resolveOptional(...)`. undeclared access fails activation. changing, adding, or removing a provider restarts its required and optional dependents while unrelated plugin scopes remain live.

## contributions

plugins register detached, deeply frozen, json-compatible declarative metadata and an optional host-only live value. snapshots and `contributions(slot)` expose only frozen metadata. executable values never cross the rpc boundary.

`contributions(slot)` returns the committed generation with its entries. hosts must pass that generation to `useContribution(...)`; stale callers fail instead of invoking a handler from a different composition. invocation, reconciliation, and shutdown share the same transition authority, so a plugin scope cannot retire while its contribution is running.

contribution ids are unique within each slot across the active composition. duplicate ids fail candidate validation and leave the previous generation live.
