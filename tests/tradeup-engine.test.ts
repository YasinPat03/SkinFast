import assert from 'node:assert/strict';
import { test } from 'node:test';
import { outcomesOf, shapeForTarget, type ContractShape } from '../src/lib/tradeup/catalog';
import { outcomeDistribution, priceOutcomes } from '../src/lib/tradeup/contract';
import { describeEligibility } from '../src/lib/tradeup/eligibility';
import { evaluateExactContract, findBestTradeups } from '../src/lib/tradeup/finder';
import { buildLeaderboard } from '../src/lib/tradeup/leaderboard';
import type { TradeupCombo, TradeupFinderResult } from '../src/lib/tradeup/types';
import { fixtureCatalog, setQuote } from './helpers/catalog-fixture';

function found(result: TradeupFinderResult | { error: string }): TradeupFinderResult {
  if ('error' in result) assert.fail(`expected results, got error: ${result.error}`);
  return result;
}

function shapeOf(result: ContractShape | { error: string }): ContractShape {
  if ('error' in result) assert.fail(result.error);
  return result;
}

// Invariants that must hold for every contract the engine reports.
function assertConsistent(combo: TradeupCombo) {
  const totalProbability = combo.all_outcomes.reduce((sum, outcome) => sum + outcome.probability, 0);
  assert.ok(Math.abs(totalProbability - 1) < 1e-3, `outcome probabilities sum to ${totalProbability}`);

  const inputTotal = combo.inputs.reduce((sum, input) => sum + input.price_cents * input.quantity, 0);
  assert.equal(combo.total_cost_cents, inputTotal);

  if (combo.float_fit === 'miss') {
    assert.equal(combo.probability, 0);
    assert.equal(combo.cost_per_attempt_cents, null);
    assert.equal(combo.target_matches_requested_wear, false);
  } else {
    assert.equal(combo.probability, combo.target_skin_probability);
    // Probabilities are rounded to 4 places on the wire; cost per hit is not derived from the rounded figure.
    const perHit = combo.total_cost_cents / combo.target_skin_probability;
    assert.ok(Math.abs(combo.cost_per_attempt_cents! - perHit) / perHit < 1e-3, 'cost per hit = cost / probability');
  }

  const expectedReturn = combo.all_outcomes.reduce(
    (sum, outcome) => sum + outcome.probability * (outcome.price_cents ?? 0),
    0,
  );
  // Allow for the 4-place rounding of the probabilities used to recompute it here.
  const slack = 2 + expectedReturn * 5e-4;
  assert.ok(Math.abs(combo.ev_cents - (expectedReturn - combo.total_cost_cents)) <= slack, 'EV = sum(p x price) - cost');
  assert.ok(combo.ev_range_cents[0] <= combo.ev_cents && combo.ev_cents <= combo.ev_range_cents[1]);
}

test('catalog folds finish phases into one item and attaches case pools to collections', () => {
  const catalog = fixtureCatalog();
  const doppler = catalog.itemBySkinId.get('k-dop-1');
  assert.ok(doppler);
  assert.equal(catalog.itemBySkinId.get('k-dop-3'), doppler);
  assert.deepEqual(doppler.skinIds, ['k-dop-1', 'k-dop-2', 'k-dop-3']);
  assert.equal(doppler.primarySkinId, 'k-dop-2');
  assert.equal(doppler.variants.length, 4);

  const alpha = catalog.pools.get('col-a');
  assert.ok(alpha);
  assert.equal(alpha.caseName, 'Alpha Case');
  assert.deepEqual(
    alpha.rare.map((item) => item.name),
    ['★ Karambit | Fade', '★ Karambit | Doppler', '★ Karambit', '★ Sport Gloves | Alpha'],
  );
  assert.equal(catalog.itemBySkinId.get('k-van')?.vanilla, true);
  assert.equal(catalog.itemBySkinId.get('g-alpha')?.kind, 'glove');
  assert.equal(catalog.itemBySkinId.get('k-fade')?.kind, 'knife');
});

test('each input weighs 1/n and splits evenly across its collection outcomes', () => {
  const catalog = fixtureCatalog();
  const shape = shapeOf(shapeForTarget(catalog.itemBySkinId.get('a-out1')!, false));
  const chances = outcomeDistribution(
    [
      [catalog.pools.get('col-a')!, 7],
      [catalog.pools.get('col-b')!, 3],
    ],
    shape,
  );
  assert.ok(chances);
  const byName = new Map(chances.map((chance) => [chance.item.name, chance.probability]));
  assert.ok(Math.abs(byName.get('AK-47 | Full')! - 0.35) < 1e-12);
  assert.ok(Math.abs(byName.get('M4A4 | Narrow')! - 0.35) < 1e-12);
  assert.ok(Math.abs(byName.get('Glock-18 | One')! - 0.1) < 1e-12);
  assert.equal(chances.length, 5);
});

test('a pool with no possible outcome makes the contract invalid', () => {
  const catalog = fixtureCatalog();
  const statTrakGold = shapeOf(shapeForTarget(catalog.itemBySkinId.get('k-fade')!, true));
  // The Gamma case only holds gloves, which have no StatTrak version.
  assert.equal(outcomesOf(catalog.pools.get('col-c')!, statTrakGold).length, 0);
  assert.equal(outcomeDistribution([[catalog.pools.get('col-c')!, 5]], statTrakGold), null);
});

test('outcomes are valued at the last-5-sold average of their exact wear, never a listing', () => {
  const catalog = fixtureCatalog((rows) => {
    setQuote(rows, 'AK-47 | Full (Field-Tested)', 999999, 2900);
    setQuote(rows, 'M4A4 | Narrow (Field-Tested)', 1500, null);
  });
  const shape = shapeOf(shapeForTarget(catalog.itemBySkinId.get('a-out1')!, false));
  const chances = outcomeDistribution([[catalog.pools.get('col-a')!, 10]], shape)!;
  const priced = priceOutcomes(chances, shape, 0.2);

  const ak = priced.outcomes.find((outcome) => outcome.item.name === 'AK-47 | Full')!;
  assert.equal(ak.wear, 'Field-Tested');
  assert.equal(ak.saleCents, 2900);

  // No sale on record: the value stays unknown instead of borrowing the
  // listing price or another wear's sale price.
  const m4 = priced.outcomes.find((outcome) => outcome.item.name === 'M4A4 | Narrow')!;
  assert.equal(m4.wear, 'Field-Tested');
  assert.equal(m4.saleCents, null);
  assert.equal(m4.listed, true);
  assert.equal(priced.hasUnpricedOutcomes, true);
  assert.equal(priced.expectedReturnCents, 0.5 * 2900);
});

test('finder: the cheapest own-collection inputs win on cost per hit when floats do not bind', () => {
  const catalog = fixtureCatalog();
  const result = found(findBestTradeups(catalog, 'a-out1', 'Field-Tested', false));
  result.tradeups.forEach(assertConsistent);

  assert.equal(result.requested_wear.reachable, true);
  assert.equal(result.requested_wear.any_float_option, true);
  assert.deepEqual(result.requested_wear.avg_normalized_range, [0.15, 0.38]);
  assert.equal(result.target.price_cents, 3000);
  assert.equal(result.target.last_sold_cents, 2900);

  // Souvenir inputs are legal in a normal contract and here they are cheapest.
  const best = result.tradeups[0];
  assert.equal(best.float_fit, 'any');
  assert.equal(best.inputs.length, 1);
  assert.equal(best.inputs[0].market_hash_name, 'Souvenir P250 | Wide (Field-Tested)');
  assert.equal(best.inputs[0].quantity, 10);
  assert.equal(best.total_cost_cents, 700);
  assert.equal(best.probability, 0.5);
  assert.equal(best.cost_per_attempt_cents, 1400);
  assert.equal(best.ev_cents, 1450);
  assert.deepEqual(best.ev_range_cents, [1450, 1450]);
  assert.equal(best.float_tolerance, 1);
  assert.equal(best.requires_specific_floats, false);

  // Any-float options come first; float-dependent ones follow only when they
  // are cheaper per hit, and never rely on a sliver of the float range.
  const fits = result.tradeups.map((combo) => combo.float_fit);
  assert.deepEqual(fits, [...fits].sort());
  const specific = result.tradeups.filter((combo) => combo.float_fit === 'specific');
  assert.ok(specific.length > 0);
  for (const combo of specific) {
    assert.ok(combo.cost_per_attempt_cents! < 1400);
    assert.ok(combo.float_tolerance >= 0.1);
    assert.equal(combo.requires_specific_floats, true);
  }
  assert.equal(specific[0].inputs[0].market_hash_name, 'MP7 | Half (Field-Tested)');
  assert.equal(specific[0].cost_per_attempt_cents, 1000);
  assert.deepEqual(specific[0].possible_avg_normalized, [0.3, 0.76]);
  assert.deepEqual(specific[0].required_avg_normalized, [0.3, 0.38]);

  // A skin with no active listing is never an input.
  for (const combo of result.tradeups) {
    assert.ok(combo.inputs.every((input) => input.skin_name !== 'MAC-10 | Ghost'));
  }
});

test('finder: fillers win when they let a cheap own input land a low-float wear', () => {
  const catalog = fixtureCatalog();
  const result = found(findBestTradeups(catalog, 'a-out2', 'Minimal Wear', false));
  result.tradeups.forEach(assertConsistent);

  // M4A4 | Narrow (0.10-0.60) is Minimal Wear for an average normalized float of 0-0.1.
  assert.deepEqual(result.requested_wear.output_float_range, [0.1, 0.15]);
  assert.deepEqual(result.requested_wear.avg_normalized_range, [0, 0.1]);

  const best = result.tradeups[0];
  assert.equal(best.float_fit, 'any');
  assert.equal(best.total_cost_cents, 270);
  assert.equal(best.probability, 0.05);
  assert.equal(best.cost_per_attempt_cents, 5400);
  const own = best.inputs.find((input) => !input.cannot_produce_target)!;
  const filler = best.inputs.find((input) => input.cannot_produce_target)!;
  assert.equal(own.market_hash_name, 'MP7 | Half (Minimal Wear)');
  assert.equal(own.quantity, 1);
  assert.equal(filler.market_hash_name, 'Nova | Filler (Factory New)');
  assert.equal(filler.quantity, 9);
  assert.deepEqual(best.possible_avg_normalized, [0.014, 0.093]);

  // The other own-collection outcome changes wear inside the possible float
  // range, so the EV is reported as a range.
  assert.equal(best.ev_cents, 545);
  assert.deepEqual(best.ev_range_cents, [350, 545]);
  const ak = best.all_outcomes.find((outcome) => outcome.skin_name === 'AK-47 | Full')!;
  assert.deepEqual(ak.possible_wears, ['Factory New', 'Minimal Wear']);
  assert.equal(best.all_outcomes.length, 5);
});

test('finder: ranking by EV is available and changes the order', () => {
  const catalog = fixtureCatalog();
  const byEv = found(findBestTradeups(catalog, 'a-out1', 'Field-Tested', false, 'ev'));
  byEv.tradeups.forEach(assertConsistent);
  assert.equal(byEv.sort, 'ev');
  const anyFloat = byEv.tradeups.filter((combo) => combo.float_fit === 'any');
  for (let i = 1; i < anyFloat.length; i++) assert.ok(anyFloat[i - 1].ev_cents >= anyFloat[i].ev_cents);
});

test('finder: StatTrak contracts use only StatTrak inputs and StatTrak outcome prices', () => {
  const catalog = fixtureCatalog();
  const result = found(findBestTradeups(catalog, 'a-out1', 'Field-Tested', true));
  result.tradeups.forEach(assertConsistent);

  const best = result.tradeups[0];
  assert.equal(best.inputs[0].market_hash_name, 'StatTrak™ P250 | Wide (Field-Tested)');
  assert.equal(best.total_cost_cents, 2500);
  assert.equal(best.cost_per_attempt_cents, 5000);
  assert.equal(best.ev_cents, 2550);
  for (const combo of result.tradeups) {
    assert.ok(combo.inputs.every((input) => !input.is_souvenir && input.market_hash_name.startsWith('StatTrak™')));
  }
  assert.equal(result.target.price_cents, 7000);
});

test('finder: a wear no purchasable inputs can reach is reported, not silently replaced', () => {
  const catalog = fixtureCatalog((rows) => {
    for (const name of [
      'P250 | Wide (Factory New)',
      'P250 | Wide (Minimal Wear)',
      'MP7 | Half (Factory New)',
      'MP7 | Half (Minimal Wear)',
      'Nova | Filler (Factory New)',
      'Nova | Filler (Minimal Wear)',
    ]) {
      setQuote(rows, name, null, 100);
    }
  });
  const result = found(findBestTradeups(catalog, 'a-out2', 'Minimal Wear', false));
  result.tradeups.forEach(assertConsistent);

  assert.equal(result.requested_wear.reachable, false);
  assert.equal(result.requested_wear.any_float_option, false);
  assert.ok(result.tradeups.length > 0);
  for (const combo of result.tradeups) {
    assert.equal(combo.float_fit, 'miss');
    assert.equal(combo.required_avg_normalized, null);
    assert.notEqual(combo.all_outcomes.find((outcome) => outcome.is_target)!.expected_wear, 'Minimal Wear');
  }
  // Closest first: Field-Tested inputs with a full float range start at 0.15.
  assert.equal(result.tradeups[0].possible_avg_normalized[0], 0.15);
});

test('finder: contracts with an unlisted outcome are dropped when a fully listed one exists', () => {
  const catalog = fixtureCatalog((rows) => {
    setQuote(rows, 'Glock-18 | Two (Factory New)', null, 200);
    setQuote(rows, 'Glock-18 | Two (Minimal Wear)', null, 200);
  });
  const result = found(findBestTradeups(catalog, 'a-out2', 'Minimal Wear', false));
  result.tradeups.forEach(assertConsistent);
  // The Beta collection now has an unlisted outcome at every float that lands
  // the request, so filler contracts lose to the own-collection ones.
  for (const combo of result.tradeups) {
    assert.equal(combo.has_unlisted_outcomes, false);
    assert.ok(combo.inputs.every((input) => !input.cannot_produce_target));
  }
  assert.equal(result.tradeups[0].cost_per_attempt_cents, 8800);
});

test('finder: when every contract has an unlisted outcome, results come back flagged', () => {
  const catalog = fixtureCatalog((rows) => setQuote(rows, 'M4A4 | Narrow (Field-Tested)', null, 1400));
  const result = found(findBestTradeups(catalog, 'a-out1', 'Field-Tested', false));
  assert.ok(result.tradeups.length > 0);
  for (const combo of result.tradeups.filter((entry) => entry.float_fit === 'any')) {
    assert.equal(combo.has_unlisted_outcomes, true);
    const m4 = combo.all_outcomes.find((outcome) => outcome.skin_name === 'M4A4 | Narrow')!;
    assert.equal(m4.has_active_listing, false);
    assert.deepEqual(m4.unlisted_wears, ['Field-Tested']);
    assert.equal(m4.price_cents, 1400);
  }
});

test('finder: 5 Coverts roll the case pool; phases are one outcome and vanilla knives are priced', () => {
  const catalog = fixtureCatalog();
  // Asked through a phase id that owns no market listings of its own.
  const result = found(findBestTradeups(catalog, 'k-dop-1', 'Factory New', false));
  result.tradeups.forEach(assertConsistent);

  const best = result.tradeups[0];
  assert.equal(best.concrete_inputs.length, 5);
  assert.equal(best.inputs[0].skin_name, 'AWP | Red');
  assert.equal(best.inputs[0].collection_name, 'Alpha Case');
  assert.equal(best.total_cost_cents, 300000);
  assert.equal(best.target_skin_probability, 0.25);
  assert.equal(best.cost_per_attempt_cents, 1200000);
  assert.equal(best.all_outcomes.length, 4);
  assert.equal(best.ev_cents, -171750);

  const target = best.all_outcomes.find((outcome) => outcome.is_target)!;
  assert.equal(target.skin_name, '★ Karambit | Doppler');
  assert.equal(target.skin_id, 'k-dop-2');
  assert.equal(target.price_cents, 140000);

  const vanilla = best.all_outcomes.find((outcome) => outcome.skin_name === '★ Karambit')!;
  assert.equal(vanilla.expected_wear, 'Vanilla');
  assert.equal(vanilla.price_cents, 95000);
  assert.equal(vanilla.has_active_listing, true);
  assert.equal(best.has_unlisted_outcomes, false);
});

test('finder: StatTrak Covert contracts only produce knives', () => {
  const catalog = fixtureCatalog();
  const result = found(findBestTradeups(catalog, 'k-fade', 'Factory New', true));
  result.tradeups.forEach(assertConsistent);
  const best = result.tradeups[0];
  assert.equal(best.all_outcomes.length, 3);
  assert.ok(best.all_outcomes.every((outcome) => !outcome.skin_name.includes('Gloves')));
  assert.equal(best.target_skin_probability, 0.3333);
  assert.equal(best.total_cost_cents, 450000);
  assert.equal(best.cost_per_attempt_cents, 1350000);
  // The gloves-only case cannot feed a StatTrak contract, so it is never a filler.
  assert.ok(result.tradeups.every((combo) => combo.inputs.every((input) => input.skin_name === 'AWP | Red')));

  assert.deepEqual(findBestTradeups(catalog, 'g-alpha', 'Field-Tested', true), {
    error: 'StatTrak Covert tradeups can only produce knives',
  });

  const gloves = found(findBestTradeups(catalog, 'g-gamma', 'Field-Tested', false));
  assert.equal(gloves.tradeups[0].target_skin_probability, 1);
  assert.equal(gloves.tradeups[0].total_cost_cents, 250000);
});

test('finder: skins that cannot come out of a contract say why', () => {
  const catalog = fixtureCatalog();
  assert.deepEqual(findBestTradeups(catalog, 'a-con', 'Field-Tested', false), {
    error: 'Consumer Grade skins cannot be obtained via tradeup',
  });
  assert.deepEqual(findBestTradeups(catalog, 'nope', 'Field-Tested', false), { error: 'Target skin not found' });
  assert.deepEqual(findBestTradeups(catalog, 'a-out2', 'Factory New', false), {
    error: 'M4A4 | Narrow does not exist in Factory New',
  });

  // A Covert weapon is a normal 10-input contract from Classified skins.
  const covert = found(findBestTradeups(catalog, 'a-cov', 'Field-Tested', false));
  assert.equal(covert.tradeups[0].concrete_inputs.length, 10);
  assert.equal(covert.tradeups[0].inputs[0].skin_name, 'USP-S | Class');
});

test('exact floats: the float decides the wear, the wear decides the listing price', () => {
  const catalog = fixtureCatalog();
  const slot = (input_float: number) => ({
    skin_id: 'a-in1',
    collection_id: 'col-a',
    market_hash_name: 'P250 | Wide (Field-Tested)',
    input_float,
  });

  const landed = evaluateExactContract(catalog, 'a-out1', 'Field-Tested', false, Array(10).fill(slot(0.2)));
  assert.ok(!('error' in landed));
  assertConsistent(landed);
  assert.equal(landed.float_source, 'exact');
  assert.equal(landed.float_fit, 'any');
  assert.equal(landed.total_cost_cents, 1000);
  assert.equal(landed.avg_normalized_float, 0.2);
  assert.equal(landed.ev_cents, 1150);
  assert.equal(landed.cost_per_attempt_cents, 2000);
  assert.equal(landed.all_outcomes.find((outcome) => outcome.is_target)!.expected_float, 0.2);

  // 0.05 is a Factory New float: the Factory New listing is what gets bought,
  // and the target comes out Factory New instead of Field-Tested.
  const missed = evaluateExactContract(catalog, 'a-out1', 'Field-Tested', false, Array(10).fill(slot(0.05)));
  assert.ok(!('error' in missed));
  assertConsistent(missed);
  assert.equal(missed.concrete_inputs[0].wear_name, 'Factory New');
  assert.equal(missed.total_cost_cents, 5000);
  assert.equal(missed.float_fit, 'miss');
  assert.equal(missed.all_outcomes.find((outcome) => outcome.is_target)!.expected_wear, 'Factory New');
});

test('exact floats: invalid contracts are rejected with a reason', () => {
  const catalog = fixtureCatalog();
  const good = { skin_id: 'a-in1', collection_id: 'col-a', market_hash_name: 'P250 | Wide (Field-Tested)', input_float: 0.2 };
  const withLast = (last: object) => [...Array(9).fill(good), { ...good, ...last }];
  const error = (inputs: unknown[]) => {
    const result = evaluateExactContract(catalog, 'a-out1', 'Field-Tested', false, inputs as never);
    assert.ok('error' in result, 'expected an error');
    return result.error;
  };

  assert.match(error(Array(9).fill(good)), /Expected 10 inputs/);
  assert.match(
    error(withLast({ skin_id: 'a-in3', market_hash_name: 'MAC-10 | Ghost (Field-Tested)' })),
    /no active Steam listing/,
  );
  assert.match(error(withLast({ skin_id: 'a-in2', market_hash_name: 'MP7 | Half (Field-Tested)', input_float: 0.7 })), /cannot have float/);
  assert.match(error(withLast({ market_hash_name: 'StatTrak™ P250 | Wide (Field-Tested)' })), /StatTrak items cannot be mixed/);
  assert.match(error(withLast({ skin_id: 'a-out2', market_hash_name: 'M4A4 | Narrow (Field-Tested)' })), /Invalid input rarity/);
  assert.match(error(withLast({ collection_id: 'col-b' })), /is not part of/);
  assert.match(error(withLast({ input_float: Number.NaN })), /valid float/);
  // A full contract of fillers cannot produce the target at all.
  const fillers = Array(10).fill({ skin_id: 'b-in1', collection_id: 'col-b', market_hash_name: 'Nova | Filler (Field-Tested)', input_float: 0.2 });
  assert.match(error(fillers), /can produce AK-47 \| Full/);
});

test('eligibility lists listed inputs only and counts the hidden ones', () => {
  const catalog = fixtureCatalog();
  const info = describeEligibility(catalog, 'a-out1');
  assert.equal(info.eligible, true);
  assert.equal(info.input_type, 'standard');
  assert.equal(info.num_inputs_required, 10);
  assert.equal(info.input_rarity_name, 'Mil-Spec Grade');
  const [alpha] = info.collections!;
  assert.deepEqual(
    alpha.input_skins.map((input) => [input.name, input.cheapest_price_cents]),
    [
      ['P250 | Wide', 60],
      ['MP7 | Half', 40],
    ],
  );
  assert.equal(alpha.unlisted_input_count, 1);
  assert.deepEqual(
    alpha.output_skins.map((output) => output.name),
    ['AK-47 | Full', 'M4A4 | Narrow'],
  );

  const knife = describeEligibility(catalog, 'k-dop-3');
  assert.equal(knife.input_type, 'gold');
  assert.equal(knife.num_inputs_required, 5);
  assert.equal(knife.collections![0].name, 'Alpha Case');
  assert.equal(knife.collections![0].output_skins.length, 4);
  assert.deepEqual(knife.collections![0].output_skins[1].alias_ids, ['k-dop-1', 'k-dop-2', 'k-dop-3']);

  assert.deepEqual(describeEligibility(catalog, 'a-con'), {
    eligible: false,
    reason: 'Consumer Grade skins cannot be obtained via tradeup',
  });
});

test('leaderboard: one entry per float range in which no outcome changes wear', () => {
  const catalog = fixtureCatalog();
  const entries = buildLeaderboard(catalog);
  for (let i = 1; i < entries.length; i++) assert.ok(entries[i - 1].ev_cents >= entries[i].ev_cents);

  // P250 | Wide (FT): both outcomes stay Field-Tested for every FT float.
  const wide = entries.filter((entry) => entry.input.market_hash_name === 'P250 | Wide (Field-Tested)');
  assert.equal(wide.length, 1);
  assert.equal(wide[0].input.any_float, true);
  assert.deepEqual(wide[0].input.required_float_range, [0.15, 0.38]);
  assert.equal(wide[0].total_cost_cents, 1000);
  assert.equal(wide[0].ev_cents, 1150);
  assert.equal(wide[0].roi_percent, 115);

  // MP7 | Half (FT) spans normalized 0.30-0.76, across which the outcomes
  // change wear four times: five separate, exact entries.
  const half = entries
    .filter((entry) => entry.input.market_hash_name === 'MP7 | Half (Field-Tested)')
    .sort((a, b) => a.input.required_float_range[0] - b.input.required_float_range[0]);
  assert.equal(half.length, 5);
  assert.ok(half.every((entry) => !entry.input.any_float));
  assert.deepEqual(half[0].input.required_float_range, [0.15, 0.19]);
  assert.equal(half[0].ev_cents, 1650);
  assert.deepEqual(
    half.map((entry) => entry.outcomes.find((outcome) => outcome.skin_name === 'AK-47 | Full')!.expected_wear),
    ['Field-Tested', 'Well-Worn', 'Battle-Scarred', 'Battle-Scarred', 'Battle-Scarred'],
  );

  // Knife contracts appear, with the vanilla knife priced and phases merged.
  const gold = entries.find((entry) => entry.contract_type === 'gold' && entry.input.skin_name === 'AWP | Red');
  assert.ok(gold);
  assert.equal(gold.num_inputs, 5);
  assert.equal(gold.collection_name, 'Alpha Case');
  assert.equal(gold.outcome_count, 4);
  assert.equal(gold.outcomes.find((outcome) => outcome.skin_name === '★ Karambit')!.expected_wear, 'Vanilla');

  // StatTrak listings are not part of the leaderboard.
  assert.ok(entries.every((entry) => !entry.input.market_hash_name.includes('StatTrak')));
});

test('leaderboard: a contract with an unlisted or unpriced outcome is excluded', () => {
  const unlisted = buildLeaderboard(fixtureCatalog((rows) => setQuote(rows, 'M4A4 | Narrow (Field-Tested)', null, 1400)));
  assert.equal(unlisted.filter((entry) => entry.input.market_hash_name === 'P250 | Wide (Field-Tested)').length, 0);

  const unpriced = buildLeaderboard(fixtureCatalog((rows) => setQuote(rows, 'M4A4 | Narrow (Field-Tested)', 1500, null)));
  assert.equal(unpriced.filter((entry) => entry.input.market_hash_name === 'P250 | Wide (Field-Tested)').length, 0);
  // Float ranges in which that outcome is another wear are unaffected.
  assert.ok(unpriced.some((entry) => entry.input.market_hash_name === 'MP7 | Half (Field-Tested)'));
});
