# @browser-agent-os/host-bun

Bun host: dev server + test scaffolding for the browser-agent-os kernel.

- `src/app.ts` — `Bun.serve` composition root for the dev server
- `src/server.ts` — pure HTTP function that serves coreutils binaries from `packages/coreutils/zig-out/bin/`
- `src/workers.ts` — adapts Bun's web-Worker to the kernel's `MessagingWorker` interface
- `test/echo.test.ts` — single-process: kernel spawns `echo.wasm`, asserts captured stdout
- `test/pipe.contract.ts` — shared contract suite parameterised over a `(kernel, transport)` pair
- `test/pipe.atomics.test.ts` — runs the contract under `AtomicsTransport` directly in Bun
- `test/jspi/worker.mjs` — Node `worker_threads` entry that wires `bootJspiRunner` to `parentPort`
- `test/jspi/runner.mjs` — Node main; hosts `JSPITransport` + spawns the contract; emits JSON results to stdout
- `test/pipe.jspi.test.ts` — Bun test: spawns the Node runner via `Bun.spawn` (with `--experimental-wasm-jspi --experimental-transform-types --no-warnings`) and asserts each contract case

## Run

```
mise run dev    # serve on localhost
mise run test   # echo + pipe contract suites under both transports
```
