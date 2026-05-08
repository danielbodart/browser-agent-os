# Roadmap

Build-up ordering. Each stage adds one capability that later stages depend on. Browser host (xterm.js) is intentionally late — it's the surface, not the substrate. Cloudflare lives near the end as the natural "firmware shelf" once the kernel is mature.

Each stage names the **goal**, the **deliverables** (concrete files / binaries / artefacts), the **acceptance test** (a check that proves it's done), and **open questions** to resolve when we pick that stage up.

When a stage closes, mark it `[done]` here and move its open questions into the next stage's prompt or close them out as resolved.

---

## Stage 0 — `[done]` MVP echo

**Goal:** Prove the spine end-to-end: kernel spawns a Web Worker, Worker fetches a `wasm32-wasi` binary, instantiates with our preview-1 shim, runs `echo`, returns stdout + exit code.

**Deliverables:**
- `packages/kernel/` (env-agnostic) with `LocalKernel`, `application(deps)` yadic factory, WASI shim in `worker/runner.ts`
- `packages/host-bun/` with pure `Http` server + `Bun.serve` entry + 3-case echo test
- `packages/coreutils/` Zig pkg with `echo` binary + `build.zig` enumerating bins
- `scripts/wasm-opt.ts` Binaryen pipeline
- `mise.toml` task chain: `build:coreutils` → `optimize:coreutils` → `build:bins`, `check`, `test`, `dev`, `clean`

**Acceptance:** `mise run test` — 3 echo cases pass against a real Web Worker.

---

## Stage 1 — `[done]` Pipes + JSPI transport

**Goal:** Real concurrent inter-process pipes. `a | b` runs `a` and `b` as separate Workers with a kernel-resident bounded byte buffer between them. Producer's `fd_write` blocks when buffer full; consumer's `fd_read` blocks when empty. Mirrors POSIX semantics; no tmpfile shims.

This is the stage that forces the JSPI question because `fd_write` and `fd_read` must return synchronously to WASM but the operation is async (waits on the other worker).

**What landed:**
- `packages/kernel/src/transport/Transport.ts` — interface; allocates pipes, drains read ends, spawns guest workers
- `packages/kernel/src/transport/JSPITransport.ts` — kernel-resident `JsPipeBuffer`; worker RPCs back via `WebAssembly.Suspending` / `WebAssembly.promising`
- `packages/kernel/src/transport/AtomicsTransport.ts` — `SharedArrayBuffer` ring buffer; workers operate on same SAB with `Atomics.wait` / `notify`; kernel main thread uses `Atomics.waitAsync`
- `packages/kernel/src/pipe/PipeBuffer.ts` + `AtomicsPipeBuffer.ts` — 64 KiB capacity by default
- `packages/kernel/src/worker/runner.atomics.ts` — Bun web-Worker runner with sync `Atomics.wait` syscalls
- `packages/kernel/src/worker/jspi.ts` — env-agnostic JSPI runner (consumed by `host-bun/test/jspi/worker.mjs` for Node)
- `Kernel.pipe()` + `Kernel.spawn(binary, args, env, fds)` — lower-level substrate; no `spawnPipeline` invented (callers compose directly, matching what `browser_agent_os_ext::spawn` will expose to guests in Stage 4)
- `packages/coreutils/src/cat/` — stdin → stdout
- `packages/host-bun/test/pipe.contract.ts` — shared scenarios; consumed by `pipe.atomics.test.ts` (in-process Bun) and the Node subprocess `jspi/runner.mjs` (spawned via `Bun.spawn` with `--experimental-wasm-jspi --experimental-transform-types`)

**Acceptance — verified:**
- `echo hello | cat` produces `hello\n` (both transports)
- Backpressure: 128 KiB write to a pipe with no consumer blocks the producer; buffer pegs at capacity; spawning `cat` drains and lets producer finish (both transports)
- Same `CONTRACT_CASES` array is green against `AtomicsTransport` (in Bun) and `JSPITransport` (Node subprocess)

**Open questions — resolved:**
- *Node module-loading flags:* `--experimental-wasm-jspi` cannot be set per-worker (rejected by `worker_threads`); set it on the parent Node process and workers inherit. `--experimental-transform-types` (parent + workers) handles parameter-property TS syntax that bare strip-types rejects. `--no-warnings` silences the `ExperimentalWarning` noise.
- *Where the `PipeBuffer` lives:* `JsPipeBuffer` lives in the kernel main thread (workers RPC into it via Suspending). `AtomicsPipeBuffer` lives in shared memory; both kernel and workers touch the same SAB — kernel main thread uses `waitAsync`, workers use sync `wait`.
- *Capacity:* 64 KiB matches the roadmap target; exposed as `DEFAULT_PIPE_CAPACITY`.
- *EOF model:* implicit close-on-writer-`proc_exit`. `LocalKernel.spawn` iterates the merged FdMap on worker exit and calls `transport.closeWriteEnd(end)` for every write end; consumers then observe a 0-byte read.

---

## Stage 2 — Filesystem abstraction + memory FS

**Goal:** Introduce the `FileSystem` interface and a `MemoryFs` implementation. Kernel can serve `path_open`, `fd_read`, `fd_write`, `fd_filestat_get`, `fd_close` against it. Coreutils can read files. Still no OPFS.

**Deliverables:**
- `packages/kernel/src/fs/FileSystem.ts` — interface (open, read, write, stat, close)
- `packages/kernel/src/fs/MemoryFs.ts` — in-process tree of files/dirs, no async
- `packages/kernel/src/fs/Path.ts` — resolution, normalisation, no symlinks
- WASI shim wires `path_open` / `fd_*` through `FileSystem`
- New coreutils binary: `cat <file>` reads a path
- `Application.ts` accepts `fs` as a dependency

**Acceptance:**
- `kernel.spawn('cat', ['/tmp/hello.txt'])` after `fs.write('/tmp/hello.txt', 'hi\n')` returns stdout `hi\n`.
- `cat` of a missing file produces `cat: /no.txt: No such file or directory` to stderr and exit code 1.

**Open questions:**
- Preopens: do we expose `/` directly, or follow WASI convention with `/` mapped to fd 3? Probably 3.
- Permission rights bitmask — start permissive (all rights) and tighten later, or start strict?

---

## Stage 3 — OPFS filesystem (browser-only)

**Goal:** Second `FileSystem` implementation backed by OPFS sync access handles. Same contract tests must pass against both `MemoryFs` and `OpfsFs`.

**Deliverables:**
- `packages/kernel/src/fs/OpfsFs.ts` — opens `FileSystemSyncAccessHandle` per file (sync ops in Worker after async open)
- File handle cache + LRU close policy (sync handles hold an exclusive lock)
- Browser-only test runner that mounts `OpfsFs` and runs the contract suite (this is where the browser host scaffolding starts to materialise — see Stage 5)
- Persistence: a write that exits should be visible across spawns

**Acceptance:**
- Same contract test suite from Stage 2 passes against `OpfsFs` in headless Chrome (Playwright spawned as a Node subprocess from Bun tests).
- After-write-then-respawn: write a file in process A, spawn process B that reads it, content matches.

**Open questions:**
- Sync handle lifecycle: open per `path_open`, close per `fd_close`, or pool? Pool likely needed because the cost of `getFileHandle` + `createSyncAccessHandle` is non-trivial.
- Concurrent access: WASI semantics allow multiple fds to one file; OPFS default `readwrite` mode is exclusive. Use `readwrite-unsafe` for shared writes, or serialise through the kernel?
- Where do we store inode numbers / metadata if we want them? jswasi uses an IndexedDB sidecar — we said we want to avoid that. Decide whether `fd_filestat_get` returning inode `0` is acceptable.

---

## Stage 4 — Shell binary + spawn extension

**Goal:** A real Zig shell running as a guest binary. Reads commands from stdin, parses, looks up binaries on `PATH`, spawns children, waits, reports exit codes. No pipes at the shell level yet (kernel-level pipes already exist from Stage 1; shell will wire them up in a follow-up).

**Deliverables:**
- `packages/shell/` — single-binary Zig package, `bin/sh.wasm`
- `packages/kernel/src/ext/BrowserAgentOsExt.ts` — clean import namespace `browser_agent_os_ext` with `spawn(path_ptr, path_len, argv_ptr, argv_len, env_ptr, env_len, fds_ptr, fds_len, pid_out_ptr) -> errno`
- WASI shim in `worker/runner.ts` exposes `browser_agent_os_ext` alongside `wasi_snapshot_preview1`
- Zig FFI in `packages/shell/` for the spawn import
- Builtins: `cd`, `pwd`, `exit`, `export`. Everything else looked up on `PATH`
- `kernel.spawn('sh', [], {PATH: '/bin'})` runs interactively over stdin/stdout connected to test fixture

**Acceptance:**
- Shell test: feed `echo hello\nexit\n` on stdin, capture `hello\n` on stdout, exit code 0.
- Shell pipeline test: feed `echo hello | cat\nexit\n`, get `hello\n`. (Requires shell to call `browser_agent_os_ext::spawn` twice with a pipe pair connecting them.)

**Open questions:**
- How does the shell pass redirect/pipe fds to spawn? Define the `fds` array shape: `[{src_fd, dst_fd}, ...]`?
- Job control / Ctrl-C: skip for now? `proc_kill` extension later?
- Shell parser scope: simple word splitting + `|` + `>` `<` redirects, or skip redirects until later?

---

## Stage 5 — Browser host package

**Goal:** Make the kernel run in a real browser tab with xterm.js. Until now everything ran in Bun + Node subprocess.

**Deliverables:**
- `packages/host-browser/` — composition root for the browser
- `index.html` mounting xterm.js, wiring its input/output to the shell process's stdin/stdout
- `packages/host-browser/src/app.ts` — yadic composition: `JSPITransport` + `OpfsFs` + `Worker` factory pointing at the kernel runner
- Vite or just `Bun.serve` static page from the existing host-bun (decide which)
- COOP/COEP headers if SAB is needed for `AtomicsTransport` fallback (with JSPI as primary, may not be needed)

**Acceptance:**
- `mise run dev` opens `http://localhost:3000` in browser. Terminal renders. `sh` is the foreground process. Typing `echo hello | cat` produces `hello\n` followed by prompt.
- Refresh the page after writing a file in OPFS — file persists.

**Open questions:**
- Bundling: do we ship raw `.ts` to the browser via Bun's transpile, or add a real bundler step? Bun's `Bun.build` probably enough.
- Service worker for COOP/COEP — only needed if `AtomicsTransport` is used as fallback. With JSPI-only deployment, not needed.
- xterm.js dep: `@xterm/xterm` (modern). Add to host-browser only.

---

## Stage 6 — Coreutils growth

**Goal:** Useful set of POSIX-shaped utilities. Driven by what the shell needs in real use.

**Deliverables:** Zig binaries in `packages/coreutils/src/<name>/main.zig`:
- `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `env`, `true`, `false`, `mkdir`, `rmdir`, `rm`, `cp`, `mv`, `touch`

**Acceptance:** Each binary has a test in `packages/host-bun/test/coreutils/<name>.test.ts` exercising at least the happy path and one error case.

**Open questions:**
- Argument parsing: hand-roll per binary, or factor a small `Args` helper module in Zig?
- POSIX flag conformance scope — match GNU coreutils behaviour or stay minimal?

---

## Stage 7 — CI/CD

**Goal:** Every push runs the full pipeline. Releases publish coreutils binaries to a Cloudflare R2 bucket.

**Deliverables:**
- `.github/workflows/ci.yml` — `mise install` → `mise run build` → `mise run test`. Runs on push + PR.
- `.github/workflows/release.yml` — on tag, builds `wasm32-wasi` binaries, uploads to R2 via `cloudflare/wrangler-action` or `aws s3` against the R2 S3-compatible endpoint
- Versioned binary paths: `r2://browser-agent-os-bin/<version>/<name>.wasm`
- `latest/` symlink-equivalent (R2 has no symlinks; use a small JSON manifest)

**Acceptance:**
- Tag `v0.1.0`, GitHub Actions runs, R2 contains `0.1.0/echo.wasm` and `latest/manifest.json`.
- CI run on a deliberately-broken commit fails the build job.

**Open questions:**
- R2 bucket name and region — pick before this stage.
- Wrangler vs S3 SDK for upload — wrangler likely smoother since we're already on Cloudflare.
- Cache headers on R2 objects — `immutable` for versioned paths, `no-cache` for `latest/manifest.json`.

---

## Stage 8 — R2 firmware overlay filesystem

**Goal:** Browser host can run a binary it has never seen before. Kernel's filesystem is now a 3-layer overlay: write layer (OPFS), read-write layer (memory), read-only firmware layer (R2). On first reference the binary is fetched from R2 and cached into OPFS.

**Deliverables:**
- `packages/kernel/src/fs/OverlayFs.ts` — composes N `FileSystem`s with a write-through cache policy
- `packages/kernel/src/fs/RemoteFs.ts` — read-only FS backed by HTTP `fetch` against a manifest; understands `If-None-Match` / `ETag`
- Manifest format: `{ binaries: { [name]: { url: string, sha256: string } } }`
- Browser host's `application(deps)` uses `OverlayFs(OpfsFs, RemoteFs)`
- Cache control: `cache-control: immutable` on versioned R2 paths; manifest re-checked at boot

**Acceptance:**
- Cold cache (clear OPFS + browser cache): `mise run dev` boots, shell prompt appears, type `echo hello`, network panel shows one fetch to R2 for echo, output is `hello\n`. Reload — no R2 fetch (cached in OPFS).
- Manifest update — bump `latest/manifest.json` to point at a new echo, reload, new echo runs without OPFS purge required (because version paths are immutable and the manifest pins the live one).

**Open questions:**
- SHA-256 verification — block execution if mismatch, or warn? Probably block.
- Eviction policy in OPFS cache — none (rely on browser quota), LRU, or version-based?
- Offline mode — what happens when the manifest fetch fails but OPFS has a copy? Use cached, surface a warning.

---

## Stage 9 — Property-based tests

**Goal:** Use `fast-check` to validate kernel invariants that unit tests can't easily cover.

**Deliverables:**
- `packages/kernel/test/property/FdTable.property.test.ts` — properties: never returns same fd to two open calls; freed fds eventually reused; clone is observably independent
- `packages/kernel/test/property/PipeBuffer.property.test.ts` — properties: total bytes written = total bytes read + bytes in buffer; reader never reads past writer; small atomic writes never split
- `packages/kernel/test/property/Path.property.test.ts` — `normalize(normalize(p)) == normalize(p)`; never escapes root via `..`
- `packages/host-bun/test/property/FileSystem.contract.test.ts` — same contract suite parameterised over MemoryFs / OpfsFs (Stage 3) / OverlayFs (Stage 8)

**Acceptance:** `mise run test` includes property suites; each runs ≥ 100 cases per property in ~few seconds.

**Open questions:**
- Default run count vs CI run count — `fc.assert(prop, { numRuns: 100 })` locally, `1000` in CI?
- Stateful property tests for FdTable — use `fc.commands` with model checking?

---

## Stage 10 — Allium specs

**Goal:** Behavioural specifications per package, derived from the test suite that already exists.

**Deliverables:**
- `packages/kernel/.allium/` with specs for `FileSystem`, `Transport`, `PipeBuffer`, `FdTable`
- `packages/coreutils/.allium/` with specs for echo, cat, ls
- CI step: `allium check` on every push

**Acceptance:** Specs match implementation; `allium check` is green; every public interface in `kernel/src/` has a corresponding entity or contract in `.allium/`.

---

## Tail — phase 3 (outline only, plan later)

These are explicitly **not** elaborated yet. They become their own roadmaps once we hit them.

- **Agent binary.** Zig WASI binary acting as an autonomous agent, similar to nullclaw / openclaw. Imports `wasi_snapshot_preview1` for FS and `browser_agent_os_ext` for `fetch` (HTTP requests via the kernel — likely lifted to the WASI preview 2 HTTP shape for portability).
- **WebRTC collaboration.** Multi-tab / multi-user. Following the zero-cast project pattern. Likely a new `Transport` for cross-peer fd plumbing or a new FS layer that syncs via CRDT.
- **Local FS mount.** User picks a real directory via `showDirectoryPicker`. Mounts as another `FileSystem` under e.g. `/mnt/local`. Persistent permissions stored separately (browser doesn't persist them today).

---

## Stage triggers between sessions

When picking up a new context, the next stage's prompt should be:

> Read `docs/ROADMAP.md`. We are starting **Stage N: <name>**. Resolve the open questions in that section, then implement to its acceptance criteria. Mark Stage N `[done]` when its acceptance test passes and update its open questions section to reflect what was decided.

This keeps the plan as the single source of truth and avoids re-litigating decisions across resets.
