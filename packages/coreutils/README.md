# @browser-agent-os/coreutils

Zig source for small WASI binaries (`echo`, future: `cat`, `ls`, `pwd`, ...). Built to `wasm32-wasi`. Runs as guest processes inside the kernel.

## Build

```
mise run build:coreutils
```

Outputs:

```
zig-out/bin/echo.wasm
```

## Add a new binary

1. `mkdir packages/coreutils/src/<name> && touch packages/coreutils/src/<name>/main.zig`
2. Append `.{ .name = "<name>" }` to `bins` in `build.zig`.
3. `mise run build:coreutils`.
