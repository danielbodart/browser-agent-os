import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {join} from "node:path";
import {serve} from "bun";
import {application, JSPITransport, MemoryFs} from "@browser-agent-os/kernel";
import {server} from "../src/server.ts";
import {webWorkerFactory} from "../src/workers.ts";
import {readAll} from "./fs.contract.ts";

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

const buildCtx = () => {
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
    return {kernel: app.kernel, transport, fs};
};

describe("sh — Stage 4 acceptance", () => {
    it("echo hello | exit -> stdout = hello\\n", async () => {
        const {kernel, transport} = buildCtx();
        const stdin = kernel.pipe();
        const buf = transport.pipeBuffer(stdin.writeEnd);
        await buf.write(enc.encode("echo hello\nexit\n"));
        transport.closeWriteEnd(stdin.writeEnd);
        const r = await kernel.spawn("sh", [], {PATH: "/bin"}, new Map([[0, stdin.readEnd]]));
        expect(dec.decode(r.stdout)).toBe("hello\n");
        expect(r.exitCode).toBe(0);
    });

    it("echo hello | cat -> hello\\n", async () => {
        const {kernel, transport} = buildCtx();
        const stdin = kernel.pipe();
        const buf = transport.pipeBuffer(stdin.writeEnd);
        await buf.write(enc.encode("echo hello | cat\nexit\n"));
        transport.closeWriteEnd(stdin.writeEnd);
        const r = await kernel.spawn("sh", [], {PATH: "/bin"}, new Map([[0, stdin.readEnd]]));
        expect(dec.decode(r.stdout)).toBe("hello\n");
        expect(r.exitCode).toBe(0);
    });

    it("multi-stage pipeline echo a | cat | cat", async () => {
        const {kernel, transport} = buildCtx();
        const stdin = kernel.pipe();
        const buf = transport.pipeBuffer(stdin.writeEnd);
        await buf.write(enc.encode("echo a | cat | cat\nexit\n"));
        transport.closeWriteEnd(stdin.writeEnd);
        const r = await kernel.spawn("sh", [], {PATH: "/bin"}, new Map([[0, stdin.readEnd]]));
        expect(dec.decode(r.stdout)).toBe("a\n");
        expect(r.exitCode).toBe(0);
    });

    it("redirect: echo hi > /out.txt then cat /out.txt", async () => {
        const {kernel, transport, fs} = buildCtx();
        const stdin = kernel.pipe();
        const buf = transport.pipeBuffer(stdin.writeEnd);
        await buf.write(enc.encode("echo hi > /out.txt\ncat /out.txt\nexit\n"));
        transport.closeWriteEnd(stdin.writeEnd);
        const r = await kernel.spawn("sh", [], {PATH: "/bin"}, new Map([[0, stdin.readEnd]]));
        expect(dec.decode(r.stdout)).toBe("hi\n");
        expect(r.exitCode).toBe(0);
        const persisted = await readAll(fs, "/out.txt");
        expect(dec.decode(persisted)).toBe("hi\n");
    });

    it("builtin: pwd at root", async () => {
        const {kernel, transport} = buildCtx();
        const stdin = kernel.pipe();
        const buf = transport.pipeBuffer(stdin.writeEnd);
        await buf.write(enc.encode("pwd\nexit\n"));
        transport.closeWriteEnd(stdin.writeEnd);
        const r = await kernel.spawn("sh", [], {PATH: "/bin"}, new Map([[0, stdin.readEnd]]));
        expect(dec.decode(r.stdout)).toBe("/\n");
        expect(r.exitCode).toBe(0);
    });

    it("exit code propagates: exit 7", async () => {
        const {kernel, transport} = buildCtx();
        const stdin = kernel.pipe();
        const buf = transport.pipeBuffer(stdin.writeEnd);
        await buf.write(enc.encode("exit 7\n"));
        transport.closeWriteEnd(stdin.writeEnd);
        const r = await kernel.spawn("sh", [], {PATH: "/bin"}, new Map([[0, stdin.readEnd]]));
        expect(r.exitCode).toBe(7);
    });
});
