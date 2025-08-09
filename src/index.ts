import type { StandardSchemaV1 } from "./standard-schema.ts";

type TValidationDeps = object;

function invariant<T>(condition: T, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

type ErrorBagFromInput<TInput> = ErrorBag<Exclude<keyof TInput, symbol | number>>;
type ErrorBagFromSchema<TSchema extends StandardSchemaV1> = ErrorBag<Exclude<keyof StandardSchemaV1.InferOutput<TSchema>, symbol | number>>;

export class ErrorBag<TKeys extends string> {
  #issues: Array<{ key: TKeys; message: string }> = [];
  #global: string | undefined;

  addGlobalError(message: string): this {
    this.#global = message;
    return this;
  }

  addError(key: TKeys, message: string): this {
    this.#issues.push({ key, message });
    return this;
  }

  get global(): string | undefined {
    return this.#global;
  }

  firstError(key: TKeys): string | undefined {
    return this.#issues.find((issue) => issue.key === key)?.message;
  }

  hasErrors(): boolean {
    return this.#issues.length > 0 || this.#global !== undefined;
  }

  toObject(): {
    global: string | undefined;
    issues: Partial<Record<TKeys, string[]>>;
  } {
    const issuesObj: Partial<Record<TKeys, string[]>> = {};
    for (const issue of this.#issues) {
      if (!issuesObj[issue.key]) {
        issuesObj[issue.key] = [];
      }
      issuesObj[issue.key]!.push(issue.message);
    }
    return {
      global: this.#global,
      issues: issuesObj,
    };
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
      errors: ErrorBagFromSchema<TSchema>;
      rule: { id?: string; description?: string } | undefined;
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

  const bag: ErrorBagFromSchema<TSchema> = new ErrorBag();

  if (presult.issues) {
    for (const issue of presult.issues) {
      if (typeof issue.message !== "string") {
        throw new Error("Unexpected error format, expected string");
      }
      let path: string;
      if (Array.isArray(issue.path)) {
        path = issue.path.join(".") as string;
      } else if (typeof issue.path === "string") {
        path = issue.path;
      } else {
        throw new Error(
          `Unsupported issue path type ${typeof issue.path}: issue: ${JSON.stringify(
            issue
          )}`
        );
      }
      bag.addError(path as any, issue.message);
    }

    return {
      success: false as const,
      errors: bag,
      rule: undefined,
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
      return {
        success: false,
        errors: bag,
        rule: { id: rule.id, description: rule.description },
      };
    }

    if (result && typeof result === "object") {
      if (
        result !== undefined &&
        result !== null &&
        "context" in result &&
        typeof result.context === "object" &&
        result.context !== null
      ) {
        context = { ...context, ...result.context };
      }
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
  TReturn = {}
> = (args: {
  data: TInput;
  deps: TDeps;
  bag: ErrorBagFromInput<TInput>;
  context: TInputContext;
}) => TReturn | Promise<TReturn> | void | Promise<void>;

type ContextRuleDefinition<
  TInput,
  TDeps extends TValidationDeps = {},
  TInputContext = {},
  TReturn = {}
> = {
  fn: ContextRuleFunction<TInput, TDeps, TInputContext, TReturn>;
  description?: string;
  id?: string;
};

export type CommandResult<TOutput, TInput, TContext> =
  | {
      success: true;
      result: Exclude<TOutput, ErrorBag<any> | void>;
      context: TContext;
    }
  | {
      success: false;
      errors: ErrorBagFromInput<TInput>;
      step: "validation" | "execution";
      rule?: { id?: string; description?: string };
    };

type ExtractContext<T> = T extends { context: infer TContext }
  ? TContext
  : never;

type NonVoidReturnContext<TReturn> = TReturn extends void | Promise<void>
  ? never
  : ExtractContext<TReturn>;

// Utility type to flatten intersection types for better display
type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

type DepsStatus = "not-required" | "required" | "passed";

export class Command<
  TSchema extends StandardSchemaV1,
  TDeps extends TValidationDeps,
  TContext,
  TOutput,
  TDepsStatus extends DepsStatus
> {
  #validatorBuilder: FluentValidatorBuilder<
    TSchema,
    TDeps,
    TContext,
    TDepsStatus
  >;
  #execute: (params: {
    data: StandardSchemaV1.InferOutput<TSchema>;
    deps: TDeps;
    context: TContext;
    bag: ErrorBagFromSchema<TSchema>;
  }) => Promise<TOutput> | TOutput;

  constructor(
    validatorBuilder: FluentValidatorBuilder<
      TSchema,
      TDeps,
      TContext,
      TDepsStatus
    >,
    execute: (params: {
      data: StandardSchemaV1.InferOutput<TSchema>;
      deps: TDeps;
      context: TContext;
      bag: ErrorBagFromSchema<TSchema>;
    }) => Promise<TOutput> | TOutput
  ) {
    this.#validatorBuilder = validatorBuilder;
    this.#execute = execute;
  }

  provide(
    this: Command<TSchema, TDeps, TContext, TOutput, "required">,
    deps: TDeps
  ): Command<TSchema, TDeps, TContext, TOutput, "passed"> {
    const newBuilder = this.#validatorBuilder.provide(deps);
    return new Command(newBuilder, this.#execute);
  }

  run: TDepsStatus extends "required"
    ? never
    : (
        input: unknown,
        opts?: ValidationOpts<StandardSchemaV1.InferInput<TSchema>>
      ) => Promise<
        CommandResult<TOutput, StandardSchemaV1.InferInput<TSchema>, TContext>
      > = (async (
    input: unknown,
    opts?: ValidationOpts<StandardSchemaV1.InferInput<TSchema>>
  ) => {
    const internals = this.#validatorBuilder["~unsafeInternals"];

    invariant(
      internals.depsStatus !== "required",
      "Deps should be provided before calling run"
    );
    invariant(
      internals.schema,
      "Schema must be defined before calling command"
    );

    const validation = await this.#validatorBuilder.validate(input, opts);

    if (!validation.success) {
      return {
        success: false,
        errors: validation.errors,
        step: "validation",
        rule: validation.rule,
      };
    }

    // Create a new error bag for the command execution
    const executionBag: ErrorBagFromSchema<TSchema> = new ErrorBag();

    const executeResult = await this.#execute({
      data: validation.value,
      deps: internals.deps!,
      context: validation.context,
      bag: executionBag,
    });

    // Check if errors were added to the bag during execution
    if (executionBag.hasErrors()) {
      return {
        success: false,
        errors: executionBag,
        step: "execution",
        rule: undefined,
      };
    }

    // Check if the execute function returned an ErrorBag
    if (executeResult instanceof ErrorBag) {
      return {
        success: false,
        errors: executeResult,
        step: "execution",
        rule: undefined,
      };
    }

    return {
      success: true,
      result: executeResult as Exclude<TOutput, ErrorBag<any> | void>,
      context: validation.context,
    };
  }) as any;

  runShape: TDepsStatus extends "required"
    ? never
    : (
        input: StandardSchemaV1.InferInput<TSchema>,
        opts?: ValidationOpts<StandardSchemaV1.InferInput<TSchema>>
      ) => Promise<
        CommandResult<TOutput, StandardSchemaV1.InferInput<TSchema>, TContext>
      > = ((
    input: StandardSchemaV1.InferInput<TSchema>,
    opts?: ValidationOpts<StandardSchemaV1.InferInput<TSchema>>
  ) => {
    const internals = this.#validatorBuilder["~unsafeInternals"];

    invariant(
      internals.depsStatus !== "required",
      "Deps should be provided before calling runShape"
    );

    return this.run(input, opts);
  }) as any;
}
type FluentValidatorBuilderState<
  TSchema extends StandardSchemaV1,
  TDeps extends TValidationDeps
> = {
  schema: TSchema | undefined;
  deps: TDeps | undefined;
  contextRules: Array<ContextRuleDefinition<any, any, any, any>>;
  depsStatus: DepsStatus;
};

export class FluentValidatorBuilder<
  TSchema extends StandardSchemaV1 = any,
  TDeps extends TValidationDeps = {},
  TContext = {},
  TDpesStatus extends DepsStatus = "not-required"
> {
  #state: FluentValidatorBuilderState<TSchema, TDeps>;

  constructor(state?: FluentValidatorBuilderState<TSchema, TDeps>) {
    this.#state = state || {
      contextRules: [],
      schema: undefined,
      deps: undefined,
      depsStatus: "not-required",
    };
  }

  #setState<
    NewSchema extends StandardSchemaV1 = TSchema,
    NewDeps extends TValidationDeps = TDeps,
    NewContext = TContext,
    NewDepsStatus extends DepsStatus = TDpesStatus
  >(
    updates: Partial<FluentValidatorBuilderState<NewSchema, NewDeps>>
  ): FluentValidatorBuilder<NewSchema, NewDeps, NewContext, NewDepsStatus> {
    // Update the state object
    Object.assign(this.#state, updates);
    // Return this instance but cast to the new type
    return this as any;
  }

  input<T extends StandardSchemaV1>(
    schema: T
  ): FluentValidatorBuilder<T, TDeps, TContext, TDpesStatus> {
    return this.#setState<T, TDeps, TContext, TDpesStatus>({ schema });
  }

  $deps<T extends TValidationDeps>(): FluentValidatorBuilder<
    TSchema,
    T,
    TContext,
    "required"
  > {
    return this.#setState<TSchema, T, TContext, "required">({
      depsStatus: "required",
    });
  }

  get ["~unsafeInternals"](): FluentValidatorBuilderState<TSchema, TDeps> {
    return this.#state;
  }

  validate: TDpesStatus extends "required"
    ? never
    : (
        input: unknown,
        opts?: ValidationOpts<StandardSchemaV1.InferInput<TSchema>>
      ) => Promise<
        | {
            success: true;
            value: StandardSchemaV1.InferOutput<TSchema>;
            context: TContext;
          }
        | {
            success: false;
            errors: ErrorBagFromSchema<TSchema>;
            rule?: { id?: string; description?: string };
          }
      > = ((
    input: unknown,
    opts?: ValidationOpts<StandardSchemaV1.InferInput<TSchema>>
  ) => {
    invariant(
      this.#state.depsStatus !== "required",
      "Deps should be provided before calling validate"
    );
    invariant(
      this.#state.schema,
      "Schema must be defined before calling validate"
    );

    return validate<TSchema, TContext>({
      schema: this.#state.schema,
      input,
      rules: this.#state.contextRules,
      opts,
      deps: this.#state.deps ?? {},
    });
  }) as any;

  rule<TReturn>(
    rule: ContextRuleDefinition<
      StandardSchemaV1.InferOutput<TSchema>,
      TDeps,
      TContext,
      TReturn
    >
  ): FluentValidatorBuilder<
    TSchema,
    TDeps,
    NonVoidReturnContext<TReturn> extends never
      ? TContext
      : Prettify<TContext & NonVoidReturnContext<TReturn>>,
    TDpesStatus
  > {
    type NewContext = NonVoidReturnContext<TReturn> extends never
      ? TContext
      : Prettify<TContext & NonVoidReturnContext<TReturn>>;

    return this.#setState<TSchema, TDeps, NewContext, TDpesStatus>({
      contextRules: [...this.#state.contextRules, rule],
    });
  }

  provide(
    this: FluentValidatorBuilder<TSchema, TDeps, TContext, "required">,
    deps: TDeps
  ): FluentValidatorBuilder<TSchema, TDeps, TContext, "passed"> {
    return this.#setState<TSchema, TDeps, TContext, "passed">({
      deps,
      depsStatus: "passed",
    });
  }

  command<TOutput>(args: {
    execute: (params: {
      data: StandardSchemaV1.InferOutput<TSchema>;
      deps: TDeps;
      context: TContext;
      bag: ErrorBagFromSchema<TSchema>;
    }) => Promise<TOutput> | TOutput;
  }): Command<TSchema, TDeps, TContext, TOutput, TDpesStatus> {
    return new Command(this, args.execute);
  }
}

export function buildValidator() {
  return new FluentValidatorBuilder();
}

export type InferCommandResult<
  TCommand extends Command<any, any, any, any, any>,
  TCondition extends "success" | "failure" | "all" = "all"
> = TCommand extends Command<
  infer TSchema,
  any,
  infer TContext,
  infer TOutput,
  any
>
  ? TCondition extends "success"
    ? CommandResult<TOutput, StandardSchemaV1.InferInput<TSchema>, TContext> & {
        success: true;
      }
    : TCondition extends "failure"
    ? CommandResult<TOutput, StandardSchemaV1.InferInput<TSchema>, TContext> & {
        success: false;
      }
    : CommandResult<TOutput, StandardSchemaV1.InferInput<TSchema>, TContext>
  : never;
