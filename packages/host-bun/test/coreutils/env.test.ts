import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {buildKernel, dec, startServer} from "./helpers.ts";

let listener: ReturnType<typeof startServer>;
beforeAll(() => { listener = startServer(); });
afterAll(() => { listener.stop(true); });

describe("env", () => {
    it("prints supplied env as K=V lines", async () => {
        const {kernel} = buildKernel(listener);
        const r = await kernel.spawn("env", [], {FOO: "bar", BAZ: "qux"});
        expect(r.exitCode).toBe(0);
        const lines = dec.decode(r.stdout).trim().split("\n").sort();
        expect(lines).toEqual(["BAZ=qux", "FOO=bar"]);
    });

    it("empty env produces no output", async () => {
        const {kernel} = buildKernel(listener);
        const r = await kernel.spawn("env", [], {});
        expect(r.exitCode).toBe(0);
        expect(r.stdout.length).toBe(0);
    });
});
