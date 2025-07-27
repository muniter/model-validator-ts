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
  bag: ErrorBag<TInput>;
  context: TInputContext;
}) => TReturn | Promise<TReturn> | void | Promise<void>;

type ContextRuleDefinition<
  TInput,
  TDeps extends TValidationDeps = {},
  TInputContext = {},
  TReturn = {}
> = {
  fn: ContextRuleFunction<TInput, TDeps, TInputContext, TReturn>;
};

export type CommandResult<TOutput, TInput, TContext> =
  | { validated: true; result: TOutput; context: TContext }
  | { validated: false; errors: ErrorBag<TInput>; step: "validation" | "execution" };

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
    bag: ErrorBag<StandardSchemaV1.InferOutput<TSchema>>;
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
      bag: ErrorBag<StandardSchemaV1.InferOutput<TSchema>>;
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

  async run(
    this: Command<TSchema, TDeps, TContext, TOutput, "passed" | "not-required">,
    input: unknown,
    opts?: ValidationOpts<StandardSchemaV1.InferInput<TSchema>>
  ): Promise<
    CommandResult<TOutput, StandardSchemaV1.InferInput<TSchema>, TContext>
  > {
    const internals = this.#validatorBuilder["~unsafeInternals"];

    invariant(
      internals.schema,
      "Schema must be defined before calling command"
    );
    invariant(
      internals.depsStatus === "passed" ||
        internals.depsStatus === "not-required",
      "Deps must be already passed, or not required at command run time"
    );

    const validation = await this.#validatorBuilder.validate(input, opts);

    if (!validation.success) {
      return { validated: false, errors: validation.errors, step: "validation" };
    }

    // Create a new error bag for the command execution
    const executionBag = new ErrorBag<StandardSchemaV1.InferOutput<TSchema>>();

    const executeResult = await this.#execute({
      data: validation.value,
      deps: internals.deps!,
      context: validation.context,
      bag: executionBag,
    });

    // Check if errors were added to the bag during execution
    if (executionBag.hasErrors()) {
      return { validated: false, errors: executionBag, step: "execution" };
    }

    // Check if the execute function returned an ErrorBag
    if (executeResult instanceof ErrorBag) {
      return { validated: false, errors: executeResult, step: "execution" };
    }

    return {
      validated: true,
      result: executeResult,
      context: validation.context,
    };
  }

  runShape(
    this: Command<TSchema, TDeps, TContext, TOutput, "passed" | "not-required">,
    input: StandardSchemaV1.InferInput<TSchema>,
    opts?: ValidationOpts<StandardSchemaV1.InferInput<TSchema>>
  ): Promise<
    CommandResult<TOutput, StandardSchemaV1.InferInput<TSchema>, TContext>
  > {
    return this.run(input, opts);
  }
}
type FluentValidatorBuilderState<
  TSchema extends StandardSchemaV1,
  TDeps extends TValidationDeps,
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
    updates: Partial<
      FluentValidatorBuilderState<NewSchema, NewDeps>
    >
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
            errors: ErrorBag<StandardSchemaV1.InferInput<TSchema>>;
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

  addRule<TReturn>(
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
      bag: ErrorBag<StandardSchemaV1.InferOutput<TSchema>>;
    }) => Promise<TOutput> | TOutput;
  }): Command<TSchema, TDeps, TContext, TOutput, TDpesStatus> {
    return new Command(this, args.execute);
  }
}

export function createValidator() {
  return new FluentValidatorBuilder();
}
