import { test, expect, describe, assert } from "vitest";
import { z } from "zod";
import { createValidator } from "./index.js";

const layerRepository = {
  getLayer: async (
    id: string
  ): Promise<{ name: string; classification?: string } | null> => {
    if (id === "layer-1") {
      return { name: "Layer 1" };
    }
    return null;
  },
};
type LayerRepository = typeof layerRepository;

describe("Fluent Validator methods", () => {
  const testSchema = z.object({ name: z.string() });
  test("Validator with no deps can be called with validate", async () => {
    const validator = createValidator().input(testSchema);

    expect(validator["~unsafeInternals"]).toMatchObject({
      contextRules: expect.any(Array),
      schema: testSchema,
      deps: undefined,
      depsStatus: "not-required",
    });

    const result = await validator.validate({ name: "John" });
    assert(result.success);
    expect(result.value).toEqual({ name: "John" });
  });

  test("Validator with deps can only be called after providing deps", async () => {
    const validator = createValidator().input(testSchema).$deps<{
      layerRepository: {
        getLayer: (id: string) => Promise<{ name: string } | null>;
      };
    }>();

    expect(validator["~unsafeInternals"]).toMatchObject({
      schema: testSchema,
      deps: undefined,
      depsStatus: "required",
    });

    expect(
      // @ts-expect-error - validate method should not be available when deps are required
      () => validator.validate({ name: "John" })
    ).toThrow("Deps should be provided before calling validate");
  });

  test("Validator with deps can be called after providing deps", async () => {
    const validator = createValidator().input(testSchema).$deps<{
      layerRepository: {
        getLayer: (id: string) => Promise<{ name: string } | null>;
      };
    }>();

    expect(validator["~unsafeInternals"]).toMatchObject({
      schema: testSchema,
      deps: undefined,
      depsStatus: "required",
    });

    const deps = { layerRepository };
    const validatorWithDeps = validator.provide(deps);

    expect(validatorWithDeps["~unsafeInternals"]).toMatchObject({
      schema: testSchema,
      deps,
      depsStatus: "passed",
    });

    const result = await validatorWithDeps.validate({ name: "John" });
    assert(result.success);
    expect(result.value).toEqual({ name: "John" });
  });

  test("Command can only be called directly if no deps are required", async () => {
    const validator = createValidator().input(testSchema);

    expect(validator["~unsafeInternals"]).toMatchObject({
      schema: testSchema,
      deps: undefined,
      depsStatus: "not-required",
    });

    const command = validator.command({
      execute: async (args) => {
        return args.data.name;
      },
    });

    const result = await command.run({ name: "John" });
    assert(result.success);
    expect(result.result).toEqual("John");
  });

  test("Command can be called after providing deps", async () => {
    const validator = createValidator().input(testSchema).$deps<{
      layerRepository: {
        getLayer: (id: string) => Promise<{ name: string } | null>;
      };
    }>();

    expect(validator["~unsafeInternals"]).toMatchObject({
      schema: testSchema,
      deps: undefined,
      depsStatus: "required",
    });

    const command = validator.command({
      execute: async (args) => {
        return args.data.name;
      },
    });

    const result = await command
      .provide({ layerRepository })
      .run({ name: "John" });
    assert(result.success);
    expect(result.result).toEqual("John");
  });
});

describe("Fluent Validator object creation efficiency", () => {
  test("should reuse the same instance when chaining methods", () => {
    const validator = createValidator();
    const withInput = validator.input(z.object({ test: z.string() }));
    const withDeps = withInput.$deps<{ service: string }>();
    const withRule = withDeps.addRule({
      fn: () => {},
    });
    const withProvide = withDeps.provide({ service: "test" });

    // All should be the same underlying object instance
    expect(validator).toBe(withInput);
    expect(validator).toBe(withDeps);
    expect(validator).toBe(withRule);
    expect(validator).toBe(withProvide);
  });
});

describe("Fluent Validator with Context", () => {
  test("can pass context between rules", async () => {
    const updateLayerVisibilitySchema = z.object({
      layerId: z.string(),
      visibility: z.enum(["public", "private"]),
    });

    const upateLayerValidatorDefinition = createValidator()
      .input(updateLayerVisibilitySchema)
      .$deps<{
        layerRepository: LayerRepository;
      }>()
      .addRule({
        fn: async (args) => {
          const layer = await args.deps.layerRepository.getLayer(
            args.data.layerId
          );
          if (!layer) {
            return args.bag.addError("layerId", "Layer not found");
          }
          return { context: { layer } };
        },
      })
      .addRule({
        fn: async (args) => {
          expect(args.context).toBeDefined();
          const layer = args.context.layer;
          if (
            layer.classification === "confidential" &&
            args.data.visibility === "public"
          ) {
            args.bag.addError(
              "visibility",
              "Layers with confidential classification cannot be public visibility"
            );
          }

          return { context: { secret: "123" } };
        },
      })
      .addRule({
        fn: async (args) => {
          expect(args.context).toBeDefined();
          const secret = args.context.secret;
          const layer = args.context.layer;

          expect({
            secret,
            layer,
          }).toMatchObject({
            layer: expect.objectContaining({
              name: expect.any(String),
            }),
            secret: "123",
          } as const);
        },
      })
      .provide({ layerRepository });

    const input = {
      layerId: "layer-1",
      visibility: "public",
    };
    const result = await upateLayerValidatorDefinition.validate(input);
    assert(result.success);
    expect(result.context).toMatchObject({
      layer: expect.objectContaining({
        name: expect.any(String),
      }),
      secret: "123",
    });
    expect(result.value).toEqual(input);
  });

  test("command provides error bag to allow faliures at execution time", async () => {
    const transferMoneySchema = z.object({
      fromAccount: z.string(),
      toAccount: z.string(),
      amount: z.number().positive(),
    });

    // Mock database service
    const mockDb = {
      executeTransaction: async (fn: () => Promise<any>) => {
        try {
          return await fn();
        } catch (error) {
          throw error;
        }
      },
      debit: async (account: string, amount: number) => {
        if (account === "insufficient-funds") {
          throw new Error("Insufficient funds");
        }
        if (account === "locked-account") {
          throw new Error("Account is locked");
        }
      },
      credit: async (account: string, amount: number) => {
        if (account === "closed-account") {
          throw new Error("Cannot credit closed account");
        }
      },
    };

    const transferCommand = createValidator()
      .input(transferMoneySchema)
      .$deps<{ db: typeof mockDb }>()
      .addRule({
        fn: async (args) => {
          // Business rule: Cannot transfer to same account
          if (args.data.fromAccount === args.data.toAccount) {
            args.bag.addError("toAccount", "Cannot transfer to same account");
          }
        },
      })
      .command({
        execute: async (args) => {
          try {
            // All validation passed, execute the transaction
            await args.deps.db.executeTransaction(async () => {
              await args.deps.db.debit(args.data.fromAccount, args.data.amount);
              await args.deps.db.credit(args.data.toAccount, args.data.amount);
            });

            return {
              transactionId: `txn-${Date.now()}`,
              status: "completed",
              ...args.data,
            };
          } catch (error) {
            // Transaction failed - report the error
            if (error instanceof Error) {
              args.bag.addError(
                "global",
                `Transaction failed: ${error.message}`
              );
            }
            return args.bag;
          }
        },
      });

    // Test validation failure (business rule violation) - step should be "validation"
    const result1 = await transferCommand.provide({ db: mockDb }).run({
      fromAccount: "account-123",
      toAccount: "account-123", // Same account - violates business rule
      amount: 100,
    });

    assert(!result1.success);
    expect(result1.step).toBe("validation");
    expect(result1.errors.firstError("toAccount")).toContain(
      "Cannot transfer to same account"
    );

    // Test execution failure (runtime error) - step should be "execution"
    const result2 = await transferCommand.provide({ db: mockDb }).run({
      fromAccount: "insufficient-funds",
      toAccount: "account-456",
      amount: 100,
    });

    assert(!result2.success);
    expect(result2.step).toBe("execution");
    expect(result2.errors.firstError("global")).toContain("Insufficient funds");

    // Test successful transfer
    const result3 = await transferCommand.provide({ db: mockDb }).run({
      fromAccount: "account-456",
      toAccount: "account-789",
      amount: 50,
    });

    assert(result3.success);
    expect(result3.result.status).toBe("completed");
    expect(result3.result.amount).toBe(50);
  });

  test("schema validation works", async () => {
    const schema = z.object({
      name: z.string().min(3),
      age: z.number().min(18),
    });

    const commandDefinition = createValidator()
      .input(schema)
      .command({
        execute: async (args) => {
          return { id: "123", ...args.data };
        },
      });

    // Test with invalid input (name too short) - should be validation step
    const result1 = await commandDefinition.run({
      name: "ab",
      age: 20,
    });
    assert(!result1.success);
    expect(result1.step).toBe("validation");
    expect(result1.errors.firstError("name")).toContain("3");

    // Test with invalid input (age too low) - should be validation step
    const result2 = await commandDefinition.run({
      name: "John",
      age: 17,
    });
    assert(!result2.success);
    expect(result2.step).toBe("validation");
    expect(result2.errors.firstError("age")).toContain("18");

    // Test with valid input
    const result3 = await commandDefinition.run({
      name: "John",
      age: 25,
    });
    assert(result3.success);
    expect(result3.result).toEqual({ id: "123", name: "John", age: 25 });
  });
});
