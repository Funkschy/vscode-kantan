export enum MiFeature {
    // Indicates support for the -var-set-frozen command, as well as possible presence of the frozen field in the output of -varobj-create. 
    Frozen = 'frozen-varobjs',
    // Indicates support for the -f option to the -break-insert command. 
    PendingBreakpoints = 'pending-breakpoints',
    // Indicates Python scripting support, Python-based pretty-printing commands, and possible presence of the ‘display_hint’ field in the output of -var-list-children 
    Python = 'python',
    // Indicates support for the -thread-info command. 
    ThreadInfo = 'thread-info',
    // Indicates support for the -data-read-memory-bytes and the -data-write-memory-bytes commands. 
    DataReadMemoryBytes = 'data-read-memory-bytes',
    // Indicates that changes to breakpoints and breakpoints created via the CLI will be announced via async records. 
    BreakpointNotifications = 'breakpoint-notifications',
    // Indicates support for the -ada-task-info command. 
    AdaTaskInfo = 'ada-task-info',
    // Indicates that all GDB/MI commands accept the --language option (see Context management). 
    languageOption = 'language-option',
    // Indicates support for the -info-gdb-mi-command command. 
    InfoGdbMiCommand = 'info-gdb-mi-command',
    // Indicates support for the "undefined-command" error code in error result records, produced when trying to execute an undefined GDB/MI command (see GDB/MI Result Records). 
    UndefinedCommandErrorCode = 'undefined-command-error-code',
    // Indicates that the -exec-run command supports the --start option
    ExecRunStartOption = 'exec-run-start-option',
    // Indicates that the -data-disassemble command supports the -a option
    DataDisassembleAOption = 'data-disassemble-a-option',
}

// see https://sourceware.org/gdb/current/onlinedocs/gdb/GDB_002fMI-Output-Syntax.html#GDB_002fMI-Output-Syntax
export class Output {
    asyncOutputs: AsyncOutput[] = [];
    streamRecords: StreamRecord[] = [];
    result: ResultRecord | null = null;

    isNotEmpty(): boolean {
        return this.result !== null || this.streamRecords.length > 0 || this.asyncOutputs.length > 0;
    }
}

export class AsyncOutput {
    // there is currently no other async-class, so an enum would be overkill
    type: string = "stopped";
    results: Result[];

    constructor(results: Result[]) {
        this.results = results;
    }
}

export class StreamRecord {
    type: StreamRecordType;
    output: string;

    constructor(type: StreamRecordType, output: string) {
        this.type = type;
        this.output = output;
    }
}

export enum StreamRecordType {
    Console, Target, Log
}

export class ResultRecord {
    resultClass: ResultClass;
    token: string | undefined;
    results: Result[];

    constructor(resultClass: ResultClass, token: string | undefined, results: Result[]) {
        this.resultClass = resultClass;
        this.token = token;
        this.results = results;
    }
}

export enum ResultClass {
    Done = "done",
    Running = "running",
    Connected = "connected",
    Error = "error",
    Exit = "exit"
}

export class Value {
    content: string | Tuple | List;

    constructor(content: string | Tuple | List) {
        this.content = content;
    }
}

export class Tuple {
    fields: any;
    
    constructor(results: Result[]) {
        this.fields = results.reduce((obj: any, item) => {
            obj[item.variable] = item.value;
            return obj;
        }, {});
    }
}

export class List {
    elements: Value[] | Result[];

    constructor(elements: Value[] | Result[]) {
        this.elements = elements;
    }
}

export class Result {
    variable: string;
    value: Value;

    constructor(variable: string, value: Value) {
        this.variable = variable;
        this.value = value;
    }
}

export function fromOutput(consoleOutput: string): Output[] | null {
    class Lexer {
        content: string;
        pos: number;
        start: number;
        peeked: Token | null;

        constructor(content: string) {
            this.content = content;
            this.pos = 0;
            this.start = 0;
            this.peeked = null;
        }

        advance(): string | null {
            let current = this.current();
            if (this.atEnd()) {
                return null;
            }
            this.pos++;
            return current;
        }

        atEnd(): boolean {
            return this.pos >= this.content.length;
        }

        current(): string {
            return this.content[this.pos];
        }

        skipWhitespace() {
            while (!this.atEnd() && ' \t\n\r'.indexOf(this.current()) >= 0) {
                this.advance();
            }
        }

        tokenFromStart(type: TokenType): Token {
            let len = this.pos - this.start;
            return new Token(type, this.content.substr(this.start, len));
        }

        lexString(): Token {
            while (!this.atEnd() && this.current() !== '"') {
                this.advance();
            }
            this.advance();
            return this.tokenFromStart(TokenType.String);
        }

        lexIdent(): Token {
            while (!this.atEnd() && (/^[a-z0-9-]+$/i).test(this.current())) {
                this.advance();
            }
            return this.tokenFromStart(TokenType.Identifier);
        }

        peek(): Token | null {
            if (this.peeked !== null) {
                return this.peeked;
            }
            this.peeked = this.next();
            return this.peeked;
        }

        next(): Token | null {
            if (this.peeked !== null) {
                let tok = this.peeked;
                this.peeked = null;
                return tok;
            }

            this.skipWhitespace();

            if (this.atEnd()) {
                return null;
            }

            this.start = this.pos;
            let c = this.advance();

            // skip (gdb)
            if (c === '(') {
                while (!this.atEnd() && this.current() !== ')') {
                    this.advance();
                }
                this.advance();
                return this.tokenFromStart(TokenType.Gdb);
            }

            switch (c) {
                case null: return null;
                case '"': return this.lexString();
                case '{': return this.tokenFromStart(TokenType.LBrace);
                case '}': return this.tokenFromStart(TokenType.RBrace);
                case '[': return this.tokenFromStart(TokenType.LBracket);
                case ']': return this.tokenFromStart(TokenType.RBracket);
                case ',': return this.tokenFromStart(TokenType.Comma);
                case '=': return this.tokenFromStart(TokenType.Eq);
                case '+': return this.tokenFromStart(TokenType.Plus);
                case '*': return this.tokenFromStart(TokenType.Star);
                case '^': return this.tokenFromStart(TokenType.Caret);
                case '~': return this.tokenFromStart(TokenType.Tilde);
                case '@': return this.tokenFromStart(TokenType.At);
                case '&': return this.tokenFromStart(TokenType.Ampersand);
                default: return this.lexIdent();
            }
        }
    }

    enum TokenType {
        Identifier, String, LBrace, RBrace, LBracket, RBracket, Comma, Eq, Plus, Star, Caret, Tilde, At, Ampersand, Gdb
    }

    class Token {
        type: TokenType;
        lexeme: string;

        constructor(type: TokenType, lexeme: string) {
            this.type = type;
            this.lexeme = lexeme;
        }
    }

    class Parser {
        lexer: Lexer;

        constructor(output: string) {
            this.lexer = new Lexer(output);
        }

        parseOutput(): ResultRecord | StreamRecord | AsyncOutput | null {
            let next = this.lexer.next();
            let last = next;
            while (next !== null) {
                switch (next.type) {
                    // result record
                    case TokenType.Caret: {
                        let resultClassTok = this.consume(TokenType.Identifier);
                        if (resultClassTok === null) {
                            return null;
                        }

                        let resultClass = resultClassTok.lexeme as ResultClass;
                        let results: Result[] = [];
                        if (this.lexer.peek()?.type === TokenType.Comma) {
                            this.consume(TokenType.Comma);
                            let parsedResults = this.parseResults();
                            if (parsedResults !== null) {
                                results = parsedResults;
                            }
                        }

                        return new ResultRecord(resultClass, last?.lexeme, results);
                    }
                    // target output
                    case TokenType.At: {
                        let str = this.consume(TokenType.String);
                        if (str === null) {
                            return null;
                        }
                        return new StreamRecord(StreamRecordType.Target, str.lexeme);
                    }
                    // exec-async-output
                    case TokenType.Star: {
                        let asyncClass = this.consume(TokenType.Identifier);
                        if (asyncClass?.lexeme !== 'stopped') {
                            break;
                        }

                        let results: Result[] = [];
                        if (this.lexer.peek()?.type === TokenType.Comma) {
                            this.consume(TokenType.Comma);
                            let parsedResults = this.parseResults();
                            if (parsedResults !== null) {
                                results = parsedResults;
                            }
                        }

                        return new AsyncOutput(results);
                    }
                }

                last = next;
                next = this.lexer.next();
            }

            return null;
        }

        parseResults(): Result[] | null {
            let results: Result[] = [];

            while (this.lexer.peek()?.type === TokenType.Identifier || this.lexer.peek()?.type === TokenType.Comma) {
                if (this.lexer.peek()?.type === TokenType.Comma) {
                    this.consume(TokenType.Comma);
                }

                let variable = this.consume(TokenType.Identifier);
                if (variable === null) {
                    return null;
                }

                if (this.consume(TokenType.Eq) === null) {
                    return null;
                }

                let value = this.parseValue();
                if (value === null) {
                    return null;
                }

                results.push(new Result(variable.lexeme, value));
            }

            return results;
        }

        parseValue(): Value | null {
            let first = this.lexer.next();
            if (first === null) {
                return null;
            }

            switch (first.type) {
                case TokenType.String: return new Value(first.lexeme);
                case TokenType.LBracket: {
                    if (this.lexer.peek()?.type === TokenType.Identifier) {
                        let results = this.parseResults();
                        if (results === null) {
                            return null;
                        }
                        return new Value(new List(results));
                    }

                    let values: Value[] = [];
                    while (this.lexer.peek()?.type !== TokenType.RBracket) {
                        let value = this.parseValue();
                        if (value === null) {
                            return null;
                        }
                        values.push(value);
                        if (this.lexer.peek()?.type === TokenType.Comma) {
                            this.consume(TokenType.Comma);
                        }
                    }
                    this.consume(TokenType.RBracket);

                    return new Value(new List(values));
                }
                case TokenType.LBrace: {
                    let results: Result[] = [];
                    let parsedResults = this.parseResults();
                    if (parsedResults === null) {
                        return null;
                    }
                    results = parsedResults;
                    this.consume(TokenType.RBrace);

                    return new Value(new Tuple(results));
                }
                default: return null;
            }
        }

        consume(type: TokenType): Token | null {
            let consumed = this.lexer.next();
            if (consumed === null || consumed.type !== type) {
                return null;
            }
            return consumed;
        }
    }

    let parser = new Parser(consoleOutput);
    let results: Output[] = [];

    let output = new Output();
    while (!parser.lexer.atEnd()) {
        let record = parser.parseOutput();

        if (record instanceof StreamRecord) {
            output.streamRecords.push(record);
        } else if (record instanceof AsyncOutput) {
            output.asyncOutputs.push(record);
        } else if (record instanceof ResultRecord) {
            if (output.result !== null) {
                results.push(output);
                output = new Output();
            }
            output.result = record;
        }
    }

    if (output.isNotEmpty()) {
        if (
            results.length === 0
            || (results.length > 0 && results[results.length - 1] !== output)
        ) {
            results.push(output);
        }
    }

    return results;
}
