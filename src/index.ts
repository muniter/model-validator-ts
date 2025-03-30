import type { StandardSchemaV1 } from "@standard-schema/spec";

type TValidationDeps = Record<string, unknown>;

function invariant<T>(condition: T, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

// A unified result type for handling validation results
export type ValidationResult<TSchema extends StandardSchemaV1> =
    | {
        success: true;
        value: StandardSchemaV1.InferOutput<TSchema>;
    }
    | {
        success: false;
        errors: ErrorBag<TSchema>;
    };


type RuleFunction<
    TSchema extends StandardSchemaV1,
    TDeps extends TValidationDeps
> = (args: {
    property: ErrorKeys<TSchema>;
    data: StandardSchemaV1.InferOutput<TSchema>;
    builder: ValidatorModel<TSchema, TDeps>;
    deps: TDeps;
}) => unknown | Promise<unknown>;

type RuleDefinition<
    TSchema extends StandardSchemaV1,
    TDeps extends TValidationDeps
> = {
    attribute: ErrorKeys<TSchema>;
    fn: RuleFunction<TSchema, TDeps>;
};

type ErrorKeys<TSchema extends StandardSchemaV1> = StandardSchemaV1.InferInput<TSchema> extends Record<string | number | symbol, unknown>
    ? keyof StandardSchemaV1.InferInput<TSchema> | "global"
    : "global";

export class ErrorBag<TSchema extends StandardSchemaV1> {
    #issues: Array<{ key: ErrorKeys<TSchema>; message: string }> = [];

    addError(key: ErrorKeys<TSchema>, message: string) {
        this.#issues.push({ key, message });
    }

    firstError(key: ErrorKeys<TSchema>): string | undefined {
        return this.#issues.find(issue => issue.key === key)?.message;
    }

    hasErrors() {
        return this.#issues.length > 0;
    }

    toFlattenObject(): Record<ErrorKeys<TSchema>, string> {
        const result: Record<ErrorKeys<TSchema>, string> = {} as Record<ErrorKeys<TSchema>, string>;
        for (const issue of this.#issues) {
            result[issue.key] = issue.message;
        }
        return result;
    }

    get toObject() {
        const result: Partial<Record<ErrorKeys<TSchema>, string[]>> = {};
        for (const issue of this.#issues) {
            if (!result[issue.key]) {
                result[issue.key] = [];
            }
            result[issue.key]!.push(issue.message);
        }
        return result;
    }

    toString() {
        return JSON.stringify(this.toObject);
    }

    toHtml() {
        let result = "";
        if (!this.hasErrors()) {
            return result;
        }
        result += "<ul>";
        for (const issue of this.#issues) {
            let strKey: string;
            if (typeof issue.key === "symbol" || typeof issue.key === "number") {
                strKey = issue.key.toString();
            } else {
                strKey = issue.key;
            }
            result += `<li>${strKey}: ${issue.message}</li>`;
        }
        result += "</ul>";
        return result
    }

    toText(): string {
        if (!this.hasErrors()) {
            return "";
        }
        const result = [];
        let currentKey: ErrorKeys<TSchema> | null = null;

        for (const issue of this.#issues) {
            if (currentKey !== issue.key) {
                currentKey = issue.key;
                result.push(currentKey);
            }
            result.push(`- ${issue.message}`);
        }

        return result.join("\n");
    }
}

// Separate class for validator definition
export class ValidatorDefinition<
    TSchema extends StandardSchemaV1,
    TBuildDeps extends TValidationDeps,
    TPreBuildDeps extends TValidationDeps = {}
> {
    schema: TSchema;
    rules: RuleDefinition<TSchema, TBuildDeps & TPreBuildDeps>[] = [];
    ['~deps']: TBuildDeps;
    ['~preBuildDeps']: TPreBuildDeps;

    constructor(args: {
        schema: TSchema;
        rules: RuleDefinition<TSchema, TBuildDeps & TPreBuildDeps>[];
        deps?: TBuildDeps;
        preBuildDeps?: TPreBuildDeps;
    }) {
        this.schema = args.schema;
        this.rules = args.rules ?? [];
        this['~deps'] = args.deps ?? {} as TBuildDeps;
        this['~preBuildDeps'] = args.preBuildDeps ?? {} as TPreBuildDeps;
    }

    addRule(ruledef: RuleDefinition<TSchema, TBuildDeps>): this {
        this.rules.push(ruledef);
        return this;
    }

    addRules(ruledefs: RuleDefinition<TSchema, TBuildDeps & TPreBuildDeps>[]): this {
        this.rules.push(...ruledefs);
        return this;
    }

    build(...dependencies: TBuildDeps extends Record<string, never> ? [] : [TBuildDeps]): ValidatorModel<TSchema, TPreBuildDeps & TBuildDeps> {
        const [deps] = dependencies;
        return new ValidatorModel<TSchema, TPreBuildDeps & TBuildDeps>(this.schema, this.rules, {
            ...this['~preBuildDeps'],
            ...(deps ?? {} as TBuildDeps),
        } as TPreBuildDeps & TBuildDeps);
    }
}

type ValidationOpts<TSchema extends StandardSchemaV1> = {
    validationType?: "plain",
    override?: Partial<TSchema>
}

// Update ValidationBuilder to accept rules and dependencies
export class ValidatorModel<
    TSchema extends StandardSchemaV1,
    TDeps extends TValidationDeps
> {
    schema: TSchema;
    #rules: RuleDefinition<TSchema, TDeps>[];
    #deps: TDeps;
    errors: ErrorBag<TSchema> = new ErrorBag<TSchema>();

    constructor(
        schema: TSchema,
        rules: RuleDefinition<TSchema, TDeps>[],
        deps: TDeps
    ) {
        this.schema = schema;
        this.#rules = rules;
        this.#deps = deps;
    }

    addError(key: ErrorKeys<TSchema>, message: string) {
        this.errors.addError(key, message);
        return this.errors;
    }

    mergeErrors(errors: Partial<Record<ErrorKeys<TSchema>, string>>) {
        for (const [key, message] of Object.entries(errors)) {
            if (!message) {
                continue;
            }

            if (typeof key !== "string") {
                throw new Error("Invalid error key, expected string");
            }

            if (typeof message !== "string") {
                throw new Error("Invalid error message, expected string");
            }

            this.addError(key as ErrorKeys<TSchema>, message);
        }
        return this.errors;
    }

    mapErrors<TSrc extends Record<string, string>>(args: [keyof TSrc] extends [ErrorKeys<TSchema>] ? {
        src: TSrc;
    } : {
        src: TSrc;
        mappings: {
            [K in keyof TSrc as K extends ErrorKeys<TSchema> ? never : K]: ErrorKeys<TSchema>;
        }
    }) {
        for (const [key, message] of Object.entries(args.src)) {
            let targetKey: ErrorKeys<TSchema> | null = null;
            if ("mappings" in args) {
                // @ts-ignore
                targetKey = args.mappings[key] ?? null;
            }
            targetKey = targetKey ?? key as ErrorKeys<TSchema>;
            this.addError(targetKey, message);
        }
        return this.errors;
    }

    /*
     * Method to validate does the same as validate but because the input is already typed
     * we can use it to validate the shape of the input at compile time
     * @param input - the input to validate
     */
    async validateShape(input: StandardSchemaV1.InferInput<TSchema>, opts?: ValidationOpts<TSchema>) {
        return this.validate(input, opts);
    }

    /*
     * Method to validate the input against the schema and business rules
     * @param input - the input to validate
     * @return a ValidationResult object
     */
    async validate(input: StandardSchemaV1.InferInput<TSchema> | unknown, opts?: ValidationOpts<TSchema>): Promise<ValidationResult<TSchema>> {
        const override = opts?.override;
        if (override && typeof input === "object" && input !== null) {
            Object.assign(input, override);
        }

        let presult = this.schema['~standard'].validate(input);
        if (presult instanceof Promise) {
            presult = await presult;
        }

        this.errors = new ErrorBag<TSchema>();

        if (presult.issues) {
            for (const issue of presult.issues) {
                if (typeof issue.message !== "string") {
                    throw new Error("Unexpected error format, expected string");
                }
                let path: ErrorKeys<TSchema>
                if (Array.isArray(issue.path)) {
                    path = issue.path.join(".") as ErrorKeys<TSchema>;
                } else if (typeof issue.path === "string") {
                    path = issue.path as ErrorKeys<TSchema>;
                } else {
                    throw new Error(`Unsupported issue path type ${typeof issue.path}: issue: ${JSON.stringify(issue)}`);
                }
                this.addError(path, issue.message);
            }

            return {
                success: false,
                errors: this.errors,
            };
        }

        for (const ruleDef of this.#rules) {
            const params = {
                property: ruleDef.attribute,
                data: presult.value,
                builder: this,
                deps: this.#deps,
            };
            if (ruleDef.fn.constructor.name === "AsyncFunction") {
                await ruleDef.fn(params);
            } else {
                ruleDef.fn(params);
            }
        }

        if (this.errors.hasErrors()) {
            return {
                success: false,
                errors: this.errors,
            };
        } else {
            return {
                success: true,
                value: presult.value,
            };
        }
    }


    toClientFields() {
        throw new Error("Not implemented");
    }
}


export type CommandResult<
    TValidator extends ValidatorModel<any, any>,
    TOutput
> = | { validated: true; result: TOutput }
    | { validated: false; errors: TValidator["errors"] };

type InferValidatorDefinition<TValidatorDef extends ValidatorDefinition<any, any>> = TValidatorDef extends ValidatorDefinition<infer U, any>
    ? U
    : never;
type InferValidatorDeps<TValidatorDef extends ValidatorDefinition<any, any>> = TValidatorDef extends ValidatorDefinition<any, infer D>
    ? D
    : never;

export function createCommand<
    TOutput,
    TValidatorDef extends ValidatorDefinition<any, any, any>
>(args: {
    validator: TValidatorDef;
    deps: TValidatorDef["~deps"];
    execute: ({
        data,
        deps,
        builder,
    }: {
        data: StandardSchemaV1.InferOutput<TValidatorDef["schema"]>;
        deps: TValidatorDef["~deps"] & TValidatorDef["~preBuildDeps"];
        builder: ValidatorModel<TValidatorDef["schema"], TValidatorDef["~deps"] & TValidatorDef["~preBuildDeps"]>;
    }) => Promise<TOutput | ErrorBag<InferValidatorDefinition<TValidatorDef>>>;
}) {
    type ValidatorModelType = ValidatorModel<
        TValidatorDef["schema"],
        TValidatorDef["~deps"]
    >;
    const validator = args.validator.build(args.deps) as ValidatorModelType;

    return {
        runShape(
            input: TValidatorDef["schema"],
            opts?: ValidationOpts<TValidatorDef["schema"]>
        ) {
            return this.run(input, opts);
        },
        async run(
            input: unknown,
            opts?: ValidationOpts<TValidatorDef["schema"]>
        ): Promise<CommandResult<ValidatorModelType, Exclude<TOutput, ErrorBag<TValidatorDef["schema"]>>>> {
            const validation = await validator.validate(input, opts);

            if (!validation.success) {
                return { validated: false, errors: validation.errors };
            }

            const result = await args.execute({
                data: validation.value,
                deps: args.deps,
                builder: validator,
            });

            if (result instanceof ErrorBag) {
                return { validated: false, errors: result };
            }

            return { validated: true, result: result as Exclude<TOutput, ErrorBag<any>> };
        },
        execute: args.execute,
        validator,
    };
}

export function createValidatorBuilder<TPreBuildDeps extends TValidationDeps>(config: {
    deps?: TPreBuildDeps | (() => TPreBuildDeps);
}) {
    return function createValidator<
        TSchema extends StandardSchemaV1, 
        TBuildDeps extends TValidationDeps
    >(args: {
        schema: TSchema;
        deps?: TBuildDeps;
        rules?: RuleDefinition<TSchema, TPreBuildDeps & TBuildDeps>[];
    }) {
        const outerDeps = typeof config.deps === "function" ? config.deps() : config.deps ?? {} as TPreBuildDeps;
        return new ValidatorDefinition<TSchema, TBuildDeps, TPreBuildDeps>({
            schema: args.schema,
            rules: args.rules ?? [],
            deps: args.deps,
            preBuildDeps: outerDeps,
        })
    };
}
