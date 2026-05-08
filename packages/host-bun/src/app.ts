import {serve} from "bun";
import {join} from "node:path";
import {server} from "./server.ts";

const root = join(import.meta.dir, "..", "..", "..");
const binariesDir = join(root, "packages", "coreutils", "zig-out", "bin");

const http = server({binariesDir});
const listener = serve({
    port: Number(process.env.PORT ?? 3000),
    fetch: http,
});

console.log(`browser-agent-os dev server listening on ${listener.url}`);
console.log(`  binaries served from ${binariesDir}/<name>.wasm`);
