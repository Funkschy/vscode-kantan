import * as proc from 'child_process';
import * as readline from 'readline';
import * as output from './output';

export interface OutputHandler {
    handleRaw(output: string): void
    handleParsed(output: output.Output): void
}

export class MiBreakpoint {
    file: string;
    line: number;

    constructor(file: string, line: number) {
        this.file = file;
        this.line = line;
    }

    toLocation(): string {
        return `"${this.file}:${this.line}"`;
    }
}

export class MiConnection {
    process?: proc.ChildProcess;
    started = false;
    loaded = false;
    breakpoints: MiBreakpoint[] = [];

    connect(handler: OutputHandler) {
        let command = proc.spawn('lldb-mi');
        let buffer = '';

        readline.createInterface({input: command.stdout, terminal: false}).on('line', line => {
            handler.handleRaw(line);
            buffer += line;

            if (buffer.endsWith('(gdb)')) {
                let result = output.fromOutput(buffer);
                if (result !== null) {
                    for (let single of result) {
                        handler.handleParsed(single);
                    }
                }
                buffer = '';
            }
        });

        this.process = command;
    }

    sendRaw(data: string) {
        this.process?.stdin?.write(data + '\r\n');
    }

    execute(command: string) {
        this.sendRaw(command);
    }

    fetchFeatures() {
        this.execute('-list-features');
    }

    loadExecutable(executable: string) {
        this.loaded = true;
        this.execute('-file-exec-and-symbols ' + executable);

        for (let bp of this.breakpoints) {
            this.setBreakpoint(bp);
        }
    }

    run() {
        this.started = true;
        this.execute('-exec-run');
    }

    setBreakpoint(bp: MiBreakpoint) {
        if (!this.loaded) {
            this.breakpoints.push(bp);
        } else {
            this.execute(`-break-insert -f ${bp.toLocation()}`);
        }
    }

    stackTrace() {
        this.execute('-stack-list-frames');
    }
}