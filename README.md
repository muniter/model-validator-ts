# Model Validator TS

[![npm version](https://img.shields.io/npm/v/model-validator-ts.svg)](https://www.npmjs.com/package/model-validator-ts)

**Bridging the gap between simple shape validation and business logic**

A type-safe validation library for TypeScript that provides a fluent API for creating validators and commands with business rules clear error messages and dependency injection. Built on top of the [Standard Schema](https://standardschema.dev/) specification, supports [zod](https://zod.dev/), [valibot](https://valibot.dev/), [ArkType](https://arktype.dev/), etc.

## The Problem

Shape validation with libraries like Zod works great for basic cases. But what happens when you need to validate business rules that require external services, database lookups, how do you provide good error messages to the caller, how do you share data between rules, how easy is to test, how do you encapsulate everything together, etc.

This library is an attempt to provide a simple and opinionated way to do all of this in a simple way taking advantage of TypeScript's type system to propagate the types through the validation pipeline.

```typescript
const loginCommand = buildValidator()
  // Your usual zod schema
  .input(
    z.object({
      email: z.string().email(),
      password: z.string().min(8),
    })
  )
  .rule({
    // Rules are evaluated in order, and execution stops
    // if any rule adds an error to the bag
    fn: async ({ data, bag }) => {
      const user = await userService.findByEmail(data.email);
      if (!user) {
        return bag.addGlobalError("Invalid email or password");
      }
      if (!(await userService.validatePassword(user, data.password))) {
        return bag.addGlobalError("Invalid email or password");
      }
      // Pass user to next rules via context
      return { context: { user } };
    },
  })
  .rule({
    fn: async ({ context, bag }) => {
      // Access user from previous rule
      if (context.user.role === "admin") {
        return bag.addError("email", "Admin users must use SSO login");
      }
    },
  })
  // Have a command (optional) that will execute the business logic
  .command({
    execute: async ({ context }) => {
      // User is already validated and available,
      return {
        user: context.user,
        token: await userService.generateToken(context.user),
      };
    },
  });

// Usage
const result = await loginCommand.run({
  email: "non-registered-user@example.com",
  password: "securepassword",
});

if (!result.success) {
  // { global: "Invalid email or password", issues: {} }
  console.log(result.errors.toObject());
} else {
  // If it was successful, result.result would be the command result
  // { user: { id: string, email: string }, token: string }
  console.log(result.result);
}
```

For a more complex real-world example with multiple dependencies and rules, check out the [order cancellation example](https://github.com/model-validator-ts/model-validator-ts/blob/main/src/order-cancellation.example.ts).

## Why this library helps with

- **Standard Schema Integration**: Works with Zod, Valibot, ArkType - whatever you're already using for shape validation.
- **Easy to Use**: It's just a simple object you pass values to and can easily test each rule.
- **Composable & Reusable**: You can easily compose validators and commands, and reuse them in different places.
- **Rich Error Context**: Know exactly which rule failed and why, not just "validation failed".
- **Testable**: Not defined in a http handler, it's just a simple object you pass values to and can easily test each rule.
- **Context Sharing**: Rules share context - you fetch whatever you need once, and pass it to the next rules and commands.
- **Type-Safe Dependency Injection**: TypeScript enforces that you provide all required services before execution.

## Installation

```bash
npm install model-validator-ts
# or
yarn add model-validator-ts
# or
pnpm add model-validator-ts
```

## Quick Start

### Basic Validation

```typescript
import { buildValidator } from "model-validator-ts";
import { z } from "zod";

const userSchema = z.object({
  name: z.string().min(3),
  age: z.number().min(18),
  email: z.string().email(),
});

// Simple validation without dependencies
const validator = buildValidator().input(userSchema).rule({
  fn: async ({ data, bag }) => {
    if (await isUserBlacklisted(data.email)) {
      return bag.addError("email", "User is blacklisted");
    }
  },
});

const result = await validator.validate({
  name: "John",
  age: 25,
  email: "john@example.com",
});

if (result.success) {
  console.log("Valid user:", result.value);
  console.log("Context:", result.context);
} else {
  console.log("Typed Validation errors to use in your UI:", result.errors.toObject());
}
```

### User Login Example

A complete example showing schema validation, business rules, context passing, and command execution:

```typescript
import { z } from "zod";
import { buildValidator } from "model-validator-ts";

interface User {
  id: string;
  role: "admin" | "customer";
  email: string;
  passwordHash: string;
}

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const loginCommand = buildValidator()
  .input(loginSchema)
  .rule({
    fn: async ({ data, bag }) => {
      // Data is fully typed from the schema
      const user = await userService.findByEmail(data.email);
      if (!user) {
        return bag.addGlobalError("Invalid email or password");
      }
      if (!(await userService.validatePassword(user, data.password))) {
        return bag.addGlobalError("Invalid email or password");
      }
      // Pass user to next rules via context
      return { context: { user } };
    },
  })
  .rule({
    fn: async ({ data, bag, context }) => {
      // Access context from previous rule
      if (context.user.role === "admin") {
        return bag.addError("email", "Admin users cannot login with password");
      }
    },
  })
  .command({
    execute: async ({ context, bag }) => {
      // Execute the business logic
      const { user } = context;
      return {
        user,
        token: await userService.generateToken(user),
      };
    },
  });

// Usage in an endpoint
app.post("/login", async (req, res) => {
  const result = await loginCommand.run(req.body);
  if (!result.success) {
    return res.status(400).json({
      success: false,
      errors: result.errors.toObject(),
    });
  }
  return res.status(200).json({
    success: true,
    result: result.result,
  });
});
```

### Money Transfer with External Services

A more complex example showing dependency injection and errors happening on command execution and rules.

```typescript
const transferMoneySchema = z.object({
  fromAccount: z.string(),
  toAccount: z.string(),
  amount: z.number().positive(),
});

const transferCommand = buildValidator()
  .input(transferMoneySchema)
  .$deps<{ externalBankService: BankService }>()
  .rule({
    id: "no-self-transfer",
    fn: async ({ data, bag }) => {
      if (data.fromAccount === data.toAccount) {
        bag.addError("toAccount", "Cannot transfer to same account");
      }
    },
  })
  .rule({
    id: "balance-check",
    fn: async ({ data, deps, bag }) => {
      const balance = await deps.externalBankService.checkAccountBalance(
        data.fromAccount
      );
      if (balance < data.amount) {
        bag.addError("amount", "Insufficient funds");
      }
    },
  })
  .command({
    execute: async ({ data, deps, bag }) => {
      try {
        const result = await deps.externalBankService.executeTransfer(
          data.fromAccount,
          data.toAccount,
          data.amount
        );
        return result;
      } catch (error) {
        // Handle runtime errors, or things that just can't be validated before execution
        return bag.addGlobalError(`External service error: ${error.message}`);
      }
    },
  });

// Execute with dependencies
const result = await transferCommand
  .provide({ externalBankService })
  .run({ fromAccount: "acc-123", toAccount: "acc-456", amount: 100 });
```

## API Reference

### FluentValidatorBuilder

#### `.input(schema)`

Define the input schema using any Standard Schema compatible library.

#### `.$deps<T>()`

Declare the required dependencies type. Must be called before `.provide()`.

#### `.rule({ fn, id?, description? })`

Add a business rule function. Rules can:

- Add errors to the error bag
- Return context: `{ context: { key: value } }`
- Access previous context and dependencies
- Include optional `id` and `description` for better error tracking

#### `.provide(deps)`

Provide the actual dependency instances. Required before validation if `$deps()` was called.

#### `.validate(input, opts?)`

Run validation and return result with `success`, `value`/`errors`, and `context`.

#### `.command({ execute })`

Create a command that combines validation with execution logic.

### Command

#### `.provide(deps)`

Provide dependencies for command execution.

#### `.run(input, opts?)`

Execute the command with validation + business logic.

#### `.runShape(input, opts?)`

Type-safe version when input type is known.

### ErrorBag

#### `.addError(key, message)`

Add an error for a specific field.

#### `.addGlobalError(message)`

Add a global error not tied to a specific field.

#### `.hasErrors()`

Check if any errors exist.

#### `.firstError(key)`

Get the first error message for a field.

#### `.toObject()`

Get errors as `{ field: ["error1", "error2"] }`.

#### `.flatten()`

Get all errors as a flat array.

#### `.toText()` / `.toHtml()`

Format errors as text or HTML.

## Error Handling

Validation results include detailed information about failures:

```typescript
const result = await command.run(input);

if (!result.success) {
  // Check which phase failed
  console.log(result.step); // "validation" or "execution"

  // For validation failures, see which rule failed
  if (result.step === "validation" && result.rule) {
    console.log(result.rule.id); // "balance-check"
    console.log(result.rule.description); // "Check if account has sufficient balance"
  }

  // Access errors in various formats
  console.log(result.errors.toObject()); // { amount: ["Insufficient funds"] }
  console.log(result.errors.firstError("amount")); // "Insufficient funds"
  console.log(result.errors.flatten()); // ["Insufficient funds"]
}
```

## More Examples

Check out these complete examples in the repository:

- [Order Cancellation Example](https://github.com/model-validator-ts/model-validator-ts/blob/main/src/order-cancellation.example.ts) - Complex e-commerce validation scenario
- [User Login Example](https://github.com/model-validator-ts/model-validator-ts/blob/main/src/login.example.ts) - Authentication with role-based rules
- [Test Suite](https://github.com/model-validator-ts/model-validator-ts/blob/main/src/test.spec.ts) - Comprehensive examples of all features

---

_Model Validator TS: Because business logic validation shouldn't make you cry._

## License

MIT
