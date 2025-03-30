import { test, expect, describe, expectTypeOf } from "vitest";
import { z } from "zod";
import { ValidatorModel, ValidatorDefinition, type ErrorBag } from "./index.js"
import { createCommand } from "./index.js"
import { createValidatorBuilder } from "./index.js"

describe("Validation Utilities", () => {
  // Setup common test schema and types
  const testSchema = z.object({
    name: z.string().min(3),
    age: z.number().min(18),
    email: z.string().email(),
  });
  
  type TestDeps = { maxAge: number };

  describe("Type Tests", () => {
    test("validator types are properly inferred", () => {
      const validator = new ValidatorDefinition({
        schema: testSchema,
        rules: [],
        deps: {} as TestDeps
      });
      
      type TestOutput = z.infer<typeof testSchema>;
      
      validator
        .addRule({
          attribute: "age",
          fn: (args) => {
            expectTypeOf(args.deps).toEqualTypeOf<TestDeps>();
            expectTypeOf(args.data).toEqualTypeOf<TestOutput>();
            expectTypeOf(args.property).toEqualTypeOf<keyof TestOutput | "global">();
            expectTypeOf(args.builder).toEqualTypeOf<ValidatorModel<typeof testSchema, TestDeps>>();
          }
        })
        .addRule({
          attribute: "name",
          fn: () => {}
        });

      // Test that attribute must be a key of TestType
      validator.addRule({
        // @ts-expect-error attribute must be keyof TestType
        attribute: "nonexistent",
        fn: () => {}
      });

      // Test builder dependencies type
      const builder = validator.build({ maxAge: 50 });
      // @ts-expect-error missing maxAge
      validator.build({});
      // @ts-expect-error wrong type for maxAge
      validator.build({ maxAge: "50" });

      // Test validation result types
      async () => {
        const result = await builder.validate({
          name: "Test",
          age: 20,
          email: "test@example.com"
        });

        if (result.success) {
          expectTypeOf(result.value).toEqualTypeOf<TestOutput>();
        } else {
          expectTypeOf(result.errors).toEqualTypeOf<ErrorBag<typeof testSchema>>();
        }
      };
    });

    test("validateShape enforces input type", () => {
      const validator = new ValidatorDefinition({
        schema: testSchema,
        rules: [],
        deps: {} as TestDeps
      });
      const builder = validator.build({ maxAge: 50 });

      // Should accept valid TestType
      builder.validateShape({
        name: "Test",
        age: 20,
        email: "test@example.com"
      });

      // @ts-expect-error missing properties
      builder.validateShape({
        name: "Test"
      });

      builder.validateShape({
        name: "Test",
        // @ts-expect-error wrong property type
        age: "20",
        email: "test@example.com"
      });
    });
  });

  describe("Runtime Tests", () => {
    test("validates with proper dependencies", async () => {
      const validator = new ValidatorDefinition({
        schema: testSchema,
        rules: [],
        deps: {} as TestDeps
      });
      
      validator.addRule({
        attribute: "age",
        fn: ({ data, deps, builder }) => {
          if (data.age > deps.maxAge) {
            builder.addError("age", "Too old");
          }
        }
      });

      const builder = validator.build({ maxAge: 50 });
      const result = await builder.validate({
        name: "Test",
        age: 51,
        email: "test@example.com"
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.firstError("age")).toBe("Too old");
      }
    });

    test("validates with async rules", async () => {
      const validator = new ValidatorDefinition({
        schema: testSchema,
        rules: [],
        deps: {} as TestDeps
      });
      
      validator.addRule({
        attribute: "age",
        fn: async ({ data, deps, builder }) => {
          // Simulate an async operation
          await new Promise(resolve => setTimeout(resolve, 10));
          if (data.age > deps.maxAge) {
            builder.addError("age", "Too old");
          }
        }
      });

      const builder = validator.build({ maxAge: 50 });
      const result = await builder.validate({
        name: "Test",
        age: 51,
        email: "test@example.com"
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.errors.firstError("age")).toBe("Too old");
      }
    });
  });

  describe("Command Tests", () => {
    // Setup a test command schema and dependencies
    const testCommandSchema = z.object({
      title: z.string().min(3),
      priority: z.number().min(1).max(5),
    });

    type TestCommandDeps = {
      taskService: {
        create(input: { title: string; priority: number }): Promise<{ id: string }>;
        exists(title: string): Promise<boolean>;
      };
    };
    
    const testDeps = {
      taskService: {
        async create(input: { title: string; priority: number }) {
          return { id: "test-123", ...input };
        },
        async exists(title: string) {
          title = title.toLowerCase();
          return false;
        },
      },
    };

    const testValidator = new ValidatorDefinition({
      schema: testCommandSchema,
      rules: [
        {
          attribute: "title",
          fn: async ({ data, deps, builder }) => {
            if (await deps.taskService.exists(data.title)) {
              builder.addError("title", "Task already exists");
            }
          },
        },
      ],
      deps: {} as TestCommandDeps
    })

    test("command executes successfully with valid input", async () => {
      const command = createCommand({
        validator: testValidator,
        deps: testDeps,
        execute: async ({ data,deps }) => {
          const result = await deps.taskService.create(data);
          return result;
        },
      });
      
      const input = {
        title: "Test Task",
        priority: 3,
      }

      const result = await command.run(input);

      expect(result.validated).toBe(true);
      if (result.validated) {
        expect(result.result).toEqual({ id: "test-123", ...input });
      }
    });

    test("command fails validation with invalid input", async () => {
      const command = createCommand({
        validator: testValidator,
        deps: testDeps,
        execute: async ({ data, deps }) => {
          const result = await deps.taskService.create(data);
          return result;
        },
      });

      const result = await command.run({
        title: "Te", // Too short
        priority: 3,
      });

      expect(result.validated).toBe(false);
      if (!result.validated) {
        expect(result.errors.firstError("title")).toBeDefined();
      }
    });

    test("command fails validation when business rule fails", async () => {
      const command = createCommand({
        validator: testValidator,
        deps: {
          taskService: {
            ...testDeps.taskService,
            exists: async () => {
              return true;
            }
          }
        },
        execute: async ({ data, deps }) => {
          const result = await deps.taskService.create(data);
          return result;
        },
      });

      const result = await command.run({
        title: "Test Task",
        priority: 3,
      });

      expect(result.validated).toBe(false);
      if (!result.validated) {
        expect(result.errors.firstError("title")).toBe("Task already exists");
      }
    });

    test("execute function receives validated data", async () => {
      let executedData: unknown;

      const command = createCommand({
        validator: testValidator,
        deps: testDeps,
        execute: async ({ data, deps }) => {
          executedData = data;
          return deps.taskService.create(data);
        },
      });

      const result = await command.run({
        title: "Test Task",
        priority: 3,
      });
      
      expect(result.validated).toBe(true);
      // Check the types
      if (result.validated) {
        expectTypeOf(result.result).toEqualTypeOf<{ id: string }>();
      }

      expect(executedData).toEqual({
        title: "Test Task",
        priority: 3,
      });
    });

    test("type tests", () => {
      createCommand({
        validator: testValidator,
        deps: testDeps,
        execute: async ({ data, deps }) => {
          // Type checks for data
          expectTypeOf(data.title).toBeString();
          expectTypeOf(data.priority).toBeNumber();
          
          // Type checks for deps
          expectTypeOf(deps.taskService.create).toBeFunction();
          expectTypeOf(deps.taskService.exists).toBeFunction();

          return deps.taskService.create(data);
        },
      });

    });
  });

  describe("Validator Builder Tests", () => {
    test("creates validator with pre-build dependencies", () => {
      const AppValidatorDefinition = createValidatorBuilder({
        deps: {
          db: {
            query: (sql: string) => Promise.resolve({ rows: [{ id: "1" }] }),
            getUser: (name: string) => Promise.resolve({ id: "1", name })
          }
        }
      });

      const CreateUserValidator = AppValidatorDefinition({
        schema: z.object({
          name: z.string(),
          email: z.string().email(),
          password: z.string().min(8),
        }),
        rules: [
          {
            attribute: "name",
            fn: async (args) => {
              const { db, logger } = args.deps;
              logger.log("Checking if user exists");
              const user = await db.getUser(args.data.name);
              if (user) {
                args.builder.addError("name", "User already exists");
              }
            }
          }
        ],
        deps: {} as { logger: { log: (message: string) => void } }
      });

      // Test type inference
      expectTypeOf(CreateUserValidator.build).toBeFunction();
      const validator = CreateUserValidator.build({ logger: console });
      expectTypeOf(validator).toBeObject();
      expectTypeOf(validator.errors).toBeObject();
      expectTypeOf(validator.errors.addError).toBeFunction();
    });

    test("validator builder with empty dependencies", () => {
      const SimpleValidatorDefinition = createValidatorBuilder({});
      
      const SimpleValidator = SimpleValidatorDefinition({
        schema: z.object({
          name: z.string(),
        }),
        rules: [
          {
            attribute: "name",
            fn: (args) => {
              args.builder.addError("name", "Test error");
            }
          }
        ],
        deps: {} as Record<string, never>
      });

      // Should allow building without dependencies
      const validator = SimpleValidator.build();
      expectTypeOf(validator).toBeObject();
      expectTypeOf(validator.errors).toBeObject();
      expectTypeOf(validator.errors.addError).toBeFunction();
    });

    test("validator builder with function dependencies", () => {
      const AppValidatorDefinition = createValidatorBuilder({
        deps: () => ({
          db: {
            query: (sql: string) => Promise.resolve({ rows: [{ id: "1", sql }] }),
            getUser: (name: string) => Promise.resolve({ id: "1", name })
          }
        })
      });

      const CreateUserValidator = AppValidatorDefinition({
        schema: z.object({
          name: z.string(),
          email: z.string().email(),
        }),
        rules: [
          {
            attribute: "name",
            fn: async (args) => {
              const { db } = args.deps;
              const user = await db.getUser(args.data.name);
              if (user) {
                args.builder.addError("name", "User exists");
              }
            }
          }
        ],
        deps: {} as { logger: { log: (message: string) => void } }
      });

      const validator = CreateUserValidator.build({ logger: console });
      expectTypeOf(validator).toBeObject();
      expectTypeOf(validator.errors).toBeObject();
      expectTypeOf(validator.errors.addError).toBeFunction();
    });
  });
});
