import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {buildKernel, dec, startServer} from "./helpers.ts";

let listener: ReturnType<typeof startServer>;
beforeAll(() => { listener = startServer(); });
afterAll(() => { listener.stop(true); });

describe("touch", () => {
    it("creates an empty file", async () => {
        const {kernel, fs} = buildKernel(listener);
        const r = await kernel.spawn("touch", ["/new.txt"]);
        expect(r.exitCode).toBe(0);
        const s = await fs.stat("/new.txt");
        expect(s.type).toBe("file");
        expect(s.size).toBe(0n);
    });

    it("missing operand: exit 1", async () => {
        const {kernel} = buildKernel(listener);
        const r = await kernel.spawn("touch", []);
        expect(r.exitCode).toBe(1);
        expect(dec.decode(r.stderr)).toContain("touch: missing operand");
    });
});
