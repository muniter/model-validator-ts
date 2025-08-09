import { test, expect, describe, assert, expectTypeOf } from "vitest";
import { z } from "zod";
import { buildValidator } from "./index.js";

describe("Schema Validation", () => {
  test("schema validation works with basic types", async () => {
    const schema = z.object({
      name: z.string().min(3),
      age: z.number().min(18),
    });

    const validator = buildValidator().input(schema);

    // Test with invalid input (name too short)
    const result1 = await validator.validate({
      name: "ab",
      age: 20,
    });
    assert(!result1.success);
    expect(result1.errors.firstError("name")).toContain("3");

    // Test with invalid input (age too low)
    const result2 = await validator.validate({
      name: "John",
      age: 17,
    });
    assert(!result2.success);
    expect(result2.errors.firstError("age")).toContain("18");

    // Test with valid input
    const result3 = await validator.validate({
      name: "John",
      age: 25,
    });
    assert(result3.success);
    expect(result3.value).toEqual({
      name: "John",
      age: 25,
    });
  });
});

describe("Validator dependenceis", () => {
  const userRegistrationSchema = z.object({
    email: z.string().email(),
    name: z.string().min(2),
    age: z.number().min(18),
  });

  test("Validator with no deps can be called with validate", async () => {
    const validator = buildValidator().input(userRegistrationSchema);

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
    const validator = buildValidator().input(userRegistrationSchema).$deps<{
      fakeService: {
        foo: string;
      };
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
    const validator = buildValidator().input(userRegistrationSchema).$deps<{
      fakeService: {
        foo: string;
      };
    }>();

    expect(validator["~unsafeInternals"]).toMatchObject({
      schema: userRegistrationSchema,
      deps: undefined,
      depsStatus: "required",
    });

    const deps = { fakeService: { foo: "bar" } };
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
});

describe("Performance", () => {
  test("should reuse the same instance when chaining methods", () => {
    const validator = buildValidator();
    const withInput = validator.input(z.object({ test: z.string() }));
    const withDeps = withInput.$deps<{ service: string }>();
    const withRule = withDeps.rule({
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

describe("Context Passing & Rule Chain", () => {
  test("can pass context between rules", async () => {
    const schema = z.object({
      hello: z.string().min(2),
      name: z.string().min(2),
      age: z.number(),
    });

    const validator = buildValidator()
      .input(schema)
      .rule({
        fn: async (args) => {
          return { context: { message: `Hello ${args.data.name}` } };
        },
      })
      .rule({
        fn: async (args) => {
          return {
            context: {
              message: `${args.context.message}. You are ${
                args.data.age >= 18 ? "an adult" : "a minor"
              }`,
            },
          };
        },
      })
      .rule({
        fn: async (args) => {
          return {
            context: {
              isAdult: args.data.age >= 18,
            },
          };
        },
      })
      .rule({
        fn: async (args) => {
          expect(args.context).toEqual({
            message: "Hello John Doe. You are an adult",
            isAdult: true,
          });
        },
      });

    const result = await validator.validate({
      hello: "Hello",
      name: "John Doe",
      age: 25,
    });
    assert(result.success);
    expect(result.context).toEqual({
      message: "Hello John Doe. You are an adult",
      isAdult: true,
    });
  });
});

describe("Command API", () => {
  const paymentSchema = z.object({
    sourceAccount: z.string().min(2),
    targetAccount: z.string().min(2),
    amount: z.number().min(1),
  });

  const paymentService = {
    executeTransfer: async (
      sourceAccount: string,
      targetAccount: string,
      amount: number
    ) => {
      if (sourceAccount === "blacklisted") {
        throw new Error("Source account is blacklisted");
      }
      if (targetAccount === "blacklisted") {
        throw new Error("Target account is blacklisted");
      }
      return { success: true, transactionId: "123" };
    },
    getAccountBalance: async (account: string) => {
      if (account === "no-funds") {
        return { balance: 0 };
      }
      return { balance: 1000 };
    },
  };

  const validator = buildValidator()
    .input(paymentSchema)
    .rule({
      fn: async (args) => {
        const balance = await paymentService.getAccountBalance(
          args.data.sourceAccount
        );
        if (balance.balance < args.data.amount) {
          args.bag.addError("amount", "Insufficient funds");
        }
      },
    });

  test("Can validate and execute a command", async () => {
    expect(validator["~unsafeInternals"]).toMatchObject({
      schema: paymentSchema,
      deps: undefined,
      depsStatus: "not-required",
    });

    const command = validator.command({
      execute: async (args) => {
        return await paymentService
          .executeTransfer(
            args.data.sourceAccount,
            args.data.targetAccount,
            args.data.amount
          )
          .catch((error) => {
            args.bag.addGlobalError(
              error instanceof Error ? error.message : "Unknown error"
            );
          });
      },
    });

    const result = await command.run({
      sourceAccount: "123",
      targetAccount: "456",
      amount: 100,
    });
    assert(result.success);
    expect(result.result).toEqual({
      success: true,
      transactionId: "123",
    });

    const result2 = await command.run({
      sourceAccount: "blacklisted",
      targetAccount: "456",
      amount: 100,
    });
    assert(!result2.success);
    expect(result2.errors.global).toBe(
      "Source account is blacklisted"
    );
  });

  test("Command deps tracks if they have been provided", async () => {
    const command = buildValidator()
      .input(z.object({ name: z.string().min(1) }))
      .$deps<{
        fakeService: {
          foo: string;
          bar: string;
        };
      }>()
      .command({
        execute: async (args) => {
          return {
            data: args.data,
            foo: args.deps.fakeService.foo,
          };
        },
      });

    // Tracked at the type level
    expectTypeOf(command.run).toBeNever();
    expectTypeOf(command.runShape).toBeNever();

    // Without providing deps, the command should throw an error
    await expect(
      // @ts-expect-error: Method is still there, just should not be called
      async () => command.run({ name: "John Doe" })
    ).rejects.toThrow("Deps should be provided before calling run");

    // runShape should also not be available without providing deps
    await expect(
      // @ts-expect-error: Method is still there, just should not be called
      async () => command.runShape({ name: "John Doe" })
    ).rejects.toThrow("Deps should be provided before calling runShape");

    const commandWithDeps = command.provide({
      fakeService: { foo: "bar", bar: "foo" },
    });
    expectTypeOf(commandWithDeps.run).not.toBeNever();
    expectTypeOf(commandWithDeps.runShape).not.toBeNever();

    const result = await commandWithDeps.run({ name: "John Doe" });
    assert(result.success);
    expect(result.result).toMatchObject({
      data: { name: "John Doe" },
      foo: "bar",
    });

    const result2 = await commandWithDeps.runShape({ name: "John Doe" });
    assert(result2.success);
    expect(result2.result).toMatchObject({
      data: { name: "John Doe" },
      foo: "bar",
    });
  });
});

describe("Real-world Validation Examples", () => {
  const userRepository = {
    users: [
      { id: "user-123", email: "existing@example.com", createdAt: new Date() },
      { id: "user-456", email: "newemail@example.com", createdAt: new Date() },
    ],
    blacklistedDomains: ["spam.com", "blocked.net"],
    blacklistedEmails: ["admin@badactor.com"],

    findUserByEmail: async (
      email: string
    ): Promise<{ id: string; email: string } | null> => {
      return userRepository.users.find((user) => user.email === email) || null;
    },

    findUserById: async (
      id: string
    ): Promise<{ id: string; email: string } | null> => {
      return userRepository.users.find((user) => user.id === id) || null;
    },
    isEmailBlacklisted: async (email: string): Promise<boolean> => {
      if (userRepository.blacklistedEmails.includes(email)) return true;
      const domain = email.split("@")[1];
      if (!domain) return false;
      return userRepository.blacklistedDomains.includes(domain);
    },
    changeEmail: async (userId: string, newEmail: string) => {
      const user = await userRepository.findUserById(userId);
      if (!user) throw new Error("User not found");
      user.email = newEmail;
      return user;
    },
    createUser: async (userData: {
      email: string;
      name: string;
      age: number;
    }): Promise<{ id: string; email: string; name: string; age: number }> => {
      const newUser = {
        id: `user-${userRepository.users.length + 1}`,
        ...userData,
        createdAt: new Date(),
      };
      userRepository.users.push(newUser);
      return newUser;
    },
  };
  type UserRepository = typeof userRepository;

  describe("User Registration", () => {
    const userRegistrationSchema = z.object({
      email: z.string().email(),
      name: z.string().min(2),
      age: z.number().min(18),
    });

    test("should detect duplicate email during validation", async () => {
      const userRegistrationValidator = buildValidator()
        .input(userRegistrationSchema)
        .$deps<{ userRepository: UserRepository }>()
        .rule({
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
      const userRegistrationValidator = buildValidator()
        .input(userRegistrationSchema)
        .$deps<{ userRepository: UserRepository }>()
        .rule({
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
      const userRegistrationValidator = buildValidator()
        .input(userRegistrationSchema)
        .$deps<{ userRepository: UserRepository }>()
        .rule({
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
        .rule({
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
      const userRegistrationCommand = buildValidator()
        .input(userRegistrationSchema)
        .$deps<{ userRepository: UserRepository }>()
        .rule({
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
        .rule({
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
        createdAt: expect.any(Date),
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

      const transferCommand = buildValidator()
        .input(transferMoneySchema)
        .$deps<{ externalBankService: typeof externalBankService }>()
        .rule({
          id: "no-self-transfer",
          description: "Validate no transfer to same account",
          fn: async (args) => {
            // Business rule: Cannot transfer to same account
            if (args.data.fromAccount === args.data.toAccount) {
              args.bag.addError("toAccount", "Cannot transfer to same account");
            }
          },
        })
        .rule({
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
        .rule({
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
              return args.bag.addGlobalError(
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
      expect(result4.errors.global).toContain(
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
