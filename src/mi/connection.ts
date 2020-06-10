import * as proc from 'child_process';
import * as readline from 'readline';
import * as output from './output';

export interface OutputHandler {
    handle(output: output.Output): void
}

export class MiConnection {
    process: proc.ChildProcess;

    constructor(handler: OutputHandler) {
        let command = proc.spawn('lldb-mi');
        let buffer = '';

        readline.createInterface({input: command.stdout, terminal: false}).on('line', line => {
            buffer += line;

            if (buffer.endsWith('(gdb)')) {
                let result = output.fromOutput(buffer);
                if (result !== null) {
                    for (let single of result) {
                        handler.handle(single);
                    }
                }
                buffer = '';
            }
        });

        this.process = command;
    }

    sendRaw(data: string) {
        this.process.stdin?.write(data + '\r\n');
    }

    execute(command: string) {
        this.sendRaw(command);
    }

    fetchFeatures() {
        this.execute('-list-features');
    }

    loadExecutable(executable: string) {
        this.execute('-file-exec-and-symbols ' + executable);
    }

    run() {
        this.execute('-exec-run');
    }
}