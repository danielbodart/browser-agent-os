import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {buildKernel, dec, startServer} from "./helpers.ts";

let listener: ReturnType<typeof startServer>;
beforeAll(() => { listener = startServer(); });
afterAll(() => { listener.stop(true); });

describe("mkdir", () => {
    it("creates a directory", async () => {
        const {kernel, fs} = buildKernel(listener);
        const r = await kernel.spawn("mkdir", ["/d"]);
        expect(r.exitCode).toBe(0);
        const s = await fs.stat("/d");
        expect(s.type).toBe("directory");
    });

    it("-p creates parents", async () => {
        const {kernel, fs} = buildKernel(listener);
        const r = await kernel.spawn("mkdir", ["-p", "/a/b/c"]);
        expect(r.exitCode).toBe(0);
        expect((await fs.stat("/a")).type).toBe("directory");
        expect((await fs.stat("/a/b")).type).toBe("directory");
        expect((await fs.stat("/a/b/c")).type).toBe("directory");
    });

    it("missing parent without -p: exit 1", async () => {
        const {kernel} = buildKernel(listener);
        const r = await kernel.spawn("mkdir", ["/missing/child"]);
        expect(r.exitCode).toBe(1);
        expect(dec.decode(r.stderr)).toContain("mkdir");
    });
});
