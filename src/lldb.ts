import { DebugSession, InitializedEvent, Thread, OutputEvent, BreakpointEvent, Breakpoint, Source, StoppedEvent, StackFrame, ContinuedEvent } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import * as vscode from 'vscode';
const { Subject } = require('await-notify');

import { MiConnection, OutputHandler, MiBreakpoint } from './mi/connection';
import { StreamRecordType, Result, Value, Tuple, StreamRecord, AsyncOutput, List } from './mi/output';

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    target: string;
}

class BreakpointInfo {
    id: number;
    vsBp: Breakpoint;
    miBp: MiBreakpoint;

    constructor(id: number, vsBp: Breakpoint, miBp: MiBreakpoint) {
        this.id = id;
        this.vsBp = vsBp;
        this.miBp = miBp;
    }
}

export class LLDBDebugSession extends DebugSession implements OutputHandler {
    private miConnection: MiConnection;
    private writeEmitter: vscode.EventEmitter<string>;
    private _configurationDone = new Subject();

    // full filepath -> line -> Breakpoint
    private breakpoints: Map<string, BreakpointInfo[]> = new Map();

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

    handleStreamRecrod(record: StreamRecord) {
        if (record.type === StreamRecordType.Target) {
            let output = record.output.substr(1, record.output.length - 2);
            output = output.replace('\\n', '\n');
            output = output.replace('\\r', '\r');

            // TODO: emit outputevent
            this.writeEmitter.fire(output);

            console.log(output);
        }
    }


        // remove ""
    fromStr(str: string) { return str.substr(1, str.length - 2); }

    handleAsyncOutput(output: AsyncOutput) {
        let result = output.results.reduce((obj: any, item) => {
            obj[item.variable] = item.value;
            return obj;
        }, {});

        if (result.reason.content !== '"breakpoint-hit"') {
            return;
        }

        let threadId = +this.fromStr(result['thread-id'].content);
        this.sendEvent(new StoppedEvent('breakpoint', threadId));
    }

    handleRaw(output: string) {
        this.sendEvent(new OutputEvent(output + '\n'));
    }

    initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments) {
        response.body = response.body || {};

		response.body.supportsConfigurationDoneRequest = true;
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

    async setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments, request?: DebugProtocol.Request) {
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
        this.clearBreakpoints(path);

        for (let bp of request?.arguments.breakpoints) {
            let vsBp = new Breakpoint(true, bp.line, undefined, src);
            let miBp = new MiBreakpoint(path, bp.line);
            points.push(vsBp);

            let answer = await this.miConnection?.setBreakpoint(miBp);
            let bkpt = answer?.result?.results[0].value.content as Tuple;
            if (bkpt) {
                let id = +this.fromStr(bkpt.fields.number.content);
                let info = new BreakpointInfo(id, vsBp, miBp);
                this.breakpoints.get(path)?.push(info);
            }

            this.sendEvent(new BreakpointEvent('new', vsBp));
        }

        response.body = {
            breakpoints: points 
        };
        this.sendResponse(response);
    }

    clearBreakpoints(path: string) {
        let bps = this.breakpoints.get(path);
        if (bps) {
            for (let old of bps) {
                this.miConnection.removeBreakpoint(old.id);
                this.sendEvent(new BreakpointEvent('removed', old.vsBp));
                continue;
            }
        }

        this.breakpoints.set(path, []);
    }

    breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request) {
        // TODO: get col info
        response.body = {
            breakpoints: [{
                line: args.line,
                column: undefined 
            }]
        };
        this.sendResponse(response);
    }

	async stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments) {
        let stack = await this.miConnection.stackTrace();

        let frames: StackFrame[] = [];
        let stackContent = stack.result?.results[0].value.content;
        let numFrames = 0;
        if (stackContent && stackContent instanceof List) {
            numFrames = stackContent.elements.length;
            for (let i = 0; i < numFrames; i++) {
                let element = stackContent.elements[i];
                if (!(element instanceof Result)) {
                    continue;
                }

                let content = element.value.content;
                if (!(content instanceof Tuple)) {
                    continue;
                }

                let file = this.fromStr(content.fields.file.content);
                let fullname = this.fromStr(content.fields.fullname.content);
                let src = new Source(file, fullname);
                let func = this.fromStr(content.fields.func.content);

                let line = +this.fromStr(content.fields.line.content);
                frames.push(new StackFrame(i, func, src, line));
            }
        }

        response.body = {
            stackFrames: frames,
            totalFrames: numFrames
        };
        this.sendResponse(response);
    }

    async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request) {
        let data = await this.miConnection.next();
        this.sendResponse(response);
        this.sendEvent(new StoppedEvent('step', args.threadId));
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

    continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, request?: DebugProtocol.Request) {
        this.miConnection.continue();
        this.sendEvent(new ContinuedEvent(args.threadId));
    }
}