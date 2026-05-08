export interface ProcessResult {
    readonly stdout: Uint8Array;
    readonly stderr: Uint8Array;
    readonly exitCode: number;
}
