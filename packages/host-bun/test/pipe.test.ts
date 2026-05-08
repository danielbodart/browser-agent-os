import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {join} from "node:path";
import {serve} from "bun";
import {application, JSPITransport, MemoryFs} from "@browser-agent-os/kernel";
import {server} from "../src/server.ts";
import {webWorkerFactory} from "../src/workers.ts";
import {CONTRACT_CASES} from "./pipe.contract.ts";

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

const buildCtx = () => {
    const transport = new JSPITransport({
        workerFactory: webWorkerFactory,
        runnerUrl: RUNNER,
    });
    const app = application({
        binaryResolver: name => new URL(`/bin/${name}`, listener.url),
        transport,
        fs: new MemoryFs(),
    });
    return {kernel: app.kernel, transport};
};

describe("pipe contract — JSPITransport in Bun.Worker", () => {
    for (const c of CONTRACT_CASES) {
        it(c.name, async () => {
            await c.run(buildCtx());
            expect(true).toBe(true);
        });
    }
});
