import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {join} from "node:path";
import {serve} from "bun";
import {server} from "../src/server.ts";
import {CONTRACT_CASES, type ContractResult} from "./pipe.contract.ts";

const ROOT = join(import.meta.dir, "..", "..", "..");
const BINARIES = join(ROOT, "packages", "coreutils", "zig-out", "bin");
const RUNNER = join(import.meta.dir, "jspi", "runner.mjs");

let listener: ReturnType<typeof serve>;
let results: readonly ContractResult[] | null = null;
let runError: string | null = null;

beforeAll(async () => {
    listener = serve({port: 0, fetch: server({binariesDir: BINARIES})});

    const proc = Bun.spawn(
        [
            "node",
            "--experimental-wasm-jspi",
            "--experimental-transform-types",
            "--no-warnings",
            RUNNER,
            listener.url.toString(),
        ],
        {
            stdout: "pipe",
            stderr: "pipe",
            cwd: ROOT,
        },
    );

    const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);

    if (code !== 0) {
        runError = `node subprocess exit=${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
        return;
    }

    const lastLine = stdout.trim().split("\n").pop() ?? "";
    try {
        results = JSON.parse(lastLine) as ContractResult[];
    } catch (e) {
        runError = `failed to parse runner stdout: ${(e as Error).message}\nstdout:\n${stdout}\nstderr:\n${stderr}`;
    }
});

afterAll(() => {
    listener?.stop(true);
});

describe("pipe contract — JSPITransport (Node subprocess)", () => {
    for (const c of CONTRACT_CASES) {
        it(c.name, () => {
            if (runError) throw new Error(runError);
            if (!results) throw new Error("no results from runner");
            const r = results.find(x => x.name === c.name);
            if (!r) throw new Error(`no result for case "${c.name}"`);
            if (!r.passed) throw new Error(r.message ?? `case "${c.name}" failed`);
            expect(r.passed).toBe(true);
        });
    }
});
