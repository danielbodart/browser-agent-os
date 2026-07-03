import type {Pipe, PipeEnd} from "../pipe/Pipe.ts";
import type {PipeBuffer} from "../pipe/PipeBuffer.ts";
import type {Syscalls} from "../syscall/Syscalls.ts";
import type {Ext} from "../ext/Ext.ts";
import type {PreopenDescriptor} from "../syscall/wire.ts";

export interface TransportSpawnOpts {
    readonly binaryUrl: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly syscalls: Syscalls;
    readonly ext: Ext;
    readonly preopens: readonly PreopenDescriptor[];
}

export interface TransportSpawnResult {
    readonly exitCode: number;
}

export interface Transport {
    pipe(capacity: number): Pipe;
    drain(readEnd: PipeEnd): Promise<Uint8Array>;
    /**
     * Register one more live holder of a write end. Balanced by `closeWriteEnd`.
     * A write end's buffer is only EOF'd once every holder has closed it, mirroring
     * POSIX dup semantics where a pipe's write side stays open until the last fd closes.
     */
    acquireWriteEnd(end: PipeEnd): void;
    /** Drop one holder of a write end; EOF the buffer when the last holder closes. */
    closeWriteEnd(end: PipeEnd): void;
    releaseEnd(end: PipeEnd): void;
    bufferedBytes(end: PipeEnd): number;
    pipeBuffer(end: PipeEnd): PipeBuffer;
    spawn(opts: TransportSpawnOpts): Promise<TransportSpawnResult>;
}
