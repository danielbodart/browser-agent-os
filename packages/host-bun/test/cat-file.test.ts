import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {join} from "node:path";
import {serve} from "bun";
import {application, JSPITransport, MemoryFs} from "@browser-agent-os/kernel";
import {server} from "../src/server.ts";
import {webWorkerFactory} from "../src/workers.ts";
import {writeAll} from "./fs.contract.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const BINARIES = join(ROOT, "packages", "coreutils", "zig-out", "bin");
const RUNNER = join(ROOT, "packages", "kernel", "src", "worker", "runner.jspi.web.ts");

let listener: ReturnType<typeof serve>;

beforeAll(() => {
    listener = serve({port: 0, fetch: server({binariesDir: BINARIES})});
});

afterAll(() => {
    listener.stop(true);
});

const dec = new TextDecoder();
const enc = new TextEncoder();

const buildKernel = () => {
    const fs = new MemoryFs();
    const transport = new JSPITransport({
        workerFactory: webWorkerFactory,
        runnerUrl: RUNNER,
    });
    const app = application({
        binaryResolver: name => new URL(`/bin/${name}`, listener.url),
        transport,
        fs,
    });
    return {kernel: app.kernel, fs};
};

describe("cat <file>", () => {
    it("reads file from MemoryFs to stdout", async () => {
        const {kernel, fs} = buildKernel();
        await writeAll(fs, "/hello.txt", enc.encode("hi\n"));
        const r = await kernel.spawn("cat", ["/hello.txt"]);
        expect(r.exitCode).toBe(0);
        expect(dec.decode(r.stdout)).toBe("hi\n");
        expect(r.stderr.length).toBe(0);
    });

    it("missing file: exit 1, stderr message", async () => {
        const {kernel} = buildKernel();
        const r = await kernel.spawn("cat", ["/no.txt"]);
        expect(r.exitCode).toBe(1);
        expect(dec.decode(r.stderr)).toContain("cat: /no.txt: No such file or directory");
    });

    it("multiple files concatenate", async () => {
        const {kernel, fs} = buildKernel();
        await writeAll(fs, "/a.txt", enc.encode("a\n"));
        await writeAll(fs, "/b.txt", enc.encode("b\n"));
        const r = await kernel.spawn("cat", ["/a.txt", "/b.txt"]);
        expect(r.exitCode).toBe(0);
        expect(dec.decode(r.stdout)).toBe("a\nb\n");
    });
});
