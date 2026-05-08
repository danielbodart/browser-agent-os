import type {Pipe, PipeEnd, FdMap} from "../pipe/Pipe.ts";

export interface TransportSpawnOpts {
    readonly binaryUrl: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
    readonly fds: FdMap;
}

export interface TransportSpawnResult {
    readonly exitCode: number;
}

export interface Transport {
    pipe(capacity: number): Pipe;
    drain(readEnd: PipeEnd): Promise<Uint8Array>;
    closeWriteEnd(end: PipeEnd): void;
    releaseEnd(end: PipeEnd): void;
    spawn(opts: TransportSpawnOpts): Promise<TransportSpawnResult>;
    bufferedBytes(end: PipeEnd): number;
}
