export type SettlementBinding = string | number | null;

export interface SettlementStatement {
  sql: string;
  bindings: SettlementBinding[];
}

export type SettlementEndReason =
  | "flag_captured"
  | "no_moves"
  | "resignation"
  | "timeout"
  | "draw"
  | "threefold_repetition";

export interface RankedSettlementPlan {
  matchId: string;
  playerAId: string;
  playerBId: string;
  winnerUserId: string | null;
  reason: SettlementEndReason;
  ratingA: number;
  ratingB: number;
  ratingDeltaA: number;
  ratingDeltaB: number;
  scoreA: 0 | 0.5 | 1;
  completedAt: number;
}

export interface PrivateSettlementPlan {
  matchId: string;
  playerAId: string;
  playerBId: string;
  winnerUserId: string | null;
  reason: SettlementEndReason;
  completedAt: number;
}

function rankedPlayerStatement(
  plan: RankedSettlementPlan,
  side: "a" | "b",
): SettlementStatement {
  const playerId = side === "a" ? plan.playerAId : plan.playerBId;
  const rating = side === "a" ? plan.ratingA : plan.ratingB;
  const won = side === "a" ? plan.scoreA === 1 : plan.scoreA === 0;
  const lost = side === "a" ? plan.scoreA === 0 : plan.scoreA === 1;
  const playerColumn = side === "a" ? "player_a_id" : "player_b_id";
  return {
    sql: `UPDATE platform_users
          SET rating = ?1, ranked_games = ranked_games + 1,
              wins = wins + ?2, losses = losses + ?3, draws = draws + ?4,
              updated_at = ?5
          WHERE id = ?6
            AND EXISTS (
              SELECT 1 FROM platform_matches settlement_match
              WHERE settlement_match.id = ?7
                AND settlement_match.ranked = 1
                AND settlement_match.mode = 'hex_ranked'
                AND settlement_match.status IN ('matched', 'active')
                AND settlement_match.${playerColumn} = ?6
            )`,
    bindings: [
      rating,
      won ? 1 : 0,
      lost ? 1 : 0,
      plan.scoreA === 0.5 ? 1 : 0,
      plan.completedAt,
      playerId,
      plan.matchId,
    ],
  };
}

export function buildRankedSettlementStatements(
  plan: RankedSettlementPlan,
): [SettlementStatement, SettlementStatement, SettlementStatement] {
  return [
    rankedPlayerStatement(plan, "a"),
    rankedPlayerStatement(plan, "b"),
    {
      sql: `UPDATE platform_matches
            SET status = 'completed', winner_user_id = ?1, ended_reason = ?2,
                rating_delta_a = ?3, rating_delta_b = ?4, completed_at = ?5
            WHERE id = ?6
              AND ranked = 1
              AND mode = 'hex_ranked'
              AND player_a_id = ?7
              AND player_b_id = ?8
              AND status IN ('matched', 'active')`,
      bindings: [
        plan.winnerUserId,
        plan.reason,
        plan.ratingDeltaA,
        plan.ratingDeltaB,
        plan.completedAt,
        plan.matchId,
        plan.playerAId,
        plan.playerBId,
      ],
    },
  ];
}

function privatePlayerStatement(
  plan: PrivateSettlementPlan,
  side: "a" | "b",
): SettlementStatement {
  const playerId = side === "a" ? plan.playerAId : plan.playerBId;
  const won = plan.winnerUserId === playerId;
  const lost = plan.winnerUserId !== null && !won;
  const playerColumn = side === "a" ? "player_a_id" : "player_b_id";
  return {
    sql: `UPDATE platform_users
          SET wins = wins + ?1, losses = losses + ?2, draws = draws + ?3,
              updated_at = ?4
          WHERE id = ?5
            AND EXISTS (
              SELECT 1 FROM platform_matches settlement_match
              WHERE settlement_match.id = ?6
                AND settlement_match.ranked = 0
                AND settlement_match.status = 'active'
                AND settlement_match.${playerColumn} = ?5
            )`,
    bindings: [
      won ? 1 : 0,
      lost ? 1 : 0,
      plan.winnerUserId === null ? 1 : 0,
      plan.completedAt,
      playerId,
      plan.matchId,
    ],
  };
}

export function buildPrivateSettlementStatements(
  plan: PrivateSettlementPlan,
): [SettlementStatement, SettlementStatement, SettlementStatement] {
  return [
    privatePlayerStatement(plan, "a"),
    privatePlayerStatement(plan, "b"),
    {
      sql: `UPDATE platform_matches
            SET status = 'completed', winner_user_id = ?1, ended_reason = ?2,
                rating_delta_a = 0, rating_delta_b = 0, completed_at = ?3
            WHERE id = ?4
              AND ranked = 0
              AND player_a_id = ?5
              AND player_b_id = ?6
              AND status = 'active'`,
      bindings: [
        plan.winnerUserId,
        plan.reason,
        plan.completedAt,
        plan.matchId,
        plan.playerAId,
        plan.playerBId,
      ],
    },
  ];
}
