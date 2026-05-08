import type {Kernel} from "./Kernel.ts";
import type {ProcessResult} from "./Process.ts";
import type {Dependency} from "@bodar/yadic/types.ts";

export type BinaryResolver = (name: string) => string | URL;
export type WorkerFactory = () => Worker;

export type LocalKernelDependencies =
    Dependency<'binaryResolver', BinaryResolver> &
    Dependency<'workerFactory', WorkerFactory>;

interface WorkerStartMessage {
    readonly type: 'start';
    readonly url: string;
    readonly args: readonly string[];
    readonly env: Readonly<Record<string, string>>;
}

interface WorkerExitMessage {
    readonly type: 'exit';
    readonly stdout: Uint8Array;
    readonly stderr: Uint8Array;
    readonly exitCode: number;
}

interface WorkerErrorMessage {
    readonly type: 'error';
    readonly message: string;
}

export type WorkerOutbound = WorkerStartMessage;
export type WorkerInbound = WorkerExitMessage | WorkerErrorMessage;

export class LocalKernel implements Kernel {
    constructor(private readonly deps: LocalKernelDependencies) {}

    spawn(binary: string, args: string[] = [], env: Record<string, string> = {}): Promise<ProcessResult> {
        const url = this.deps.binaryResolver(binary).toString();
        const worker = this.deps.workerFactory();
        const argv = [binary, ...args];
        return new Promise<ProcessResult>((resolve, reject) => {
            worker.onmessage = (event: MessageEvent<WorkerInbound>) => {
                worker.terminate();
                if (event.data.type === 'exit') {
                    resolve({
                        stdout: event.data.stdout,
                        stderr: event.data.stderr,
                        exitCode: event.data.exitCode,
                    });
                } else {
                    reject(new Error(event.data.message));
                }
            };
            worker.onerror = (event: ErrorEvent) => {
                worker.terminate();
                reject(new Error(event.message || 'worker error'));
            };
            const start: WorkerStartMessage = {type: 'start', url, args: argv, env};
            worker.postMessage(start);
        });
    }
}
