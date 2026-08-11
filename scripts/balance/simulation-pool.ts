import {
  AUGMENT_CATALOG,
  AUGMENT_CATALOG_VERSION,
  AUGMENT_IDS,
  AUGMENT_SUITS,
  type AugmentDefinition,
  type AugmentId,
  type AugmentSuit,
} from "../../lib/augments.ts";

/**
 * One authoritative pool for every automated match simulation.
 *
 * Clock cards remain part of the shipped v3 catalog and retain their focused
 * product tests. They are deliberately absent from bot matches until player
 * timing data is available, so they must never contribute to a simulation
 * coverage denominator.
 */
export const SIMULATION_CATALOG_VERSION = AUGMENT_CATALOG_VERSION;
export const SIMULATION_CATALOG_SIZE = AUGMENT_CATALOG.length;

export const EXCLUDED_CLOCK_AUGMENT_IDS = Object.freeze(
  AUGMENT_CATALOG
    .filter((definition) => definition.effect.kind === "clock")
    .map((definition) => definition.id)
    .sort(),
) as readonly AugmentId[];

export const SIMULATION_ELIGIBLE_AUGMENTS = Object.freeze(
  AUGMENT_CATALOG.filter((definition) => definition.effect.kind !== "clock"),
) as readonly AugmentDefinition[];

export const SIMULATION_ELIGIBLE_AUGMENT_IDS = Object.freeze(
  SIMULATION_ELIGIBLE_AUGMENTS.map((definition) => definition.id),
) as readonly AugmentId[];

export const SIMULATION_ELIGIBLE_COUNT = SIMULATION_ELIGIBLE_AUGMENT_IDS.length;

const SIMULATION_ELIGIBLE_ID_SET = new Set<AugmentId>(
  SIMULATION_ELIGIBLE_AUGMENT_IDS,
);

export function isSimulationEligibleAugment(id: AugmentId) {
  return SIMULATION_ELIGIBLE_ID_SET.has(id);
}

export function simulationAugmentsBySuit(suit: AugmentSuit) {
  return SIMULATION_ELIGIBLE_AUGMENTS.filter(
    (definition) => definition.suit === suit,
  );
}

export function simulationIdsBySuit() {
  return Object.fromEntries(
    AUGMENT_SUITS.map((suit) => [
      suit,
      simulationAugmentsBySuit(suit).map((definition) => definition.id),
    ]),
  ) as Record<AugmentSuit, AugmentId[]>;
}

export function assertSimulationPoolReady() {
  if (SIMULATION_CATALOG_VERSION !== "junqi-augments-v3") {
    throw new Error(
      `Simulation requires the v3 catalog, received ${SIMULATION_CATALOG_VERSION}.`,
    );
  }
  if (new Set(AUGMENT_IDS).size !== AUGMENT_CATALOG.length) {
    throw new Error("Simulation catalog IDs are not one-to-one with definitions.");
  }
  if (
    SIMULATION_ELIGIBLE_COUNT + EXCLUDED_CLOCK_AUGMENT_IDS.length !==
    SIMULATION_CATALOG_SIZE
  ) {
    throw new Error("Simulation eligible and excluded pools do not partition the catalog.");
  }
  if (
    SIMULATION_ELIGIBLE_AUGMENTS.some(
      (definition) => definition.effect.kind === "clock",
    )
  ) {
    throw new Error("A clock augment entered the simulation-eligible pool.");
  }
  for (const suit of AUGMENT_SUITS) {
    if (simulationAugmentsBySuit(suit).length < 3) {
      throw new Error(`${suit} has fewer than three simulation-eligible augments.`);
    }
  }
}
