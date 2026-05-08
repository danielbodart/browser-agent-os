import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {join} from "node:path";
import {serve} from "bun";
import {application} from "@browser-agent-os/kernel";
import {server} from "../src/server.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const BINARIES = join(ROOT, "packages", "coreutils", "zig-out", "bin");
const RUNNER = join(ROOT, "packages", "kernel", "src", "worker", "runner.ts");

let listener: ReturnType<typeof serve>;

beforeAll(() => {
    listener = serve({port: 0, fetch: server({binariesDir: BINARIES})});
});

afterAll(() => {
    listener.stop(true);
});

const decoder = new TextDecoder();

describe("kernel.spawn echo", () => {
    it("echoes a single argument with trailing newline", async () => {
        const app = application({
            binaryResolver: name => new URL(`/bin/${name}`, listener.url),
            workerFactory: () => new Worker(RUNNER),
        });

        const result = await app.kernel.spawn("echo", ["hello"]);

        expect(result.exitCode).toBe(0);
        expect(decoder.decode(result.stdout)).toBe("hello\n");
        expect(result.stderr.length).toBe(0);
    });

    it("space-separates multiple arguments", async () => {
        const app = application({
            binaryResolver: name => new URL(`/bin/${name}`, listener.url),
            workerFactory: () => new Worker(RUNNER),
        });

        const result = await app.kernel.spawn("echo", ["hello", "world", "foo"]);

        expect(result.exitCode).toBe(0);
        expect(decoder.decode(result.stdout)).toBe("hello world foo\n");
    });

    it("emits just a newline when given no arguments", async () => {
        const app = application({
            binaryResolver: name => new URL(`/bin/${name}`, listener.url),
            workerFactory: () => new Worker(RUNNER),
        });

        const result = await app.kernel.spawn("echo");

        expect(result.exitCode).toBe(0);
        expect(decoder.decode(result.stdout)).toBe("\n");
    });
});
