import type {Terminal} from "@xterm/xterm";

export interface LineDiscipline {
    onData(data: string): void;
}

export interface LineDisciplineDeps {
    readonly terminal: Terminal;
    readonly sendLine: (line: string) => void;
}

export function createLineDiscipline(deps: LineDisciplineDeps): LineDiscipline {
    const {terminal, sendLine} = deps;
    let buf: string[] = [];
    return {
        onData(data: string): void {
            for (const ch of data) {
                if (ch === "\r" || ch === "\n") {
                    terminal.write("\r\n");
                    sendLine(buf.join(""));
                    buf = [];
                    continue;
                }
                if (ch === "\x7f" || ch === "\b") {
                    if (buf.length > 0) {
                        buf.pop();
                        terminal.write("\b \b");
                    }
                    continue;
                }
                if (ch === "\t" || ch >= " ") {
                    buf.push(ch);
                    terminal.write(ch);
                }
            }
        },
    };
}
