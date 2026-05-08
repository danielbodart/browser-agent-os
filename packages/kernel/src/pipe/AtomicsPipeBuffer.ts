import type {PipeBuffer} from "./PipeBuffer.ts";

const HEADER_BYTES = 16;
const WRITE_POS_INDEX = 0;
const READ_POS_INDEX = 1;
const CLOSED_INDEX = 2;
const EVENT_INDEX = 3;

export class AtomicsPipeBuffer implements PipeBuffer {
    readonly capacity: number;
    readonly sab: SharedArrayBuffer;
    private readonly header: Int32Array;
    private readonly data: Uint8Array;

    constructor(capacity: number) {
        if (capacity <= 0) throw new Error(`pipe capacity must be > 0, got ${capacity}`);
        this.capacity = capacity;
        this.sab = new SharedArrayBuffer(HEADER_BYTES + capacity);
        this.header = new Int32Array(this.sab, 0, 4);
        this.data = new Uint8Array(this.sab, HEADER_BYTES, capacity);
    }

    get buffered(): number {
        return Atomics.load(this.header, WRITE_POS_INDEX) - Atomics.load(this.header, READ_POS_INDEX);
    }

    async write(bytes: Uint8Array): Promise<number> {
        if (bytes.length === 0) return 0;
        let written = 0;
        while (written < bytes.length) {
            if (Atomics.load(this.header, CLOSED_INDEX) === 1) {
                throw new Error('EPIPE: write on closed pipe');
            }
            const ev = Atomics.load(this.header, EVENT_INDEX);
            const rp = Atomics.load(this.header, READ_POS_INDEX);
            const wp = Atomics.load(this.header, WRITE_POS_INDEX);
            const free = this.capacity - (wp - rp);
            if (free === 0) {
                await this.waitAsync(EVENT_INDEX, ev);
                continue;
            }
            const take = Math.min(free, bytes.length - written);
            this.copyIn(bytes.subarray(written, written + take), wp);
            Atomics.store(this.header, WRITE_POS_INDEX, wp + take);
            Atomics.add(this.header, EVENT_INDEX, 1);
            Atomics.notify(this.header, EVENT_INDEX);
            written += take;
        }
        return written;
    }

    async read(buf: Uint8Array): Promise<number> {
        if (buf.length === 0) return 0;
        while (true) {
            const ev = Atomics.load(this.header, EVENT_INDEX);
            const wp = Atomics.load(this.header, WRITE_POS_INDEX);
            const rp = Atomics.load(this.header, READ_POS_INDEX);
            const avail = wp - rp;
            if (avail > 0) {
                const take = Math.min(avail, buf.length);
                this.copyOut(buf.subarray(0, take), rp);
                Atomics.store(this.header, READ_POS_INDEX, rp + take);
                Atomics.add(this.header, EVENT_INDEX, 1);
                Atomics.notify(this.header, EVENT_INDEX);
                return take;
            }
            if (Atomics.load(this.header, CLOSED_INDEX) === 1) return 0;
            await this.waitAsync(EVENT_INDEX, ev);
        }
    }

    closeWrite(): void {
        if (Atomics.compareExchange(this.header, CLOSED_INDEX, 0, 1) !== 0) return;
        Atomics.add(this.header, EVENT_INDEX, 1);
        Atomics.notify(this.header, EVENT_INDEX);
    }

    private async waitAsync(index: number, value: number): Promise<void> {
        const result = Atomics.waitAsync(this.header, index, value);
        if (result.async) await result.value;
    }

    private copyIn(src: Uint8Array, wp: number): void {
        const offset = wp % this.capacity;
        const tail = this.capacity - offset;
        if (src.length <= tail) {
            this.data.set(src, offset);
        } else {
            this.data.set(src.subarray(0, tail), offset);
            this.data.set(src.subarray(tail), 0);
        }
    }

    private copyOut(dst: Uint8Array, rp: number): void {
        const offset = rp % this.capacity;
        const tail = this.capacity - offset;
        if (dst.length <= tail) {
            dst.set(this.data.subarray(offset, offset + dst.length));
        } else {
            dst.set(this.data.subarray(offset, this.capacity), 0);
            dst.set(this.data.subarray(0, dst.length - tail), tail);
        }
    }
}

export const PIPE_HEADER_BYTES = HEADER_BYTES;
export const PIPE_WRITE_POS_INDEX = WRITE_POS_INDEX;
export const PIPE_READ_POS_INDEX = READ_POS_INDEX;
export const PIPE_CLOSED_INDEX = CLOSED_INDEX;
export const PIPE_EVENT_INDEX = EVENT_INDEX;
