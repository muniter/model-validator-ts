import { buildValidator } from "./index.js";
import { z } from "zod";

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
      const user = await userService.findByEmail(data.email);
      if (!user) {
        // Use the bag to put what goes wrong, you can use "global"
        // errors, think of it as friendly message for the caller
        // Once every rule function completed, if there's any error
        // on the bag, the validator execution will stop
        return bag.addGlobalError("Invalid email or password");
      }
      if (!(await userService.validatePassword(user, data.password))) {
        return bag.addGlobalError("Invalid email or password");
      }
      // Now we are returning a user inside a context object
      // You will see the rule and command below will have access
      // to the user object, they types are flowing through our pipeline
      return { context: { user } };
    },
  })
  .rule({
    fn: async ({ data, bag, context }) => {
      if (context.user.role === "admin") {
        // You can also add errors to specific fields,
        // The first argument field name is typesafe
        // you get full autocompletion for the possible field names
        return bag.addError("email", "Admin users cannot login with password");
      }
    },
  })
  .command({
    execute: async ({ context, bag }) => {
      // We access the user object from the context
      // no need to query the database again, we know is
      // the same user we already validated etc.
      const { user } = context;
      return {
        user,
        token: await userService.generateToken(user),
      };
    },
  });

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

// Just to make typescript happy
declare const app: {
  post(
    path: string,
    handler: (
      req: { body: unknown },
      res: { status: (code: number) => { json: (data: unknown) => void } }
    ) => unknown | Promise<unknown>
  ): void;
};
