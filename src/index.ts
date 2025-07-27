import type { StandardSchemaV1 } from "./standard-schema.ts";

type TValidationDeps = Record<string, unknown>;

function invariant<T>(condition: T, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

type ErrorKeys<TInput> = TInput extends Record<
  string | number | symbol,
  unknown
>
  ? keyof TInput | "global"
  : "global";

export class ErrorBag<TInput> {
  #issues: Array<{ key: ErrorKeys<TInput>; message: string }> = [];

  addError(key: ErrorKeys<TInput>, message: string) {
    this.#issues.push({ key, message });
  }

  firstError(key: ErrorKeys<TInput>): string | undefined {
    return this.#issues.find((issue) => issue.key === key)?.message;
  }

  hasErrors() {
    return this.#issues.length > 0;
  }

  toFlattenObject(): Record<ErrorKeys<TInput>, string> {
    const result: Record<ErrorKeys<TInput>, string> = {} as Record<
      ErrorKeys<TInput>,
      string
    >;
    for (const issue of this.#issues) {
      result[issue.key] = issue.message;
    }
    return result;
  }

  get toObject() {
    const result: Partial<Record<ErrorKeys<TInput>, string[]>> = {};
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
    return result;
  }

  toText(): string {
    if (!this.hasErrors()) {
      return "";
    }
    const result = [];
    let currentKey: ErrorKeys<TInput> | null = null;

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

type ValidationOpts<TInput> = {
  validationType?: "plain";
  override?: Partial<TInput>;
};

async function validate<
  TSchema extends StandardSchemaV1,
  TContext = Record<string, unknown>
>(args: {
  schema: TSchema;
  input: unknown;
  rules: Array<ContextRuleDefinition<any, any, any, any>>;
  opts?: ValidationOpts<StandardSchemaV1.InferInput<TSchema>>;
  deps: TValidationDeps;
}): Promise<
  | {
      success: true;
      value: StandardSchemaV1.InferOutput<TSchema>;
      context: TContext;
    }
  | {
      success: false;
      errors: ErrorBag<StandardSchemaV1.InferOutput<TSchema>>;
    }
> {
  const override = args.opts?.override;
  if (override && typeof args.input === "object" && args.input !== null) {
    Object.assign(args.input, override);
  }

  let presult = args.schema["~standard"].validate(args.input);
  if (presult instanceof Promise) {
    presult = await presult;
  }

  const bag = new ErrorBag<any>();

  if (presult.issues) {
    for (const issue of presult.issues) {
      if (typeof issue.message !== "string") {
        throw new Error("Unexpected error format, expected string");
      }
      let path: ErrorKeys<any>;
      if (Array.isArray(issue.path)) {
        path = issue.path.join(".") as ErrorKeys<any>;
      } else if (typeof issue.path === "string") {
        path = issue.path as ErrorKeys<any>;
      } else {
        throw new Error(
          `Unsupported issue path type ${typeof issue.path}: issue: ${JSON.stringify(
            issue
          )}`
        );
      }
      bag.addError(path, issue.message);
    }

    return {
      success: false as const,
      errors: bag,
    };
  }

  // Now time to evaluate the rules
  let context = {} as TContext;
  for (const rule of args.rules) {
    const result = await rule.fn({
      data: args.input,
      bag,
      deps: args.deps,
      context,
    });

    if (bag.hasErrors()) {
      return { success: false, errors: bag };
    }

    if (result && typeof result === "object") {
      context = Object.assign(context, result);
    }
  }

  return {
    success: true as const,
    context,
    value: presult.value,
  };
}

type ContextRuleFunction<
  TInput,
  TDeps extends TValidationDeps = {},
  TInputContext = {},
  TOutputContext = {}
> = (args: {
  data: TInput;
  deps: TDeps;
  bag: ErrorBag<TInput>;
  context: TInputContext;
}) => TOutputContext | Promise<TOutputContext> | void | Promise<void>;

type ContextRuleDefinition<
  TInput,
  TDeps extends TValidationDeps = {},
  TInputContext = {},
  TOutputContext = {}
> = {
  fn: ContextRuleFunction<TInput, TDeps, TInputContext, TOutputContext>;
};

export type CommandResult<TOutput, TInput, TContext> =
  | { validated: true; result: TOutput; context: TContext }
  | { validated: false; errors: ErrorBag<TInput> };

type DepsStatus = "not-required" | "required" | "passed";
export class FluentValidatorBuilder<
  TSchema extends StandardSchemaV1 = any,
  TDeps extends TValidationDeps = {},
  TContext = {},
  TDpesStatus extends DepsStatus = "not-required"
> {
  #schema?: TSchema;
  #deps?: TDeps;
  #contextRules: Array<
    ContextRuleDefinition<TSchema, TDeps, TContext, TContext>
  > = [];
  #depsStatus: DepsStatus = "not-required";

  input<T extends StandardSchemaV1>(
    schema: T
  ): FluentValidatorBuilder<T, TDeps, TContext, TDpesStatus> {
    return new FluentValidatorBuilder<T, TDeps, TContext, TDpesStatus>()
      .setSchema(schema)
      .setDeps(this.#deps)
      .setRules(this.#contextRules);
  }

  $deps<T extends TValidationDeps>(): FluentValidatorBuilder<
    TSchema,
    T,
    TContext,
    "required"
  > {
    return new FluentValidatorBuilder<TSchema, T, TContext, "required">()
      .setSchema(this.#schema)
      .setDepsStatus("required")
      .setRules(this.#contextRules);
  }

  private setDepsStatus(depsStatus: DepsStatus): this {
    this.#depsStatus = depsStatus;
    return this;
  }

  private setSchema(schema?: TSchema): this {
    this.#schema = schema;
    return this;
  }

  private setDeps(deps?: TDeps): this {
    this.#deps = deps;
    return this;
  }

  private setRules(
    rules: Array<{ fn: (args: any) => any | Promise<any> }>
  ): this {
    this.#contextRules = rules;
    return this;
  }

  get ["~unsafeInternals"](): {
    schema?: TSchema;
    deps?: TDeps;
    depsStatus: DepsStatus;
    contextRules: Array<
      ContextRuleDefinition<TSchema, TDeps, TContext, TContext>
    >;
  } {
    return {
      schema: this.#schema,
      deps: this.#deps,
      depsStatus: this.#depsStatus,
      contextRules: this.#contextRules,
    };
  }

  validate(
    this: FluentValidatorBuilder<
      TSchema,
      TDeps,
      TContext,
      "passed" | "not-required"
    >,
    input: unknown,
    opts?: ValidationOpts<StandardSchemaV1.InferInput<TSchema>>
  ): Promise<
    | {
        success: true;
        value: StandardSchemaV1.InferOutput<TSchema>;
        context: TContext;
      }
    | {
        success: false;
        errors: ErrorBag<StandardSchemaV1.InferInput<TSchema>>;
      }
  > {
    invariant(
      this.#depsStatus === "passed" || this.#depsStatus === "not-required",
      "Deps must be passed or not required at validation time"
    );
    invariant(this.#schema, "Schema must be defined before calling validate");

    return validate<TSchema, TContext>({
      schema: this.#schema,
      input,
      rules: this.#contextRules,
      opts,
      deps: this.#deps ?? {},
    });
  }

  addRule<TOutputContext>(
    rule: ContextRuleDefinition<
      StandardSchemaV1.InferOutput<TSchema>,
      TDeps,
      TContext,
      TOutputContext
    >
  ): FluentValidatorBuilder<
    TSchema,
    TDeps,
    TContext & TOutputContext,
    TDpesStatus
  > {
    return new FluentValidatorBuilder<
      TSchema,
      TDeps,
      TContext & TOutputContext
    >()
      .setSchema(this.#schema)
      .setDeps(this.#deps)
      .setDepsStatus(this.#depsStatus)
      .setRules([...this.#contextRules, rule]);
  }

  provide(
    this: FluentValidatorBuilder<TSchema, TDeps, TContext, "required">,
    deps: TDeps
  ): FluentValidatorBuilder<TSchema, TDeps, TContext, "passed"> {
    return new FluentValidatorBuilder<TSchema, TDeps, TContext, "passed">()
      .setSchema(this.#schema)
      .setDeps(deps)
      .setDepsStatus("passed")
      .setRules(this.#contextRules);
  }

  command<TOutput>(
    this: FluentValidatorBuilder<
      TSchema,
      TDeps,
      TContext,
      "passed" | "not-required"
    >,
    args: {
      execute: (params: {
        data: StandardSchemaV1.InferOutput<TSchema>;
        deps: TDeps;
        context: TContext;
      }) => Promise<TOutput> | TOutput;
    }
  ): {
    runShape: (
      input: StandardSchemaV1.InferInput<TSchema>,
      opts?: ValidationOpts<TSchema>
    ) => Promise<
      CommandResult<TOutput, StandardSchemaV1.InferInput<TSchema>, TContext>
    >;
    run: (
      input: unknown,
      opts?: ValidationOpts<TSchema>
    ) => Promise<
      CommandResult<TOutput, StandardSchemaV1.InferInput<TSchema>, TContext>
    >;
  };
  command<TOutput>(
    this: FluentValidatorBuilder<TSchema, TDeps, TContext, "required">,
    args: {
      execute: (params: {
        data: StandardSchemaV1.InferOutput<TSchema>;
        deps: TDeps;
        context: TContext;
      }) => Promise<TOutput> | TOutput;
    }
  ): {
    provide: (deps: TDeps) => {
      runShape: (
        input: StandardSchemaV1.InferInput<TSchema>,
        opts?: ValidationOpts<TSchema>
      ) => Promise<
        CommandResult<TOutput, StandardSchemaV1.InferInput<TSchema>, TContext>
      >;
      run: (
        input: unknown,
        opts?: ValidationOpts<TSchema>
      ) => Promise<
        CommandResult<TOutput, StandardSchemaV1.InferInput<TSchema>, TContext>
      >;
    };
  };
  command<TOutput>(
    this: FluentValidatorBuilder<
      TSchema,
      TDeps,
      TContext,
      "not-required" | "passed" | "required"
    >,
    args: {
      execute: (params: {
        data: StandardSchemaV1.InferOutput<TSchema>;
        deps: TDeps;
        context: TContext;
      }) => Promise<TOutput> | TOutput;
    }
  ) {
    const executeCommand = async (
      input: unknown,
      opts: ValidationOpts<StandardSchemaV1.InferInput<TSchema>> | undefined,
      deps: TDeps
    ): Promise<
      CommandResult<TOutput, StandardSchemaV1.InferInput<TSchema>, TContext>
    > => {
      console.dir(this["~unsafeInternals"], { depth: null });
      invariant(this.#schema, "Schema must be defined before calling command");
      invariant(
        this.#depsStatus === "passed" || this.#depsStatus === "not-required",
        "Deps must be already passed, or not required at command run time"
      );

      const validation = await this.validate(input, opts);

      if (!validation.success) {
        return { validated: false, errors: validation.errors };
      }

      const executeResult = await args.execute({
        data: validation.value,
        deps,
        context: validation.context,
      });

      if (executeResult instanceof ErrorBag) {
        return { validated: false, errors: executeResult };
      }

      return {
        validated: true,
        result: executeResult,
        context: validation.context,
      };
    };

    if (this.#depsStatus === "passed" || this.#depsStatus === "not-required") {
      return {
        run: async (input: unknown, opts?: ValidationOpts<TSchema>) => {
          return executeCommand(input, opts, this.#deps!);
        },
        runShape: (
          input: StandardSchemaV1.InferInput<TSchema>,
          opts?: ValidationOpts<TSchema>
        ) => {
          return executeCommand(input, opts, this.#deps!);
        },
      };
    } else {
      return {
        provide: (deps: TDeps) => {
          this.setDeps(deps);
          this.setDepsStatus("passed");
          return {
            runShape: (
              input: StandardSchemaV1.InferInput<TSchema>,
              opts?: ValidationOpts<TSchema>
            ) => {
              return executeCommand(input, opts, deps);
            },
            run: async (input: unknown, opts?: ValidationOpts<TSchema>) => {
              return executeCommand(input, opts, deps);
            },
          };
        },
      };
    }
  }
}

export function createValidator() {
  return new FluentValidatorBuilder();
}
