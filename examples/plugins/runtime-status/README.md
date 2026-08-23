# runtime status example plugin

this is the minimal trusted local plugin package used to prove the package lifecycle. plugins run in the server process with the server's full permissions, so only install code you trust.

copy this directory into the active environment's plugin directory:

```text
<active-environment>/userdata/plugins/com.t3code.runtime-status-example
```

for a normal local install, `<active-environment>` is usually `~/.t3`. development servers use the worktree's `.t3` directory, and an explicit `T3CODE_HOME` or `--base-dir` uses that configured directory.

t3 code discovers the package without a rebuild. use `pluginPackages.status` to inspect it and `pluginPackages.enable` with the manifest id to enable it for that environment. `pluginPackages.reload` re-evaluates the entrypoint, and `pluginPackages.disable` removes its contributions. once enabled, `example.runtime-status` appears in the web and desktop command palettes.

local packages run in the server process and are fully trusted. marketplace distribution, signing, sandboxing, and renderer code are not part of this mvp.
