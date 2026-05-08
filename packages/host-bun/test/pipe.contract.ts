import type {Kernel, PipeEnd, Transport} from "@browser-agent-os/kernel";
import {DEFAULT_PIPE_CAPACITY} from "@browser-agent-os/kernel";

const decoder = new TextDecoder();

export interface ContractCtx {
    readonly kernel: Kernel;
    readonly transport: Transport;
}

export interface ContractCase {
    readonly name: string;
    run(ctx: ContractCtx): Promise<void>;
}

export interface ContractResult {
    readonly name: string;
    readonly passed: boolean;
    readonly message?: string;
}

function assertEq<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
}

async function pipeline(
    kernel: Kernel,
    producer: {binary: string; args?: string[]; env?: Record<string, string>},
    consumer: {binary: string; args?: string[]; env?: Record<string, string>},
) {
    const {readEnd, writeEnd} = kernel.pipe();
    return Promise.all([
        kernel.spawn(producer.binary, producer.args, producer.env, new Map([[1, writeEnd]])),
        kernel.spawn(consumer.binary, consumer.args, consumer.env, new Map([[0, readEnd]])),
    ]);
}

const settled = (p: Promise<unknown>): {settled: boolean} => {
    const state = {settled: false};
    p.then(() => { state.settled = true; }, () => { state.settled = true; });
    return state;
};

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export const CONTRACT_CASES: readonly ContractCase[] = [
    {
        name: "echo hello",
        async run({kernel}) {
            const result = await kernel.spawn("echo", ["hello"]);
            assertEq(result.exitCode, 0, "echo exitCode");
            assertEq(decoder.decode(result.stdout), "hello\n", "echo stdout");
            assertEq(result.stderr.length, 0, "echo stderr length");
        },
    },
    {
        name: "echo hello world foo",
        async run({kernel}) {
            const result = await kernel.spawn("echo", ["hello", "world", "foo"]);
            assertEq(result.exitCode, 0, "echo exitCode");
            assertEq(decoder.decode(result.stdout), "hello world foo\n", "echo stdout");
        },
    },
    {
        name: "echo with no args",
        async run({kernel}) {
            const result = await kernel.spawn("echo");
            assertEq(result.exitCode, 0, "echo exitCode");
            assertEq(decoder.decode(result.stdout), "\n", "echo stdout");
        },
    },
    {
        name: "echo hello | cat",
        async run({kernel}) {
            const [echoRes, catRes] = await pipeline(
                kernel,
                {binary: "echo", args: ["hello"]},
                {binary: "cat"},
            );
            assertEq(echoRes.exitCode, 0, "echo exitCode");
            assertEq(catRes.exitCode, 0, "cat exitCode");
            assertEq(decoder.decode(catRes.stdout), "hello\n", "cat stdout");
            assertEq(catRes.stderr.length, 0, "cat stderr length");
        },
    },
    {
        name: "echo hello world foo | cat",
        async run({kernel}) {
            const [, catRes] = await pipeline(
                kernel,
                {binary: "echo", args: ["hello", "world", "foo"]},
                {binary: "cat"},
            );
            assertEq(decoder.decode(catRes.stdout), "hello world foo\n", "cat stdout");
        },
    },
    {
        name: "cat with no input emits empty stdout",
        async run({kernel}) {
            const result = await kernel.spawn("cat");
            assertEq(result.exitCode, 0, "cat exitCode");
            assertEq(result.stdout.length, 0, "cat stdout length");
        },
    },
    {
        name: "backpressure: producer suspends when buffer full without consumer",
        async run({kernel, transport}) {
            const argSize = DEFAULT_PIPE_CAPACITY * 2;
            const arg = "x".repeat(argSize);
            const expected = arg + "\n";

            const {readEnd, writeEnd} = kernel.pipe();
            const echoPromise = kernel.spawn("echo", [arg], {}, new Map([[1, writeEnd]]));
            const echoState = settled(echoPromise);

            await sleep(100);
            if (echoState.settled) {
                throw new Error("echo finished without consumer — pipe backpressure missing");
            }
            const buffered = transport.bufferedBytes(writeEnd);
            if (buffered < DEFAULT_PIPE_CAPACITY) {
                throw new Error(`expected pipe near capacity, buffered=${buffered}`);
            }

            const catPromise = kernel.spawn("cat", [], {}, new Map([[0, readEnd]]));
            const [echoRes, catRes] = await Promise.all([echoPromise, catPromise]);

            assertEq(echoRes.exitCode, 0, "echo exitCode");
            assertEq(catRes.exitCode, 0, "cat exitCode");
            const stdout = decoder.decode(catRes.stdout);
            if (stdout.length !== expected.length) {
                throw new Error(`cat stdout length: expected ${expected.length}, got ${stdout.length}`);
            }
            assertEq(stdout, expected, "cat stdout content");
        },
    },
];

export async function runContract(ctx: ContractCtx): Promise<ContractResult[]> {
    const results: ContractResult[] = [];
    for (const c of CONTRACT_CASES) {
        try {
            await c.run(ctx);
            results.push({name: c.name, passed: true});
        } catch (e) {
            results.push({name: c.name, passed: false, message: (e as Error).message});
        }
    }
    return results;
}
