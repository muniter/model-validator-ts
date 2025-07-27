import { test, expect, describe, assert } from "vitest";
import { z } from "zod";
import { createValidator } from "./index.js";

const layerRepository = {
  getLayer: async (id: string): Promise<{ name: string } | null> => {
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
      // @ts-expect-error - Deps are not provided, depsStatus is required
      () => validator.validate({ name: "John" })
    ).toThrow("Deps must be passed or not required at validation time");
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
    assert(result.validated);
    expect(result.result).toEqual("John");
  });

  test("Command can be called after providing deps", async () => {
    const validator = createValidator()
      .input(testSchema)
      .$deps<{
        layerRepository: {
          getLayer: (id: string) => Promise<{ name: string } | null>;
        };
      }>()

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
    assert(result.validated);
    expect(result.result).toEqual("John");
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
          return { layer };
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
            return args.bag.addError(
              "visibility",
              "Layers with confidential classification cannot be public visibility"
            );
          }
        },
      })
      .provide({ layerRepository });

    const input = {
      layerId: "layer-1",
      visibility: "public",
    };
    const result = await upateLayerValidatorDefinition.validate(input);
    assert(result.success);
    expect(result.value).toEqual(input);
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

    // Test with invalid input (name too short)
    const result1 = await commandDefinition.run({
      name: "ab",
      age: 20,
    });
    expect(result1.validated).toBe(false);
    if (!result1.validated) {
      expect(result1.errors.firstError("name")).toContain("3");
    }

    // Test with invalid input (age too low)
    const result2 = await commandDefinition.run({
      name: "John",
      age: 17,
    });
    expect(result2.validated).toBe(false);
    if (!result2.validated) {
      expect(result2.errors.firstError("age")).toContain("18");
    }

    // Test with valid input
    const result3 = await commandDefinition.run({
      name: "John",
      age: 25,
    });
    expect(result3.validated).toBe(true);
    if (result3.validated) {
      expect(result3.result).toEqual({ id: "123", name: "John", age: 25 });
    }
  });
});
