import { LoggingDebugSession, InitializedEvent, OutputEvent } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import * as vscode from 'vscode';
import { ExtensionTerminalOptions } from 'vscode';

import { MiConnection, OutputHandler } from './mi/connection';
import { Output, StreamRecordType } from './mi/output';

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    target: string;
}

export class LLDBDebugSession extends LoggingDebugSession implements OutputHandler {
    miConnection?: MiConnection;
    outputChannel?: vscode.OutputChannel;
    writeEmitter: vscode.EventEmitter<string>;

    constructor() {
        super();

        this.writeEmitter = new vscode.EventEmitter<string>();
        const pty: vscode.Pseudoterminal = {
            onDidWrite: this.writeEmitter.event,
            open: () => { },
            close: () => { }
        };
        let term = vscode.window.createTerminal({ name: 'Kantan', pty });
        term.show();

        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);
    }

    handle(output: Output) {
        for (let streamRec of output.streamRecords) {
            if (streamRec.type === StreamRecordType.Target) {
                let output = streamRec.output.substr(1, streamRec.output.length - 2);
                output = output.replace('\\n', '\n');
                output = output.replace('\\r', '\r');

                this.writeEmitter.fire(output);

                console.log(output);
            }
        }

        console.log(output);
    }

    initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) {
        response.body = response.body || {};
        // response.body.supportsDataBreakpoints = true;
        // response.body.supportsInstructionBreakpoints = true;
        // response.body.supportsBreakpointLocationsRequest = true;
        this.sendEvent(new InitializedEvent());
        this.sendResponse(response);
    }

    launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments, request?: DebugProtocol.Request) {
        this.miConnection = new MiConnection(this);
        this.miConnection.fetchFeatures();
        this.miConnection.loadExecutable(args.target);
        this.miConnection.run();
    }

    setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments, request?: DebugProtocol.Request) {
        console.log('bruh 1');
    }

    breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request) {
        console.log('bruh 2');
    }

    setInstructionBreakpointsRequest(response: DebugProtocol.SetInstructionBreakpointsResponse, args: DebugProtocol.SetInstructionBreakpointsArguments, request?: DebugProtocol.Request) {
        console.log('bruh 3');
    }
}