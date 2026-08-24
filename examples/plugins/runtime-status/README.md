# runtime status example plugin

this is the minimal trusted local plugin package used to prove the package lifecycle. plugins run in the server process with the server's full permissions, so only install code you trust.

copy this directory into the active environment's plugin directory:

```text
<active-environment>/userdata/plugins/com.t3code.runtime-status-example
```

for a normal local install, `<active-environment>` is usually `~/.t3`. development servers use the worktree's `.t3` directory, and an explicit `T3CODE_HOME` or `--base-dir` uses that configured directory.

t3 code discovers the package without a rebuild. use `pluginPackages.status` to inspect it and `pluginPackages.enable` with the manifest id to enable it for that environment. enabling a plugin grants the host permissions currently declared in its manifest. a reload that adds permissions is rejected until the plugin is disabled and enabled again. `pluginPackages.reload` re-evaluates the entrypoint, and `pluginPackages.disable` removes its contributions. once enabled, `example.runtime-status` appears in the web and desktop command palettes.

## host capabilities and plugin-owned data

manifest permissions are explicit, bounded grants:

- `settings:read-write`, `state:read-write`, and `cache:read-write` expose detached JSON key/value stores.
- `secrets:<name>` exposes one plugin-namespaced secret.
- `filesystem:data` exposes text files under the plugin's own data directory and rejects traversal and symlink escapes.
- `network:https://host` allows text responses from one HTTPS origin.
- `process:<command>` allows one exact executable name with no shell, a minimal environment, timeout, and output limits.

plugin data lives under the active environment's `plugin-data/<plugin-id>/` directory. settings and state survive reloads and restarts. cache is separately clearable. secrets use the server secret store and never share names with another plugin.

host operations return Effect values. command handlers may return those values directly and compose them with `api.effect.succeed`, `api.effect.map`, and `api.effect.flatMap`. synchronous and Promise handlers remain supported.

plugins run in supervised subprocesses with typed host transport, bounded protocol output, invocation deadlines, a V8 heap limit, crash detection, and automatic restart. failed replacement activation keeps the previous worker and command generation live.

workers still run as the same OS user as the environment server. process isolation prevents a plugin crash or `process.exit()` from stopping t3 code, but it is not a hostile-code filesystem sandbox. only install code you trust.

local packages are fully trusted. marketplace distribution, signing, OS-level sandboxing, and renderer code are not part of this mvp.
