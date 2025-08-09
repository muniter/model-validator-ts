import { test, expect, describe, assert } from "vitest";
import {
  orderCancellationValidator,
  cancelOrderCommand,
  type Order,
  type Product,
  type ShippingStatus,
  type OrderService,
  type ProductCatalog,
  type DiscountService,
  type ShippingService,
  type NotificationService,
  type User,
} from "./order-cancellation.example.js";

describe("Order Cancellation", () => {
  // Mock data
  const mockOrder: Order = {
    id: "order-123",
    customerId: "customer-456",
    status: "processing",
    items: [
      {
        id: "item-1",
        productId: "product-1",
        productType: "physical",
        quantity: 2,
        price: 50,
      },
      {
        id: "item-2",
        productId: "product-2",
        productType: "digital",
        quantity: 1,
        price: 30,
      },
    ],
    totalAmount: 130,
    discountCode: "SUMMER20",
    fulfillmentType: "internal",
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), // 2 days ago
    shippingId: "shipping-123",
  };

  const mockProducts: Record<string, Product> = {
    "product-1": {
      id: "product-1",
      name: "Regular T-Shirt",
      type: "physical",
      isCancellable: true,
    },
    "product-2": {
      id: "product-2",
      name: "Digital Album",
      type: "digital",
      isCancellable: true,
    },
    "product-3": {
      id: "product-3",
      name: "Personalized Mug",
      type: "personalized",
      isCancellable: false,
    },
    "product-4": {
      id: "product-4",
      name: "Software License",
      type: "downloadable",
      isCancellable: false,
    },
  };

  const mockShippingStatus: ShippingStatus = {
    shippingId: "shipping-123",
    isShipped: false,
    plannedShippingDate: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), // 3 days from now
  };

  // Mock services
  const createMockServices = (overrides?: {
    orders?: Record<string, Order>;
    products?: Record<string, Product>;
    shippingStatuses?: Record<string, ShippingStatus>;
    specialDiscounts?: string[];
  }) => {
    const orders = overrides?.orders || { "order-123": mockOrder };
    const products = overrides?.products || mockProducts;
    const shippingStatuses = overrides?.shippingStatuses || {
      "shipping-123": mockShippingStatus,
    };
    const specialDiscounts = overrides?.specialDiscounts || ["SPECIAL50"];

    const orderService: OrderService = {
      findById: async (orderId: string) => orders[orderId] || null,
      cancelOrder: async (orderId: string, reason: string) => {
        const order = orders[orderId];
        if (!order) throw new Error("Order not found");
        return { ...order, status: "cancelled" };
      },
    };

    const productCatalog: ProductCatalog = {
      findById: async (productId: string) => products[productId] || null,
    };

    const discountService: DiscountService = {
      isSpecialDiscount: async (code: string) =>
        specialDiscounts.includes(code),
    };

    const shippingService: ShippingService = {
      getShippingStatus: async (shippingId: string) => {
        const status = shippingStatuses[shippingId];
        if (!status) throw new Error("Shipping info not found");
        return status;
      },
    };

    const notificationService: NotificationService = {
      notifyCancellation: async (orderId, customerId, reason) => ({
        sent: true,
        timestamp: new Date(),
      }),
    };

    return {
      orderService,
      productCatalog,
      discountService,
      shippingService,
      notificationService,
    };
  };

  describe("Validation Rules", () => {
    test("should pass when order exists and all conditions are met", async () => {
      const services = createMockServices();
      const user: User = { id: "customer-456", role: "customer" };

      const result = await orderCancellationValidator
        .provide({ ...services, user })
        .validate({
          orderId: "order-123",
          customerId: "customer-456",
          reason: "Changed my mind about the purchase",
          source: "customer-portal",
        });

      assert(result.success);
    });

    test("should fail when order does not exist", async () => {
      const services = createMockServices();
      const user: User = { id: "customer-456", role: "customer" };

      const result = await orderCancellationValidator
        .provide({ ...services, user })
        .validate({
          orderId: "non-existent",
          customerId: "customer-456",
          reason: "Changed my mind about the purchase",
          source: "customer-portal",
        });

      assert(!result.success);
      expect(result.errors.firstError("orderId")).toBe("Order not found");
      expect(result.rule?.id).toBe("order-exists");
    });

    test("should fail when user does not have permission", async () => {
      const services = createMockServices();
      const user: User = { id: "another-customer", role: "customer" };

      const result = await orderCancellationValidator
        .provide({ ...services, user })
        .validate({
          orderId: "order-123",
          customerId: "customer-456",
          reason: "Changed my mind about the purchase",
          source: "customer-portal",
        });

      assert(!result.success);
      expect(result.errors.global).toBe(
        "You do not have permission to cancel this order"
      );
      expect(result.rule?.id).toBe("permission-to-cancel");
    });

    test("should pass when admin cancels any order", async () => {
      const services = createMockServices();
      const user: User = { id: "admin-789", role: "admin" };

      const result = await orderCancellationValidator
        .provide({ ...services, user })
        .validate({
          orderId: "order-123",
          customerId: "customer-456",
          reason: "Customer requested cancellation",
          source: "admin-panel",
        });

      assert(result.success);
    });

    test("should fail when order is already cancelled", async () => {
      const cancelledOrder: Order = {
        ...mockOrder,
        status: "cancelled",
      };
      const services = createMockServices({
        orders: { "order-123": cancelledOrder },
      });
      const user: User = { id: "customer-456", role: "customer" };

      const result = await orderCancellationValidator
        .provide({ ...services, user })
        .validate({
          orderId: "order-123",
          customerId: "customer-456",
          reason: "Changed my mind about the purchase",
          source: "customer-portal",
        });

      assert(!result.success);
      expect(result.errors.global).toBe("Order is already cancelled");
      expect(result.rule?.id).toBe("order-not-cancelled");
    });

    test("should fail when order is already shipped", async () => {
      const shippedStatus: ShippingStatus = {
        shippingId: "shipping-123",
        isShipped: true,
        trackingNumber: "TRACK123",
        carrier: "FedEx",
      };
      const services = createMockServices({
        shippingStatuses: { "shipping-123": shippedStatus },
      });
      const user: User = { id: "customer-456", role: "customer" };

      const result = await orderCancellationValidator
        .provide({ ...services, user })
        .validate({
          orderId: "order-123",
          customerId: "customer-456",
          reason: "Changed my mind about the purchase",
          source: "customer-portal",
        });

      assert(!result.success);
      expect(result.errors.global).toBe(
        "Cannot cancel orders that have already been shipped"
      );
      expect(result.rule?.id).toBe("not-shipped-or-shipping-soon");
    });

    test("should fail when order is shipping within 24 hours", async () => {
      const shippingSoonStatus: ShippingStatus = {
        shippingId: "shipping-123",
        isShipped: false,
        plannedShippingDate: new Date(Date.now() + 12 * 60 * 60 * 1000), // 12 hours from now
      };
      const services = createMockServices({
        shippingStatuses: { "shipping-123": shippingSoonStatus },
      });
      const user: User = { id: "customer-456", role: "customer" };

      const result = await orderCancellationValidator
        .provide({ ...services, user })
        .validate({
          orderId: "order-123",
          customerId: "customer-456",
          reason: "Changed my mind about the purchase",
          source: "customer-portal",
        });

      assert(!result.success);
      expect(result.errors.global).toMatch(
        /Cannot cancel orders scheduled to ship within 24 hours/
      );
      expect(result.rule?.id).toBe("not-shipped-or-shipping-soon");
    });

    test("should fail when order contains non-cancellable items", async () => {
      const orderWithPersonalized: Order = {
        ...mockOrder,
        items: [
          ...mockOrder.items,
          {
            id: "item-3",
            productId: "product-3",
            productType: "personalized",
            quantity: 1,
            price: 45,
          },
        ],
      };
      const services = createMockServices({
        orders: { "order-123": orderWithPersonalized },
      });
      const user: User = { id: "customer-456", role: "customer" };

      const result = await orderCancellationValidator
        .provide({ ...services, user })
        .validate({
          orderId: "order-123",
          customerId: "customer-456",
          reason: "Changed my mind about the purchase",
          source: "customer-portal",
        });

      assert(!result.success);
      expect(result.errors.global).toContain(
        "Order contains non-cancellable items: Personalized Mug (personalized)"
      );
      expect(result.rule?.id).toBe("all-items-cancellable");
    });

    test("should fail when order has special discount code", async () => {
      const orderWithSpecialDiscount: Order = {
        ...mockOrder,
        discountCode: "SPECIAL50",
      };
      const services = createMockServices({
        orders: { "order-123": orderWithSpecialDiscount },
      });
      const user: User = { id: "customer-456", role: "customer" };

      const result = await orderCancellationValidator
        .provide({ ...services, user })
        .validate({
          orderId: "order-123",
          customerId: "customer-456",
          reason: "Changed my mind about the purchase",
          source: "customer-portal",
        });

      assert(!result.success);
      expect(result.errors.global).toBe(
        "Orders with special discount codes cannot be cancelled"
      );
      expect(result.rule?.id).toBe("no-special-discounts");
    });

    test("should fail when order is fulfilled by third party", async () => {
      const thirdPartyOrder: Order = {
        ...mockOrder,
        fulfillmentType: "third-party",
      };
      const services = createMockServices({
        orders: { "order-123": thirdPartyOrder },
      });
      const user: User = { id: "customer-456", role: "customer" };

      const result = await orderCancellationValidator
        .provide({ ...services, user })
        .validate({
          orderId: "order-123",
          customerId: "customer-456",
          reason: "Changed my mind about the purchase",
          source: "customer-portal",
        });

      assert(!result.success);
      expect(result.errors.global).toBe(
        "Orders fulfilled by third-party vendors cannot be cancelled through this system"
      );
      expect(result.rule?.id).toBe("no-third-party-fulfillment");
    });

    test("should fail when order is older than 10 days", async () => {
      const oldOrder: Order = {
        ...mockOrder,
        createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000), // 15 days ago
      };
      const services = createMockServices({
        orders: { "order-123": oldOrder },
      });
      const user: User = { id: "customer-456", role: "customer" };

      const result = await orderCancellationValidator
        .provide({ ...services, user })
        .validate({
          orderId: "order-123",
          customerId: "customer-456",
          reason: "Changed my mind about the purchase",
          source: "customer-portal",
        });

      assert(!result.success);
      expect(result.errors.global).toMatch(
        /Order cannot be cancelled after 10 days/
      );
      expect(result.rule?.id).toBe("within-time-limit");
    });

    test("should handle shipping service errors gracefully", async () => {
      const services = createMockServices({
        shippingStatuses: {}, // No shipping status available
      });
      const user: User = { id: "customer-456", role: "customer" };

      const result = await orderCancellationValidator
        .provide({ ...services, user })
        .validate({
          orderId: "order-123",
          customerId: "customer-456",
          reason: "Changed my mind about the purchase",
          source: "customer-portal",
        });

      assert(!result.success);
      expect(result.errors.global).toBe(
        "Cannot process cancellation for this order for now, please try again later"
      );
      expect(result.rule?.id).toBe("fetch-shipping-info");
    });
  });

  describe("Cancel Order Command", () => {
    test("should successfully cancel order when all validations pass", async () => {
      const services = createMockServices();
      const user: User = { id: "customer-456", role: "customer" };

      const result = await cancelOrderCommand
        .provide({ ...services, user })
        .run({
          orderId: "order-123",
          customerId: "customer-456",
          reason: "Changed my mind about the purchase",
          source: "customer-portal",
        });

      assert(result.success);
      expect(result.result).toMatchObject({
        success: true,
        orderId: "order-123",
        status: "cancelled",
        refundAmount: 130,
        message:
          "Order successfully cancelled. Refund will be processed within 3-5 business days.",
      });
    });

    test("should fail at validation step when order not found", async () => {
      const services = createMockServices();
      const user: User = { id: "customer-456", role: "customer" };

      const result = await cancelOrderCommand
        .provide({ ...services, user })
        .run({
          orderId: "non-existent",
          customerId: "customer-456",
          reason: "Changed my mind about the purchase",
          source: "customer-portal",
        });

      assert(!result.success);
      expect(result.step).toBe("validation");
      expect(result.errors.firstError("orderId")).toBe("Order not found");
    });

    test("should fail at execution step when order service throws error", async () => {
      const services = createMockServices();
      // Override cancelOrder to throw error
      services.orderService.cancelOrder = async () => {
        throw new Error("Database connection failed");
      };
      const user: User = { id: "customer-456", role: "customer" };

      const result = await cancelOrderCommand
        .provide({ ...services, user })
        .run({
          orderId: "order-123",
          customerId: "customer-456",
          reason: "Changed my mind about the purchase",
          source: "customer-portal",
        });

      assert(!result.success);
      expect(result.step).toBe("execution");
      expect(result.errors.global).toBe(
        "Failed to cancel order: Database connection failed. Try again later."
      );
    });

    test("should handle notification failures gracefully", async () => {
      const services = createMockServices();
      // Override notification service to throw error
      services.notificationService.notifyCancellation = async () => {
        throw new Error("Notification service unavailable");
      };
      const user: User = { id: "customer-456", role: "customer" };

      const result = await cancelOrderCommand
        .provide({ ...services, user })
        .run({
          orderId: "order-123",
          customerId: "customer-456",
          reason: "Changed my mind about the purchase",
          source: "customer-portal",
        });

      assert(!result.success);
      expect(result.step).toBe("execution");
      expect(result.errors.global).toContain("Notification service unavailable");
    });

    test("should validate input schema", async () => {
      const services = createMockServices();
      const user: User = { id: "customer-456", role: "customer" };

      const result = await cancelOrderCommand
        .provide({ ...services, user })
        .run({
          orderId: "",
          customerId: "customer-456",
          reason: "Too short",
          source: "customer-portal",
        });

      assert(!result.success);
      expect(result.step).toBe("validation");
      expect(result.errors.firstError("orderId")).toBe("Order ID is required");
      expect(result.errors.firstError("reason")).toContain("10 characters");
    });
  });

  describe("Complex Scenarios", () => {
    test("should handle multiple validation failures", async () => {
      const complexOrder: Order = {
        ...mockOrder,
        status: "processing",
        fulfillmentType: "third-party",
        discountCode: "SPECIAL50",
        createdAt: new Date(Date.now() - 15 * 24 * 60 * 60 * 1000), // 15 days ago
      };
      const services = createMockServices({
        orders: { "order-123": complexOrder },
      });
      const user: User = { id: "customer-456", role: "customer" };

      const result = await orderCancellationValidator
        .provide({ ...services, user })
        .validate({
          orderId: "order-123",
          customerId: "customer-456",
          reason: "Changed my mind about the purchase",
          source: "customer-portal",
        });

      assert(!result.success);
      // Should fail on the first failing rule
      expect(result.errors.global).toBe(
        "Orders with special discount codes cannot be cancelled"
      );
      expect(result.rule?.id).toBe("no-special-discounts");
    });

    test("should accumulate context through rule chain", async () => {
      const services = createMockServices();
      const user: User = { id: "customer-456", role: "customer" };

      const result = await orderCancellationValidator
        .provide({ ...services, user })
        .validate({
          orderId: "order-123",
          customerId: "customer-456",
          reason: "Changed my mind about the purchase",
          source: "customer-portal",
        });

      assert(result.success);
      // Context should contain both order and shippingStatus
      expect(result.context).toHaveProperty("order");
      expect(result.context).toHaveProperty("shippingStatus");
      expect(result.context.order.id).toBe("order-123");
      expect(result.context.shippingStatus.shippingId).toBe("shipping-123");
    });
  });
});