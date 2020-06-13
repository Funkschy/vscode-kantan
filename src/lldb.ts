import { DebugSession, InitializedEvent, Thread, Handles, OutputEvent, BreakpointEvent, Breakpoint, Source, StoppedEvent, StackFrame, ContinuedEvent, Scope, Variable } from 'vscode-debugadapter';
import { DebugProtocol } from 'vscode-debugprotocol';
import * as vscode from 'vscode';
const { Subject } = require('await-notify');

import { MiConnection, OutputHandler, MiBreakpoint } from './mi/connection';
import { Output, StreamRecordType, Result, Value, Tuple, StreamRecord, AsyncOutput, List, ResultClass } from './mi/output';

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
        let bps = this.breakpoints.get(path) || [];
        for (let old of bps) {
            this.miConnection.removeBreakpoint(old.id);
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

    async getFuncArgs(): Promise<Value[]> {
        let funcArgs = await this.miConnection.listArgs();
        if (!funcArgs.isDone()) {
            return [];
        }
        let frames = (funcArgs.result?.results[0].value.content as List).elements as Result[];
        let args = (frames[0].value.content as Tuple).fields.args.content.elements as Result[];

        let outs: Promise<Output>[] = args.map(async arg => {
            let name = this.fromStr(arg.value.content as string);
            return this.miConnection.varCreate(name);
        });

        let outputs: Value[] = [];
        for (let out of outs) {
            let tuple = new Tuple((await out).result?.results as Result[]);
            outputs.push(new Value(tuple));
        }

        return outputs;
    }

    async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {
        let isForComplexType = args.variablesReference >= VAR_HANDLES_START;

        if (isForComplexType) {
            let fields: Variable[] = [];
            let varName = this.varHandles.get(args.variablesReference);
            let childrenResults = (await this.miConnection.listChildren(varName)).result?.results;
            // TODO: error if resultClass != done

            for (let elem of childrenResults!) {
                if (elem.variable !== 'children') {
                    continue;
                }

                let children = elem.value.content as List;
                for (let child of children.elements as Result[]) {
                    let childTuple = child.value.content as Tuple;
                    let childName = this.fromStr(childTuple.fields.exp.content);
                    let numChildren = +this.fromStr(childTuple.fields.numchild.content);
                    let varType = this.fromStr(childTuple.fields.type.content);

                    let isPointer = varType.endsWith('*');
                    let isString = varType === 'char *';

                    let expr = this.fromStr(childTuple.fields.name.content);
                    let result = await this.miConnection.evaluate(expr);

                    let varRef = 0;
                    let value = '';

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
                        value = 'null';
                    } else if (numChildren <= 0 || isString) {
                        if (isString) {
                            value = this.parseMiStringLiteral(contentValue);
                        } else {
                            value = contentValue;
                        }
                    } else {
                        varRef = this.varHandles.create(expr);
                    }

                    fields.push(new Variable(childName, value, varRef));
                }
            }

            response.body = {
                variables: fields
            };
            this.sendResponse(response);
            return;
        }

        let funcArgs = this.getFuncArgs();
        let vars = await this.miConnection.listLocals();
        let localsByName = new Map<string, Variable>();

        if (vars.isDone()) {
            let values = (vars.result?.results[0].value.content as List).elements as Value[];
            let args = await funcArgs;
            values = values.concat(args);

            for (let value of values) {
                let tuple = value.content as Tuple;

                let varName = this.fromStr(tuple.fields.name.content);
                let varType = this.fromStr(tuple.fields.type.content);
                let isPointer = varType.endsWith('*');
                let isString = varType === 'char *';

                let varRef = 0;
                let varValue = '';

                if (isPointer) {
                    let ptrValue = this.fromStr(tuple.fields.value.content);
                    let isNull = isPointer && +ptrValue === 0;

                    if (isNull) {
                        varValue = 'null';
                    } else if (isString) {
                        varValue = this.parseMiStringLiteral(ptrValue);
                    } else {
                        varValue = ptrValue;
                        varRef = this.varHandles.create(varName);
                    }
                } else if (tuple.fields.value && tuple.fields.value.content !== '"{...}"') {
                    // simple type
                    varValue = this.fromStr(tuple.fields.value.content);
                } else {
                    varRef = this.varHandles.create(varName);
                }

                if (localsByName.get(varName)) {
                    await this.miConnection.varDelete(varName);
                }

                await this.miConnection.varCreate(varName);
                let v = new Variable(varName, varValue, varRef);

                localsByName.set(varName, v);
            }
        }

        response.body = {
            variables: Array.from(localsByName.values())
        };
        this.sendResponse(response);
    }
}