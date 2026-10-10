/**
 * Anda C Smoke Hub — local SQLite schema.
 *
 * Ported from the original Postgres schema with the same table and column
 * names so a hosted build can be migrated later. Differences are mechanical:
 *   uuid      -> text with a generated UUID
 *   varchar   -> text (SQLite has no length limit)
 *   decimal   -> real
 *   boolean   -> integer (0/1)
 *   timestamp -> integer (unix seconds, returned as Date)
 *   jsonb     -> text with JSON mode
 *   pgEnum    -> text constrained to the same value list
 *
 * The offline 'paystack' payment method has been dropped; this build settles
 * in cash or mobile money only.
 */
import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { relations } from 'drizzle-orm';

const uuid = () => crypto.randomUUID();
const now = () => new Date();

export const departmentEnum = ['beauty', 'groceries'] as const;
export const categoryTypeEnum = [
  'all',
  'skincare',
  'makeup',
  'fragrances',
  'body-care',
  'beauty-tools',
  'rice-grains',
  'cooking-oils',
  'seasoning-spices',
  'beverages',
  'snacks-sweets',
  'household-care',
  'daily-essentials',
  'new-arrivals',
  'best-sellers',
  'offers',
] as const;
export const orderStatusEnum = [
  'Confirmed',
  'Processing',
  'Packing Order',
  'Out for Delivery',
  'Delivered',
  'Refunded',
  'Cancelled',
] as const;
/** Cash and mobile money only in this build — no online payment processor. */
export const paymentMethodEnum = [
  'momo-mtn',
  'momo-telecel',
  'momo-at',
  'cash-on-delivery',
  'card',
  'apple-pay',
] as const;
export const paymentStatusEnum = ['paid', 'pending', 'failed'] as const;
export const deliveryMethodEnum = [
  'accra-express',
  'standard-delivery',
  'intercity',
  'store-pickup',
] as const;
export const discountTypeEnum = ['percentage', 'fixed'] as const;
export const adminRoleEnum = [
  'Super Admin',
  'Store Manager',
  'Inventory Dispatcher',
  'Cashier',
] as const;
export const routineStepEnum = ['cleanse', 'treat', 'hydrate', 'protect'] as const;

export const products = sqliteTable(
  'products',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    brand: text('brand').notNull(),
    department: text('department', { enum: departmentEnum }).notNull(),
    category: text('category', { enum: categoryTypeEnum }).notNull(),
    categoryLabel: text('category_label').notNull(),
price: real('price').notNull(),
  /** Authoritative price in pesewas. `price` is kept as a display mirror. */
  pricePesewas: integer('price_pesewas'),
  /** What the shop pays for the item. Never shown on a receipt. */
  costPricePesewas: integer('cost_price_pesewas'),
  /** Units left before this item should be reordered. Drives low-stock. */
  reorderLevel: integer('reorder_level').notNull().default(0),
  wholesalePrice: real('wholesale_price'),
    deliveryPrice: real('delivery_price'),
    originalPrice: real('original_price'),
    discountBadge: text('discount_badge'),
    unit: text('unit').notNull(),
    barcode: text('barcode'),
    serialNumber: text('serial_number'),
    image: text('image').notNull(),
    images: text('images', { mode: 'json' }).$type<string[]>().notNull().default([]),
    description: text('description').notNull(),
    highlights: text('highlights', { mode: 'json' }).$type<string[]>().notNull().default([]),
    badge: text('badge'),
    inStock: integer('in_stock', { mode: 'boolean' }).notNull().default(true),
    isPublished: integer('is_published', { mode: 'boolean' }).notNull().default(true),
    stockCount: integer('stock_count').notNull().default(2),
    options: text('options', { mode: 'json' })
      .$type<Array<{ name: string; values: string[] }>>()
      .default([]),
    rating: real('rating').notNull().default(5),
    reviewCount: integer('review_count').notNull().default(0),
    origin: text('origin'),
    routineStep: text('routine_step', { enum: routineStepEnum }),
    skinType: text('skin_type', { mode: 'json' }).$type<string[]>().default([]),
    skinConcern: text('skin_concern', { mode: 'json' }).$type<string[]>().default([]),
    packSize: text('pack_size'),
    storageInfo: text('storage_info'),
    shelfLife: text('shelf_life'),
    variants: text('variants', { mode: 'json' })
      .$type<
        Array<{
          id: string;
          name: string;
          options?: Record<string, string>;
          price: number;
          wholesalePrice?: number;
          originalPrice?: number;
          image?: string;
          inStock: boolean;
          stockCount?: number;
          description?: string;
          barcode?: string;
          serialNumber?: string;
        }>
      >()
      .default([]),
    details: text('details', { mode: 'json' }).$type<{
      howToUse?: string;
      ingredients?: string;
      benefits?: string;
      nutritionalInfo?: string;
    }>(),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
  },
  (table) => ({
    categoryIdx: index('products_category_idx').on(table.category),
    departmentIdx: index('products_department_idx').on(table.department),
    publishedIdx: index('products_published_idx').on(table.isPublished),
    brandIdx: index('products_brand_idx').on(table.brand),
    barcodeIdx: uniqueIndex('products_barcode_idx').on(table.barcode),
    serialNumberIdx: uniqueIndex('products_serial_number_idx').on(table.serialNumber),
  }),
);

export const categories = sqliteTable('categories', {
  id: text('id', { enum: categoryTypeEnum }).primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  department: text('department', { enum: departmentEnum }).notNull(),
  image: text('image').notNull(),
  description: text('description').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  sortOrder: integer('sort_order').default(0),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
});

export const brands = sqliteTable('brands', {
  id: text('id').primaryKey().$defaultFn(uuid),
  name: text('name').notNull().unique(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
});

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    email: text('email').notNull().unique(),
    fullName: text('full_name').notNull(),
    phone: text('phone').notNull(),
    profileImage: text('profile_image'),
    passwordHash: text('password_hash'),
    savedAddresses: text('saved_addresses', { mode: 'json' })
      .$type<
        Array<{
          fullName: string;
          phone: string;
          email?: string;
          city: string;
          area: string;
          landmarkOrGps?: string;
        }>
      >()
      .default([]),
    savedItemIds: text('saved_item_ids', { mode: 'json' }).$type<string[]>().default([]),
    loyaltyPoints: integer('loyalty_points').notNull().default(0),
    isWholesale: integer('is_wholesale', { mode: 'boolean' }).notNull().default(false),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    adminNotes: text('admin_notes'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
  },
  (table) => ({
    emailIdx: uniqueIndex('users_email_idx').on(table.email),
  }),
);

export const orders = sqliteTable(
  'orders',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    orderNumber: text('order_number').notNull().unique(),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    items: text('items', { mode: 'json' })
      .$type<
        Array<{
          product: {
            id: string;
            name: string;
            brand: string;
            price: number;
            originalPrice?: number;
            image: string;
            unit: string;
            category: string;
            inStock: boolean;
            stockCount: number;
          };
          quantity: number;
          selectedOption?: string;
          selectedVariant?: {
            id: string;
            name: string;
            price: number;
            originalPrice?: number;
            inStock: boolean;
          };
        }>
      >()
      .notNull(),
subtotal: real('subtotal').notNull(),
  shippingFee: real('shipping_fee').notNull(),
  discount: real('discount').notNull().default(0),
  total: real('total').notNull(),
  /** Authoritative figures in pesewas; the REAL columns are display mirrors. */
  subtotalPesewas: integer('subtotal_pesewas').notNull().default(0),
  discountPesewas: integer('discount_pesewas').notNull().default(0),
  totalPesewas: integer('total_pesewas').notNull().default(0),
  /** Lines voided from a completed sale, for the shift and sales reports. */
  voidedLines: text('voided_lines', { mode: 'json' }).$type<string[]>().default([]),
    paymentMethod: text('payment_method', { enum: paymentMethodEnum }).notNull(),
    paymentStatus: text('payment_status', { enum: paymentStatusEnum }).notNull().default('pending'),
    orderSource: text('order_source').notNull().default('website'),
    deliveryMethod: text('delivery_method', { enum: deliveryMethodEnum }).notNull(),
    shippingAddress: text('shipping_address', { mode: 'json' })
      .$type<{
        fullName: string;
        phone: string;
        email?: string;
        city: string;
        area: string;
        landmarkOrGps?: string;
        deliveryNotes?: string;
      }>()
      .notNull(),
    status: text('status', { enum: orderStatusEnum }).notNull().default('Confirmed'),
    estimatedDeliveryTime: text('estimated_delivery_time'),
    appliedPromoCode: text('applied_promo_code'),
    paymentReference: text('payment_reference'),
    paymentSenderPhone: text('payment_sender_phone'),
    idempotencyKey: text('idempotency_key'),
    cashierName: text('cashier_name'),
    riderInfo: text('rider_info', { mode: 'json' }).$type<{
      riderName?: string;
      riderPhone?: string;
      riderLocation?: string;
      estimatedArrival?: string;
      stageIndex?: number;
    }>(),
    adminNotes: text('admin_notes', { mode: 'json' })
      .$type<Array<{ note: string; status: string; createdAt: string; adminName?: string }>>()
      .notNull()
      .default([]),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
  },
  (table) => ({
    userIdIdx: index('orders_user_id_idx').on(table.userId),
    statusIdx: index('orders_status_idx').on(table.status),
    createdAtIdx: index('orders_created_at_idx').on(table.createdAt),
    orderNumberIdx: uniqueIndex('orders_order_number_idx').on(table.orderNumber),
    paymentReferenceIdx: uniqueIndex('orders_payment_reference_idx').on(table.paymentReference),
    idempotencyKeyIdx: uniqueIndex('orders_idempotency_key_idx').on(table.idempotencyKey),
  }),
);

export const posPayments = sqliteTable('pos_payments', {
  id: text('id').primaryKey().$defaultFn(uuid),
  orderId: text('order_id')
    .notNull()
    .references(() => orders.id, { onDelete: 'restrict' }),
  method: text('method', { enum: paymentMethodEnum }).notNull(),
  status: text('status').notNull(),
  amount: real('amount').notNull(),
  /** One row per tender, so a split payment can be reconciled individually. */
  amountPesewas: integer('amount_pesewas').notNull().default(0),
  tenderedPesewas: integer('tendered_pesewas'),
  changePesewas: integer('change_pesewas'),
  reference: text('reference'),
  cashReceived: real('cash_received'),
  changeGiven: real('change_given'),
  cashierName: text('cashier_name'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
});

export const inventoryMovements = sqliteTable(
  'inventory_movements',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    variantId: text('variant_id'),
    orderId: text('order_id').references(() => orders.id, { onDelete: 'restrict' }),
    movementType: text('movement_type').notNull(),
    quantity: integer('quantity').notNull(),
    quantityBefore: integer('quantity_before').notNull(),
    quantityAfter: integer('quantity_after').notNull(),
    actorName: text('actor_name'),
    reason: text('reason'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
  },
  (table) => ({
    productIdx: index('inventory_movements_product_idx').on(table.productId),
    orderIdx: index('inventory_movements_order_idx').on(table.orderId),
  }),
);

export const auditLogs = sqliteTable('audit_logs', {
  id: text('id').primaryKey().$defaultFn(uuid),
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  actorName: text('actor_name'),
  metadata: text('metadata', { mode: 'json' }).notNull().default({}),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
});

/**
 * Tickets the cashier put aside before paying.
 *
 * Held sales are stored in the database, not the browser, so a cashier can hand
 * the till over mid-queue and the next person can still recall the ticket.
 */
export const heldSales = sqliteTable(
  'held_sales',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    ticketLabel: text('ticket_label').notNull(),
    deviceId: text('device_id'),
    items: text('items', { mode: 'json' }).$type<unknown[]>().notNull().default([]),
    subtotal: real('subtotal').notNull().default(0),
    discount: real('discount').notNull().default(0),
    total: real('total').notNull().default(0),
    promoCode: text('promo_code'),
    paymentMethod: text('payment_method'),
    cashReceived: real('cash_received'),
    heldBy: text('held_by'),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
    recalledAt: integer('recalled_at', { mode: 'timestamp' }),
  },
  (table) => ({
    createdAtIdx: index('held_sales_created_at_idx').on(table.createdAt),
  }),
);

export const posShifts = sqliteTable(
  'pos_shifts',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    deviceId: text('device_id').notNull(),
    cashierName: text('cashier_name').notNull(),
    status: text('status').notNull().default('OPEN'),
openingCash: real('opening_cash').notNull(),
  expectedCash: real('expected_cash'),
  actualCash: real('actual_cash'),
  difference: real('difference'),
  /** Authoritative shift figures in pesewas. */
  openingCashPesewas: integer('opening_cash_pesewas').notNull().default(0),
  expectedCashPesewas: integer('expected_cash_pesewas'),
  actualCashPesewas: integer('actual_cash_pesewas'),
  differencePesewas: integer('difference_pesewas'),
    openedAt: integer('opened_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
    closedAt: integer('closed_at', { mode: 'timestamp' }),
    notes: text('notes'),
  },
  (table) => ({
    deviceIdx: index('pos_shifts_device_idx').on(table.deviceId),
    statusIdx: index('pos_shifts_status_idx').on(table.status),
  }),
);

export const reviews = sqliteTable(
  'reviews',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
    authorName: text('author_name').notNull(),
    rating: integer('rating').notNull(),
    title: text('title'),
    comment: text('comment').notNull(),
    verifiedPurchase: integer('verified_purchase', { mode: 'boolean' }).notNull().default(false),
    skinType: text('skin_type'),
    images: text('images', { mode: 'json' }).$type<string[]>().default([]),
    helpfulCount: integer('helpful_count').notNull().default(0),
    adminReply: text('admin_reply'),
    isApproved: integer('is_approved', { mode: 'boolean' }).notNull().default(true),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
  },
  (table) => ({
    productIdIdx: index('reviews_product_id_idx').on(table.productId),
    userIdIdx: index('reviews_user_id_idx').on(table.userId),
    approvedIdx: index('reviews_approved_idx').on(table.isApproved),
  }),
);

export const promoCodes = sqliteTable(
  'promo_codes',
  {
    id: text('id').primaryKey(),
    code: text('code').notNull().unique(),
    discountType: text('discount_type', { enum: discountTypeEnum }).notNull(),
discountValue: real('discount_value').notNull(),
  /** For a fixed-amount discount, the value in pesewas. */
  discountValuePesewas: integer('discount_value_pesewas'),
  minSpend: real('min_spend'),
  minSpendPesewas: integer('min_spend_pesewas'),
    freeShipping: integer('free_shipping', { mode: 'boolean' }).notNull().default(false),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    usageCount: integer('usage_count').notNull().default(0),
    maxUsage: integer('max_usage'),
    description: text('description'),
    expiryDate: integer('expiry_date', { mode: 'timestamp' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
  },
  (table) => ({
    codeIdx: uniqueIndex('promo_codes_code_idx').on(table.code),
    activeIdx: index('promo_codes_active_idx').on(table.isActive),
  }),
);

export const flashDeals = sqliteTable(
  'flash_deals',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    title: text('title').notNull(),
    subtitle: text('subtitle'),
    description: text('description'),
    badgeText: text('badge_text'),
    discountPercentage: integer('discount_percentage').notNull(),
    hoursRemaining: integer('hours_remaining').notNull().default(0),
    minutesRemaining: integer('minutes_remaining').notNull().default(0),
    secondsRemaining: integer('seconds_remaining').notNull().default(0),
    isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    backgroundGradient: text('background_gradient'),
    productIds: text('product_ids', { mode: 'json' }).$type<string[]>().notNull().default([]),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
  },
  (table) => ({
    activeIdx: index('flash_deals_active_idx').on(table.isActive),
    expiresAtIdx: index('flash_deals_expires_at_idx').on(table.expiresAt),
  }),
);

export const storeSettings = sqliteTable('store_settings', {
  id: text('id').primaryKey().$defaultFn(uuid),
  key: text('key').notNull().unique(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
});

export const adminSessions = sqliteTable('admin_sessions', {
  id: text('id').primaryKey().$defaultFn(uuid),
  adminName: text('admin_name').notNull(),
  adminRole: text('admin_role', { enum: adminRoleEnum }).notNull(),
  email: text('email').notNull().unique(),
  phone: text('phone').notNull().default(''),
  /** bcrypt hash of the PIN. The PIN itself is never stored anywhere. */
  pinHash: text('pin_hash').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  lastLoginAt: integer('last_login_at', { mode: 'timestamp' }),
  /**
   * Consecutive failed sign-in attempts, reset on success. Counted in the
   * database rather than in memory so a restart cannot be used to reset them.
   */
  failedPinAttempts: integer('failed_pin_attempts').notNull().default(0),
  /** Set while the account is locked out; null when usable. */
  lockedUntil: integer('locked_until', { mode: 'timestamp' }),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
});

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    title: text('title').notNull(),
    message: text('message').notNull(),
    actionUrl: text('action_url'),
    isRead: integer('is_read', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
  },
  (table) => ({
    userIdIdx: index('notifications_user_id_idx').on(table.userId),
    createdAtIdx: index('notifications_created_at_idx').on(table.createdAt),
    readIdx: index('notifications_read_idx').on(table.isRead),
  }),
);

export const carts = sqliteTable(
  'carts',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    sessionId: text('session_id'),
    items: text('items', { mode: 'json' })
      .$type<
        Array<{
          productId: string;
          quantity: number;
          selectedOption?: string;
          selectedVariant?: {
            id: string;
            name: string;
            price: number;
            originalPrice?: number;
            inStock: boolean;
          };
        }>
      >()
      .notNull()
      .default([]),
    promoCode: text('promo_code'),
    discountAmount: real('discount_amount').default(0),
    hasFreeShippingCoupon: integer('has_free_shipping_coupon', { mode: 'boolean' }).default(false),
    selectedSamples: text('selected_samples', { mode: 'json' }).$type<string[]>().default([]),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
    updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
  },
  (table) => ({
    userIdIdx: index('carts_user_id_idx').on(table.userId),
    sessionIdIdx: index('carts_session_id_idx').on(table.sessionId),
  }),
);

export const wishlists = sqliteTable(
  'wishlists',
  {
    id: text('id').primaryKey().$defaultFn(uuid),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    sessionId: text('session_id'),
    productId: text('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' }).notNull().$defaultFn(now),
  },
  (table) => ({
    userIdIdx: index('wishlists_user_id_idx').on(table.userId),
    sessionIdIdx: index('wishlists_session_id_idx').on(table.sessionId),
    uniqueUserProduct: uniqueIndex('wishlists_unique_user_product').on(table.userId, table.productId),
    uniqueSessionProduct: uniqueIndex('wishlists_unique_session_product').on(table.sessionId, table.productId),
  }),
);

export const productsRelations = relations(products, ({ many }) => ({
  reviews: many(reviews),
  wishlists: many(wishlists),
}));

export const categoriesRelations = relations(categories, ({ many }) => ({
  products: many(products),
}));

export const ordersRelations = relations(orders, ({ one }) => ({
  user: one(users, { fields: [orders.userId], references: [users.id] }),
}));

export const usersRelations = relations(users, ({ many }) => ({
  orders: many(orders),
  reviews: many(reviews),
  carts: many(carts),
  wishlists: many(wishlists),
}));

export const reviewsRelations = relations(reviews, ({ one }) => ({
  product: one(products, { fields: [reviews.productId], references: [products.id] }),
  user: one(users, { fields: [reviews.userId], references: [users.id] }),
}));

export const cartsRelations = relations(carts, ({ one }) => ({
  user: one(users, { fields: [carts.userId], references: [users.id] }),
}));

export const wishlistsRelations = relations(wishlists, ({ one }) => ({
  user: one(users, { fields: [wishlists.userId], references: [users.id] }),
  product: one(products, { fields: [wishlists.productId], references: [products.id] }),
}));