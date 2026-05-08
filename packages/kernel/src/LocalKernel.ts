import type {Kernel} from "./Kernel.ts";
import type {ProcessResult} from "./Process.ts";
import type {Dependency} from "@bodar/yadic/types.ts";
import type {Transport} from "./transport/Transport.ts";
import type {Pipe, PipeEnd, FdMap} from "./pipe/Pipe.ts";
import {DEFAULT_PIPE_CAPACITY} from "./pipe/Pipe.ts";
import type {FileSystem} from "./fs/FileSystem.ts";
import {FdTable} from "./fd/FdTable.ts";
import type {FdEntry} from "./fd/FdEntry.ts";
import {SyscallHandler} from "./syscall/SyscallHandler.ts";
import type {PreopenDescriptor} from "./syscall/wire.ts";
import {ExtHandler} from "./ext/ExtHandler.ts";

export type BinaryResolver = (name: string) => string | URL;

export type LocalKernelDependencies =
    Dependency<'transport', Transport> &
    Dependency<'binaryResolver', BinaryResolver> &
    Dependency<'fs', FileSystem>;

const PREOPEN_FD = 3;
const FIRST_ALLOC_FD = 16;

export class LocalKernel implements Kernel {
    constructor(private readonly deps: LocalKernelDependencies) {}

    pipe(): Pipe {
        return this.deps.transport.pipe(DEFAULT_PIPE_CAPACITY);
    }

    spawn(
        binary: string,
        args: string[] = [],
        env: Record<string, string> = {},
        fds: FdMap = new Map(),
    ): Promise<ProcessResult> {
        const entries = new Map<number, FdEntry>();
        for (const [fd, end] of fds) {
            entries.set(fd, {kind: 'pipe', direction: end.kind, end});
        }
        return this.spawnWithEntries(binary, [binary, ...args], env, entries);
    }

    private async spawnWithEntries(
        binary: string,
        argv: readonly string[],
        env: Readonly<Record<string, string>>,
        provided: ReadonlyMap<number, FdEntry>,
    ): Promise<ProcessResult> {
        const tx = this.deps.transport;
        const merged = new Map<number, FdEntry>(provided);
        const ownedEnds: PipeEnd[] = [];

        let stdoutP: Promise<Uint8Array> = Promise.resolve(new Uint8Array());
        let stderrP: Promise<Uint8Array> = Promise.resolve(new Uint8Array());

        if (!merged.has(0)) {
            const p = tx.pipe(DEFAULT_PIPE_CAPACITY);
            tx.closeWriteEnd(p.writeEnd);
            merged.set(0, {kind: 'pipe', direction: 'read', end: p.readEnd});
            ownedEnds.push(p.readEnd, p.writeEnd);
        }
        if (!merged.has(1)) {
            const p = tx.pipe(DEFAULT_PIPE_CAPACITY);
            merged.set(1, {kind: 'pipe', direction: 'write', end: p.writeEnd});
            stdoutP = tx.drain(p.readEnd);
            ownedEnds.push(p.readEnd, p.writeEnd);
        }
        if (!merged.has(2)) {
            const p = tx.pipe(DEFAULT_PIPE_CAPACITY);
            merged.set(2, {kind: 'pipe', direction: 'write', end: p.writeEnd});
            stderrP = tx.drain(p.readEnd);
            ownedEnds.push(p.readEnd, p.writeEnd);
        }

        const initial: Array<[number, FdEntry]> = [];
        for (const [fd, entry] of merged) initial.push([fd, entry]);
        const rootDir = await this.deps.fs.opendir('/');
        initial.push([PREOPEN_FD, {kind: 'dir', handle: rootDir, path: '/', preopen: true, owned: true}]);

        const fdTable = new FdTable(initial, FIRST_ALLOC_FD);
        const syscalls = new SyscallHandler(fdTable, this.deps.fs, end => tx.pipeBuffer(end));
        const ext = new ExtHandler(tx, fdTable, (path, argv, e, entries) =>
            this.spawnWithEntries(path, argv, e, entries));
        const preopens: PreopenDescriptor[] = [{fd: PREOPEN_FD, path: '/'}];

        const url = this.deps.binaryResolver(binary).toString();

        let exitCode = 0;
        try {
            const r = await tx.spawn({binaryUrl: url, args: argv, env, syscalls, ext, preopens});
            exitCode = r.exitCode;
        } finally {
            for (const [, entry] of merged) {
                if (entry.kind === 'pipe' && entry.direction === 'write') {
                    tx.closeWriteEnd(entry.end);
                }
            }
        }

        const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);

        for (const e of ownedEnds) tx.releaseEnd(e);

        return {stdout, stderr, exitCode};
    }
}
