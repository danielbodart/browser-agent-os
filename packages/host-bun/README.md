# @browser-agent-os/host-bun

Bun host: dev server + test scaffolding for the browser-agent-os kernel.

- `src/app.ts` — `Bun.serve` composition root for the dev server
- `src/server.ts` — pure HTTP function that serves coreutils binaries from `packages/coreutils/zig-out/bin/`
- `src/workers.ts` — adapts Bun's web-Worker to the kernel's `MessagingWorker` interface
- `test/pipe.contract.ts` — shared pipe contract suite (kernel + transport)
- `test/pipe.test.ts` — runs the pipe contract under `JSPITransport` in-process via Bun.Worker
- `test/fs.contract.ts` — shared FileSystem contract suite
- `test/memoryFs.test.ts` — runs the FS contract against `MemoryFs`
- `test/cat-file.test.ts` — `cat <file>` integration: spawns `cat.wasm` against `MemoryFs`-backed kernel
- `test/opfs/` — browser bundles + Bun-served `index.html` driving the OpfsFs contract in headless Chrome
- `test/opfsFs.test.ts` — Bun test: builds the bundles, serves them, drives Playwright Chrome, asserts the FS contract + a persistence-across-respawn case

## Run

```
mise run dev    # serve on localhost
mise run test   # full suite
```
