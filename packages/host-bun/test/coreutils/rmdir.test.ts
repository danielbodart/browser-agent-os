import {describe, it, expect, beforeAll, afterAll} from "bun:test";
import {buildKernel, dec, startServer, writeFile} from "./helpers.ts";
import {FsError} from "@browser-agent-os/kernel";

let listener: ReturnType<typeof startServer>;
beforeAll(() => { listener = startServer(); });
afterAll(() => { listener.stop(true); });

describe("rmdir", () => {
    it("removes empty directory", async () => {
        const {kernel, fs} = buildKernel(listener);
        await fs.mkdir("/empty");
        const r = await kernel.spawn("rmdir", ["/empty"]);
        expect(r.exitCode).toBe(0);
        await expect(fs.stat("/empty")).rejects.toBeInstanceOf(FsError);
    });

    it("non-empty: exit 1", async () => {
        const {kernel, fs} = buildKernel(listener);
        await fs.mkdir("/full");
        await writeFile(fs, "/full/f", "x");
        const r = await kernel.spawn("rmdir", ["/full"]);
        expect(r.exitCode).toBe(1);
        expect(dec.decode(r.stderr)).toContain("rmdir: /full");
    });
});
