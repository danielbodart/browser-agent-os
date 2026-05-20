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

## Stage 4 — `[done]` Shell binary + spawn extension

**Goal:** A real Zig shell running as a guest binary. Reads commands from stdin, parses, spawns children, waits, reports exit codes. Pipes and `<` `>` `>>` redirects are wired at the shell level via a new `browser_agent_os_ext` namespace.

**What landed:**
- `packages/shell/` — Zig pkg producing `bin/sh.wasm`. `build.zig` mirrors `packages/coreutils/`. Tokenizer + parser + executor + REPL in single `src/main.zig` (~520 lines).
- `packages/kernel/src/ext/wire.ts` — `ExtRequest` / `ExtReply` discriminated unions, parallel to `syscall/wire.ts`. Three ops: `fd_pipe`, `proc_spawn`, `proc_join`.
- `packages/kernel/src/ext/Ext.ts` + `ExtHandler.ts` + `ProcessTable.ts` — kernel-side handler. Per-process `ExtHandler` constructed in `LocalKernel.spawnWithEntries` alongside `SyscallHandler`. `ProcessTable` maps pid → exit-promise; `procJoin` `take`s the promise (single-use; second join returns `ECHILD`).
- `packages/kernel/src/worker/ExtClient.ts` + `extImports.ts` — guest-side RPC client + the `browser_agent_os_ext` namespace functions (`fd_pipe`, `proc_spawn`, `proc_join`). All async; `Suspending`-wrapped via the existing `wrapImports` pass.
- `packages/kernel/src/worker/wasiCommon.ts` — bootRunner now wires both `wasi_snapshot_preview1` and `browser_agent_os_ext`.
- `packages/kernel/src/transport/JSPITransport.ts` — extra `'ext'` message case on `handleMessage`; sibling `serviceExt` parallel to `serviceSyscall`.
- `packages/kernel/src/LocalKernel.ts` — public `spawn(binary, args, env, fds<PipeEnd>)` unchanged; private `spawnWithEntries(binary, argv, env, entries<FdEntry>)` does the heavy lifting and is what `ExtHandler.procSpawn` re-enters.
- `packages/kernel/src/fd/FdEntry.ts` — `FileFdEntry`/`DirFdEntry` gain `owned: boolean`. `SyscallHandler.fdClose` skips `handle.close()` for borrowed entries (entries adopted from another process via `proc_spawn`). Prevents double-close when shell hands a redirect fd to a child.
- `packages/kernel/src/wasi/Errno.ts` — `ECHILD = 12` added.
- `packages/host-bun/src/server.ts` — `binariesDirs: readonly string[]`, first match wins. `app.ts` lists both `coreutils/zig-out/bin` and `shell/zig-out/bin`.
- `mise.toml` — `build:shell` + `optimize:shell`; `build:bins` depends on both.
- `packages/host-bun/test/shell.test.ts` — 6 cases: `echo hello`, `echo hello | cat`, `echo a | cat | cat`, `echo > file` redirect + read-back, `pwd`, `exit 7`.

**Acceptance — verified:**
- `echo hello\nexit\n` → stdout `hello\n`, exit 0.
- `echo hello | cat\nexit\n` → stdout `hello\n`, exit 0.
- `echo a | cat | cat\nexit\n` → stdout `a\n` (multi-stage).
- `echo hi > /out.txt\ncat /out.txt\nexit\n` → stdout `hi\n`, file persisted.
- `pwd` at root, `exit 7` exit-code propagation — green.

**Open questions — resolved:**
- *Spawn API shape:* `proc_spawn` (non-blocking, returns pid) + `proc_join(pid)` (returns exit code). WASIX prior-art names; matches POSIX `posix_spawn`+`waitpid` semantics. Required for pipelines (children must run concurrently).
- *Pipe API:* `fd_pipe(read_fd_out, write_fd_out)` returns *shell fds*, not opaque end-ids. Pipe ends become first-class fds in the shell's `FdTable`, unifying file redirects and pipe wiring under a single fdmap shape.
- *fdmap shape:* flat `(child_fd, parent_shell_fd)` i32 pairs in the spawn call. Kernel looks up each `parent_shell_fd` in caller's `FdTable` and adopts a borrowed copy into the child's table. File and pipe redirects use identical mechanism.
- *Parser scope:* whitespace word-split, `|` pipelines, `<` `>` `>>` redirects, builtins (`cd`/`pwd`/`exit`/`export`). No quoting, no `&`/`;`/`&&`/`||`/`$VAR` — defer.
- *Job control / signals:* skipped. `proc_kill` deferred until xterm.js (Stage 5) has a Ctrl-C source.
- *Wire channel:* a parallel `'ext'`/`'extReply'` envelope alongside the existing syscall channel. Same `MessagingWorker` post path, separate reqId space, separate `ExtClient`. Duplication accepted; a generic `RpcClient<>` may be extracted when a third channel arrives.
- *Borrowed FdEntries:* `ExtHandler.procSpawn` clones each adopted file/dir entry with `owned: false` (and resets `position` for files). Prevents double-close from parent + child. Pipe entries don't carry an `owned` flag because pipe ends are never released by `fdClose` anyway (transport owns the buffer).

**Known limitations (deferred):**
- Pipe ends allocated via `fd_pipe` are not released from `JSPITransport.ends` when the shell `fd_close`s them. `SyscallHandler.fdClose` for pipe entries removes the table entry but doesn't call `transport.releaseEnd`. Bounded leak per `JSPITransport` instance; revisit when shells run long enough to matter (likely Stage 5 once xterm.js is live).
- No path normalisation in `cd`. `cd ..` stores literal `..` in `cwd`, which the kernel won't resolve. Acceptable for Stage 4 scope.

---

## Stage 5 — `[done]` Browser host package

**Goal:** Make the kernel run in a real browser tab with xterm.js. Until now everything ran in Bun + Node subprocess.

**What landed:**
- `packages/host-browser/` — composition root for the browser. `src/app.ts` wires `JSPITransport` + `OpfsFs` + `LocalKernel` via `application(deps)`, spawns `sh -i` with explicit stdin/stdout/stderr pipes wired to xterm. `src/server.ts` `Bun.build`s three browser bundles (app + JSPI runner + OPFS runner) and serves them; `src/main.ts` is the runnable dev server combining browser routes with `host-bun`'s binary `server()` for `/bin/*`. `src/lineDiscipline.ts` is a cooked-mode TTY (echo, Backspace, send-on-Enter) — the line-editing layer lives in the host page (kernel side), not in the shell, mirroring the conventional Unix arrangement where the TTY driver does cooked mode and the shell sees full lines.
- `packages/coreutils/src/ls/` — added so manual testing can `ls` and `cd`. Hand-rolled WASI `path_open` + `fd_readdir` with an `extern struct Dirent` for the WASI dirent layout.
- `packages/shell/src/main.zig` — converted batch `readAllStdin` loop into a true REPL: line-by-line `readRaw` (direct WASI `fd_read` extern; `std.Io.File.stdin().reader().readSliceShort` hung after the first batch in the JSPI/async-pipe environment), `LineReader` struct, `-i` flag for `cwd $ ` prompt, `normalizePath` helper so `cd ..` resolves correctly. The new `readRaw` extern coexists with the existing `path_open`/`fd_close`/`fd_pipe` externs.
- `packages/host-bun/src/index.ts` — re-exports `server` and `webWorkerFactory` (also imported by `host-browser`). `package.json` `main` switched from `./src/app.ts` to `./src/index.ts`; `app.ts` remains the runnable script for `mise run dev`.
- `packages/kernel/src/index.ts` — added `export type {PipeBuffer}` (host-browser drains stdout/stderr via `transport.pipeBuffer(end).read()`).
- `mise.toml` — `dev:browser` task that depends on `build:bins` and runs the host-browser dev server on port 3000.
- `packages/host-browser/test/host-browser.smoke.test.ts` — Playwright (headless Chrome via Bun test) drives three cases: `echo hello | cat` produces `hello`, `echo > /a.txt` then `ls /` shows `a.txt`, write → reload → cat persists across an OPFS instance respawn.

**Acceptance — verified:**
- `mise run dev:browser` serves http://localhost:3000; the page mounts xterm with a `/$ ` prompt; typing `echo hello | cat` and Enter produces `hello\n` followed by the next prompt.
- `echo persisted > /persist.txt`, reload, `cat /persist.txt` — file persists across page reloads via OPFS.
- All 38 tests across 6 files pass under `mise run test`, including the 3 new headless Chrome smoke cases.

**Open questions — resolved:**
- *Bundling:* `Bun.build({target: 'browser', format: 'esm'})` handles app + worker entries with no extra tooling; xterm CSS served from `node_modules`. Vite would buy nothing at this stage.
- *Cross-origin isolation:* skipped. JSPI does not require COOP/COEP, OPFS sync access handles only require a dedicated worker (which `runner.opfs.web.ts` already is). No SharedArrayBuffer anywhere in the kernel since Stage 2.
- *Shell interactivity:* shell now exposes `-i`. Tests don't pass `-i` (no prompt) so existing batch tests stay green; browser host passes `-i`.
- *Line discipline location:* host page, not shell. Cooked-mode equivalent. Raw mode would need a TTY layer + a `browser_agent_os_ext` op to switch modes — deferred until a program (e.g., editor) actually needs it.
- *Stdin reader bug:* `std.Io.File.stdin().reader(io, &rbuf).interface.readSliceShort` hangs after the first non-trivial read inside a JSPI worker. Worked around with a direct WASI `fd_read` extern. Worth filing upstream; for now the workaround is local to the shell and `ls` is unaffected (it only reads the directory fd, not stdin).
- *xterm.js package:* `@xterm/xterm` 5.5+ added to host-browser only.

**Known limitations (deferred):**
- No Ctrl-C / signal handling. Pressing `Ctrl-C` in xterm just sends `\x03` into the line buffer. `proc_kill` ext op + worker termination semantics deferred to Stage 6 alongside coreutils growth.
- Tab character is sent into the buffer but xterm renders it as cursor advancement, so visual position can drift after Backspace following a Tab. Cosmetic.
- Pipe-end leak in `JSPITransport.ends` from Stage 4 still applies (host-browser doesn't make it worse).

---

## Stage 6 — `[done]` Coreutils growth

**Goal:** Useful set of POSIX-shaped utilities. Driven by what the shell needs in real use.

**What landed:**
- `packages/coreutils/src/<name>/main.zig` for each of the 13 new binaries: `pwd`, `head`, `tail`, `wc`, `env`, `true`, `false`, `mkdir`, `rmdir`, `rm`, `cp`, `mv`, `touch` (joining the existing `echo`, `cat`, `ls`).
- `packages/coreutils/build.zig` `bins` array updated to enumerate all 16.
- `packages/host-bun/test/coreutils/<name>.test.ts` — one test file per new binary, with `helpers.ts` factoring out the `buildKernel`/server scaffolding.
- `packages/shell/src/main.zig` — shell now `env.put("PWD", ...)` on init and on every `cd`, so the standalone `pwd` binary (which reads `$PWD`) reports the right cwd when run from the shell.

**Per-binary scope:**
- `true` / `false`: exit 0 / exit 1, no flags.
- `pwd`: reads `$PWD`, falls back to `/`. No flags.
- `env`: prints `K=V` lines from `init.environ_map`. No `env K=V cmd...` form yet (would need ext spawn).
- `head` / `tail`: `-n N` (default 10 lines) and `-c N` (bytes). Files or stdin. Multi-file `==>name<==` banners.
- `wc`: `-l` / `-w` / `-c` (default all three). Files or stdin. Totals row when >1 file.
- `mkdir`: `-p` (create parents, treats EEXIST as benign).
- `rmdir`: no flags.
- `rm`: `-r`/`-R` (iterative post-order tree removal via fd_readdir), `-f` (silence missing files).
- `cp`: file→file copy + `-r` recursive directory tree copy (iterative via `fd_readdir`). Read-loop + write-loop per file. Overwrites existing dest. Error-return paths (ENOENT, EISDIR-without-`-r`) currently trap due to a Zig 0.16 wasm codegen bug — see "Known limitations" below.
- `mv`: single `path_rename` call; no flags.
- `touch`: create-only via `path_open(O_CREAT)`. No mtime update because WASI `path_filestat_set_times` returns `ENOSYS` in the kernel.

**Acceptance — verified:**
- Each of the 13 new binaries has a happy-path + error-case test in `packages/host-bun/test/coreutils/`.
- 61 of 62 tests across 18 files pass under `bun test`. The single failure is a pre-existing `opfsFs.test.ts` flake (concurrent `Bun.build` reading `kernel/src/index.ts`) that reproduces on a base checkout with the new coreutils removed — unrelated to Stage 6.

**Open questions — resolved:**
- *Argument parsing:* hand-roll per binary. The flag sets are too divergent for a shared `Args` module to pay for itself at 13 binaries; the duplicated code is ~5 lines per binary.
- *POSIX flag conformance:* minimal. Enough to be usable from the shell, no `-l`/`-a` on `ls`, no `-p`/`-i` on `cp`, no `-f` follow on `tail`. The roadmap can grow these later as agents and scripts actually need them.

**Known limitations (deferred):**
- **`cp` error-return paths trap.** Zig 0.16 wasm emits a `(unreachable)`-bodied stub function for each WASI extern — visible in the disassembly as e.g. `.Lpath_open|wasi_snapshot_preview1_bitcast_invalid` — and routes calls through the stub from any user-defined helper that wraps the extern. The optimizer normally rewrites those stub calls into direct import calls (`call $fimport$N`), but when the user helper is non-`inline` and reached through certain control-flow shapes the rewrite is skipped, leaving a live `call $stub` that traps at runtime with "Unreachable code". Confirmed identical behaviour in Bun 1.3.13 and headless Chrome (the cp worker traps; shell's `proc_join` never returns; subsequent commands hang), so this is upstream Zig wasm codegen, not a runtime issue. Marking the helpers `inline fn` recovers most of the binary (file copy, dir-tree `-r`, overwrite); the error-return paths through `doCopy` for ENOENT/EISDIR still trap and are excluded from the test suite. Filing upstream as Zig issue; possible fixes here include a kernel-side `path_copy` ext op or fully inlining the error path into `main`.
- `touch` cannot update an existing file's mtime — kernel returns `ENOSYS` for `path_filestat_set_times`.
- `env` doesn't run a command yet (no `env K=V cmd args...` form). Same `proc_spawn` glue as the shell would be needed; lift if a script needs it.

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
