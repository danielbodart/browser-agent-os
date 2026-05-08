import type {FdEntry} from "./FdEntry.ts";

export class FdTable {
    private readonly entries = new Map<number, FdEntry>();
    private nextFd: number;

    constructor(initial: Iterable<readonly [number, FdEntry]>, firstAllocFd = 16) {
        let max = firstAllocFd - 1;
        for (const [fd, entry] of initial) {
            this.entries.set(fd, entry);
            if (fd > max) max = fd;
        }
        this.nextFd = Math.max(firstAllocFd, max + 1);
    }

    has(fd: number): boolean {
        return this.entries.has(fd);
    }

    get(fd: number): FdEntry | undefined {
        return this.entries.get(fd);
    }

    allocate(entry: FdEntry): number {
        const fd = this.nextFd++;
        this.entries.set(fd, entry);
        return fd;
    }

    close(fd: number): FdEntry | undefined {
        const e = this.entries.get(fd);
        if (e !== undefined) this.entries.delete(fd);
        return e;
    }

    [Symbol.iterator](): IterableIterator<[number, FdEntry]> {
        return this.entries.entries();
    }
}
