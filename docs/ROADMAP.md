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
- `packages/kernel/src/worker/wasiCommon.ts` — shared WASI preview-1 shim + `bootRunner` lifecycle
- `packages/kernel/src/worker/atomics.ts` + `jspi.ts` — env-agnostic guest-runner factories layered on `wasiCommon`
- `packages/kernel/src/worker/runner.atomics.web.ts` — web-Worker entry wiring `self` to `bootAtomicsRunner`
- `packages/host-bun/test/jspi/worker.mjs` — Node `worker_threads` entry wiring `parentPort` to `bootJspiRunner`
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

**Retired in Stage 2:** `AtomicsTransport` + the Node subprocess JSPI test rig. Bun 1.3.13 ships JSPI, so `JSPITransport` runs in-process and inside `Bun.Worker` — single transport, single runner, single contract suite green under Bun.

---

## Stage 2 — `[done]` Filesystem abstraction + memory FS

**Goal:** Introduce the `FileSystem` interface and a `MemoryFs` implementation. Kernel can serve `path_open`, `fd_read`, `fd_write`, `fd_filestat_get`, `fd_close` against it. Coreutils can read files. Still no OPFS.

**What landed:**
- `packages/kernel/src/fs/FileSystem.ts` — async `FileSystem` (open, opendir, stat, mkdir, rmdir, unlink, rename) + `FileHandle` (read/write at offset, truncate, stat, sync, close) + `DirHandle` + `FsError`
- `packages/kernel/src/fs/MemoryFs.ts` — in-process tree, async-shaped
- `packages/kernel/src/fs/Path.ts` — `normalize` / `resolve` / `dirname` / `basename` / `split`; no symlinks; never escapes root
- `packages/kernel/src/fd/FdTable.ts` + `FdEntry.ts` — per-process kernel-side fd table, dynamic allocation for `path_open`
- `packages/kernel/src/syscall/Syscalls.ts` + `SyscallHandler.ts` + `wire.ts` — generic syscall RPC; kernel-side dispatch over `FdTable` + `FileSystem` + transport pipes
- `packages/kernel/src/worker/SyscallClient.ts` — worker-side RPC client
- `packages/kernel/src/worker/wasiCommon.ts` — WASI shim: `path_open`, `fd_read/write/seek/tell/close/sync/readdir/filestat_get/filestat_set_size/pread/pwrite`, `path_create_directory/remove_directory/unlink_file/rename/filestat_get`. Async ops are `Suspending` imports.
- `LocalKernel` builds the per-process `FdTable` (pipe entries from caller fds + fd 3 = `/` preopen) and a `SyscallHandler` per spawn; passes them to `Transport.spawn`
- `Application` takes `fs: FileSystem` as a yadic dependency
- `cat` extended: positional file args; `-` means stdin; missing file → stderr + exit 1
- `host-bun/test/fs.contract.ts` — shared FS contract suite (9 cases)
- `host-bun/test/memoryFs.test.ts` — runs the contract against `MemoryFs`
- `host-bun/test/cat-file.test.ts` — `cat <file>` integration vs `MemoryFs`-backed kernel

**Also dropped this stage:**
- `AtomicsTransport`, `AtomicsPipeBuffer`, `worker/atomics.ts`, `runner.atomics.web.ts`, `pipe.atomics.test.ts` — Bun 1.3.13 ships JSPI globals (`WebAssembly.Suspending` / `promising`); JSPI runs in-process inside Bun and inside `Bun.Worker`. The Node subprocess test rig (`test/jspi/`) is gone too. Single transport, single runner entry (`worker/runner.jspi.web.ts`), single contract suite green in-process under Bun.

**Acceptance — verified:**
- `kernel.spawn('cat', ['/hello.txt'])` after `MemoryFs` `open`/`write` of `/hello.txt` returns stdout `hi\n`, exit 0.
- `cat /no.txt` → stderr `cat: /no.txt: No such file or directory`, exit 1.

**Open questions — resolved:**
- *Preopens:* fd 3 = `/`. `LocalKernel` allocates a `dir` `FdEntry` for fd 3 from `fs.opendir('/')` per spawn. Worker shim handles `fd_prestat_get` / `fd_prestat_dir_name` locally from the start-message preopen list (no RPC).
- *Rights bitmask:* permissive (all bits set in `fd_fdstat_get`). Worker decodes guest-supplied rights into `OpenFlags.read`/`write`; if zero (libc default), defaults to read+write.
- *Inode:* `fd_filestat_get` reports `ino = guestFd`, `path_filestat_get` reports `ino = 0`. No IndexedDB sidecar.
- *Errno bridging:* `FsError` thrown by `FileSystem` impls is unwrapped in `JSPITransport.serviceSyscall` alongside `SyscallError`; raw exceptions become `EIO`.

---

## Stage 3 — `[done]` OPFS filesystem (browser-only)

**Goal:** Second `FileSystem` implementation backed by OPFS sync access handles. Same contract tests must pass against both `MemoryFs` and `OpfsFs`.

**What landed:**
- `packages/kernel/src/fs/OpfsFs.ts` — kernel-side `FileSystem` proxy. Posts requests to a backend (anything implementing `OpfsFsBackend`); `FileHandle` / `DirHandle` instances RPC through the same backend.
- `packages/kernel/src/fs/opfsBackend.ts` — `bootOpfsBackend(io)` runs inside an OPFS-capable Worker. Hosts `FileSystemSyncAccessHandle`s, services every `FileSystem` op + per-handle file/dir ops. Handler registered synchronously and queues messages while `navigator.storage.getDirectory()` resolves.
- `packages/kernel/src/fs/runner.opfs.web.ts` — web-Worker entry; wires `self` to `bootOpfsBackend`.
- `packages/host-bun/test/opfs/` — `page.ts` (page-side runner), `worker-entry.ts` (FS Worker), `opfsServer.ts` (Bun.build the bundles + serve `index.html` / `page.js` / `opfs-worker.js`).
- `packages/host-bun/test/opfsFs.test.ts` — Bun test: spins up the test server, drives Playwright Chromium, navigates, waits for `document.title === 'done'`, asserts each contract case + persistence.

**Acceptance — verified:**
- All 9 cases from `fs.contract.ts` pass against `OpfsFs` in headless Chrome, run inline from `bun test` (Playwright launched in-process; no Node subprocess).
- Persistence: write `/persist.txt` via one `OpfsFs` instance (fresh FS Worker), construct another `OpfsFs` with a fresh FS Worker, read same path, content matches.

**Open questions — resolved:**
- *Sync handle lifecycle:* per-open. `path_open` → `getFileHandle` + `createSyncAccessHandle`; `fd_close` closes the sync handle. No pool; perf review deferred until Stage 6 coreutils exercise the FS harder.
- *Concurrent access:* serialised through the kernel. Single FS Worker hosts all sync handles; default exclusive `readwrite` mode; multiple guest fds to the same path simply mean multiple sync handles, but all coordinated by the same backend (currently one handle per open file, which would conflict — acceptable for Stage 3 since coreutils don't exercise that path; revisit alongside the pool decision).
- *Inode/metadata:* `fd_filestat_get` returns `ino = guestFd`, no IndexedDB sidecar. Acceptable for now.
- *Test runner:* Playwright runs in-process under Bun (`import {chromium} from "playwright"`). Roadmap originally said "Node subprocess from Bun tests" — Bun runs Playwright fine, no subprocess needed.

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
