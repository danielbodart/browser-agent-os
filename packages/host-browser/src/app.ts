import {Terminal} from "@xterm/xterm";
import {
    application,
    JSPITransport,
    OpfsFs,
    type OpfsFsBackend,
    type PipeBuffer,
    type PipeEnd,
} from "@browser-agent-os/kernel";
import {webWorkerFactory} from "@browser-agent-os/host-bun";
import {createLineDiscipline} from "./lineDiscipline.ts";

function makeOpfsBackend(workerUrl: string): OpfsFsBackend {
    const worker = new Worker(workerUrl, {type: "module"});
    worker.addEventListener("error", e => {
        console.error("[opfs worker error]", (e as ErrorEvent).message);
    });
    return {
        postMessage(msg) { worker.postMessage(msg); },
        addReplyListener(handler) {
            worker.addEventListener("message", e => handler((e as MessageEvent).data));
        },
    };
}

async function drainToTerminal(buf: PipeBuffer, terminal: Terminal): Promise<void> {
    const tmp = new Uint8Array(4096);
    const dec = new TextDecoder();
    while (true) {
        const n = await buf.read(tmp);
        if (n === 0) break;
        terminal.write(dec.decode(tmp.subarray(0, n)));
    }
}

async function main(): Promise<void> {
    const root = document.getElementById("term");
    if (!root) throw new Error("missing #term element");
    const terminal = new Terminal({convertEol: true, cursorBlink: true});
    terminal.open(root);
    terminal.focus();

    const transport = new JSPITransport({
        workerFactory: webWorkerFactory,
        runnerUrl: "/runner.jspi.web.js",
    });
    const fs = new OpfsFs(makeOpfsBackend("/runner.opfs.web.js"));

    const app = application({
        transport,
        fs,
        binaryResolver: name => `/bin/${name}`,
    });
    const kernel = app.kernel;

    const stdin = kernel.pipe();
    const stdout = kernel.pipe();
    const stderr = kernel.pipe();

    const stdinBuf = transport.pipeBuffer(stdin.writeEnd);
    const stdoutBuf = transport.pipeBuffer(stdout.readEnd);
    const stderrBuf = transport.pipeBuffer(stderr.readEnd);

    const enc = new TextEncoder();
    const sendLine = (line: string): void => {
        void stdinBuf.write(enc.encode(line + "\n"));
    };
    const ld = createLineDiscipline({terminal, sendLine});
    terminal.onData(data => ld.onData(data));

    void drainToTerminal(stdoutBuf, terminal);
    void drainToTerminal(stderrBuf, terminal);

    // Test hooks (harmless; used by Playwright smoke test).
    const win = window as unknown as Record<string, unknown>;
    win.__sendLine = sendLine;
    win.__terminalText = (): string => {
        const buffer = terminal.buffer.active;
        const lines: string[] = [];
        for (let y = 0; y < buffer.length; y++) {
            const row = buffer.getLine(y);
            if (row) lines.push(row.translateToString(true));
        }
        return lines.join("\n");
    };
    win.__shellReady = true;

    const result = await kernel.spawn(
        "sh",
        ["-i"],
        {PATH: "/bin"},
        new Map<number, PipeEnd>([
            [0, stdin.readEnd],
            [1, stdout.writeEnd],
            [2, stderr.writeEnd],
        ]),
    );
    terminal.write(`\r\n[shell exited ${result.exitCode}]\r\n`);
    win.__shellExited = result.exitCode;
}

void main().catch(err => {
    console.error("[host-browser fatal]", err);
    document.body.append(`fatal: ${(err as Error).message}`);
});
