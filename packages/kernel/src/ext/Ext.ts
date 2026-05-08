export interface FdPipeResult {
    readonly readFd: number;
    readonly writeFd: number;
}

export interface ProcSpawnResult {
    readonly pid: number;
}

export interface ProcJoinResult {
    readonly exitCode: number;
}

export interface Ext {
    fdPipe(): FdPipeResult;
    procSpawn(
        path: string,
        argv: readonly string[],
        env: Readonly<Record<string, string>>,
        fdmap: readonly (readonly [number, number])[],
    ): Promise<ProcSpawnResult>;
    procJoin(pid: number): Promise<ProcJoinResult>;
}
