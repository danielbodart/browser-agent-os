import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {buildKernel, dec, startServer} from "./helpers.ts";

let listener: ReturnType<typeof startServer>;
beforeAll(() => { listener = startServer(); });
afterAll(() => { listener.stop(true); });

describe("pwd", () => {
    it("prints $PWD when set", async () => {
        const {kernel} = buildKernel(listener);
        const r = await kernel.spawn("pwd", [], {PWD: "/home/dan"});
        expect(r.exitCode).toBe(0);
        expect(dec.decode(r.stdout)).toBe("/home/dan\n");
    });

    it("falls back to / when PWD unset", async () => {
        const {kernel} = buildKernel(listener);
        const r = await kernel.spawn("pwd", []);
        expect(r.exitCode).toBe(0);
        expect(dec.decode(r.stdout)).toBe("/\n");
    });
});
