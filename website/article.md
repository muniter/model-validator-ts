# Business Logic Validation with Model Validator TS

**TL;DR:** [Model Validator TS](https://github.com/model-validator-ts/model-validator-ts) is an opinionated library to simplify business logci validations.

## The Problem

Something I'm always worrying about when developing software is that I'm properly validating the business rules, from the shape of the data which is wonderfully handled by the TypeScript ecosystem ([zod](https://zod.dev/), [standard-schema](https://standardschema.dev/), etc.), to the more complex business rules like uniqueness, property relationships, current state of some other system, etc. This second set of rules is something that we each implement our way, and I've seen in projects I've worked in that this is a very common source of complexity, messiness, and bugs.

I believe this happens because it's not simple. Business logic can be very elaborate. Here's an imaginary example of an ecommerce order cancellation process:

> Only allow cancelling an order from the customer portal if it's not already shipped or planned to be shipped in the next 24 hours, and all the items of the order are "cancellable" (downloadable product, personalized product, etc), and if the order did not have a special discount code, and if the order is not being fulfilled by a third party, and if the order was not created more than 10 days ago, only the customer can cancel their own orders, admin users can cancel any order, etc.

So now imagine implementing this. I'm sure there are lots of rules that are not mentioned yet and you could increase difficulty if you imagine that there are multiple services involved and in this case we are talking about money.

Because of this I've always enjoyed reading about how other people approach these challenges, and have studied various approaches (Domain Model, Transaction Script, CQRS, Ruby on Rails Model Validations, Laravel Validation Rules, Yii2 Model Rules, etc).

## The Solution

That's why I've decided to write a simple library that provides an opinionated way to validate business rules. The idea is to take advantage of TypeScript's flexible type system to make our lives easier when we need to combine a bunch of business logic and concerns together.

The library helps us have a schema ([zod](https://zod.dev/), [standard-schema](https://standardschema.dev/), etc) that will [parse/validate](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate) mainly the shape of the data, and give us full type safety. Then we can evaluate a set of rules. These rules importantly have the ability to pass context between them, so if a rule queries a service/db for the Order, the next rules can have access to the Order object and provide values of their own. Ultimately there's a small abstraction of defining a handler as a way to fuse `input -> validation -> work`. There's also the possibility of defining a set of "dependencies" (aka dependency injection) that are needed to run as a way to make things more testable.

## Example: User Login

Let's look at a simple login example to demonstrate the concepts. For a more complex example implementing the order cancellation scenario mentioned above, check out [this implementation](https://github.com/model-validator-ts/model-validator-ts/blob/main/src/order-cancellation.example.ts).
```typescript
import { z } from 'zod';
import { buildValidator } from 'model-validator-ts';

interface User {
  id: string;
  role: "admin" | "customer";
  email: string;
  passwordHash: string;
}

declare const userService: {
  findByEmail(email: string): Promise<User | null>;
  validatePassword(user: User, password: string): Promise<boolean>;
  generateToken(user: User): Promise<string>;
};

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const loginCommand = buildValidator()
  .input(loginSchema)
  .rule({
    fn: async ({ data, bag }) => {
      // Data is fully typed. When rule functions run, the first step of shape validation
      // has been successfully performed, so we can access the data with full type safety
      const user = await userService.findByEmail(data.email);
      if (!user) {
        // Use the bag to put what goes wrong. You can use "global"
        // errors, think of it as friendly messages for the caller.
        // Once every rule function completes, if there's any error
        // in the bag, the validator execution will stop
        return bag.addGlobalError("Invalid email or password");
      }
      if (!(await userService.validatePassword(user, data.password))) {
        return bag.addGlobalError("Invalid email or password");
      }
      // Now we are returning a user inside a context object.
      // You will see the rule and command below will have access
      // to the user object. The types are flowing through our pipeline
      return { context: { user } };
    },
  })
  .rule({
    fn: async ({ data, bag, context }) => {
      if (context.user.role === "admin") {
        // You can also add errors to specific fields.
        // The first argument field name is typesafe
        return bag.addError("email", "Admin users cannot login with password");
      }
    },
  })
  .command({
    execute: async ({ context, bag }) => {
      // We access the user object from the context -
      // no need to query the database again, we know it's
      // the same user we retrieved in the previous rule
      const { user } = context;
      return {
        user,
        token: await userService.generateToken(user),
      };
    },
  });
```

## Integration Examples

Now that we have combined everything - validating the shape of the data, then more complex business logic, and finally executing the command we want to perform - we can imagine a simple endpoint that looks like this:

```typescript
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

But that's not all. It's easy to see how we can test this command - it's decoupled from any HTTP context or framework. It's just a schema and functions. We can use the same command in a CLI interface our app has:

```typescript
program
  .command("get:login-token")
  .argument("<email>", "The email of the user")
  .argument("<password>", "The password of the user")
  .action(async (email, password) => {
    const result = await loginCommand.run({ email, password });
    if (!result.success) {
      console.error(result.errors.toObject());
      process.exit(1);
    }
    console.log(`Login token: ${result.result.token}`);
  });
```

When errors occur, you get detailed information about which rule failed:

```typescript
// Example of validation failure
const result = await loginCommand.run({ email: "admin@example.com", password: "password123" });
if (!result.success) {
  console.log(result.step);  // "validation"
  console.log(result.rule?.id);  // Could be your rule ID if you set one
  console.log(result.errors.firstError("email"));  // "Admin users cannot login with password"
  
  // Multiple error formats available
  console.log(result.errors.toObject());  // { email: ["Admin users cannot login with password"] }
  console.log(result.errors.flatten());   // ["Admin users cannot login with password"]
}
```

The library also supports type-safe dependency injection and rule composition, allowing you to build reusable validation pipelines. Check out the [GitHub repository](https://github.com/yourusername/model-validator-ts) for more advanced examples and complete documentation.

## Conclusion

Business logic validation is hard. What starts as simple if-statements quickly evolves into a tangled mess as requirements grow - rules need to share data, call external services, provide meaningful errors, need to be tested and understood, etc.

If you're using Typescript, you might find [this library useful](https://github.com/model-validator-ts/model-validator-ts). It's still early days, but I like how it's shaping up.