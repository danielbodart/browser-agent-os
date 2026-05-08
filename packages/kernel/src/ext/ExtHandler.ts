import {EBADF, ECHILD} from "../wasi/Errno.ts";
import {SyscallError} from "../syscall/SyscallHandler.ts";
import {DEFAULT_PIPE_CAPACITY} from "../pipe/Pipe.ts";
import type {Transport} from "../transport/Transport.ts";
import type {FdTable} from "../fd/FdTable.ts";
import type {FdEntry} from "../fd/FdEntry.ts";
import type {ProcessResult} from "../Process.ts";
import type {Ext, FdPipeResult, ProcJoinResult, ProcSpawnResult} from "./Ext.ts";
import {ProcessTable} from "./ProcessTable.ts";

export type ExtSpawnFn = (
    path: string,
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
    entries: ReadonlyMap<number, FdEntry>,
) => Promise<ProcessResult>;

export class ExtHandler implements Ext {
    private readonly processes = new ProcessTable();

    constructor(
        private readonly transport: Transport,
        private readonly fds: FdTable,
        private readonly spawnFn: ExtSpawnFn,
    ) {}

    fdPipe(): FdPipeResult {
        const {readEnd, writeEnd} = this.transport.pipe(DEFAULT_PIPE_CAPACITY);
        const readFd = this.fds.allocate({kind: 'pipe', direction: 'read', end: readEnd});
        const writeFd = this.fds.allocate({kind: 'pipe', direction: 'write', end: writeEnd});
        return {readFd, writeFd};
    }

    async procSpawn(
        path: string,
        argv: readonly string[],
        env: Readonly<Record<string, string>>,
        fdmap: readonly (readonly [number, number])[],
    ): Promise<ProcSpawnResult> {
        const entries = new Map<number, FdEntry>();
        for (const [childFd, parentFd] of fdmap) {
            const e = this.fds.get(parentFd);
            if (!e) throw new SyscallError(EBADF, `bad parent fd ${parentFd} in fdmap`);
            entries.set(childFd, borrow(e));
        }
        const promise = this.spawnFn(path, argv, env, entries);
        promise.catch(() => {});
        const pid = this.processes.register(promise);
        return {pid};
    }

    async procJoin(pid: number): Promise<ProcJoinResult> {
        const promise = this.processes.take(pid);
        if (!promise) throw new SyscallError(ECHILD, `no such pid ${pid}`);
        const r = await promise;
        return {exitCode: r.exitCode};
    }
}

// Borrow an FdEntry for a child process: file/dir handles share the underlying
// resource but the child never closes it (only the owner does on its own fd_close).
// Pipe ends are always shareable; ownership of the underlying buffer lives in the
// transport, not the FdTable.
function borrow(e: FdEntry): FdEntry {
    if (e.kind === 'file') return {kind: 'file', handle: e.handle, flags: e.flags, owned: false, position: 0n};
    if (e.kind === 'dir') return {kind: 'dir', handle: e.handle, path: e.path, preopen: false, owned: false};
    return e;
}
