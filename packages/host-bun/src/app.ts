import {serve} from "bun";
import {join} from "node:path";
import {server} from "./server.ts";

const root = join(import.meta.dir, "..", "..", "..");
const binariesDirs = [
    join(root, "packages", "coreutils", "zig-out", "bin"),
    join(root, "packages", "shell", "zig-out", "bin"),
];

const http = server({binariesDirs});
const listener = serve({
    port: Number(process.env.PORT ?? 3000),
    fetch: http,
});

console.log(`browser-agent-os dev server listening on ${listener.url}`);
for (const dir of binariesDirs) {
    console.log(`  binaries served from ${dir}/<name>.wasm`);
}
