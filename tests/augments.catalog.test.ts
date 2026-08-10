import assert from "node:assert/strict";
import test from "node:test";

import {
  AUGMENT_CATALOG,
  AUGMENT_CATALOG_VERSION,
  AUGMENT_IDS,
  AUGMENT_SUITS,
  AUGMENT_SUIT_META,
  LEGACY_AUGMENT_CATALOG_VERSION,
  LEGACY_AUGMENT_IDS,
  AugmentRuleError,
  assertValidAugmentDraftState,
  beginSecondAugmentDraft,
  chooseAndLockAugment,
  createAugmentDraftState,
  createSeededAugmentRandom,
  getAugmentDefinition,
  getAugmentsBySuit,
  isAugmentId,
  isSecondAugmentDraftDue,
  lockAugmentSelection,
  projectAugmentDraft,
  refreshAugmentOption,
  revealCurrentAugmentRound,
  selectAugment,
  validateAugmentDraftState,
  type AugmentDraftState,
  type AugmentErrorCode,
  type AugmentId,
  type AugmentSide,
  type AugmentSuit,
} from "../lib/augments.ts";

function expectAugmentError(action: () => unknown, code: AugmentErrorCode) {
  assert.throws(
    action,
    (error: unknown) => error instanceof AugmentRuleError && error.code === code,
  );
}

function lockBoth(state: AugmentDraftState): AugmentDraftState {
  const round = state.rounds.find((candidate) => candidate.number === state.activeRound);
  assert.ok(round);
  let next = chooseAndLockAugment(state, "black", round.players.black.options[0]);
  next = chooseAndLockAugment(next, "white", round.players.white.options[1]);
  return next;
}

test("the catalog has fifty stable, executable definitions in descending poker-suit tiers", () => {
  assert.equal(AUGMENT_CATALOG_VERSION, "junqi-augments-v2");
  assert.equal(LEGACY_AUGMENT_CATALOG_VERSION, "junqi-augments-v1");
  assert.equal(AUGMENT_CATALOG.length, 50);
  assert.equal(AUGMENT_IDS.length, 50);
  assert.equal(new Set(AUGMENT_IDS).size, 50);
  assert.deepEqual(
    AUGMENT_SUITS.map((suit) => AUGMENT_SUIT_META[suit].strength),
    [4, 3, 2, 1],
  );

  const expectedSuitSizes: Record<AugmentSuit, number> = {
    spades: 13,
    hearts: 13,
    clubs: 12,
    diamonds: 12,
  };
  for (const suit of AUGMENT_SUITS) {
    const definitions = getAugmentsBySuit(suit);
    assert.equal(definitions.length, expectedSuitSizes[suit], suit);
    assert.ok(definitions.every((definition) => definition.suit === suit));
    assert.ok(definitions.every((definition) => definition.suitSymbol === AUGMENT_SUIT_META[suit].symbol));
  }

  assert.deepEqual(
    AUGMENT_CATALOG.map(({ id, effect }) => `${id}:${effect.kind}:${effect.mode}`),
    [
      "spade-grand-maneuver:movement:engineer_rail",
      "spade-relentless-assault:extra_turn:after_capture",
      "spade-tactical-retreat:combat:attacker_retreat",
      "spade-total-intelligence:reconnaissance:choose_enemy",
      "spade-strategic-reserve:clock:low_time_rescue",
      "spade-rail-dominion:movement:engineer_rail",
      "spade-serpentine-offensive:movement:rail_turn",
      "spade-deep-strike:movement:road_dash",
      "spade-global-redeployment:movement:camp_transfer",
      "spade-command-chain:extra_turn:after_quiet_move",
      "spade-counteroffensive:extra_turn:after_capture",
      "spade-shadow-retreat:combat:attacker_retreat",
      "spade-supreme-recon:reconnaissance:choose_enemy",
      "heart-rail-turn:movement:rail_turn",
      "heart-initiative:extra_turn:after_quiet_move",
      "heart-remote-exchange:exchange:same_rank",
      "heart-bomb-disposal:combat:engineer_defuses_bomb",
      "heart-targeted-recon:reconnaissance:choose_enemy",
      "heart-mobile-rail:movement:engineer_rail",
      "heart-double-turn:movement:rail_turn",
      "heart-breakthrough:movement:road_dash",
      "heart-camp-network:movement:camp_transfer",
      "heart-victory-momentum:extra_turn:after_capture",
      "heart-orderly-withdrawal:combat:attacker_retreat",
      "heart-wide-recon:reconnaissance:frontline_random",
      "heart-reserve-clock:clock:low_time_rescue",
      "club-forced-march:movement:road_dash",
      "club-line-hop:movement:rail_jump",
      "club-field-exchange:exchange:adjacent_mobile",
      "club-steady-tempo:clock:move_increment",
      "club-frontline-scout:reconnaissance:frontline_random",
      "club-rail-passage:movement:engineer_rail",
      "club-rail-switch:movement:rail_turn",
      "club-road-patrol:movement:road_dash",
      "club-camp-relay:movement:camp_transfer",
      "club-local-recon:reconnaissance:frontline_random",
      "club-pocket-time:clock:flat_bonus",
      "club-engineer-oath:combat:engineer_last_stand",
      "diamond-camp-transfer:movement:camp_transfer",
      "diamond-forward-bomb:setup:forward_bomb",
      "diamond-deep-mine:setup:deep_mine",
      "diamond-engineer-screen:combat:engineer_last_stand",
      "diamond-time-cache:clock:flat_bonus",
      "diamond-road-step:movement:road_dash",
      "diamond-camp-relay:movement:camp_transfer",
      "diamond-front-watch:reconnaissance:frontline_random",
      "diamond-pocket-watch:clock:flat_bonus",
      "diamond-drill:clock:move_increment",
      "diamond-forward-pair:setup:forward_bomb",
      "diamond-deep-pair:setup:deep_mine",
    ],
  );

  for (const definition of AUGMENT_CATALOG) {
    assert.equal(isAugmentId(definition.id), true);
    assert.equal(getAugmentDefinition(definition.id).id, definition.id);
    assert.ok(definition.name.length > 0);
    assert.ok(definition.description.length > 0);
    assert.ok(definition.timing.length > 0);
    assert.ok(Number.isInteger(definition.charges) && definition.charges > 0);
  }
  assert.equal(isAugmentId("spade-not-a-real-card"), false);
});

test("no two cards are canonical activation, charge, and effect duplicates", () => {
  const signatures = new Map<string, AugmentId>();
  for (const definition of AUGMENT_CATALOG) {
    const signature = JSON.stringify({
      activation: definition.activation,
      charges: definition.charges,
      effect: definition.effect,
    });
    const duplicate = signatures.get(signature);
    assert.equal(duplicate, undefined, `${definition.id} duplicates ${duplicate}`);
    signatures.set(signature, definition.id);
  }
  assert.equal(signatures.size, 50);
});

test("seeded drafts are reproducible and give both players independent offers of one suit", () => {
  const first = createAugmentDraftState({
    random: createSeededAugmentRandom("same-match"),
    initialSuit: "hearts",
  });
  const repeated = createAugmentDraftState({
    random: createSeededAugmentRandom("same-match"),
    initialSuit: "hearts",
  });
  assert.deepEqual(first, repeated);
  assert.equal(first.activeRound, 1);
  assert.equal(first.rounds[0].trigger, "setup");
  assert.equal(first.rounds[0].suit, "hearts");

  for (const side of ["black", "white"] as const) {
    const options = first.rounds[0].players[side].options;
    assert.equal(options.length, 3);
    assert.equal(new Set(options).size, 3);
    assert.ok(options.every((id) => getAugmentDefinition(id).suit === "hearts"));
    assert.deepEqual(first.seenBySide[side], options);
  }
  assert.notDeepEqual(
    first.rounds[0].players.black.options,
    first.rounds[0].players.white.options,
    "offers are generated independently rather than copied between players",
  );

  expectAugmentError(
    () => createAugmentDraftState({ random: () => 1, initialSuit: "spades" }),
    "INVALID_RANDOM_SOURCE",
  );
  expectAugmentError(
    () => createAugmentDraftState({ random: () => Number.NaN, initialSuit: "spades" }),
    "INVALID_RANDOM_SOURCE",
  );
});

test("a player may refresh exactly one slot and every encountered card stays out of the pool", () => {
  const original = createAugmentDraftState({
    random: createSeededAugmentRandom(7),
    initialSuit: "clubs",
  });
  const oldOptions = [...original.rounds[0].players.black.options];
  const selected = selectAugment(original, "black", oldOptions[1]);
  const refreshed = refreshAugmentOption(selected, "black", 1, () => 0);
  const replacement = refreshed.rounds[0].players.black.options[1];

  assert.deepEqual(original.rounds[0].players.black.options, oldOptions, "transitions are immutable");
  assert.equal(original.seenBySide.black.length, 3);
  assert.notEqual(replacement, oldOptions[1]);
  assert.equal(oldOptions.includes(replacement), false);
  assert.equal(refreshed.rounds[0].players.black.selectedId, null);
  assert.equal(refreshed.rounds[0].players.black.refreshedSlot, 1);
  assert.equal(refreshed.seenBySide.black.length, 4);
  assert.ok(oldOptions.every((id) => refreshed.seenBySide.black.includes(id)));
  assert.ok(refreshed.seenBySide.black.includes(replacement));
  assert.deepEqual(refreshed.seenBySide.white, original.seenBySide.white);

  expectAugmentError(
    () => refreshAugmentOption(refreshed, "black", 0, () => 0),
    "REFRESH_ALREADY_USED",
  );
  expectAugmentError(
    () => refreshAugmentOption(original, "black", 3 as never, () => 0),
    "INVALID_SLOT",
  );

  const locked = chooseAndLockAugment(original, "white", original.rounds[0].players.white.options[0]);
  expectAugmentError(
    () => refreshAugmentOption(locked, "white", 0, () => 0),
    "SELECTION_LOCKED",
  );
});

test("selection stays private until an explicit simultaneous reveal", () => {
  const initial = createAugmentDraftState({
    random: createSeededAugmentRandom("projection"),
    initialSuit: "diamonds",
  });
  const blackChoice = initial.rounds[0].players.black.options[0];
  const whiteChoice = initial.rounds[0].players.white.options[2];
  let state = chooseAndLockAugment(initial, "black", blackChoice);

  const blackView = projectAugmentDraft(state, "black");
  const whiteView = projectAugmentDraft(state, "white");
  const spectatorView = projectAugmentDraft(state, "spectator");
  assert.deepEqual(blackView.rounds[0].players.black.options, initial.rounds[0].players.black.options);
  assert.equal(blackView.rounds[0].players.black.selectedId, blackChoice);
  assert.deepEqual(blackView.loadouts.black, [blackChoice]);
  assert.equal(whiteView.rounds[0].players.black.options, null);
  assert.equal(whiteView.rounds[0].players.black.selectedId, null);
  assert.equal(whiteView.rounds[0].players.black.locked, true);
  assert.deepEqual(whiteView.loadouts.black, []);
  assert.equal(spectatorView.rounds[0].players.black.options, null);
  assert.equal(spectatorView.rounds[0].players.black.selectedId, null);
  assert.equal(spectatorView.seenIds, null);

  expectAugmentError(() => revealCurrentAugmentRound(state), "BOTH_PLAYERS_NOT_LOCKED");
  expectAugmentError(
    () => selectAugment(state, "black", state.rounds[0].players.black.options[1]),
    "SELECTION_LOCKED",
  );

  state = chooseAndLockAugment(state, "white", whiteChoice);
  const waitingView = projectAugmentDraft(state, "spectator");
  assert.equal(waitingView.rounds[0].players.black.selectedId, null);
  assert.equal(waitingView.rounds[0].players.white.selectedId, null);
  state = revealCurrentAugmentRound(state);

  const revealed = projectAugmentDraft(state, "spectator");
  assert.equal(state.activeRound, null);
  assert.equal(revealed.rounds[0].revealed, true);
  assert.equal(revealed.rounds[0].players.black.selectedId, blackChoice);
  assert.equal(revealed.rounds[0].players.white.selectedId, whiteChoice);
  assert.deepEqual(revealed.loadouts, { black: [blackChoice], white: [whiteChoice] });
});

test("the move-10 draft uses a new shared suit and resets each player's refresh", () => {
  let state = createAugmentDraftState({
    random: createSeededAugmentRandom("round-one"),
    initialSuit: "spades",
  });
  state = revealCurrentAugmentRound(lockBoth(state));
  assert.equal(isSecondAugmentDraftDue(state, 8), false);
  assert.equal(isSecondAugmentDraftDue(state, 9), true);
  assert.equal(isSecondAugmentDraftDue(state, 10), true);
  assert.equal(isSecondAugmentDraftDue(state, 100), true);
  expectAugmentError(
    () => beginSecondAugmentDraft(state, { suit: "spades" }),
    "SAME_SUIT_AS_FIRST_ROUND",
  );
  const diamondSecond = beginSecondAugmentDraft(state, {
    random: createSeededAugmentRandom("diamond-round-two"),
    suit: "diamonds",
  });
  assert.ok(
    diamondSecond.rounds[1].players.black.options.every(
      (id) => getAugmentDefinition(id).activation !== "setup",
    ),
  );

  const second = beginSecondAugmentDraft(state, {
    random: createSeededAugmentRandom("round-two"),
    suit: "hearts",
  });
  assert.equal(second.activeRound, 2);
  assert.equal(second.rounds[1].trigger, "move_10");
  assert.equal(second.rounds[1].suit, "hearts");
  assert.notEqual(second.rounds[0].suit, second.rounds[1].suit);
  assert.equal(isSecondAugmentDraftDue(second, 10), false);

  for (const side of ["black", "white"] as const) {
    const firstSeen = new Set(state.seenBySide[side]);
    const secondOptions = second.rounds[1].players[side].options;
    assert.ok(secondOptions.every((id) => !firstSeen.has(id)));
    assert.ok(secondOptions.every((id) => getAugmentDefinition(id).suit === "hearts"));
    assert.equal(second.rounds[1].players[side].refreshedSlot, null);
  }

  const refreshed = refreshAugmentOption(second, "black", 2, () => 0);
  assert.equal(refreshed.rounds[1].players.black.refreshedSlot, 2);
  assert.equal(refreshed.seenBySide.black.length, state.seenBySide.black.length + 4);
  expectAugmentError(
    () => beginSecondAugmentDraft(second, { suit: "clubs" }),
    "ROUND_ALREADY_STARTED",
  );
});

test("invalid selections and malformed persisted states fail closed", () => {
  const state = createAugmentDraftState({
    random: createSeededAugmentRandom("validation"),
    initialSuit: "hearts",
  });
  const notOffered = getAugmentsBySuit("hearts")
    .map((definition) => definition.id)
    .find((id) => !state.rounds[0].players.black.options.includes(id));
  assert.ok(notOffered);
  expectAugmentError(() => selectAugment(state, "black", notOffered), "AUGMENT_NOT_OFFERED");
  expectAugmentError(() => lockAugmentSelection(state, "black"), "SELECTION_REQUIRED");

  const duplicateOffer = structuredClone(state);
  duplicateOffer.rounds[0].players.black.options[1] =
    duplicateOffer.rounds[0].players.black.options[0];
  assert.equal(validateAugmentDraftState(duplicateOffer), false);
  expectAugmentError(() => assertValidAugmentDraftState(duplicateOffer), "INVALID_STATE");

  const wrongSuit = structuredClone(state);
  wrongSuit.rounds[0].players.white.options[0] = "spade-grand-maneuver";
  wrongSuit.seenBySide.white[0] = "spade-grand-maneuver";
  assert.equal(validateAugmentDraftState(wrongSuit), false);

  const prematurelyPublic = structuredClone(state);
  prematurelyPublic.rounds[0].revealed = true;
  prematurelyPublic.activeRound = null;
  assert.equal(validateAugmentDraftState(prematurelyPublic), false);
});

test("a full two-round draft yields two visible cards per player without repeats", () => {
  let state = createAugmentDraftState({
    random: createSeededAugmentRandom("full-match"),
    initialSuit: "clubs",
  });
  state = refreshAugmentOption(state, "black", 0, createSeededAugmentRandom("black-reroll-1"));
  state = refreshAugmentOption(state, "white", 2, createSeededAugmentRandom("white-reroll-1"));
  state = revealCurrentAugmentRound(lockBoth(state));
  state = beginSecondAugmentDraft(state, {
    random: createSeededAugmentRandom("second-offer"),
    suit: "hearts",
  });
  state = refreshAugmentOption(state, "black", 1, createSeededAugmentRandom("black-reroll-2"));
  state = refreshAugmentOption(state, "white", 0, createSeededAugmentRandom("white-reroll-2"));
  state = revealCurrentAugmentRound(lockBoth(state));

  assert.equal(state.rounds.length, 2);
  assert.equal(state.activeRound, null);
  for (const side of ["black", "white"] as AugmentSide[]) {
    assert.equal(state.loadouts[side].length, 2);
    assert.equal(new Set(state.loadouts[side]).size, 2);
    assert.equal(new Set(state.seenBySide[side]).size, state.seenBySide[side].length);
    assert.equal(state.seenBySide[side].length, 8);
  }
  assertValidAugmentDraftState(state);
  assert.deepEqual(
    projectAugmentDraft(state, "spectator").loadouts,
    state.loadouts,
  );
});

test("random suit selection never repeats the first-round tier or offers setup cards", () => {
  for (const firstSuit of AUGMENT_SUITS as readonly AugmentSuit[]) {
    for (let seed = 0; seed < 20; seed += 1) {
      let state = createAugmentDraftState({
        random: createSeededAugmentRandom(seed),
        initialSuit: firstSuit,
      });
      state = revealCurrentAugmentRound(lockBoth(state));
      state = beginSecondAugmentDraft(state, { random: createSeededAugmentRandom(seed) });
      assert.notEqual(state.rounds[1].suit, firstSuit);
      for (const side of ["black", "white"] as const) {
        assert.ok(
          state.rounds[1].players[side].options.every(
            (id) => getAugmentDefinition(id).activation !== "setup",
          ),
        );
      }
    }
  }
});

test("persisted v1 rooms retain the old twenty-card pool and projection semantics", () => {
  const persisted = JSON.stringify({
    catalogVersion: LEGACY_AUGMENT_CATALOG_VERSION,
    activeRound: null,
    rounds: [
      {
        number: 1,
        trigger: "setup",
        suit: "spades",
        revealed: true,
        players: {
          black: {
            options: [
              "spade-grand-maneuver",
              "spade-relentless-assault",
              "spade-tactical-retreat",
            ],
            selectedId: "spade-grand-maneuver",
            locked: true,
            refreshedSlot: null,
          },
          white: {
            options: [
              "spade-total-intelligence",
              "spade-strategic-reserve",
              "spade-tactical-retreat",
            ],
            selectedId: "spade-strategic-reserve",
            locked: true,
            refreshedSlot: null,
          },
        },
      },
    ],
    seenBySide: {
      black: [
        "spade-grand-maneuver",
        "spade-relentless-assault",
        "spade-tactical-retreat",
      ],
      white: [
        "spade-total-intelligence",
        "spade-strategic-reserve",
        "spade-tactical-retreat",
      ],
    },
    loadouts: {
      black: ["spade-grand-maneuver"],
      white: ["spade-strategic-reserve"],
    },
  });
  const restored = JSON.parse(persisted) as AugmentDraftState;
  assertValidAugmentDraftState(restored);
  assert.equal(projectAugmentDraft(restored, "spectator").catalogVersion, "junqi-augments-v1");

  const second = beginSecondAugmentDraft(restored, {
    random: createSeededAugmentRandom("legacy-room-resume"),
    suit: "hearts",
  });
  const legacyIds = new Set<AugmentId>(LEGACY_AUGMENT_IDS);
  for (const side of ["black", "white"] as const) {
    assert.ok(second.rounds[1].players[side].options.every((id) => legacyIds.has(id)));
  }
  const refreshed = refreshAugmentOption(second, "black", 0, () => 0);
  assert.ok(legacyIds.has(refreshed.rounds[1].players.black.options[0]));
  expectAugmentError(
    () => beginSecondAugmentDraft(restored, { suit: "diamonds" }),
    "SUIT_NOT_AVAILABLE_FOR_ROUND",
  );

  const contaminated = structuredClone(restored);
  contaminated.seenBySide.black[0] = "spade-rail-dominion";
  contaminated.rounds[0].players.black.options[0] = "spade-rail-dominion";
  contaminated.rounds[0].players.black.selectedId = "spade-rail-dominion";
  contaminated.loadouts.black[0] = "spade-rail-dominion";
  assert.equal(validateAugmentDraftState(contaminated), false);
});

test("stable ids cover the catalog exactly", () => {
  const idsFromCatalog = AUGMENT_CATALOG.map((definition) => definition.id).sort();
  const declaredIds = [...AUGMENT_IDS].sort();
  assert.deepEqual(idsFromCatalog, declaredIds);
  assert.equal(new Set(idsFromCatalog).size, idsFromCatalog.length);

  const allIds = new Set<AugmentId>();
  for (const definition of AUGMENT_CATALOG) allIds.add(definition.id);
  assert.equal(allIds.size, 50);
});
