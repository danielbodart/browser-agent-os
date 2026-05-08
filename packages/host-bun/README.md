# @browser-agent-os/host-bun

Bun host: dev server + test scaffolding for the browser-agent-os kernel.

- `src/app.ts` — Bun.serve composition root
- `src/server.ts` — pure HTTP function that serves coreutils binaries from `packages/coreutils/zig-out/bin/`
- `test/echo.test.ts` — end-to-end: kernel spawns echo.wasm in a real Worker, asserts stdout

## Run

```
mise run dev    # serve on localhost
mise run test   # run end-to-end tests
```
