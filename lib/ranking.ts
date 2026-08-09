export const DEFAULT_RATING = 1200;
export const MIN_RATING = 0;
export const MAX_RATING = 9999;

export type RankTier =
  | "黑铁"
  | "青铜"
  | "白银"
  | "黄金"
  | "铂金"
  | "翡翠"
  | "钻石"
  | "大师"
  | "宗师"
  | "王者";

export interface RankSnapshot {
  tier: RankTier;
  division: "IV" | "III" | "II" | "I" | null;
  label: string;
  rating: number;
  floor: number;
  nextFloor: number | null;
  progress: number;
}

interface TierDefinition {
  tier: RankTier;
  floor: number;
  ceiling: number | null;
  divided: boolean;
}

const TIERS: readonly TierDefinition[] = [
  { tier: "黑铁", floor: 0, ceiling: 600, divided: true },
  { tier: "青铜", floor: 600, ceiling: 1000, divided: true },
  { tier: "白银", floor: 1000, ceiling: 1400, divided: true },
  { tier: "黄金", floor: 1400, ceiling: 1800, divided: true },
  { tier: "铂金", floor: 1800, ceiling: 2200, divided: true },
  { tier: "翡翠", floor: 2200, ceiling: 2600, divided: true },
  { tier: "钻石", floor: 2600, ceiling: 3000, divided: true },
  { tier: "大师", floor: 3000, ceiling: 3300, divided: false },
  { tier: "宗师", floor: 3300, ceiling: 3600, divided: false },
  { tier: "王者", floor: 3600, ceiling: null, divided: false },
] as const;

const DIVISIONS = ["IV", "III", "II", "I"] as const;

function requireFiniteNumber(value: number, name: string) {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

export function clampRating(rating: number) {
  requireFiniteNumber(rating, "rating");
  return Math.min(MAX_RATING, Math.max(MIN_RATING, Math.round(rating)));
}

export function rankForRating(input: number): RankSnapshot {
  const rating = clampRating(input);
  const definition =
    [...TIERS].reverse().find((candidate) => rating >= candidate.floor) ?? TIERS[0];
  const tierSpan = definition.ceiling === null ? null : definition.ceiling - definition.floor;
  let division: RankSnapshot["division"] = null;

  if (definition.divided && tierSpan !== null) {
    const divisionSpan = tierSpan / DIVISIONS.length;
    const divisionIndex = Math.min(
      DIVISIONS.length - 1,
      Math.floor((rating - definition.floor) / divisionSpan),
    );
    division = DIVISIONS[divisionIndex];
  }

  const progress =
    tierSpan === null
      ? 1
      : Math.min(1, Math.max(0, (rating - definition.floor) / tierSpan));

  return {
    tier: definition.tier,
    division,
    label: division ? `${definition.tier} ${division}` : definition.tier,
    rating,
    floor: definition.floor,
    nextFloor: definition.ceiling,
    progress,
  };
}

export function expectedScore(rating: number, opponentRating: number) {
  const own = clampRating(rating);
  const opponent = clampRating(opponentRating);
  return 1 / (1 + 10 ** ((opponent - own) / 400));
}

export function ratingKFactor(rankedGames: number) {
  if (!Number.isSafeInteger(rankedGames) || rankedGames < 0) {
    throw new RangeError("rankedGames must be a non-negative safe integer");
  }
  if (rankedGames < 10) return 48;
  if (rankedGames < 30) return 32;
  return 24;
}

export function calculateRatingDelta(
  rating: number,
  opponentRating: number,
  score: 0 | 0.5 | 1,
  rankedGames: number,
) {
  if (score !== 0 && score !== 0.5 && score !== 1) {
    throw new RangeError("score must be 0, 0.5, or 1");
  }
  const raw = ratingKFactor(rankedGames) * (score - expectedScore(rating, opponentRating));
  const rounded = Math.round(raw);
  if (score === 1) return Math.max(1, rounded);
  if (score === 0) return Math.min(-1, rounded);
  return rounded;
}

export function calculateMatchRatings(input: {
  ratingA: number;
  ratingB: number;
  rankedGamesA: number;
  rankedGamesB: number;
  scoreA: 0 | 0.5 | 1;
}) {
  const scoreB = (1 - input.scoreA) as 0 | 0.5 | 1;
  const deltaA = calculateRatingDelta(
    input.ratingA,
    input.ratingB,
    input.scoreA,
    input.rankedGamesA,
  );
  const deltaB = calculateRatingDelta(
    input.ratingB,
    input.ratingA,
    scoreB,
    input.rankedGamesB,
  );
  return {
    deltaA,
    deltaB,
    ratingA: clampRating(input.ratingA + deltaA),
    ratingB: clampRating(input.ratingB + deltaB),
  };
}
