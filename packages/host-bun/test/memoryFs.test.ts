import {describe, it} from "bun:test";
import {MemoryFs} from "@browser-agent-os/kernel";
import {FS_CASES} from "./fs.contract.ts";

describe("FileSystem contract — MemoryFs", () => {
    for (const c of FS_CASES) {
        it(c.name, async () => {
            await c.run(new MemoryFs());
        });
    }
});
