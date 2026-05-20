import {join} from "node:path";
import {serve} from "bun";
import {application, JSPITransport, MemoryFs} from "@browser-agent-os/kernel";
import {server} from "../../src/server.ts";
import {webWorkerFactory} from "../../src/workers.ts";

type ServerHandle = ReturnType<typeof serve>;

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const BINARIES = join(ROOT, "packages", "coreutils", "zig-out", "bin");
const RUNNER = join(ROOT, "packages", "kernel", "src", "worker", "runner.jspi.web.ts");

export const enc = new TextEncoder();
export const dec = new TextDecoder();

export function startServer(): ServerHandle {
    return serve({port: 0, fetch: server({binariesDirs: [BINARIES]})});
}

export function buildKernel(listener: ServerHandle) {
    const fs = new MemoryFs();
    const transport = new JSPITransport({workerFactory: webWorkerFactory, runnerUrl: RUNNER});
    const app = application({
        binaryResolver: name => new URL(`/bin/${name}`, listener.url),
        transport,
        fs,
    });
    return {kernel: app.kernel, transport, fs};
}

export async function writeFile(fs: MemoryFs, path: string, bytes: Uint8Array | string): Promise<void> {
    const data = typeof bytes === "string" ? enc.encode(bytes) : bytes;
    const h = await fs.open(path, {read: false, write: true, create: true, exclusive: false, truncate: true, append: false, directory: false});
    try {
        let off = 0n;
        while (Number(off) < data.length) {
            const n = await h.write(data.subarray(Number(off)), off);
            off += BigInt(n);
        }
    } finally {
        await h.close();
    }
}

export async function readFile(fs: MemoryFs, path: string): Promise<Uint8Array> {
    const h = await fs.open(path, {read: true, write: false, create: false, exclusive: false, truncate: false, append: false, directory: false});
    try {
        const stat = await h.stat();
        const buf = new Uint8Array(Number(stat.size));
        let off = 0n;
        while (Number(off) < buf.length) {
            const n = await h.read(buf.subarray(Number(off)), off);
            if (n === 0) break;
            off += BigInt(n);
        }
        return buf;
    } finally {
        await h.close();
    }
}

