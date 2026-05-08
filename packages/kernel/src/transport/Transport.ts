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
    closeWriteEnd(end: PipeEnd): void;
    releaseEnd(end: PipeEnd): void;
    bufferedBytes(end: PipeEnd): number;
    pipeBuffer(end: PipeEnd): PipeBuffer;
    spawn(opts: TransportSpawnOpts): Promise<TransportSpawnResult>;
}
