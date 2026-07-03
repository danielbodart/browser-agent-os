import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {join} from "node:path";
import {serve} from "bun";
import {application, JSPITransport, MemoryFs} from "@browser-agent-os/kernel";
import {server} from "../src/server.ts";
import {webWorkerFactory} from "../src/workers.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const COREUTILS = join(ROOT, "packages", "coreutils", "zig-out", "bin");
const SHELL = join(ROOT, "packages", "shell", "zig-out", "bin");
const RUNNER = join(ROOT, "packages", "kernel", "src", "worker", "runner.jspi.web.ts");

let listener: ReturnType<typeof serve>;
beforeAll(() => {
    listener = serve({port: 0, fetch: server({binariesDirs: [COREUTILS, SHELL]})});
});
afterAll(() => {
    listener.stop(true);
});

const dec = new TextDecoder();
const enc = new TextEncoder();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const buildCtx = () => {
    const fs = new MemoryFs();
    const transport = new JSPITransport({workerFactory: webWorkerFactory, runnerUrl: RUNNER});
    const app = application({
        binaryResolver: name => new URL(`/bin/${name}`, listener.url),
        transport,
        fs,
    });
    return {kernel: app.kernel, transport};
};

describe("sh — streaming stdin (staggered arrival on an open pipe)", () => {
    // These feed stdin in chunks with delays and keep the write end OPEN between
    // chunks, unlike shell.test.ts which closes it up-front. That forces the shell's
    // stdin reader to block on an empty pipe and resume when the next chunk arrives
    // (a JSPI suspend/resume) — the interactive REPL scenario. The builtin case
    // isolates the reader from proc_spawn; the echo case exercises both plus the
    // shared-stdout write-end refcount.
    it("staggered pwd — reader must block then resume", async () => {
        const {kernel, transport} = buildCtx();
        const stdin = kernel.pipe();
        const buf = transport.pipeBuffer(stdin.writeEnd);
        await buf.write(enc.encode("pwd\n"));
        const done = kernel.spawn("sh", [], {PATH: "/bin"}, new Map([[0, stdin.readEnd]]));
        await sleep(300);
        await buf.write(enc.encode("pwd\n"));
        await sleep(300);
        await buf.write(enc.encode("exit\n"));
        transport.closeWriteEnd(stdin.writeEnd);
        const r = await done;
        expect(dec.decode(r.stdout)).toBe("/\n/\n");
        expect(r.exitCode).toBe(0);
    });

    it("staggered echo — reader + spawn together", async () => {
        const {kernel, transport} = buildCtx();
        const stdin = kernel.pipe();
        const buf = transport.pipeBuffer(stdin.writeEnd);
        await buf.write(enc.encode("echo one\n"));
        const done = kernel.spawn("sh", [], {PATH: "/bin"}, new Map([[0, stdin.readEnd]]));
        await sleep(300);
        await buf.write(enc.encode("echo two\n"));
        await sleep(300);
        await buf.write(enc.encode("exit\n"));
        transport.closeWriteEnd(stdin.writeEnd);
        const r = await done;
        expect(dec.decode(r.stdout)).toBe("one\ntwo\n");
        expect(r.exitCode).toBe(0);
    });
});
