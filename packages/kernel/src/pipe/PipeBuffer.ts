export interface PipeBuffer {
    write(bytes: Uint8Array): Promise<number>;
    read(buf: Uint8Array): Promise<number>;
    closeWrite(): void;
    readonly buffered: number;
}

export async function drainBuffer(buffer: PipeBuffer): Promise<Uint8Array> {
    const chunks: Uint8Array[] = [];
    const tmp = new Uint8Array(4096);
    while (true) {
        const n = await buffer.read(tmp);
        if (n === 0) break;
        chunks.push(tmp.slice(0, n));
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
}

export class JsPipeBuffer implements PipeBuffer {
    private readonly capacity: number;
    private readonly chunks: Uint8Array[] = [];
    private size = 0;
    private closed = false;
    private readonly readerWaiters: Array<() => void> = [];
    private readonly writerWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

    constructor(capacity: number) {
        if (capacity <= 0) throw new Error(`pipe capacity must be > 0, got ${capacity}`);
        this.capacity = capacity;
    }

    get buffered(): number {
        return this.size;
    }

    async write(bytes: Uint8Array): Promise<number> {
        if (bytes.length === 0) return 0;
        let written = 0;
        while (written < bytes.length) {
            if (this.closed) throw new Error('EPIPE: write on closed pipe');
            const space = this.capacity - this.size;
            if (space === 0) {
                await new Promise<void>((resolve, reject) => {
                    this.writerWaiters.push({resolve, reject});
                });
                continue;
            }
            const take = Math.min(space, bytes.length - written);
            this.chunks.push(bytes.slice(written, written + take));
            this.size += take;
            written += take;
            this.wakeReaders();
        }
        return written;
    }

    async read(buf: Uint8Array): Promise<number> {
        if (buf.length === 0) return 0;
        while (this.size === 0) {
            if (this.closed) return 0;
            await new Promise<void>(resolve => {
                this.readerWaiters.push(resolve);
            });
        }
        return this.copyOut(buf);
    }

    closeWrite(): void {
        if (this.closed) return;
        this.closed = true;
        const writers = this.writerWaiters.splice(0);
        for (const w of writers) w.reject(new Error('EPIPE: pipe closed'));
        this.wakeReaders();
    }

    private copyOut(buf: Uint8Array): number {
        let written = 0;
        while (written < buf.length && this.chunks.length > 0) {
            const head = this.chunks[0];
            const take = Math.min(head.length, buf.length - written);
            buf.set(head.subarray(0, take), written);
            written += take;
            if (take === head.length) this.chunks.shift();
            else this.chunks[0] = head.subarray(take);
            this.size -= take;
        }
        this.wakeWriters();
        return written;
    }

    private wakeReaders(): void {
        const waiters = this.readerWaiters.splice(0);
        for (const w of waiters) w();
    }

    private wakeWriters(): void {
        const waiters = this.writerWaiters.splice(0);
        for (const w of waiters) w.resolve();
    }
}
