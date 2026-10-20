export type DepartmentType = 'beauty' | 'groceries';

export type CategoryType = 
  | 'all' 
  // Beauty Categories
  | 'skincare' 
  | 'makeup'
  | 'fragrances' 
  | 'body-care' 
  | 'beauty-tools'
  // Grocery Categories
  | 'rice-grains'
  | 'cooking-oils'
  | 'seasoning-spices'
  | 'beverages'
  | 'snacks-sweets'
  | 'household-care'
  | 'daily-essentials'
  // Special Curations
  | 'new-arrivals'
  | 'best-sellers'
  | 'offers';

export interface CategoryConfig {
  id: CategoryType;
  slug: string;
  name: string;
  department: DepartmentType;
  image: string;
  description: string;
  isActive: boolean;
}

export interface StoreSettings {
  storeName: string;
  storeEmail: string;
  storePhone: string;
  storeAddress: string;
  /** Tax Identification Number for receipts. */
  tin?: string;
  /** Logo URL or data URI for receipts. */
  logo?: string;
}

export interface StoreSettingsRow {
  key: string;
  value: any;
}

export interface PromoCode {
  id: string;
  code: string;
  discountType: 'percentage' | 'fixed';
  discountValue: number;
  minSpend?: number;
  isActive: boolean;
  usageCount: number;
  description: string;
  expiryDate?: string;
}

export interface AdminSession {
  isLoggedIn: boolean;
  adminId?: string;
  adminName: string;
  adminRole: 'Super Admin' | 'Store Manager' | 'Inventory Dispatcher' | 'Cashier';
  email: string;
  phone?: string;
  avatar?: string;
}

export interface ProductVariant {
  id: string;
  name: string; // e.g. "30ml", "100ml", "5kg", "10kg"
  options?: Record<string, string>;
  price: number;
  wholesalePrice?: number;
  image?: string;
  barcode?: string;
  inStock: boolean;
  stockCount?: number;
  /** Supplier or manufacturer identifier accepted by the POS scanner. */
  serialNumber?: string;
}

export interface ProductOption {
  name: string;
  values: string[];
}

export interface Product {
  id: string;
  name: string;
  brand: string;
  department: DepartmentType;
  category: CategoryType;
  categoryLabel: string;
  price: number;
  wholesalePrice?: number;
  unit: string;
  barcode?: string;
  serialNumber?: string;
  image: string;
  images: string[];
  inStock: boolean;
  isPublished?: boolean;
  stockCount: number;
  options?: ProductOption[];
  variants?: ProductVariant[];
}

export interface CartItem {
  product: Product;
  quantity: number;
  selectedVariant?: ProductVariant;
  priceType?: 'retail' | 'wholesale';
}

export type DeliveryMethod = 'store-pickup';

export type PaymentMethod =
  | 'momo-mtn'
  | 'momo-telecel'
  | 'momo-at'
  | 'cash-on-delivery'
  | 'card'
  | 'apple-pay';

export interface ShippingAddress {
  fullName: string;
  phone: string;
  email?: string;
  city: string;
  region?: string;
  area: string;
}

export type OrderStatus =
  | 'Pending Payment'
  | 'Confirmed'
  | 'Processing'
  | 'Packing Order'
  | 'Out for Delivery'
  | 'Delivered'
  | 'Refunded'
  | 'Cancelled';

export interface Order {
  id: string;
  orderNumber: string;
  createdAt: string;
  items: CartItem[];
  subtotal: number;
  shippingFee: number;
  discount: number;
  total: number;
  paymentMethod: PaymentMethod;
  paymentStatus: 'paid';
  orderSource?: 'pos';
  deliveryMethod: DeliveryMethod;
  shippingAddress: ShippingAddress;
  status: OrderStatus;
  appliedPromoCode?: string;
  paymentReference?: string;
  paymentSenderPhone?: string;
  /** Staff member who served this sale at the register. */
  cashierName?: string | null;
}

export interface AdminAccount {
  id: string;
  fullName: string;
  email: string;
  phone: string;
  role: 'super_admin' | 'admin' | 'manager' | 'cashier';
  avatar?: string;
  profileImage?: string;
}


