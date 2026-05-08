#!/usr/bin/env bun
import {Glob, $} from "bun";

const dir = process.argv[2];
if (!dir) {
    console.error("usage: wasm-opt.ts <bin-dir>");
    process.exit(1);
}

const files = Array.from(new Glob("*.wasm").scanSync(dir));
if (files.length === 0) {
    console.log(`no .wasm files in ${dir}`);
    process.exit(0);
}

const wasmOpt = "./node_modules/.bin/wasm-opt";

await Promise.all(files.map(async (name) => {
    const path = `${dir}/${name}`;
    const before = Bun.file(path).size;
    await $`${wasmOpt} -Oz \
        --enable-bulk-memory \
        --enable-sign-ext \
        --enable-mutable-globals \
        --enable-nontrapping-float-to-int \
        --enable-reference-types \
        ${path} -o ${path}`.quiet();
    const after = Bun.file(path).size;
    const saved = before - after;
    const pct = Math.round((saved * 100) / before);
    console.log(`  ${name}: ${before} -> ${after} (-${pct}%)`);
}));
