import type {ProcessResult} from "./Process.ts";
import type {FdMap, Pipe} from "./pipe/Pipe.ts";

export interface Kernel {
    pipe(): Pipe;
    spawn(
        binary: string,
        args?: string[],
        env?: Record<string, string>,
        fds?: FdMap,
    ): Promise<ProcessResult>;
}
