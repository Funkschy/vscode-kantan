import { DebugSession, InitializedEvent, Thread, OutputEvent, BreakpointEvent, Breakpoint, Source, StoppedEvent, StackFrame } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import * as vscode from 'vscode';
const { Subject } = require('await-notify');

import { MiConnection, OutputHandler, MiBreakpoint } from './mi/connection';
import { Output, StreamRecordType, Result, Value } from './mi/output';

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    target: string;
}

class BreakpointInfo {
    vsBp: Breakpoint;
    miBp: MiBreakpoint;

    constructor(vsBp: Breakpoint, miBp: MiBreakpoint) {
        this.vsBp = vsBp;
        this.miBp = miBp;
    }
}

export class LLDBDebugSession extends DebugSession implements OutputHandler {
    private miConnection: MiConnection;
    private writeEmitter: vscode.EventEmitter<string>;
    private _configurationDone = new Subject();

    // full filepath -> line -> Breakpoint
    private breakpoints: Map<string, Map<number, BreakpointInfo>> = new Map();

    constructor() {
        super();

		this.setDebuggerLinesStartAt1(true);
		this.setDebuggerColumnsStartAt1(true);

        this.miConnection = new MiConnection();

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

    handleParsed(output: Output) {
        for (let streamRec of output.streamRecords) {
            if (streamRec.type === StreamRecordType.Target) {
                let output = streamRec.output.substr(1, streamRec.output.length - 2);
                output = output.replace('\\n', '\n');
                output = output.replace('\\r', '\r');

                // TODO: emit outputevent
                this.writeEmitter.fire(output);

                console.log(output);
            }
        }

        if (output.asyncOutputs.length > 0) {
            for (let asyncOutput of output.asyncOutputs) {
                let map = asyncOutput.results.reduce((obj: any, item) => {
                    obj[item.variable] = item.value;
                    return obj;
                }, new Map<string, Value>());

                if (map['reason'].content !== '"breakpoint-hit"') {
                    break;
                }

                let frame = map['frame'];
                let frameData = frame.content.reduce((obj: any, item: Result) => {
                    obj[item.variable] = item.value;
                    return obj;
                }, new Map<string, Value>());

                // remove ""
                const fromStr = (str: string) => str.substr(1, str.length - 2);

                let line = +fromStr(frameData['line'].content);
                // let file = fromStr(frameData['file'].content);
                let fullname = fromStr(frameData['fullname'].content);
                let threadId = +fromStr(map['thread-id'].content);

                let bp = this.breakpoints.get(fullname)?.get(line)?.vsBp;
                if (bp) {
                    bp.verified = true;
                    this.sendEvent(new BreakpointEvent('changed', bp));
                }

                // this.emit('breakpointValidated', bp);
                this.sendEvent(new StoppedEvent('breakpoint', threadId));
            }
        }

        console.log(output);
    }

    handleRaw(output: string) {
        this.sendEvent(new OutputEvent(output + '\n'));
    }

    initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) {
        response.body = response.body || {};

		response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsInstructionBreakpoints = true;
        response.body.supportsBreakpointLocationsRequest = true;

        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }

    async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments, request?: DebugProtocol.Request) {
		// wait until configuration has finished (and configurationDoneRequest has been called)
		await this._configurationDone.wait(1000);

        this.miConnection.connect(this);
        this.miConnection.fetchFeatures();
        this.miConnection.loadExecutable(args.target);
        this.miConnection.run();
        this.sendResponse(response);
    }

    configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments) {
		super.configurationDoneRequest(response, args);

		// notify the launchRequest that configuration has finished
		this._configurationDone.notify();
	}

    setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments, request?: DebugProtocol.Request) {
        let path = args.source.path;
        if (path === undefined) {
            path = '';
        }
        let name = args.source.name;
        if (name === undefined) {
            name = '';
        }

        let src = new Source(name, path);
        let points: Breakpoint[] = [];

        for (let bp of request?.arguments.breakpoints) {
            if (!this.breakpoints.get(path)) {
                this.breakpoints.set(path, new Map());
            }
            let vsBp = new Breakpoint(true, bp.line, undefined, src);
            let miBp = new MiBreakpoint(path, bp.line);
            let info = new BreakpointInfo(vsBp, miBp);
            this.breakpoints.get(path)?.set(bp.line, info);
            points.push(vsBp);
            this.miConnection?.setBreakpoint(miBp);

            this.sendEvent(new BreakpointEvent('new', vsBp));
        }

        response.body = {
            breakpoints: points 
        };
        this.sendResponse(response);
    }

    breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request) {
        response.body = {
            breakpoints: []
        };

        let path = args.source.path;
        if (path) {
            const bp = this.breakpoints.get(path)?.get(args.line)?.miBp;
            if (bp) {
                response.body = {
                    breakpoints: [{
                        line: bp.line,
                        column: 5
                    }]
                };
            }
        }

        this.sendResponse(response);
    }

    setInstructionBreakpointsRequest(response: DebugProtocol.SetInstructionBreakpointsResponse, args: DebugProtocol.SetInstructionBreakpointsArguments, request?: DebugProtocol.Request) {
        super.setInstructionBreakpointsRequest(response, args, request);
        console.log('bruh 3');
    }

	stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
        this.miConnection.stackTrace();

        let src = new Source('bintree.kan', '/home/felix/Documents/programming/kantan/compiler/test/files/bintree.kan');
        response.body = {
            stackFrames: [new StackFrame(0, 'main', src, 84)],
            totalFrames: 1
        };
        this.sendResponse(response);
        console.log('dont trace my stack');
    }

    nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request) {
        super.nextRequest(response, args, request);
        console.log('next');
    }	

    threadsRequest(response: DebugProtocol.ThreadsResponse) {
		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(1, "thread 1")
			]
		};
		this.sendResponse(response);
    }

    scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments, request?: DebugProtocol.Request) {
        console.log('scopes');
    }
}