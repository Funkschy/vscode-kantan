import { Output, Tuple, List, Value, ResultClass, Result } from "./output";
import { Source } from "vscode-debugadapter";

export class MappingError {
    message: string;

    constructor(message: string) {
        this.message = message;
    }
}

function checkResult(output: Output): MappingError | Result[] {
    if (output.result?.resultClass === ResultClass.Error) {
        return new MappingError(fromValue(output.result.results[0].value));
    }

    const results = output.result?.results;
    if (!results || results.length <= 0) {
        return new MappingError('Empty result');
    }

    return results;
}

// remove ""
function fromValue(value: Value): string {
    if (!value || !value.content || !(typeof value.content === 'string')) {
        return '';
    }

    return fromStr(value.content);
}

function fromStr(str: string): string { 
    return str.substr(1, str.length - 2);
 }

export class BreakpointResult {
    constructor(
        public addr: string,
        public enabled: boolean,
        public source: Source,
        public func: string,
        public line: number,
        public id: number
    ) { } 

    static fromOutput(output: Output): BreakpointResult | MappingError {
        const results = checkResult(output);
        if (results instanceof MappingError) {
            return results;
        }

        const result = results[0];
        if (result.variable !== 'bkpt' || !(result.value.content instanceof Tuple)) {
            return new MappingError('Wrong answer');
        }

        const fields = result.value.content.fields;
        return new BreakpointResult(
            fromValue(fields.addr),
            fromValue(fields.enabled) === 'y',
            new Source(fromValue(fields.file), fromValue(fields.fullname)),
            fromValue(fields.func),
            +fromValue(fields.line),
            +fromValue(fields.number)
        );
    }
}

export class Frame {
    constructor(
        public addr: string,
        public source: Source,
        public func: string,
        public line: number,
    ) { } 
}

export class StacktraceResult {
    constructor(
        public frames: Frame[]
    ) {}

    static fromOutput(output: Output): StacktraceResult | MappingError {
        const results = checkResult(output);
        if (results instanceof MappingError) {
            return results;
        }

        const result = results[0];
        if (result.variable !== 'stack' || !(result.value.content instanceof List)) {
            return new MappingError('Wrong answer');
        }

        const list = (result.value.content as List).elements;
        const frames: Frame[] = [];
        for (let i = 0; i < list.length; i++) {
            const fields = ((list[i] as Result).value.content as Tuple).fields;
            const frame = new Frame(
                fromValue(fields.addr),
                new Source(fromValue(fields.file), fromValue(fields.fullname)),
                fromValue(fields.func),
                +fromValue(fields.line),
            );
            frames.push(frame);
        }

        return new StacktraceResult(frames);
    }
}

export interface VarInfo {
    getName(): string;
    getType(): string | undefined;
    getValue(): string | undefined;
}

export class Argument implements VarInfo {
    constructor(
        public name: string
    ) {}

    getName(): string {
        return this.name;
    }

    getType(): string | undefined {
        return undefined;
    }

    getValue(): string | undefined {
        return undefined;
    }
}

export class FuncArgsResult {
    constructor (
        public args: Argument[]
    ) {}


    static fromOutput(output: Output): FuncArgsResult | MappingError {
        const results = checkResult(output);
        if (results instanceof MappingError) {
            return results;
        }

        const result = results[0];
        if (result.variable !== 'stack-args' || !(result.value.content instanceof List)) {
            return new MappingError('Wrong answer');
        }

        const first = result.value.content.elements[0];
        if (!(first instanceof Result)) {
            return new MappingError('Wrong answer');
        }

        const tuple = first.value.content as Tuple;
        const elements = (tuple.fields.args.content as List).elements;

        const args: Argument[] = [];
        for (let i = 0; i < elements.length; i++) {
            const result = elements[i] as Result;
            args.push(new Argument(fromValue(result.value)));
        }

        return new FuncArgsResult(args);
    }
}

export class Local implements VarInfo {
    constructor(
        public name: string,
        public ty: string,
        public value: string | undefined,
    ) {}

    getName(): string {
        return this.name;
    }

    getType(): string {
        return this.ty;
    }

    getValue(): string | undefined {
        return this.value;
    }
}

export class LocalsResult {
    constructor (
        public locals: Local[]
    ) {}


    static fromOutput(output: Output): LocalsResult | MappingError {
        const results = checkResult(output);
        if (results instanceof MappingError) {
            return results;
        }

        const result = results[0];
        if (result.variable !== 'locals' || !(result.value.content instanceof List)) {
            return new MappingError('Wrong answer');
        }

        const locals: Local[] = [];
        const elements = result.value.content.elements;
        for (let i = 0; i < elements.length; i++) {
            const tuple = (elements[i] as Value).content as Tuple;
            let value: string | undefined = fromValue(tuple.fields.value);
            if (value === '') {
                value = undefined;
            }

            locals.push(new Local(
                fromValue(tuple.fields.name),
                fromValue(tuple.fields.type),
                value
            ));
        }

        return new LocalsResult(locals);
    }
}

export class Child implements VarInfo {
    constructor(
        public name: string,
        public threadId: number,
        public numChild: number,
        public type: string,
        public exp: string
    ) {}

    getName(): string {
        return this.name;
    }

    getType(): string {
        return this.type;
    }

    // value has to be calculated using name/exp
    getValue(): undefined {
        return undefined;
    }
}

export class ListChildrenResult {
    constructor(
        public children: Child[]
    ) {}

    static fromOutput(output: Output): ListChildrenResult | MappingError {
        const results = checkResult(output);
        if (results instanceof MappingError) {
            return results;
        }

        const result = results[1];
        if (result.variable !== 'children' || !(result.value.content instanceof List)) {
            return new MappingError('Wrong answer');
        }

        const children: Child[] = [];
        const elements = result.value.content.elements as Result[];
        for (let i = 0; i < elements.length; i++) {
            const tuple = elements[i].value.content as Tuple;
            children.push(new Child(
                fromValue(tuple.fields.name),
                +fromValue(tuple.fields['thread-id']),
                +fromValue(tuple.fields.numchild),
                fromValue(tuple.fields.type),
                fromValue(tuple.fields.exp)
            ));
        }

        return new ListChildrenResult(children);
    }
}