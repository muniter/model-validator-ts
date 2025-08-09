# Model Validator TS: Business Logic Validation Done Right

## The Problem We All Face

You've been there. You need to validate that a user can cancel their order. Simple enough, right?

> "Only allow cancelling an order if it's not already shipped, all items are cancellable, no special discount was used, it's not third-party fulfilled, and it was created less than 10 days ago..."

*wipes tears* 😭

So you write this:

```typescript
async function cancelOrder(orderId: string, customerId: string) {
  // 50 lines of if-statements and service calls
  const order = await orderRepo.findById(orderId);
  if (!order) throw new Error("Order not found");
  if (order.customerId !== customerId) throw new Error("Not your order");
  
  const shipping = await shippingService.getStatus(orderId);
  if (shipping.isShipped) throw new Error("Already shipped");
  
  // ... 5 more similar blocks
  // ... then finally the actual cancellation logic
}
```

**The result?** Unmaintainable code, poor error messages, impossible to test individual rules, and no reusability.

## What If Validation Could Be This Clean?

```typescript
const cancelOrderValidator = buildValidator()
  .input(orderCancellationSchema)
  .$deps<{ orderRepo, shippingService, productCatalog }>()
  .rule({
    id: "order-exists",
    fn: async ({ data, deps, bag }) => {
      const order = await deps.orderRepo.findById(data.orderId);
      if (!order) bag.addError("orderId", "Order not found");
      return { context: { order } }; // Share data with next rules
    }
  })
  .rule({
    id: "not-shipped", 
    fn: async ({ data, deps, context, bag }) => {
      const status = await deps.shippingService.getStatus(data.orderId);
      if (status.isShipped) {
        bag.addError("orderId", "Cannot cancel shipped orders");
      }
    }
  })
  .rule({
    id: "items-cancellable",
    fn: async ({ context, deps, bag }) => {
      // Use order from previous rule's context
      for (const item of context.order.items) {
        const product = await deps.productCatalog.findById(item.productId);
        if (!product.isCancellable) {
          bag.addError("orderId", `${product.name} cannot be cancelled`);
        }
      }
    }
  })
  // Add more rules as needed...

// Combine validation + execution
const cancelOrderCommand = cancelOrderValidator.command({
  execute: async ({ data, deps, context }) => {
    await deps.orderRepo.cancel(data.orderId);
    await deps.notificationService.notify(context.order.customerId);
    return { success: true, refundAmount: context.order.total };
  }
});

// Usage
const result = await cancelOrderCommand
  .provide({ orderRepo, shippingService, productCatalog })
  .run({ orderId: "123", customerId: "456", reason: "Changed mind" });

if (!result.success) {
  console.log(`Failed at: ${result.step}`); // "validation" or "execution"
  console.log(`Rule: ${result.rule?.id}`); // "not-shipped"
  console.log(`Error: ${result.errors.firstError("orderId")}`); // "Cannot cancel shipped orders"
}
```

## Why This Approach Wins

### ✅ **No More Data Fetching Duplication**
Rules share context - fetch the order once, use it everywhere.

### ✅ **Testable Business Rules**
Test individual rules in isolation:
```typescript
test("should reject shipped orders", async () => {
  const rule = rules.find(r => r.id === "not-shipped");
  // Test just this one rule
});
```

### ✅ **Composable & Reusable**
```typescript
const adminCancelValidator = cancelOrderValidator
  .removeRule("customer-ownership") // Admins can cancel any order
  .addRule(auditLogRule);
```

### ✅ **Rich Error Context**
Know exactly which rule failed and why, not just "validation failed".

### ✅ **Type-Safe Dependency Injection**
TypeScript enforces that you provide all required services before execution.

### ✅ **Standard Schema Integration**
Works with Zod, Valibot, ArkType - whatever you're already using for shape validation.

## When Should You Use This?

### ✅ **Perfect For:**
- Complex business rules with multiple service dependencies
- Domain-heavy applications (e-commerce, finance, healthcare)
- When you need detailed validation error reporting
- Teams comfortable with TypeScript and fluent APIs
- Scenarios where validation rules change frequently

### ❌ **Overkill For:**
- Simple form validation (`zod` alone is better)
- Basic CRUD APIs without complex business logic  
- Teams that prefer minimal dependencies
- Performance-critical validation (rules run sequentially)

## Real Talk: The Trade-offs

**Learning Curve:** This isn't as simple as `zod`. Your team needs to understand rules, context, dependencies, and commands.

**Performance:** Rules run sequentially with async operations. For 10+ rules with external service calls, this could be slower than optimized parallel validation.

**Ecosystem:** This is a newer library without the battle-testing of established validation libraries.

**Debugging:** Complex rule chains can be harder to debug than straightforward procedural code.

## The Bottom Line

If you're building **complex business applications** where validation involves multiple services, external APIs, and intricate business rules, this library will save you from maintenance hell.

If you're building **simple CRUD apps** with basic validation, stick with `zod` or similar.

**Try it on one feature first.** Don't rewrite your entire validation layer - pick one complex validation scenario and see if the benefits justify the learning curve for your team.

---

*Model Validator TS: Because business logic validation shouldn't make you cry.*

## Getting Started

```bash
npm install model-validator-ts
```

Check out the [complete order cancellation example](../src/order-cancellation.spec.ts) to see all features in action.