import { DebugSession, InitializedEvent, Thread, Handles, OutputEvent, BreakpointEvent, Breakpoint, Source, StoppedEvent, StackFrame, ContinuedEvent, Scope, Variable } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import * as vscode from 'vscode';
const { Subject } = require('await-notify');

import { MiConnection, OutputHandler, MiBreakpoint } from './mi/connection';
import { Output, StreamRecordType, Result, Value, Tuple, StreamRecord, AsyncOutput, List, ResultClass } from './mi/output';
import { BreakpointResult, MappingError, StacktraceResult, VarInfo } from './mi/mapping';

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
    program: string;
    cwd: string;
    args: string[];
}

const STACK_HANDLES_START = 1;
const VAR_HANDLES_START = 1024;

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
    private varHandles = new Handles<string>(VAR_HANDLES_START);

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

    handleStreamRecord(record: StreamRecord) {
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

        await this.miConnection.connect(this, args.cwd);
        this.miConnection.fetchFeatures();
        await this.miConnection.loadExecutable(args.program);
        await this.miConnection.run(args.args);
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

        const src = new Source(name, path);
        const points: Breakpoint[] = [];
        await this.clearBreakpoints(path);

        for (let bp of request?.arguments.breakpoints) {
            const vsBp = new Breakpoint(true, bp.line, undefined, src);
            const miBp = new MiBreakpoint(path, bp.line);
            points.push(vsBp);

            const bkpt = await this.miConnection?.setBreakpoint(miBp);
            let id = -1;
            if (bkpt instanceof BreakpointResult) {
                id = bkpt.id;
            } else if (typeof bkpt === 'number') {
                id = bkpt;
            }

            let info = new BreakpointInfo(id, vsBp, miBp);
            this.breakpoints.get(path)?.push(info);
            this.sendEvent(new BreakpointEvent('new', vsBp));
        }

        response.body = {
            breakpoints: points
        };
        this.sendResponse(response);
    }

    async clearBreakpoints(path: string) {
        let bps = this.breakpoints.get(path) || [];
        for (let old of bps) {
            await this.miConnection.removeBreakpoint(old.id);
            this.sendEvent(new BreakpointEvent('removed', old.vsBp));
            continue;
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
        if (stack instanceof MappingError) {
            vscode.window.showInformationMessage(stack.message);
            return;
        }

        let frames: StackFrame[] = [];
        for (let i = 0; i < stack.frames.length; i++) {
            const frame = stack.frames[i];
            frames.push(new StackFrame(i, frame.func, frame.source, frame.line));
        }

        response.body = {
            stackFrames: frames,
            totalFrames: frames.length
        };
        this.sendResponse(response);
    }

    async nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments, request?: DebugProtocol.Request) {
        await this.miConnection.next();
        this.sendResponse(response);
        this.sendEvent(new StoppedEvent('step', args.threadId));
    }

    async stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments, request?: DebugProtocol.Request) {
        await this.miConnection.step();
        this.sendResponse(response);
        this.sendEvent(new StoppedEvent('step', args.threadId));
    }

    async stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments, request?: DebugProtocol.Request) {
        await this.miConnection.finish();
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
        response.body = {
            scopes: [new Scope('Locals', STACK_HANDLES_START + args.frameId, false)]
        };
        this.sendResponse(response);
    }

    continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments, request?: DebugProtocol.Request) {
        this.miConnection.continue();
        this.sendEvent(new ContinuedEvent(args.threadId));
        this.sendResponse(response);
    }

    parseMiStringLiteral(value: string): string {
        let result = value.match(/0x[\da-fA-F]+ \\\"(.*)\\\"/);
        if (!result) {
            return '';
        }
        return `"${result[1]}"`;
    }

    async variablesRequest(response: DebugProtocol.VariablesResponse, varArgs: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {
        let isForComplexType = varArgs.variablesReference >= VAR_HANDLES_START;

        if (isForComplexType) {
            let fields: Variable[] = [];
            let varName = this.varHandles.get(varArgs.variablesReference);
            let childrenResults = await this.miConnection.listChildren(varName);
            if (childrenResults instanceof MappingError) {
                vscode.window.showInformationMessage(childrenResults.message);
                return;
            }

            for (let child of childrenResults.children) {
                const childName = child.exp;
                const numChildren = child.numChild;
                const varType = child.type;

                const isPointer = varType.endsWith('*');
                const isString = varType === 'char *';

                // gdb terminology is pretty weird here, if we want to access
                // mystruct.i, name is mystruct.i, but exp is just i
                const expr = child.name;
                const result = await this.miConnection.evaluate(expr);

                let varRef = 0;
                let varValue = '';

                if (result.result?.resultClass !== ResultClass.Done) {
                    console.log(result);
                    continue;
                }

                let content = result.result?.results[0].value.content;
                let contentValue = '';
                if (typeof (content) === 'string') {
                    contentValue = this.fromStr(content);
                }

                let isNull = isPointer && +contentValue === 0;

                if (isNull) {
                    varValue = 'null';
                } else if (numChildren <= 0 || isString) {
                    if (isString) {
                        varValue = this.parseMiStringLiteral(contentValue);
                    } else {
                        varValue = contentValue;
                    }
                } else {
                    varValue = child.type || '{...}';
                    varRef = this.varHandles.create(expr);
                }

                fields.push(new Variable(childName, varValue, varRef));
            }

            response.body = {
                variables: fields
            };
            this.sendResponse(response);
            return;
        }

        const funcArgs = this.miConnection.listArgs();
        const vars = await this.miConnection.listLocals();
        if (vars instanceof MappingError) {
            vscode.window.showInformationMessage(vars.message);
            return;
        }

        const localsByName = new Map<string, Variable>();

        const args = await funcArgs;
        if (args instanceof MappingError) {
            vscode.window.showInformationMessage(args.message);
            return;
        }

        const locals: VarInfo[] = (vars.locals as VarInfo[]).concat(args.args);

        for (let local of locals) {
            const name = local.getName();
            const isPointer = local.getType()?.endsWith('*');
            const isString = local.getType() === 'char *';

            let varRef = 0;
            let varValue = '';

            if (local.getValue() && !isPointer) {
                // simple type
                varValue = local.getValue()!;
            } else if (isString) {
                varValue = local.getValue() || '';
                varValue = this.parseMiStringLiteral(varValue);
            } else {
                varValue = local.getType() || '{...}';
                if (localsByName.get(name)) {
                    await this.miConnection.varDelete(name);
                } else {
                    varRef = this.varHandles.create(name);
                }
            }

            await this.miConnection.varCreate(name);
            let v = new Variable(name, varValue, varRef);

            localsByName.set(name, v);
        }

        response.body = {
            variables: Array.from(localsByName.values())
        };
        this.sendResponse(response);
    }
}