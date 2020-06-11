import * as proc from 'child_process';
import * as readline from 'readline';
import * as output from './output';

export interface OutputHandler {
    handleRaw(output: string): void
    handleStreamRecrod(record: output.StreamRecord): void;
    handleAsyncOutput(output: output.AsyncOutput): void;
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
    private process?: proc.ChildProcess;
    private loaded = false;
    private pendingBreakpoints: MiBreakpoint[] = [];
    private currentToken = 1;

    private handlers: { [index: number]: (output: output.Output) => any } = {};

    connect(handler: OutputHandler) {
        let command = proc.spawn('lldb-mi');
        let buffer = '';

        readline.createInterface({ input: command.stdout, terminal: false }).on('line', line => {
            handler.handleRaw(line);
            buffer += line;

            if (buffer.endsWith('(gdb)')) {
                let result = output.fromOutput(buffer);

                if (result !== null) {
                    for (let single of result) {
                        for (let streamRec of single.streamRecords) {
                            handler.handleStreamRecrod(streamRec);
                        }

                        for (let asyncOutput of single.asyncOutputs) {
                            handler.handleAsyncOutput(asyncOutput);
                        }

                        let token = single.result?.token;
                        if (token) {
                            this.handlers[+token](single);
                        }
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

    async execute(command: string): Promise<output.Output> {
        let token = this.currentToken++;
        return new Promise((resolve, reject) => {
            this.handlers[token] = (output: output.Output) => {
                resolve(output);
            };
            this.sendRaw(`${token}-${command}`);
        });
    }

    async fetchFeatures(): Promise<output.Output> {
        return this.execute('list-features');
    }

    async loadExecutable(executable: string): Promise<output.Output> {
        this.loaded = true;
        let result = this.execute('file-exec-and-symbols ' + executable);

        let len = this.pendingBreakpoints.length;
        for (let i = 0; i < len; i++) {
            let bp = this.pendingBreakpoints.pop();
            if (bp) {
                this.setBreakpoint(bp);
            }
        }

        return result;
    }

    async run(): Promise<output.Output> {
        return this.execute('exec-run');
    }

    async continue(): Promise<output.Output> {
        return this.execute('exec-continue');
    }

    async next(): Promise<output.Output> {
        return this.execute('exec-next');
    }

    async removeBreakpoint(id: number) {
        return this.execute(`break-delete ${id}`);
    }

    async setBreakpoint(bp: MiBreakpoint) {
        if (!this.loaded) {
            this.pendingBreakpoints.push(bp);
        } else {
            return this.execute(`break-insert -f ${bp.toLocation()}`);
        }
    }

    async stackTrace(): Promise<output.Output> {
        return this.execute('stack-list-frames');
    }
}