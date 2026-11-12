import type { ReturnClass, Zone } from "@prisma/client";

/** Appendix A catalogue (prices in rupees here; stored in paise). */
export interface CatalogProduct {
  sku: string;
  name: string;
  priceInr: number;
  category: string;
  returnClass: ReturnClass;
  notes: string;
  stock: Record<string, number>;
  sizeChart: Record<string, string>;
}

export const CATALOG: CatalogProduct[] = [
  {
    sku: "WL-KUR-01",
    name: "Cotton printed kurta",
    priceInr: 1299,
    category: "kurta",
    returnClass: "RETURNABLE",
    notes: "Can be returned or exchanged",
    stock: { S: 5, M: 8, L: 6, XL: 3, XXL: 0 },
    sizeChart: {
      S: "Chest 38 in, length 40 in — fits ~5'4\"–5'7\", 55–65 kg",
      M: "Chest 40 in, length 41 in — fits ~5'6\"–5'9\", 62–72 kg",
      L: "Chest 42 in, length 42 in — fits ~5'8\"–5'11\", 70–80 kg",
      XL: "Chest 44 in, length 43 in — fits ~5'10\"–6'1\", 78–90 kg",
      XXL: "Chest 46 in, length 44 in — fits ~6'0\"+, 88–100 kg",
    },
  },
  {
    sku: "WL-TEE-02",
    name: "Oversized graphic tee",
    priceInr: 699,
    category: "tee",
    returnClass: "RETURNABLE",
    notes: "Can be returned or exchanged",
    stock: { S: 4, M: 10, L: 7, XL: 0 },
    sizeChart: {
      S: "Chest 42 in (oversized) — usual size XS–S, up to 60 kg",
      M: "Chest 44 in (oversized) — usual size S–M, 58–70 kg",
      L: "Chest 46 in (oversized) — usual size M–L, 68–80 kg",
      XL: "Chest 48 in (oversized) — usual size L–XL, 78–92 kg",
    },
  },
  {
    sku: "WL-JNS-03",
    name: "Relaxed fit jeans",
    priceInr: 1799,
    category: "jeans",
    returnClass: "RETURNABLE",
    notes: "Can be returned or exchanged",
    stock: { "28": 3, "30": 5, "32": 6, "34": 4, "36": 2 },
    sizeChart: {
      "28": "Waist 28 in, inseam 30 in",
      "30": "Waist 30 in, inseam 31 in",
      "32": "Waist 32 in, inseam 32 in",
      "34": "Waist 34 in, inseam 32 in",
      "36": "Waist 36 in, inseam 33 in",
    },
  },
  {
    sku: "WL-BRF-04",
    name: "Cotton briefs, pack of 3",
    priceInr: 499,
    category: "innerwear",
    returnClass: "INNERWEAR",
    notes: "Innerwear, no returns",
    stock: { S: 20, M: 25, L: 25, XL: 15 },
    sizeChart: { S: "Waist 28–30 in", M: "Waist 30–32 in", L: "Waist 32–34 in", XL: "Waist 34–36 in" },
  },
  {
    sku: "WL-BAG-05",
    name: "Canvas tote bag",
    priceInr: 899,
    category: "bag",
    returnClass: "RETURN_ONLY",
    notes: "Can be returned",
    stock: { ONE: 15 },
    sizeChart: { ONE: "40 x 38 cm, 10 cm gusset, 12 oz canvas" },
  },
  {
    sku: "WL-SAL-06",
    name: "Sale tee",
    priceInr: 399,
    category: "tee",
    returnClass: "SALE",
    notes: "Sale item, size exchange only",
    stock: { S: 2, M: 0, L: 3, XL: 1 },
    sizeChart: {
      S: "Chest 38 in, regular fit",
      M: "Chest 40 in, regular fit",
      L: "Chest 42 in, regular fit",
      XL: "Chest 44 in, regular fit",
    },
  },
];

export interface PincodeSeed {
  pincode: string;
  city: string;
  state: string;
  zone: Zone;
  codAvailable: boolean;
  serviceable?: boolean;
}

export const PINCODES: PincodeSeed[] = [
  { pincode: "110001", city: "New Delhi", state: "Delhi", zone: "METRO", codAvailable: true },
  { pincode: "110017", city: "New Delhi", state: "Delhi", zone: "METRO", codAvailable: true },
  { pincode: "400001", city: "Mumbai", state: "Maharashtra", zone: "METRO", codAvailable: true },
  { pincode: "400050", city: "Mumbai", state: "Maharashtra", zone: "METRO", codAvailable: true },
  { pincode: "560001", city: "Bengaluru", state: "Karnataka", zone: "METRO", codAvailable: true },
  { pincode: "560034", city: "Bengaluru", state: "Karnataka", zone: "METRO", codAvailable: true },
  { pincode: "600001", city: "Chennai", state: "Tamil Nadu", zone: "METRO", codAvailable: true },
  { pincode: "700001", city: "Kolkata", state: "West Bengal", zone: "METRO", codAvailable: true },
  { pincode: "500001", city: "Hyderabad", state: "Telangana", zone: "METRO", codAvailable: true },
  { pincode: "411001", city: "Pune", state: "Maharashtra", zone: "METRO", codAvailable: true },
  { pincode: "380001", city: "Ahmedabad", state: "Gujarat", zone: "METRO", codAvailable: true },
  { pincode: "302001", city: "Jaipur", state: "Rajasthan", zone: "REST", codAvailable: true },
  { pincode: "226001", city: "Lucknow", state: "Uttar Pradesh", zone: "REST", codAvailable: true },
  { pincode: "452001", city: "Indore", state: "Madhya Pradesh", zone: "REST", codAvailable: true },
  { pincode: "641001", city: "Coimbatore", state: "Tamil Nadu", zone: "REST", codAvailable: true },
  { pincode: "682001", city: "Kochi", state: "Kerala", zone: "REST", codAvailable: true },
  { pincode: "800001", city: "Patna", state: "Bihar", zone: "REST", codAvailable: true },
  { pincode: "462001", city: "Bhopal", state: "Madhya Pradesh", zone: "REST", codAvailable: true },
  { pincode: "201301", city: "Noida", state: "Uttar Pradesh", zone: "REST", codAvailable: true },
  { pincode: "781001", city: "Guwahati", state: "Assam", zone: "NE_JK", codAvailable: true },
  { pincode: "795001", city: "Imphal", state: "Manipur", zone: "NE_JK", codAvailable: false },
  { pincode: "793001", city: "Shillong", state: "Meghalaya", zone: "NE_JK", codAvailable: false },
  { pincode: "737101", city: "Gangtok", state: "Sikkim", zone: "NE_JK", codAvailable: true },
  { pincode: "180001", city: "Jammu", state: "Jammu & Kashmir", zone: "NE_JK", codAvailable: true },
  { pincode: "190001", city: "Srinagar", state: "Jammu & Kashmir", zone: "NE_JK", codAvailable: false },
  { pincode: "744101", city: "Port Blair", state: "Andaman & Nicobar", zone: "REST", codAvailable: false, serviceable: false },
];
