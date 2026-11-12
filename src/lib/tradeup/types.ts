// Shapes sent to the browser by the trade-up API routes. Types only, so client
// components can import this file without pulling in server code.

// How the chosen input wears relate to the requested output wear:
//   any      - every float those wears can have lands the requested wear
//   specific - only some floats do; the buyer has to pick items by float
//   miss     - no float those wears can have lands the requested wear
export type FloatFit = 'any' | 'specific' | 'miss';

export type FloatSource = 'wear_assumption' | 'exact';

export type TradeupSort = 'cost_per_hit' | 'ev';

export interface TradeupGroupedInput {
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  wear_name: string;
  // Lowest active Steam listing for this exact variant.
  price_cents: number;
  is_souvenir: boolean;
  collection_id: string;
  collection_name: string;
  market_hash_name: string;
  image_url: string | null;
  quantity: number;
  // True when this input's collection cannot produce the target: a cheaper
  // filler that lowers the target chance and adds its own outcomes to the pool.
  cannot_produce_target: boolean;
}

export interface TradeupConcreteInput {
  slot: number;
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  wear_name: string;
  price_cents: number;
  is_souvenir: boolean;
  collection_id: string;
  collection_name: string;
  market_hash_name: string;
  image_url: string | null;
  min_float: number;
  max_float: number;
  // The floats this skin can have in this wear.
  wear_float_range: [number, number];
  // Exact float when the user supplied one; otherwise a float inside the wear
  // that makes the contract land the requested wear (or the middle of the wear
  // when any float works).
  input_float: number;
  normalized_float: number;
  float_source: FloatSource;
}

export interface TradeupOutcomeEvaluation {
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  collection_name: string;
  probability: number;
  // Average of the last 5 Steam sales of exactly `expected_wear`; null when
  // there is no sale on record (counted as $0 in EV).
  price_cents: number | null;
  last_sale_at: string | null;
  image_url: string | null;
  is_target: boolean;
  // False when exactly this variant (expected_wear) has no active Steam listing.
  has_active_listing: boolean;
  expected_float: number;
  expected_wear: string;
  // Every wear this outcome can come out in across the floats that still land
  // the request. More than one entry means its price depends on the floats.
  possible_wears: string[];
  // The possible wears that have no active listing / no sale on record.
  unlisted_wears: string[];
  unpriced_wears: string[];
}

export interface TradeupCombo {
  rank: number;
  float_fit: FloatFit;
  inputs: TradeupGroupedInput[];
  concrete_inputs: TradeupConcreteInput[];
  total_cost_cents: number;
  // Chance of the requested skin in the requested wear.
  probability: number;
  // Chance of the requested skin in any wear.
  target_skin_probability: number;
  target_matches_requested_wear: boolean;
  // total cost / probability: what one hit costs on average. Null when the
  // contract cannot land the requested wear.
  cost_per_attempt_cents: number | null;
  ev_cents: number;
  // Lowest and highest EV across the floats that still land the request.
  ev_range_cents: [number, number];
  avg_normalized_float: number;
  // Average normalized floats the chosen wears can produce.
  possible_avg_normalized: [number, number];
  // Average normalized floats that land the requested wear with these wears;
  // null when none do.
  required_avg_normalized: [number, number] | null;
  // Share of the possible float range that lands the requested wear (1 = any).
  float_tolerance: number;
  float_source: FloatSource;
  requires_specific_floats: boolean;
  all_outcomes: TradeupOutcomeEvaluation[];
  // True when some outcome, in some wear it can come out in, has no active
  // listing / no sale on record.
  has_unlisted_outcomes: boolean;
  has_unpriced_outcomes: boolean;
}

export interface RequestedWearInfo {
  // False when no purchasable combination of input wears can land the wear.
  reachable: boolean;
  // True when at least one option lands the wear whatever the input floats.
  any_float_option: boolean;
  // The requested wear's float window clamped to the skin's float range; null
  // when the skin does not exist in that wear.
  output_float_range: [number, number] | null;
  // The average normalized input float that lands inside that window.
  avg_normalized_range: [number, number] | null;
}

export interface TradeupFinderResult {
  requested_wear: RequestedWearInfo;
  sort: TradeupSort;
  target: {
    skin_id: string;
    skin_name: string;
    weapon_name: string;
    wear: string;
    is_stattrak: boolean;
    // Lowest active listing for the requested variant; null when unlisted.
    price_cents: number | null;
    has_active_listing: boolean;
    // Last-5-sold average for the requested variant (what outcomes are valued at).
    last_sold_cents: number | null;
    image_url: string | null;
  };
  tradeups: TradeupCombo[];
  // How many input combinations were examined, for transparency.
  combinations_checked: number;
}

export interface ExactTradeupInput {
  skin_id: string;
  collection_id: string;
  market_hash_name: string;
  input_float: number;
}

export interface TradeupEligibility {
  eligible: boolean;
  reason?: string;
  input_rarity_id?: string;
  input_rarity_name?: string;
  input_type?: 'standard' | 'gold';
  num_inputs_required?: number;
  collections?: {
    id: string;
    name: string;
    image_url: string | null;
    // Only skins with an active Steam listing: unlisted skins are never inputs.
    input_skins: {
      id: string;
      name: string;
      image_url: string | null;
      cheapest_price_cents: number;
      cheapest_is_souvenir: boolean;
    }[];
    // Input-rarity skins hidden because none of their variants is listed.
    unlisted_input_count: number;
    output_skins: {
      id: string;
      name: string;
      image_url: string | null;
      // Cheapest last-5-sold average across normal wears; null when unknown.
      cheapest_price_cents: number | null;
      // False when no normal (non-souvenir) wear of this skin is listed.
      has_active_listing: boolean;
      // Skin ids folded into this outcome (finish phases share one entry).
      alias_ids: string[];
    }[];
  }[];
}

export interface TradeupLeaderboardOutcome {
  skin_id: string;
  skin_name: string;
  weapon_name: string;
  image_url: string | null;
  probability: number;
  // Outcome float range across the entry's input float range.
  float_range: [number, number];
  expected_wear: string;
  // Last-5-sold average for expected_wear; every outcome shown has one.
  price_cents: number;
}

export interface TradeupLeaderboardEntry {
  id: string;
  contract_type: 'standard' | 'gold';
  collection_id: string;
  collection_name: string;
  num_inputs: number;
  input: {
    skin_id: string;
    skin_name: string;
    weapon_name: string;
    image_url: string | null;
    wear_name: string;
    market_hash_name: string;
    price_cents: number;
    is_souvenir: boolean;
    // The floats this skin can have in this wear.
    wear_float_range: [number, number];
    // The average input float the figures below hold for. Equal to
    // wear_float_range when any item of this wear will do.
    required_float_range: [number, number];
    any_float: boolean;
  };
  total_cost_cents: number;
  expected_return_cents: number;
  ev_cents: number;
  roi_percent: number;
  outcome_count: number;
  best_outcome_price_cents: number;
  outcomes: TradeupLeaderboardOutcome[];
}

export interface TradeupLeaderboardResult {
  entries: TradeupLeaderboardEntry[];
  total_matches: number;
}
