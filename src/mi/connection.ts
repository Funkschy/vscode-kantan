import * as proc from 'child_process';
import * as readline from 'readline';
import * as output from './output';
import * as r from './mapping';

export interface OutputHandler {
    handleRaw(output: string): void
    handleStreamRecord(record: output.StreamRecord): void;
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

    async connect(handler: OutputHandler, cwd: string) {
        let command = proc.spawn('lldb-mi', [], {cwd: cwd, env: process.env});
        let buffer = '';

        readline.createInterface({ input: command.stdout, terminal: false }).on('line', line => {
            handler.handleRaw(line);
            buffer += line;

            if (buffer.endsWith('(gdb)')) {
                let result = output.fromOutput(buffer);

                if (result !== null) {
                    this.dispatchOutput(handler, result);
                }
                buffer = '';
            }
        });

        this.process = command;
        await this.executeMi(`environment-cd ${cwd}`);
    }

    dispatchOutput(handler: OutputHandler, result: output.Output[]) {
        for (let single of result) {
            for (let streamRec of single.streamRecords) {
                handler.handleStreamRecord(streamRec);
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

    sendRaw(data: string) {
        this.process?.stdin?.write(data + '\r\n');
    }

    async execute(command: string, sep: string): Promise<output.Output> {
        let token = this.currentToken++;
        return new Promise((resolve, reject) => {
            this.handlers[token] = (output: output.Output) => {
                resolve(output);
            };
            this.sendRaw(`${token}${sep}${command}`);
        });
    }

    async executeMi(command: string): Promise<output.Output> {
        return this.execute(command, '-');
    }

    async executeCli(command: string): Promise<output.Output> {
        return this.execute(command, ' ');
    }

    async fetchFeatures(): Promise<output.Output> {
        return this.executeMi('list-features');
    }

    async loadExecutable(executable: string): Promise<output.Output> {
        this.loaded = true;
        let result = this.executeMi('file-exec-and-symbols ' + executable);

        let len = this.pendingBreakpoints.length;
        for (let i = 0; i < len; i++) {
            let bp = this.pendingBreakpoints.pop();
            if (bp) {
                this.setBreakpoint(bp);
            }
        }

        return result;
    }

    async run(args: string[]): Promise<output.Output> {
        if (args.length > 0) {
            await this.executeMi(`exec-arguments ${args.join(', ')}`);
        }
        return this.executeCli('run');
    }

    async continue(): Promise<output.Output> {
        return this.executeMi('exec-continue');
    }

    async next(): Promise<output.Output> {
        return this.executeMi('exec-next');
    }

    async step(): Promise<output.Output> {
        return this.executeMi('exec-step');
    }

    async finish(): Promise<output.Output> {
        return this.executeMi('exec-finish');
    }

    async removeBreakpoint(id: number): Promise<output.Output> {
        await this.executeMi(`break-disable ${id}`);
        return this.executeMi(`break-delete ${id}`);
    }

    async setBreakpoint(bp: MiBreakpoint): Promise<r.MappingError | r.BreakpointResult | number> {
        if (!this.loaded) {
            this.pendingBreakpoints.push(bp);
            return this.pendingBreakpoints.length;
        } else {
            return this.executeMi(`break-insert -f ${bp.toLocation()}`).then( out =>
                r.BreakpointResult.fromOutput(out)
            );
        }
    }

    async stackTrace(): Promise<r.StacktraceResult | r.MappingError> {
        return this.executeMi('stack-list-frames')
            .then(out => r.StacktraceResult.fromOutput(out));
    }

    async listArgs(): Promise<r.FuncArgsResult | r.MappingError> {
        return this.executeMi('stack-list-arguments 0 0 0')
            .then(out => r.FuncArgsResult.fromOutput(out));
    }

    async listLocals(): Promise<r.LocalsResult | r.MappingError> {
        return this.executeMi('stack-list-locals 2')
            .then(out => r.LocalsResult.fromOutput(out));
    }

    async varCreate(name: string, expr?: string): Promise<output.Output> {
        if (!expr) {
            expr = name;
        }

        return this.executeMi(`var-create ${name} * ${expr}`);
    }

    async listChildren(name: string): Promise<r.ListChildrenResult | r.MappingError> {
        return this.executeMi(`var-list-children ${name}`)
            .then(out => r.ListChildrenResult.fromOutput(out));
    }

    async varDelete(name: string): Promise<output.Output> {
        return this.executeMi(`var-delete ${name}`);
    }

    // -var-create t * t
    // ^done,name="t",numchild="2",value="{...}",type="bintree.Test",thread-id="1",has_more="0"
    // (gdb)
    // -var-evaluate-expression t
    // ^done,value="{...}"
    // (gdb)
    // -var-list-children t
    // ^done,numchild="2",children=[child={name="t.i",exp="i",numchild="0",type="int",thread-id="1",has_more="0"},child={name="t.p",exp="p",numchild="2",type="bintree.Person",thread-id="1",has_more="0"}],has_more="0"
    // (gdb)
    async evaluate(expr: string): Promise<output.Output> {
        return this.executeMi(`var-evaluate-expression ${expr}`);
    }
}