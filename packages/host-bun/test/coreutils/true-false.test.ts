import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {buildKernel, startServer} from "./helpers.ts";

let listener: ReturnType<typeof startServer>;
beforeAll(() => { listener = startServer(); });
afterAll(() => { listener.stop(true); });

describe("true / false", () => {
    it("true exits 0", async () => {
        const {kernel} = buildKernel(listener);
        const r = await kernel.spawn("true", []);
        expect(r.exitCode).toBe(0);
        expect(r.stdout.length).toBe(0);
    });

    it("false exits 1", async () => {
        const {kernel} = buildKernel(listener);
        const r = await kernel.spawn("false", []);
        expect(r.exitCode).toBe(1);
    });
});
