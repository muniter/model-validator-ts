# Model Validator TS

[![npm version](https://img.shields.io/npm/v/model-validator-ts.svg)](https://www.npmjs.com/package/model-validator-ts)

A type-safe validation library for TypeScript that provides a fluent API for creating validators with business rules and dependency injection. Built on top of the Standard Schema specification.

## Features

- **Type-safe validation** with full TypeScript support
- **Standard Schema support** - works with Zod (and other compatible libraries)
- **Fluent API** - chainable methods for building validators
- **Business rules** with context passing between rules
- **Command pattern** - validation + execution in one step
- **Dependency injection** with compile-time type checking
- **Multiple error formats** - object, flatten, HTML, text
- **Efficient object reuse** - same instance, different types

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
import { buildValidator } from 'model-validator-ts';
import { z } from 'zod';

const userSchema = z.object({
  name: z.string().min(3),
  age: z.number().min(18),
  email: z.string().email()
});

// Simple validation without dependencies
const validator = buildValidator().input(userSchema);

const result = await validator.validate({
  name: "John",
  age: 25,
  email: "john@example.com"
});

if (result.success) {
  console.log("Valid user:", result.value);
  console.log("Context:", result.context);
} else {
  console.log("Validation errors:", result.errors.toObject);
}
```

### With Dependencies and Business Rules

```typescript
interface UserRepository {
  findByEmail(email: string): Promise<{ id: string } | null>;
}

const userValidator = buildValidator()
  .input(userSchema)
  .$deps<{ userRepo: UserRepository }>()
  .rule({
    fn: async ({ data, deps, bag }) => {
      // Check if email is already taken
      const existingUser = await deps.userRepo.findByEmail(data.email);
      if (existingUser) {
        bag.addError("email", "Email is already taken");
      }
    }
  })
  .provide({ userRepo: myUserRepository });

const result = await userValidator.validate(userData);
```

### Context Passing Between Rules

```typescript
const layerValidator = buildValidator()
  .input(z.object({
    layerId: z.string(),
    visibility: z.enum(["public", "private"])
  }))
  .$deps<{ layerRepo: LayerRepository }>()
  .rule({
    fn: async ({ data, deps, bag }) => {
      const layer = await deps.layerRepo.getLayer(data.layerId);
      if (!layer) {
        bag.addError("layerId", "Layer not found");
        return;
      }
      // Return context for next rules
      return { context: { layer } };
    }
  })
  .rule({
    fn: async ({ data, context, bag }) => {
      // Access context from previous rule
      if (context.layer.classification === "confidential" && 
          data.visibility === "public") {
        bag.addError("visibility", "Confidential layers cannot be public");
      }
      return { context: { validated: true } };
    }
  })
  .provide({ layerRepo });
```

### Command Pattern for Validation + Execution

```typescript
const transferMoneyCommand = buildValidator()
  .input(z.object({
    fromAccount: z.string(),
    toAccount: z.string(),
    amount: z.number().positive()
  }))
  .$deps<{ db: DatabaseService }>()
  .rule({
    fn: async ({ data, bag }) => {
      // Business rule validation
      if (data.fromAccount === data.toAccount) {
        bag.addError("toAccount", "Cannot transfer to same account");
      }
    }
  })
  .command({
    execute: async ({ data, deps, context, bag }) => {
      try {
        // Execute the business logic
        await deps.db.executeTransaction(async () => {
          await deps.db.debit(data.fromAccount, data.amount);
          await deps.db.credit(data.toAccount, data.amount);
        });

        return {
          transactionId: `txn-${Date.now()}`,
          status: "completed",
          ...data
        };
      } catch (error) {
        // Handle runtime errors
        bag.addError("global", `Transaction failed: ${error.message}`);
        return bag; // Return error bag
      }
    }
  });

// Execute command
const result = await transferMoneyCommand
  .provide({ db: databaseService })
  .run({
    fromAccount: "acc-123",
    toAccount: "acc-456", 
    amount: 100
  });

if (result.success) {
  console.log("Transfer successful:", result.result);
  console.log("Context:", result.context);
} else {
  console.log("Transfer failed at step:", result.step); // "validation" | "execution"
  console.log("Errors:", result.errors.toText());
}
```

## API Reference

### FluentValidatorBuilder

#### `.input(schema)`
Define the input schema using any Standard Schema compatible library.

#### `.$deps<T>()`
Declare the required dependencies type. Must be called before `.provide()`.

#### `.rule({ fn })`
Add a business rule function. Rules can:
- Add errors to the error bag
- Return context: `{ context: { key: value } }`
- Access previous context and dependencies

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
Add an error for a specific field or "global".

#### `.hasErrors()`
Check if any errors exist.

#### `.firstError(key)`
Get the first error message for a field.

#### `.toObject`
Get errors as `{ field: ["error1", "error2"] }`.

#### `.toFlattenObject()`
Get errors as `{ field: "error1" }` (first error only).

#### `.toText()` / `.toHtml()`
Format errors as text or HTML.

## Error Handling

Validation results include a `step` field to distinguish between:
- `"validation"` - Schema or business rule validation failed
- `"execution"` - Runtime error during command execution

```typescript
const result = await command.run(input);

if (!result.success) {
  if (result.step === "validation") {
    // Handle validation errors
    console.log("Input validation failed:", result.errors.toObject);
  } else {
    // Handle execution errors  
    console.log("Execution failed:", result.errors.toObject);
  }
}
```

## Type Safety

- **Schema types** are automatically inferred from your schema
- **Dependencies** must be provided before validation/execution
- **Context types** accumulate through the rule chain
- **Command results** are properly typed based on execution function

```typescript
// TypeScript will enforce these relationships:
const validator = buildValidator()
  .input(schema)           // Infers input/output types
  .$deps<{ service: T }>() // Requires provide() before validate()
  .rule({ ... })        // Rule receives typed data, deps, context
  .provide(dependencies);  // Type-checked against $deps<T>

// result.value is typed according to schema output
const result = await validator.validate(data);
```


## License

MIT 