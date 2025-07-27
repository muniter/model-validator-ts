import { test, expect, describe, assert } from "vitest";
import { z } from "zod";
import { createValidator } from "./index.js";

const userRepository = {
  findUserByEmail: async (
    email: string
  ): Promise<{ id: string; email: string } | null> => {
    // Simulate existing users
    if (email === "existing@example.com") {
      return { id: "user-123", email };
    }
    return null;
  },
  findUserById: async (
    id: string
  ): Promise<{ id: string; email: string } | null> => {
    // Simulate existing users
    if (id === "user-456") {
      return { id, email: "newemail@example.com" };
    }
    return null;
  },
  isEmailBlacklisted: async (email: string): Promise<boolean> => {
    // Simulate blacklisted domains/emails
    const blacklistedDomains = ["spam.com", "blocked.net"];
    const blacklistedEmails = ["admin@badactor.com"];

    if (blacklistedEmails.includes(email)) return true;

    const domain = email.split("@")[1];
    if (!domain) return false;
    return blacklistedDomains.includes(domain);
  },
  createUser: async (userData: {
    email: string;
    name: string;
    age: number;
  }) => {
    return {
      id: `user-${Date.now()}`,
      ...userData,
      createdAt: new Date().toISOString(),
    };
  },
};
type UserRepository = typeof userRepository;

describe("Basic Validator API", () => {
  const userRegistrationSchema = z.object({
    email: z.string().email(),
    name: z.string().min(2),
    age: z.number().min(18),
  });

  test("Validator with no deps can be called with validate", async () => {
    const validator = createValidator().input(userRegistrationSchema);

    expect(validator["~unsafeInternals"]).toMatchObject({
      contextRules: expect.any(Array),
      schema: userRegistrationSchema,
      deps: undefined,
      depsStatus: "not-required",
    });

    const result = await validator.validate({
      email: "john@example.com",
      name: "John Doe",
      age: 25,
    });
    assert(result.success);
    expect(result.value).toEqual({
      email: "john@example.com",
      name: "John Doe",
      age: 25,
    });
  });

  test("Validator with deps can only be called after providing deps", async () => {
    const validator = createValidator().input(userRegistrationSchema).$deps<{
      userRepository: UserRepository;
    }>();

    expect(validator["~unsafeInternals"]).toMatchObject({
      schema: userRegistrationSchema,
      deps: undefined,
      depsStatus: "required",
    });

    expect(() =>
      // @ts-expect-error: Validate is not available at the type level, this is correct
      // but we also want to test runtime behavior and that's an error being thrown because
      // the method is actually there but should not be called
      validator.validate({
        email: "john@example.com",
        name: "John Doe",
        age: 25,
      })
    ).toThrow("Deps should be provided before calling validate");
  });

  test("Validator with deps can be called after providing deps", async () => {
    const validator = createValidator().input(userRegistrationSchema).$deps<{
      userRepository: UserRepository;
    }>();

    expect(validator["~unsafeInternals"]).toMatchObject({
      schema: userRegistrationSchema,
      deps: undefined,
      depsStatus: "required",
    });

    const deps = { userRepository };
    const validatorWithDeps = validator.provide(deps);

    expect(validatorWithDeps["~unsafeInternals"]).toMatchObject({
      schema: userRegistrationSchema,
      deps,
      depsStatus: "passed",
    });

    const result = await validatorWithDeps.validate({
      email: "john@example.com",
      name: "John Doe",
      age: 25,
    });
    assert(result.success);
    expect(result.value).toEqual({
      email: "john@example.com",
      name: "John Doe",
      age: 25,
    });
  });

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

describe("Schema Validation", () => {
  test("schema validation works with basic types", async () => {
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

describe("Context Passing & Rule Chain", () => {
  test("can pass context between rules", async () => {
    const updateEmailSchema = z.object({
      userId: z.string(),
      newEmail: z.string().email(),
    });

    const updateEmailValidatorDefinition = createValidator()
      .input(updateEmailSchema)
      .$deps<{
        userRepository: UserRepository;
      }>()
      .addRule({
        id: "user-exists-check",
        description: "Check if user exists",
        fn: async (args) => {
          const user = await args.deps.userRepository.findUserById(
            args.data.userId
          );
          if (!user) {
            return args.bag.addError("userId", "User not found");
          }
          return {
            context: {
              user,
            },
          };
        },
      })
      .addRule({
        description: "Check if new email is already taken",
        fn: async (args) => {
          expect(args.context.user).toBeDefined();
          if (args.context.user && args.context.user.id !== args.data.userId) {
            return args.bag.addError(
              "newEmail",
              "Email already taken by another user"
            );
          }
        },
      })
      .addRule({
        id: "blacklist-check-context",
        description: "Check if new email is blacklisted",
        fn: async (args) => {
          expect(args.context.user).toBeDefined();
          const isBlacklisted =
            await args.deps.userRepository.isEmailBlacklisted(
              args.data.newEmail
            );
          if (isBlacklisted) {
            return args.bag.addError("newEmail", "Email domain is not allowed");
          }
          return { context: { validationToken: "abc123" } };
        },
      })
      .addRule({
        fn: async (args) => {
          expect(args.context).toBeDefined();
          const validationToken = args.context.validationToken;
          const user = args.context.user;

          expect({
            validationToken,
            user,
          }).toMatchObject({
            user: expect.objectContaining({
              id: expect.any(String),
              email: expect.any(String),
            }),
            validationToken: "abc123",
          } as const);
        },
      })
      .provide({ userRepository });

    // Test successful case
    const input = {
      userId: "user-456",
      newEmail: "newemail@example.com",
    };
    const result = await updateEmailValidatorDefinition.validate(input);
    assert(result.success);
    expect(result.context).toMatchObject({
      user: { id: "user-456", email: "newemail@example.com" },
      validationToken: "abc123",
    });
    expect(result.value).toEqual(input);

    // Test failure case to check rule tracking with blacklisted email
    const failResult = await updateEmailValidatorDefinition.validate({
      userId: "user-456",
      // This will trigger blacklist rule
      newEmail: "test@spam.com",
    });
    assert(!failResult.success);
    expect(failResult.errors.firstError("newEmail")).toBe(
      "Email domain is not allowed"
    );
    expect(failResult.rule).toMatchObject({
      id: "blacklist-check-context",
      description: "Check if new email is blacklisted",
    });

    const failNoExists = await updateEmailValidatorDefinition.validate({
      userId: "user-789",
      newEmail: "test@spam.com",
    });
    assert(!failNoExists.success);
    expect(failNoExists.errors.firstError("userId")).toBe("User not found");
    expect(failNoExists.rule?.id).toBe("user-exists-check");
  });
});

describe("Command API", () => {
  const userRegistrationSchema = z.object({
    email: z.string().email(),
    name: z.string().min(2),
    age: z.number().min(18),
  });

  test("Command can only be called directly if no deps are required", async () => {
    const validator = createValidator().input(userRegistrationSchema);

    expect(validator["~unsafeInternals"]).toMatchObject({
      schema: userRegistrationSchema,
      deps: undefined,
      depsStatus: "not-required",
    });

    const command = validator.command({
      execute: async (args) => {
        return { userId: "user-123", ...args.data };
      },
    });

    const result = await command.run({
      email: "john@example.com",
      name: "John Doe",
      age: 25,
    });
    assert(result.success);
    expect(result.result).toEqual({
      userId: "user-123",
      email: "john@example.com",
      name: "John Doe",
      age: 25,
    });
  });

  test("Command can be called after providing deps", async () => {
    const validator = createValidator().input(userRegistrationSchema).$deps<{
      userRepository: UserRepository;
    }>();

    expect(validator["~unsafeInternals"]).toMatchObject({
      schema: userRegistrationSchema,
      deps: undefined,
      depsStatus: "required",
    });

    const command = validator.command({
      execute: async (args) => {
        return await args.deps.userRepository.createUser(args.data);
      },
    });

    // Without providing deps, the command should throw an error
    await expect(
      // @ts-expect-error: run is not available at the type level when deps are required
      command.run({ email: "john@example.com", name: "John Doe", age: 25 })
    ).rejects.toThrow("Deps should be provided before calling run");

    // runShape should also not be available without providing deps
    expect(
      // @ts-expect-error: runShape is not available at the type level when deps are required
      () => command.runShape({ email: "test@example.com", name: "Test", age: 25 })
    ).toThrow("Deps should be provided before calling runShape");

    const result = await command
      .provide({ userRepository })
      .run({ email: "john@example.com", name: "John Doe", age: 25 });
    assert(result.success);
    expect(result.result).toMatchObject({
      id: expect.stringMatching(/^user-\d+$/),
      email: "john@example.com",
      name: "John Doe",
      age: 25,
      createdAt: expect.any(String),
    });

    // runShape should also work when deps are provided
    const resultShape = await command
      .provide({ userRepository })
      .runShape({ email: "jane@example.com", name: "Jane Doe", age: 30 });
    assert(resultShape.success);
    expect(resultShape.result).toMatchObject({
      id: expect.stringMatching(/^user-\d+$/),
      email: "jane@example.com", 
      name: "Jane Doe",
      age: 30,
      createdAt: expect.any(String),
    });
  });
});

describe("Real-world Validation Examples", () => {
  describe("User Registration", () => {
    const userRegistrationSchema = z.object({
      email: z.string().email(),
      name: z.string().min(2),
      age: z.number().min(18),
    });

    test("should detect duplicate email during validation", async () => {
      const userRegistrationValidator = createValidator()
        .input(userRegistrationSchema)
        .$deps<{ userRepository: UserRepository }>()
        .addRule({
          id: "duplicate-email-check",
          description: "Check for duplicate email",
          fn: async (args) => {
            const existingUser = await args.deps.userRepository.findUserByEmail(
              args.data.email
            );
            if (existingUser) {
              args.bag.addError("email", "Email already exists");
            }
          },
        })
        .provide({ userRepository });

      // Test with existing email
      const result1 = await userRegistrationValidator.validate({
        email: "existing@example.com",
        name: "John Doe",
        age: 25,
      });

      assert(!result1.success);
      expect(result1.errors.firstError("email")).toBe("Email already exists");
      expect(result1.rule?.id).toBe("duplicate-email-check");
      expect(result1.rule?.description).toBe("Check for duplicate email");

      // Test with new email
      const result2 = await userRegistrationValidator.validate({
        email: "new@example.com",
        name: "Jane Doe",
        age: 30,
      });

      assert(result2.success);
      expect(result2.value.email).toBe("new@example.com");
    });

    test("should detect blacklisted email during validation", async () => {
      const userRegistrationValidator = createValidator()
        .input(userRegistrationSchema)
        .$deps<{ userRepository: UserRepository }>()
        .addRule({
          id: "blacklist-check",
          description: "Check for blacklisted email",
          fn: async (args) => {
            const isBlacklisted =
              await args.deps.userRepository.isEmailBlacklisted(
                args.data.email
              );
            if (isBlacklisted) {
              args.bag.addError("email", "Email domain is not allowed");
            }
          },
        })
        .provide({ userRepository });

      // Test with blacklisted domain
      const result1 = await userRegistrationValidator.validate({
        email: "user@spam.com",
        name: "John Doe",
        age: 25,
      });

      assert(!result1.success);
      expect(result1.errors.firstError("email")).toBe(
        "Email domain is not allowed"
      );
      expect(result1.rule?.id).toBe("blacklist-check");
      expect(result1.rule?.description).toBe("Check for blacklisted email");

      // Test with blacklisted specific email
      const result2 = await userRegistrationValidator.validate({
        email: "admin@badactor.com",
        name: "Jane Doe",
        age: 30,
      });

      assert(!result2.success);
      expect(result2.errors.firstError("email")).toBe(
        "Email domain is not allowed"
      );

      // Test with allowed email
      const result3 = await userRegistrationValidator.validate({
        email: "user@gooddomain.com",
        name: "Bob Smith",
        age: 28,
      });

      assert(result3.success);
      expect(result3.value.email).toBe("user@gooddomain.com");
    });

    test("should run all validation rules and combine errors", async () => {
      const userRegistrationValidator = createValidator()
        .input(userRegistrationSchema)
        .$deps<{ userRepository: UserRepository }>()
        .addRule({
          description: "Check for duplicate email",
          fn: async (args) => {
            const existingUser = await args.deps.userRepository.findUserByEmail(
              args.data.email
            );
            if (existingUser) {
              args.bag.addError("email", "Email already exists");
            }
          },
        })
        .addRule({
          description: "Check for blacklisted email",
          fn: async (args) => {
            const isBlacklisted =
              await args.deps.userRepository.isEmailBlacklisted(
                args.data.email
              );
            if (isBlacklisted) {
              args.bag.addError("email", "Email domain is not allowed");
            }
          },
        })
        .provide({ userRepository });

      // Test with existing blacklisted email - should get both errors
      const result = await userRegistrationValidator.validate({
        email: "existing@example.com", // This email exists in our mock
        name: "John Doe",
        age: 25,
      });

      assert(!result.success);
      expect(result.errors.firstError("email")).toBe("Email already exists");
    });

    test("user registration command with full validation", async () => {
      const userRegistrationCommand = createValidator()
        .input(userRegistrationSchema)
        .$deps<{ userRepository: UserRepository }>()
        .addRule({
          id: "command-duplicate-check",
          description: "Check for duplicate email",
          fn: async (args) => {
            const existingUser = await args.deps.userRepository.findUserByEmail(
              args.data.email
            );
            if (existingUser) {
              args.bag.addError("email", "Email already exists");
            }
          },
        })
        .addRule({
          id: "command-blacklist-check",
          description: "Check for blacklisted email",
          fn: async (args) => {
            const isBlacklisted =
              await args.deps.userRepository.isEmailBlacklisted(
                args.data.email
              );
            if (isBlacklisted) {
              args.bag.addError("email", "Email domain is not allowed");
            }
          },
        })
        .command({
          execute: async (args) => {
            return await args.deps.userRepository.createUser(args.data);
          },
        });

      // Test successful registration
      const result1 = await userRegistrationCommand
        .provide({ userRepository })
        .run({
          email: "success@example.com",
          name: "John Doe",
          age: 25,
        });

      assert(result1.success);
      expect(result1.result).toMatchObject({
        id: expect.stringMatching(/^user-\d+$/),
        email: "success@example.com",
        name: "John Doe",
        age: 25,
        createdAt: expect.any(String),
      });

      // Test failed registration due to duplicate email
      const result2 = await userRegistrationCommand
        .provide({ userRepository })
        .run({
          email: "existing@example.com",
          name: "Jane Doe",
          age: 30,
        });

      assert(!result2.success);
      expect(result2.step).toBe("validation");
      expect(result2.errors.firstError("email")).toBe("Email already exists");
      expect(result2.rule?.id).toBe("command-duplicate-check");
      expect(result2.rule?.description).toBe("Check for duplicate email");

      // Test failed registration due to blacklisted email
      const result3 = await userRegistrationCommand
        .provide({ userRepository })
        .run({
          email: "bad@spam.com",
          name: "Bob Smith",
          age: 28,
        });

      assert(!result3.success);
      expect(result3.step).toBe("validation");
      expect(result3.errors.firstError("email")).toBe(
        "Email domain is not allowed"
      );
      expect(result3.rule?.id).toBe("command-blacklist-check");
      expect(result3.rule?.description).toBe("Check for blacklisted email");
    });
  });

  describe("Money Transfer", () => {
    test("command provides error bag to allow failures at execution time", async () => {
      const transferMoneySchema = z.object({
        fromAccount: z.string(),
        toAccount: z.string(),
        amount: z.number().positive(),
      });

      // Mock external bank service
      const externalBankService = {
        checkAccountBalance: async (account: string): Promise<number> => {
          if (account === "insufficient-funds") return 50; // Less than transfer amount
          return 1000; // Sufficient funds
        },
        validateAccountStatus: async (account: string): Promise<boolean> => {
          if (account === "closed-account")
            throw new Error("Account is closed");
          if (account === "suspended-account")
            throw new Error("Account is suspended");
          if (account === "frozen-account")
            throw new Error("Account is frozen");
          return true;
        },
        executeTransfer: async (from: string, to: string, amount: number) => {
          if (from === "fails-in-transfer")
            throw new Error("Failed in transfer");
          // This would make the actual API call to the bank
          return {
            transactionId: `ext-txn-${Date.now()}`,
            status: "completed",
            from,
            to,
            amount,
          };
        },
      };

      const transferCommand = createValidator()
        .input(transferMoneySchema)
        .$deps<{ externalBankService: typeof externalBankService }>()
        .addRule({
          id: "no-self-transfer",
          description: "Validate no transfer to same account",
          fn: async (args) => {
            // Business rule: Cannot transfer to same account
            if (args.data.fromAccount === args.data.toAccount) {
              args.bag.addError("toAccount", "Cannot transfer to same account");
            }
          },
        })
        .addRule({
          id: "account-status-check",
          description: "Validate account status",
          fn: async (args) => {
            // Validate account status
            await args.deps.externalBankService
              .validateAccountStatus(args.data.fromAccount)
              .catch((_error) => {
                args.bag.addError(
                  "fromAccount",
                  "Account is not in a valid state to transfer"
                );
              });
            await args.deps.externalBankService
              .validateAccountStatus(args.data.toAccount)
              .catch((_error) => {
                args.bag.addError(
                  "toAccount",
                  "Account is not in a valid state to transfer"
                );
              });
          },
        })
        .addRule({
          id: "balance-check",
          description: "Check if from account has sufficient balance",
          fn: async (args) => {
            const fromBalance =
              await args.deps.externalBankService.checkAccountBalance(
                args.data.fromAccount
              );
            if (fromBalance < args.data.amount) {
              args.bag.addError("amount", "Insufficient funds");
            }
          },
        })
        .command({
          execute: async (args) => {
            try {
              // Execute the external transfer
              const result =
                await args.deps.externalBankService.executeTransfer(
                  args.data.fromAccount,
                  args.data.toAccount,
                  args.data.amount
                );
              return result;
            } catch (error) {
              // External service failed unexpectedly
              return args.bag.addError(
                "global",
                `External service error: ${
                  error instanceof Error ? error.message : "Unknown error"
                }`
              );
            }
          },
        });

      // Test validation failure (business rule violation) - step should be "validation"
      const result1 = await transferCommand
        .provide({ externalBankService })
        .run({
          fromAccount: "account-123",
          toAccount: "account-123", // Same account - violates business rule
          amount: 100,
        });

      assert(!result1.success);
      expect(result1.step).toBe("validation");
      expect(result1.errors.firstError("toAccount")).toContain(
        "Cannot transfer to same account"
      );
      expect(result1.rule).toMatchObject({
        id: "no-self-transfer",
        description: "Validate no transfer to same account",
      });

      // Test execution failure (insufficient funds) - step should be "validation"
      const result2 = await transferCommand
        .provide({ externalBankService })
        .run({
          fromAccount: "insufficient-funds",
          toAccount: "account-456",
          amount: 100,
        });

      assert(!result2.success);
      expect(result2.step).toBe("validation");
      expect(result2.errors.firstError("amount")).toContain(
        "Insufficient funds"
      );
      expect(result2.rule).toMatchObject({
        id: "balance-check",
        description: "Check if from account has sufficient balance",
      });

      // Test execution failure (frozen account) - step should be "validation"
      const result3 = await transferCommand
        .provide({ externalBankService })
        .run({
          fromAccount: "frozen-account",
          toAccount: "account-456",
          amount: 100,
        });

      assert(!result3.success);
      expect(result3.step).toBe("validation");
      expect(result3.errors.firstError("fromAccount")).toContain(
        "Account is not in a valid state to transfer"
      );
      expect(result3.rule).toMatchObject({
        id: "account-status-check",
        description: "Validate account status",
      });

      // Test execution failure (failed in transfer) - step should be "execution"
      const result4 = await transferCommand
        .provide({ externalBankService })
        .run({
          fromAccount: "fails-in-transfer",
          toAccount: "account-456",
          amount: 100,
        });

      assert(!result4.success);
      expect(result4.step).toBe("execution");
      expect(result4.errors.firstError("global")).toContain(
        "Failed in transfer"
      );
      expect(result4.rule).toBeUndefined();

      // Test successful transfer
      const result5 = await transferCommand
        .provide({ externalBankService })
        .run({
          fromAccount: "account-456",
          toAccount: "account-789",
          amount: 50,
        });

      assert(result5.success);
      expect(result5.result.status).toBe("completed");
      expect(result5.result.amount).toBe(50);
    });
  });
});
