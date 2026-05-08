import type {ProcessResult} from "../Process.ts";

interface Entry {
    readonly promise: Promise<ProcessResult>;
}

export class ProcessTable {
    private nextPid = 2;
    private readonly entries = new Map<number, Entry>();

    register(promise: Promise<ProcessResult>): number {
        const pid = this.nextPid++;
        this.entries.set(pid, {promise});
        return pid;
    }

    take(pid: number): Promise<ProcessResult> | undefined {
        const e = this.entries.get(pid);
        if (!e) return undefined;
        this.entries.delete(pid);
        return e.promise;
    }
}
