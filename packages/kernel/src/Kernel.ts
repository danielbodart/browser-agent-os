import type {ProcessResult} from "./Process.ts";

export interface Kernel {
    spawn(binary: string, args?: string[], env?: Record<string, string>): Promise<ProcessResult>;
}
