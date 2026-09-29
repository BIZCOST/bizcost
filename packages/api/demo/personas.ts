import type { Locale } from '@bizcost/domain'
import type { RoleTemplateKey, SetupAdjustments, SetupAnswers } from '@bizcost/modules'
import {
  BAKER_COSTING,
  CAFE_COSTING,
  DESIGNER_COSTING,
  FACTORY_COSTING,
  FITOUT_COSTING,
  GROCERY_COSTING,
  PRINT3D_COSTING,
  WORKSHOP_COSTING,
  type DemoCosting,
} from './costing-data'

// Local demo businesses: one per persona of docs/PRODUCT.md §6.11, with the persona's exact Smart
// Setup answers (the server recomputes everything from them), an Arabic legal name, a TRN when
// VAT-registered, a team where the persona has one, and its Costing Core data (demo/costing-data.ts). Every account is local only and shares
// DEMO_PASSWORD; demo:reset deletes exactly the accounts under DEMO_EMAIL_DOMAIN.

export const DEMO_EMAIL_DOMAIN = 'demo.bizcost.local'
/** The shared password of every demo account (local stack only; the password rule of D-072). */
export const DEMO_PASSWORD = 'bizcost2026'

export interface DemoPerson {
  readonly email: string
  readonly name: string
  readonly locale: Locale
}

export interface DemoTeamMember extends DemoPerson {
  readonly role: Exclude<RoleTemplateKey, 'owner'>
  /** true: has an account and accepted; false: the invitation stays pending (its email is in Mailpit). */
  readonly joined: boolean
}

export interface DemoPersona {
  /** PRODUCT.md §6.11 persona. */
  readonly title: string
  readonly owner: DemoPerson
  readonly legalName: string
  readonly legalNameAr: string
  /** 15 digits; only for VAT-registered businesses. */
  readonly trn: string | null
  readonly answers: SetupAnswers
  /** Review changes, as the owner would make them on "Here's your BizCost". */
  readonly adjustments?: SetupAdjustments
  /** Locations beyond the default one (needs multi_location). */
  readonly branches?: readonly string[]
  readonly team?: readonly DemoTeamMember[]
  /** Suppliers, materials, products, recipes, purchases, running costs, expenses… (M2). */
  readonly costing?: DemoCosting
}

const email = (local: string) => `${local}@${DEMO_EMAIL_DOMAIN}`

export const DEMO_PERSONAS: readonly DemoPersona[] = [
  {
    title: 'Home baker, alone',
    costing: BAKER_COSTING,
    owner: { email: email('baker'), name: 'سارة الحمادي', locale: 'ar' },
    legalName: "Sara's Home Sweets",
    legalNameAr: 'حلويات سارة المنزلية',
    trn: null,
    answers: {
      what_you_do: ['food_drinks'],
      workplace: 'home',
      team: 'alone',
      work_setup: ['none'],
      sales_channels: ['messages'],
      vat: 'no',
    },
  },
  {
    title: 'Coffee shop, POS + staff (two branches)',
    costing: CAFE_COSTING,
    owner: { email: email('cafe'), name: 'خالد المنصوري', locale: 'ar' },
    legalName: 'Bean Corner Cafe',
    legalNameAr: 'مقهى ركن البن',
    trn: '100234567800003',
    answers: {
      what_you_do: ['food_drinks'],
      workplace: 'shop',
      branches: false,
      team: 'team',
      team_tracking: ['hours', 'salaries', 'staff_cash'],
      work_setup: ['stock'],
      sales_channels: ['walk_in', 'online'],
      pos: true,
      vat: 'yes',
    },
    // The persona answered "one branch"; the owner switched branches on in the review.
    adjustments: { modules: [], capabilities: [{ key: 'multi_location', enabled: true }] },
    branches: ['فرع مردف'],
    team: [
      {
        email: email('cafe.manager'),
        name: 'يوسف الأحمد',
        locale: 'ar',
        role: 'manager',
        joined: true,
      },
      {
        email: email('cafe.barista'),
        name: 'ليلى حسن',
        locale: 'ar',
        role: 'employee',
        joined: true,
      },
      {
        email: email('cafe.accountant'),
        name: 'مريم علي',
        locale: 'ar',
        role: 'accountant',
        joined: false,
      },
    ],
  },
  {
    title: '3D printing maker (one helper)',
    costing: PRINT3D_COSTING,
    owner: { email: email('print3d'), name: 'Mariam Al Suwaidi', locale: 'en' },
    legalName: 'Layer Lab 3D',
    legalNameAr: 'مختبر الطبقات للطباعة ثلاثية الأبعاد',
    trn: null,
    answers: {
      what_you_do: ['make_products'],
      how_you_make: ['catalog', 'custom_jobs'],
      workplace: 'home',
      team: 'team',
      team_tracking: ['cost_only'],
      work_setup: ['stock', 'machines'],
      sales_channels: ['messages', 'online'],
      vat: 'no',
    },
    team: [
      {
        email: email('print3d.helper'),
        name: 'Omar Haddad',
        locale: 'en',
        role: 'employee',
        joined: true,
      },
    ],
  },
  {
    title: 'Fit-out / decor project company',
    costing: FITOUT_COSTING,
    owner: { email: email('fitout'), name: 'عبدالله الكعبي', locale: 'ar' },
    legalName: 'Modern Touch Interiors',
    legalNameAr: 'لمسة عصرية للديكور',
    trn: '100345678900003',
    answers: {
      what_you_do: ['projects'],
      workplace: 'customer_sites',
      branches: false,
      team: 'team',
      team_tracking: ['hours', 'salaries', 'staff_cash'],
      work_setup: ['materials', 'vehicles'],
      vat: 'yes',
    },
    team: [
      {
        email: email('fitout.supervisor'),
        name: 'فيصل النعيمي',
        locale: 'ar',
        role: 'supervisor',
        joined: true,
      },
      {
        email: email('fitout.accountant'),
        name: 'هدى السعدي',
        locale: 'ar',
        role: 'accountant',
        joined: true,
      },
      {
        email: email('fitout.worker'),
        name: 'راجو كومار',
        locale: 'en',
        role: 'employee',
        joined: false,
      },
    ],
  },
  {
    title: 'Freelance designer (services only)',
    costing: DESIGNER_COSTING,
    owner: { email: email('designer'), name: 'Noura Al Ali', locale: 'en' },
    legalName: 'Noura Design Studio',
    legalNameAr: 'استوديو نورة للتصميم',
    trn: null,
    answers: {
      what_you_do: ['services'],
      workplace: 'home',
      team: 'alone',
      work_setup: ['none'],
      sales_channels: ['messages', 'quotes', 'invoice_later'],
      vat: 'no',
    },
  },
  {
    title: 'Retail shop with stock',
    costing: GROCERY_COSTING,
    owner: { email: email('retail'), name: 'أحمد الشامسي', locale: 'ar' },
    legalName: 'Al Khair Grocery',
    legalNameAr: 'بقالة الخير',
    trn: '100456789000003',
    answers: {
      what_you_do: ['sell_products'],
      workplace: 'shop',
      branches: false,
      team: 'team',
      team_tracking: ['salaries', 'staff_cash'],
      work_setup: ['stock', 'vehicles'],
      sales_channels: ['walk_in', 'messages'],
      pos: true,
      vat: 'yes',
    },
    team: [
      {
        email: email('retail.cashier'),
        name: 'سعيد البلوشي',
        locale: 'ar',
        role: 'sales',
        joined: true,
      },
      {
        email: email('retail.stock'),
        name: 'أنور حسين',
        locale: 'ar',
        role: 'employee',
        joined: false,
      },
    ],
  },
  {
    title: 'Small factory (cleaning products)',
    costing: FACTORY_COSTING,
    owner: { email: email('factory'), name: 'سلطان المزروعي', locale: 'ar' },
    legalName: 'Al Naqaa Cleaning Products Factory',
    legalNameAr: 'مصنع النقاء لمواد التنظيف',
    trn: '100567890100003',
    answers: {
      what_you_do: ['make_products'],
      how_you_make: ['batches'],
      workplace: 'factory',
      branches: false,
      team: 'team',
      team_tracking: ['hours', 'salaries'],
      work_setup: ['stock', 'machines', 'vehicles'],
      sales_channels: ['messages', 'quotes', 'invoice_later'],
      vat: 'yes',
    },
    team: [
      {
        email: email('factory.manager'),
        name: 'ماجد الحوسني',
        locale: 'ar',
        role: 'manager',
        joined: true,
      },
      {
        email: email('factory.accountant'),
        name: 'Priya Nair',
        locale: 'en',
        role: 'accountant',
        joined: true,
      },
      {
        email: email('factory.supervisor'),
        name: 'علي رضا',
        locale: 'ar',
        role: 'supervisor',
        joined: false,
      },
    ],
  },
  {
    title: 'Workshop with many jobs (carpentry)',
    costing: WORKSHOP_COSTING,
    owner: { email: email('workshop'), name: 'حمد الظاهري', locale: 'ar' },
    legalName: 'Al Itqan Carpentry',
    legalNameAr: 'نجارة الإتقان',
    trn: '100678901200003',
    answers: {
      what_you_do: ['make_products'],
      how_you_make: ['custom_jobs'],
      workplace: 'workshop',
      branches: false,
      team: 'team',
      team_tracking: ['hours', 'salaries', 'staff_cash'],
      work_setup: ['stock', 'machines', 'vehicles'],
      sales_channels: ['messages', 'quotes'],
      vat: 'yes',
    },
    team: [
      {
        email: email('workshop.supervisor'),
        name: 'سالم الكتبي',
        locale: 'ar',
        role: 'supervisor',
        joined: true,
      },
      {
        email: email('workshop.carpenter'),
        name: 'Imran Khan',
        locale: 'en',
        role: 'employee',
        joined: true,
      },
      {
        email: email('workshop.sales'),
        name: 'نورة الشحي',
        locale: 'ar',
        role: 'sales',
        joined: false,
      },
    ],
  },
]
