import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateMatchRatings,
  calculateRatingDelta,
  expectedScore,
  rankForRating,
  ratingKFactor,
} from "../lib/ranking.ts";

test("Chinese rank tiers and divisions have stable boundaries", () => {
  assert.equal(rankForRating(0).label, "黑铁 IV");
  assert.equal(rankForRating(599).label, "黑铁 I");
  assert.equal(rankForRating(600).label, "青铜 IV");
  assert.equal(rankForRating(1200).label, "白银 II");
  assert.equal(rankForRating(2999).label, "钻石 I");
  assert.equal(rankForRating(3000).label, "大师");
  assert.equal(rankForRating(3300).label, "宗师");
  assert.equal(rankForRating(3600).label, "王者");
  assert.equal(rankForRating(-100).rating, 0);
  assert.equal(rankForRating(20_000).rating, 9999);
});

test("Elo expectation is symmetric and placement games move faster", () => {
  assert.equal(expectedScore(1200, 1200), 0.5);
  assert.ok(Math.abs(expectedScore(1400, 1200) + expectedScore(1200, 1400) - 1) < 1e-12);
  assert.equal(ratingKFactor(0), 48);
  assert.equal(ratingKFactor(10), 32);
  assert.equal(ratingKFactor(30), 24);
  assert.equal(calculateRatingDelta(1200, 1200, 1, 0), 24);
  assert.equal(calculateRatingDelta(1200, 1200, 0, 0), -24);
  assert.equal(calculateRatingDelta(1200, 1200, 1, 40), 12);
  assert.equal(calculateRatingDelta(1200, 1200, 0.5, 40), 0);
});

test("match rating settlement returns both deltas and clamped ratings", () => {
  assert.deepEqual(
    calculateMatchRatings({
      ratingA: 1200,
      ratingB: 1200,
      rankedGamesA: 0,
      rankedGamesB: 0,
      scoreA: 1,
    }),
    { deltaA: 24, deltaB: -24, ratingA: 1224, ratingB: 1176 },
  );
  const upset = calculateMatchRatings({
    ratingA: 800,
    ratingB: 1600,
    rankedGamesA: 40,
    rankedGamesB: 40,
    scoreA: 1,
  });
  assert.ok(upset.deltaA > 20);
  assert.ok(upset.deltaB < -20);
});

test("rating functions reject malformed numeric inputs", () => {
  assert.throws(() => rankForRating(Number.NaN), RangeError);
  assert.throws(() => ratingKFactor(-1), RangeError);
  assert.throws(() => calculateRatingDelta(1200, 1200, 0.25 as 0, 10), RangeError);
});
