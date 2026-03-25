// Core skin data from skins.json
export interface Skin {
  id: string;
  name: string;
  weapon_name: string;
  pattern_name: string;
  rarity_id: string;
  rarity_name: string;
  min_float: number;
  max_float: number;
  has_stattrak: boolean;
  has_souvenir: boolean;
  image_url: string;
  paint_index: number | null;
}

// One row per wear×variant from skins_not_grouped.json
export interface SkinVariant {
  id: number;
  skin_id: string;
  market_hash_name: string;
  wear_name: string;
  is_stattrak: boolean;
  is_souvenir: boolean;
}

// Collection metadata
export interface Collection {
  id: string;
  name: string;
  image_url: string;
}

// Junction table: which skins belong to which collections at which rarity
export interface CollectionSkin {
  collection_id: string;
  skin_id: string;
  rarity_id: string;
}

// Cached Steam market prices
export interface PriceData {
  market_hash_name: string;
  lowest_price_cents: number | null;
  median_price_cents: number | null;
  volume: number | null;
  sell_listings: number | null;
  updated_at: string;
}

// A single possible outcome from a tradeup contract
export interface TradeupOutcome {
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  wear_name: string;
  probability: number;
  price_cents: number | null;
  collection_id: string;
  collection_name: string;
}

// Full tradeup result with inputs, outcomes, and cost metrics
export interface TradeupResult {
  inputs: {
    skin_id: string;
    skin_name: string;
    weapon_name: string;
    wear_name: string;
    price_cents: number;
    collection_id: string;
    collection_name: string;
    quantity: number;
  }[];
  outcomes: TradeupOutcome[];
  total_cost_cents: number;
  probability_of_target: number;
  cost_per_attempt_cents: number;
  ev_cents: number;
}

// Rarity tier mapping
export const RARITY_TIERS: Record<string, number> = {
  rarity_common_weapon: 1,    // Consumer Grade
  rarity_uncommon_weapon: 2,  // Industrial Grade
  rarity_rare_weapon: 3,      // Mil-Spec Grade
  rarity_mythical_weapon: 4,  // Restricted
  rarity_legendary_weapon: 5, // Classified
  rarity_ancient_weapon: 6,   // Covert
};

// Input rarity → Output rarity mapping
export const TRADEUP_INPUT_RARITY: Record<string, string> = {
  rarity_uncommon_weapon: 'rarity_common_weapon',    // Industrial ← Consumer
  rarity_rare_weapon: 'rarity_uncommon_weapon',      // Mil-Spec ← Industrial
  rarity_mythical_weapon: 'rarity_rare_weapon',      // Restricted ← Mil-Spec
  rarity_legendary_weapon: 'rarity_mythical_weapon', // Classified ← Restricted
  rarity_ancient_weapon: 'rarity_legendary_weapon',  // Covert ← Classified
};

// Wear condition boundaries
export const WEAR_BOUNDARIES = {
  'Factory New': { min: 0.00, max: 0.07 },
  'Minimal Wear': { min: 0.07, max: 0.15 },
  'Field-Tested': { min: 0.15, max: 0.38 },
  'Well-Worn': { min: 0.38, max: 0.45 },
  'Battle-Scarred': { min: 0.45, max: 1.00 },
} as const;
