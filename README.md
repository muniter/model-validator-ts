# Model Validator TS

[![npm version](https://img.shields.io/npm/v/model-validator-ts.svg)](https://www.npmjs.com/package/model-validator-ts)

🔒 A type-safe validation library for TypeScript that helps you validate data with complex business rules and dependencies 🚀

## Features

- 🔒 100% Type-safe validation with TypeScript
- 📦 Support for multiple schema libraries ([Standard Schema](https://standardschema.dev/)) (Zod, Valibot, ArkType)
- 🔄 Complex business rules with dependencies
- 🏗️ Command pattern support for validation + execution
- 📝 Clear error messages and error handling
- 🎯 Static and runtime dependency injection

## Installation

```bash
npm install model-validator-ts
# or
yarn add model-validator-ts
# or
pnpm add model-validator-ts
```

## Quick Start

```typescript
import { createValidatorBuilder, createCommand } from 'model-validator-ts';
import { z } from 'zod'; // or any other schema library compatible with Standard Schema

// First we create what will help us define the validator, we can pass static/whole app dependencies here
// like db, cache, logger, etc. This is done once for your whole app.
const AppValidatorDefinition = createValidatorBuilder({
    deps: {
        db: myDatabase,
        cache: myCache,
        logger: logger,
    }
});

// Create a validator for user creation
const userValidator = AppValidatorDefinition({
    // Define your schema using Standard Schema Zod, Valibot, ArkType, etc.
    schema: z.object({
        email: z.string().email(),
        age: z.number().min(18),
    }),
    // Define the dependencies, you only pass a type they are passed when you build the validator
    deps: {} as { emailService: { isEmailBlacklisted: (email: string) => Promise<boolean> } },
    rules: [
        {
            // All the attributes names, dependencies, data, builder are type safe
            attribute: 'email',
            fn: async ({ data, deps, builder }) => {
                if (await deps.db.users.findByEmail(data.email)) {
                    builder.addError('email', 'Email is already taken');
                }
                if (await deps.emailService.isEmailBlacklisted(data.email)) {
                    builder.addError('email', 'Email is blacklisted');
                }
            }
        },
    ]
});

// Use the validator, but first build it passing the dependencies (Checked by TypeScript) 
// see that db, cache, logger are not passed they are already in the AppValidatorDefinition
const result = await userValidator.build({
    emailService: myEmailService
}).validate({
    email: 'user@example.com',
    age: 25
});

if (result.success) {
    console.log(`Validation passed, ${result.value.email} is ${result.value.age} years old`);
} else {
    console.log(`Validation failed`);
    if (result.errors.firstError('email')) {
        console.log("Email field invalid:", result.errors.firstError('email'));
    }
    // Or log the whole object
    console.log(result.errors.toFlattenObject());
}

// Now let's use the command helper, which mixes the validator with the execution logic
const createUserCommand = createCommand({
    validator: userValidator,
    deps: {
        emailService: myEmailService,
    },
    execute: async ({ data, deps }) => {
        // Now you can be completely sure that the data has been validated 
        // by it's shape (schema) but also by the rules (business logic)
        // and all dependencies are available
        const user = await deps.db.users.create(data);
        return user;
    }
});

// Example usage in an API endpoint
app.post({
    path: '/users',
    schema: createUserCommand.validator.schema,
    handler: async (req, res) => {
        const data = req.body;
        const result = await createUserCommand.run(data);
        if (result.validated) {
            res.status(200).json(result.result);
        } else {
            res.status(400).json(result.errors.toFlattenObject());
        }
    }
});
```


## License

MIT 