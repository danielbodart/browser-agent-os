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

    async spawn(
        binary: string,
        args: string[] = [],
        env: Record<string, string> = {},
        fds: FdMap = new Map(),
    ): Promise<ProcessResult> {
        const tx = this.deps.transport;
        const merged = new Map<number, PipeEnd>(fds);
        const owned: PipeEnd[] = [];

        let stdoutP: Promise<Uint8Array> = Promise.resolve(new Uint8Array());
        let stderrP: Promise<Uint8Array> = Promise.resolve(new Uint8Array());

        if (!merged.has(0)) {
            const p = tx.pipe(DEFAULT_PIPE_CAPACITY);
            tx.closeWriteEnd(p.writeEnd);
            merged.set(0, p.readEnd);
            owned.push(p.readEnd, p.writeEnd);
        }
        if (!merged.has(1)) {
            const p = tx.pipe(DEFAULT_PIPE_CAPACITY);
            merged.set(1, p.writeEnd);
            stdoutP = tx.drain(p.readEnd);
            owned.push(p.readEnd, p.writeEnd);
        }
        if (!merged.has(2)) {
            const p = tx.pipe(DEFAULT_PIPE_CAPACITY);
            merged.set(2, p.writeEnd);
            stderrP = tx.drain(p.readEnd);
            owned.push(p.readEnd, p.writeEnd);
        }

        const initial: Array<[number, FdEntry]> = [];
        for (const [fd, end] of merged) {
            initial.push([fd, {kind: 'pipe', direction: end.kind, end}]);
        }
        const rootDir = await this.deps.fs.opendir('/');
        initial.push([PREOPEN_FD, {kind: 'dir', handle: rootDir, path: '/', preopen: true}]);

        const fdTable = new FdTable(initial, FIRST_ALLOC_FD);
        const syscalls = new SyscallHandler(fdTable, this.deps.fs, end => tx.pipeBuffer(end));
        const preopens: PreopenDescriptor[] = [{fd: PREOPEN_FD, path: '/'}];

        const url = this.deps.binaryResolver(binary).toString();
        const argv = [binary, ...args];

        let exitCode = 0;
        try {
            const r = await tx.spawn({binaryUrl: url, args: argv, env, syscalls, preopens});
            exitCode = r.exitCode;
        } finally {
            for (const [, end] of merged) {
                if (end.kind === 'write') tx.closeWriteEnd(end);
            }
        }

        const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);

        for (const e of owned) tx.releaseEnd(e);

        return {stdout, stderr, exitCode};
    }
}
