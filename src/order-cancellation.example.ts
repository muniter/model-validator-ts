/**
 * Order Cancellation Business Logic Validation Example
 *
 * This example demonstrates how to handle complex business rules for order cancellation
 * in an imaginary ecommerce app:
 * The rules are that a product can be cancelled if:
 * - The order is not already cancelled
 * - The user has permission to cancel the order (it's owned by the user or the user is an admin)
 * - The order is not shipped or scheduled to ship within 24 hours
 * - The order does not contain non-cancellable items (like personalized products or digital downloads)
 * - The order did not use a special discount code
 * - The order is not fulfilled by a third party
 * - The order was created within the last 10 days
 * - The order belongs to the requesting customer (except admin panel)
 */

import { z } from "zod";
import { buildValidator } from "./index.js";

// At the end of the file you can find the types of Order, Product, etc.
// And also the methods of each of this services, this is moved to the
// end of the file to make the example more readable. In a real app
// this would be defined acrosss your entire application.

// Request Schema
export const orderCancellationSchema = z.object({
  orderId: z.string().min(1, "Order ID is required"),
  customerId: z.string().min(1, "Customer ID is required"),
  reason: z
    .string()
    .min(10, "Cancellation reason must be at least 10 characters")
    .max(500, "Reason too long"),
  source: z.enum(["customer-portal", "admin-panel", "api"]),
});

export type OrderCancellationRequest = z.infer<typeof orderCancellationSchema>;

// Business Logic Validation
export const orderCancellationValidator = buildValidator()
  .input(orderCancellationSchema)
  .$deps<CancellationDependencies>()
  .rule({
    id: "order-exists",
    description: "Check if order exists and belongs to customer",
    fn: async ({ data, deps, bag }) => {
      const order = await deps.orderService.findById(data.orderId);

      if (!order) {
        return bag.addError("orderId", "Order not found");
      }
      // Pass order to subsequent rules
      return { context: { order } };
    },
  })
  .rule({
    id: "order-not-cancelled",
    description: "Check if order is not already cancelled",
    fn: async ({ context, bag }) => {
      if (context.order.status === "cancelled") {
        bag.addGlobalError("Order is already cancelled");
      }
    },
  })
  .rule({
    id: "permission-to-cancel",
    description: "Check if user has permission to cancel the order",
    fn: async ({ context, deps, bag }) => {
      if (
        deps.user.role !== "admin" &&
        context.order.customerId !== deps.user.id
      ) {
        return bag.addGlobalError(
          "You do not have permission to cancel this order"
        );
      }
    },
  })
  .rule({
    id: "fetch-shipping-info",
    description: "Fetch shipping information for the order",
    fn: async ({ context, deps, bag }) => {
      // ✨ CONTEXT PASSING: Use the order from the previous rule's context
      const { order } = context;

      try {
        const shippingStatus = await deps.shippingService.getShippingStatus(
          order.shippingId
        );
        return { context: { shippingStatus } };
      } catch (error) {
        return bag.addGlobalError(
          "Cannot process cancellation for this order for now, please try again later"
        );
      }
    },
  })
  .rule({
    id: "not-shipped-or-shipping-soon",
    description:
      "Check if order is not shipped or planned to ship within 24 hours",
    fn: async ({ context, bag }) => {
      // ✨ CONTEXT PASSING: Use shipping status from the previous rule's context
      if (context.shippingStatus.isShipped) {
        return bag.addGlobalError(
          "Cannot cancel orders that have already been shipped"
        );
      }

      if (context.shippingStatus.plannedShippingDate) {
        const hoursUntilShipping =
          (context.shippingStatus.plannedShippingDate.getTime() - Date.now()) /
          (1000 * 60 * 60);
        if (hoursUntilShipping <= 24 && hoursUntilShipping > 0) {
          return bag.addGlobalError(
            `Cannot cancel orders scheduled to ship within 24 hours (ships in ${Math.round(
              hoursUntilShipping
            )} hours)`
          );
        }
      }
    },
  })
  .rule({
    id: "all-items-cancellable",
    description: "Check if all items in the order are cancellable",
    fn: async ({ context, deps, bag }) => {
      // ✨ CONTEXT PASSING: Use order from previous rule's context
      const nonCancellableItems: string[] = [];

      for (const item of context.order.items) {
        const product = await deps.productCatalog.findById(item.productId);
        if (product && !product.isCancellable) {
          nonCancellableItems.push(`${product.name} (${product.type})`);
        }
      }

      if (nonCancellableItems.length > 0) {
        bag.addGlobalError(
          `Order contains non-cancellable items: ${nonCancellableItems.join(
            ", "
          )}`
        );
      }
    },
  })
  .rule({
    id: "no-special-discounts",
    description: "Check if order doesn't have special discount codes",
    fn: async ({ context, deps, bag }) => {
      if (context.order.discountCode) {
        const isSpecial = await deps.discountService.isSpecialDiscount(
          context.order.discountCode
        );
        if (isSpecial) {
          bag.addGlobalError(
            "Orders with special discount codes cannot be cancelled"
          );
        }
      }
    },
  })
  .rule({
    id: "no-third-party-fulfillment",
    description: "Check if order is not fulfilled by third party",
    fn: async ({ context, bag }) => {
      if (context.order.fulfillmentType === "third-party") {
        bag.addGlobalError(
          "Orders fulfilled by third-party vendors cannot be cancelled through this system"
        );
      }
    },
  })
  .rule({
    id: "within-time-limit",
    description: "Check if order was created within the last 10 days",
    fn: async ({ context, bag }) => {
      const daysSinceCreation =
        (Date.now() - context.order.createdAt.getTime()) /
        (1000 * 60 * 60 * 24);
      if (daysSinceCreation > 10) {
        bag.addGlobalError(
          `Order cannot be cancelled after 10 days (created ${Math.round(
            daysSinceCreation
          )} days ago)`
        );
      }
    },
  });

// Command that combines validation + execution
export const cancelOrderCommand = orderCancellationValidator.command({
  execute: async ({ data, deps, context, bag }) => {
    try {
      // Cancel the order
      const cancelledOrder = await deps.orderService.cancelOrder(
        data.orderId,
        data.reason
      );

      // Send notification
      await deps.notificationService.notifyCancellation(
        data.orderId,
        context.order.customerId,
        data.reason
      );

      return {
        success: true,
        orderId: cancelledOrder.id,
        status: cancelledOrder.status,
        refundAmount: cancelledOrder.totalAmount,
        message:
          "Order successfully cancelled. Refund will be processed within 3-5 business days.",
      };
    } catch (error) {
      // Handle execution errors
      bag.addGlobalError(
        `Failed to cancel order: ${
          error instanceof Error ? error.message : "Unknown error"
        }. Try again later.`
      );
      return bag;
    }
  },
});

// Usage Example
export async function exampleUsage(dependencies: CancellationDependencies) {
  // Customer trying to cancel their own order
  const result = await cancelOrderCommand.provide(dependencies).run({
    orderId: "order-123",
    customerId: "customer-456",
    reason: "Changed my mind about the purchase",
    source: "customer-portal",
  });

  if (result.success) {
    // TypeScript knows result.result exists and has the correct shape just like zod
    return {
      success: true,
      data: {
        refundAmount: result.result.refundAmount,
      },
    };
  } else {
    // TypeScript knows result.errors exists just like zod
    return {
      success: false,
      // Just a plain object you can return to the client
      // and they can use in the UI for a global message and under each field
      // {result.errors.global && <p class="error">${result.errors.global}</p>}
      // <input class="error" name="orderId" value="${result.data.orderId}" />
      // {errors.issuses.orderId[0] && <p class="error">${errors.issuses.orderId[0]}</p>}
      error: result.errors.toObject(),
    };
  }
}

// First we define the types of our system.
export type OrderStatus =
  | "pending"
  | "processing"
  | "shipped"
  | "delivered"
  | "cancelled";
export type ProductType =
  | "physical"
  | "digital"
  | "personalized"
  | "downloadable";
export type FulfillmentType = "internal" | "third-party";
export type RequestSource = "customer-portal" | "admin-panel" | "api";

export interface User {
  id: string;
  role: "customer" | "admin";
}

export interface OrderItem {
  id: string;
  productId: string;
  productType: ProductType;
  quantity: number;
  price: number;
}

export interface Order {
  id: string;
  customerId: string;
  status: OrderStatus;
  items: OrderItem[];
  totalAmount: number;
  discountCode?: string;
  fulfillmentType: FulfillmentType;
  createdAt: Date;
  shippingId: string;
}

export interface Product {
  id: string;
  name: string;
  type: ProductType;
  isCancellable: boolean;
}

export interface ShippingStatus {
  shippingId: string;
  isShipped: boolean;
  plannedShippingDate?: Date;
  trackingNumber?: string;
  carrier?: string;
}

// Then we define imaginary services that we will use to validate the order.
export interface OrderService {
  findById(orderId: string): Promise<Order | null>;
  cancelOrder(orderId: string, reason: string): Promise<Order>;
}

export interface ProductCatalog {
  findById(productId: string): Promise<Product | null>;
}

export interface DiscountService {
  isSpecialDiscount(code: string): Promise<boolean>;
}

export interface ShippingService {
  getShippingStatus(shippingId: string): Promise<ShippingStatus>;
}

export interface NotificationService {
  notifyCancellation(
    orderId: string,
    customerId: string,
    reason: string
  ): Promise<{ sent: boolean; timestamp: Date }>;
}

// Dependencies the command will need to validate everything and
// then cancel the order.
export interface CancellationDependencies {
  orderService: OrderService;
  productCatalog: ProductCatalog;
  discountService: DiscountService;
  shippingService: ShippingService;
  notificationService: NotificationService;
  user: User;
}
