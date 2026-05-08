import type {FileSystem} from "@browser-agent-os/kernel";
import {FsError} from "@browser-agent-os/kernel";

const enc = new TextEncoder();
const dec = new TextDecoder();

function assertEq<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

async function readAll(fs: FileSystem, path: string): Promise<Uint8Array> {
    const h = await fs.open(path, openRead());
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

async function writeAll(fs: FileSystem, path: string, bytes: Uint8Array): Promise<void> {
    const h = await fs.open(path, openWrite());
    try {
        let off = 0n;
        while (Number(off) < bytes.length) {
            const n = await h.write(bytes.subarray(Number(off)), off);
            off += BigInt(n);
        }
    } finally {
        await h.close();
    }
}

const openRead = () => ({read: true, write: false, create: false, exclusive: false, truncate: false, append: false, directory: false});
const openWrite = () => ({read: false, write: true, create: true, exclusive: false, truncate: true, append: false, directory: false});
const openReadWrite = () => ({read: true, write: true, create: true, exclusive: false, truncate: false, append: false, directory: false});

export interface FsCase {
    readonly name: string;
    run(fs: FileSystem): Promise<void>;
}

export const FS_CASES: readonly FsCase[] = [
    {
        name: "write then read returns content",
        async run(fs) {
            await writeAll(fs, "/hello.txt", enc.encode("hi\n"));
            const out = await readAll(fs, "/hello.txt");
            assertEq(dec.decode(out), "hi\n", "content");
        },
    },
    {
        name: "open missing file returns ENOENT",
        async run(fs) {
            try {
                await fs.open("/no.txt", openRead());
                throw new Error("expected ENOENT");
            } catch (e) {
                if (!(e instanceof FsError)) throw e;
                assertEq(e.errno, 44, "ENOENT");
            }
        },
    },
    {
        name: "stat reports size + type",
        async run(fs) {
            await writeAll(fs, "/f.txt", enc.encode("12345"));
            const s = await fs.stat("/f.txt");
            assertEq(s.type, "file", "type");
            assertEq(s.size, 5n, "size");
        },
    },
    {
        name: "mkdir + readdir lists entries",
        async run(fs) {
            await fs.mkdir("/d");
            await writeAll(fs, "/d/a.txt", enc.encode("a"));
            await writeAll(fs, "/d/b.txt", enc.encode("b"));
            const dh = await fs.opendir("/d");
            try {
                const entries = await dh.readdir();
                const names = entries.map(e => e.name).sort();
                assertEq(names.join(","), "a.txt,b.txt", "names");
            } finally {
                await dh.close();
            }
        },
    },
    {
        name: "rename moves file",
        async run(fs) {
            await writeAll(fs, "/x.txt", enc.encode("x"));
            await fs.rename("/x.txt", "/y.txt");
            const out = await readAll(fs, "/y.txt");
            assertEq(dec.decode(out), "x", "moved content");
            try {
                await fs.stat("/x.txt");
                throw new Error("source should be gone");
            } catch (e) {
                if (!(e instanceof FsError)) throw e;
                assertEq(e.errno, 44, "ENOENT");
            }
        },
    },
    {
        name: "unlink removes file",
        async run(fs) {
            await writeAll(fs, "/u.txt", enc.encode("u"));
            await fs.unlink("/u.txt");
            try {
                await fs.stat("/u.txt");
                throw new Error("should be gone");
            } catch (e) {
                if (!(e instanceof FsError)) throw e;
                assertEq(e.errno, 44, "ENOENT");
            }
        },
    },
    {
        name: "rmdir removes empty dir",
        async run(fs) {
            await fs.mkdir("/empty");
            await fs.rmdir("/empty");
            try {
                await fs.stat("/empty");
                throw new Error("should be gone");
            } catch (e) {
                if (!(e instanceof FsError)) throw e;
                assertEq(e.errno, 44, "ENOENT");
            }
        },
    },
    {
        name: "rmdir non-empty fails ENOTEMPTY",
        async run(fs) {
            await fs.mkdir("/d2");
            await writeAll(fs, "/d2/f", enc.encode("x"));
            try {
                await fs.rmdir("/d2");
                throw new Error("expected ENOTEMPTY");
            } catch (e) {
                if (!(e instanceof FsError)) throw e;
                assertEq(e.errno, 55, "ENOTEMPTY");
            }
        },
    },
    {
        name: "truncate shrinks file",
        async run(fs) {
            await writeAll(fs, "/t.txt", enc.encode("abcdef"));
            const h = await fs.open("/t.txt", openReadWrite());
            try {
                await h.truncate(3n);
            } finally {
                await h.close();
            }
            const out = await readAll(fs, "/t.txt");
            assertEq(dec.decode(out), "abc", "truncated");
        },
    },
];

export {writeAll, readAll, openRead, openWrite, openReadWrite};
