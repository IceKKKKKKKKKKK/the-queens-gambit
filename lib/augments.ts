export const LEGACY_AUGMENT_CATALOG_VERSION = "junqi-augments-v1" as const;
export const AUGMENT_CATALOG_VERSION = "junqi-augments-v2" as const;
export type AugmentCatalogVersion =
  | typeof LEGACY_AUGMENT_CATALOG_VERSION
  | typeof AUGMENT_CATALOG_VERSION;
export const SECOND_AUGMENT_MOVE_NUMBER = 10 as const;

export const AUGMENT_SUITS = ["spades", "hearts", "clubs", "diamonds"] as const;
export const AUGMENT_SIDES = ["black", "white"] as const;

export type AugmentSuit = (typeof AUGMENT_SUITS)[number];
export type AugmentSide = (typeof AUGMENT_SIDES)[number];
export type AugmentSlot = 0 | 1 | 2;
export type AugmentDraftRoundNumber = 1 | 2;
export type AugmentViewer = AugmentSide | "spectator";

export interface AugmentSuitMetadata {
  label: string;
  symbol: "♠" | "♥" | "♣" | "♦";
  strength: 4 | 3 | 2 | 1;
  color: "black" | "red";
}

export const AUGMENT_SUIT_META: Readonly<Record<AugmentSuit, AugmentSuitMetadata>> = {
  spades: { label: "黑桃", symbol: "♠", strength: 4, color: "black" },
  hearts: { label: "红桃", symbol: "♥", strength: 3, color: "red" },
  clubs: { label: "梅花", symbol: "♣", strength: 2, color: "black" },
  diamonds: { label: "方块", symbol: "♦", strength: 1, color: "red" },
};

export type MovementAugmentEffect =
  | {
      kind: "movement";
      mode: "engineer_rail";
      eligible: "any_mobile_piece" | "junior_mobile_piece";
      destination: "empty" | "empty_or_enemy";
      consumesTurn: true;
    }
  | {
      kind: "movement";
      mode: "rail_turn";
      eligible: "non_engineer_mobile_piece" | "junior_mobile_piece";
      maxTurns: 1 | 2;
      destination: "empty" | "empty_or_enemy";
      consumesTurn: true;
    }
  | {
      kind: "movement";
      mode: "road_dash";
      eligible: "any_mobile_piece" | "junior_mobile_piece";
      exactEdges: 2 | 3;
      intermediate: "empty";
      destination: "empty" | "empty_or_enemy";
      consumesTurn: true;
    }
  | {
      kind: "movement";
      mode: "rail_jump";
      eligible: "any_mobile_piece";
      jumpedPieces: 1;
      jumpedSide: "friendly";
      route: "straight_rail";
      destination: "empty";
      consumesTurn: true;
    }
  | {
      kind: "movement";
      mode: "camp_transfer";
      eligible: "mobile_piece_in_camp" | "junior_piece_in_camp";
      destination: "empty_friendly_half_camp" | "empty_any_camp";
      consumesTurn: true;
    };

export type ExtraTurnAugmentEffect = {
  kind: "extra_turn";
  mode: "after_capture" | "after_quiet_move";
  maxExtraMoves: 1;
  requireDifferentPiece: boolean;
  normalMovesOnly: true;
  canChain: false;
};

export type CombatAugmentEffect =
  | {
      kind: "combat";
      mode: "attacker_retreat";
      trigger: "attacker_would_lose_while_defender_survives";
      attackerOutcome: "return_to_origin";
      defenderOutcome: "unchanged";
      eligible?: "any_attacker" | "junior_attacker";
    }
  | {
      kind: "combat";
      mode: "engineer_defuses_bomb";
      trigger: "engineer_attacks_bomb";
      attackerOutcome: "survives_on_target";
      defenderOutcome: "removed";
    }
  | {
      kind: "combat";
      mode: "engineer_last_stand";
      trigger: "engineer_would_lose_non_mine_combat";
      attackerOutcome: "removed";
      defenderOutcome: "removed";
    };

export type ReconnaissanceAugmentEffect =
  | {
      kind: "reconnaissance";
      mode: "choose_enemy";
      count: 1 | 2 | 3;
      reveal: "permanent";
      trigger: "after_round_reveal";
    }
  | {
      kind: "reconnaissance";
      mode: "frontline_random";
      count: 1 | 2;
      rowsFromFront: 1 | 2 | 3;
      selection: "server_random";
      reveal: "until_piece_moves";
      trigger: "after_round_reveal";
    };

export type ClockAugmentEffect =
  | {
      kind: "clock";
      mode: "low_time_rescue";
      trigger: "start_of_turn_below_threshold";
      thresholdMs: number;
      bonusMs: number;
    }
  | {
      kind: "clock";
      mode: "move_increment";
      trigger: "after_completed_own_move";
      bonusMs: number;
      maxTriggers: number;
    }
  | {
      kind: "clock";
      mode: "flat_bonus";
      trigger: "after_round_reveal";
      bonusMs: number;
    };

export type ExchangeAugmentEffect =
  | {
      kind: "exchange";
      mode: "same_rank";
      eligible: "two_mobile_friendly_pieces";
      consumesTurn: true;
    }
  | {
      kind: "exchange";
      mode: "adjacent_mobile";
      eligible: "two_adjacent_mobile_friendly_pieces";
      adjacency: "road_edge";
      consumesTurn: true;
    };

export type SetupAugmentEffect =
  | {
      kind: "setup";
      mode: "forward_bomb";
      allowance: 1 | 2;
      destination: "front_setup_row";
    }
  | {
      kind: "setup";
      mode: "deep_mine";
      allowance: 1 | 2;
      destination: "third_row_from_home";
    };

export type AugmentEffect =
  | MovementAugmentEffect
  | ExtraTurnAugmentEffect
  | CombatAugmentEffect
  | ReconnaissanceAugmentEffect
  | ClockAugmentEffect
  | ExchangeAugmentEffect
  | SetupAugmentEffect;

export type AugmentActivation = "active" | "automatic" | "setup";

export const AUGMENT_IDS = [
  "spade-grand-maneuver",
  "spade-relentless-assault",
  "spade-tactical-retreat",
  "spade-total-intelligence",
  "spade-strategic-reserve",
  "spade-rail-dominion",
  "spade-serpentine-offensive",
  "spade-deep-strike",
  "spade-global-redeployment",
  "spade-command-chain",
  "spade-counteroffensive",
  "spade-shadow-retreat",
  "spade-supreme-recon",
  "heart-rail-turn",
  "heart-initiative",
  "heart-remote-exchange",
  "heart-bomb-disposal",
  "heart-targeted-recon",
  "heart-mobile-rail",
  "heart-double-turn",
  "heart-breakthrough",
  "heart-camp-network",
  "heart-victory-momentum",
  "heart-orderly-withdrawal",
  "heart-wide-recon",
  "heart-reserve-clock",
  "club-forced-march",
  "club-line-hop",
  "club-field-exchange",
  "club-steady-tempo",
  "club-frontline-scout",
  "club-rail-passage",
  "club-rail-switch",
  "club-road-patrol",
  "club-camp-relay",
  "club-local-recon",
  "club-pocket-time",
  "club-engineer-oath",
  "diamond-camp-transfer",
  "diamond-forward-bomb",
  "diamond-deep-mine",
  "diamond-engineer-screen",
  "diamond-time-cache",
  "diamond-road-step",
  "diamond-camp-relay",
  "diamond-front-watch",
  "diamond-pocket-watch",
  "diamond-drill",
  "diamond-forward-pair",
  "diamond-deep-pair",
] as const;

export type AugmentId = (typeof AUGMENT_IDS)[number];

export interface AugmentDefinition {
  id: AugmentId;
  name: string;
  shortName: string;
  suit: AugmentSuit;
  suitSymbol: AugmentSuitMetadata["symbol"];
  description: string;
  timing: string;
  activation: AugmentActivation;
  charges: number;
  effect: AugmentEffect;
}

export const AUGMENT_CATALOG = [
  {
    id: "spade-grand-maneuver",
    name: "大迂回",
    shortName: "大迂回",
    suit: "spades",
    suitSymbol: "♠",
    description: "一次：令任意可移动棋子按工兵铁路规则移动，并可攻击终点敌子。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 1,
    effect: {
      kind: "movement",
      mode: "engineer_rail",
      eligible: "any_mobile_piece",
      destination: "empty_or_enemy",
      consumesTurn: true,
    },
  },
  {
    id: "spade-relentless-assault",
    name: "乘胜追击",
    shortName: "乘胜追击",
    suit: "spades",
    suitSymbol: "♠",
    description: "一次：完成一次吃子后，用另一枚棋子追加一次普通行动。",
    timing: "你的吃子结算后",
    activation: "automatic",
    charges: 1,
    effect: {
      kind: "extra_turn",
      mode: "after_capture",
      maxExtraMoves: 1,
      requireDifferentPiece: true,
      normalMovesOnly: true,
      canChain: false,
    },
  },
  {
    id: "spade-tactical-retreat",
    name: "金蝉脱壳",
    shortName: "金蝉脱壳",
    suit: "spades",
    suitSymbol: "♠",
    description: "一次：进攻方本应落败且守方存活时，进攻方退回起点，守方留在原位。",
    timing: "你的进攻战斗结算时",
    activation: "automatic",
    charges: 1,
    effect: {
      kind: "combat",
      mode: "attacker_retreat",
      trigger: "attacker_would_lose_while_defender_survives",
      attackerOutcome: "return_to_origin",
      defenderOutcome: "unchanged",
    },
  },
  {
    id: "spade-total-intelligence",
    name: "洞若观火",
    shortName: "洞若观火",
    suit: "spades",
    suitSymbol: "♠",
    description: "本轮强化公开后，选择两枚敌子，永久获知其身份。",
    timing: "本轮强化公开后",
    activation: "active",
    charges: 1,
    effect: {
      kind: "reconnaissance",
      mode: "choose_enemy",
      count: 2,
      reveal: "permanent",
      trigger: "after_round_reveal",
    },
  },
  {
    id: "spade-strategic-reserve",
    name: "战略储备",
    shortName: "战略储备",
    suit: "spades",
    suitSymbol: "♠",
    description: "一次：你的回合开始且剩余不足60秒时，立即增加120秒。",
    timing: "低时间回合开始时",
    activation: "automatic",
    charges: 1,
    effect: {
      kind: "clock",
      mode: "low_time_rescue",
      trigger: "start_of_turn_below_threshold",
      thresholdMs: 60_000,
      bonusMs: 120_000,
    },
  },
  {
    id: "spade-rail-dominion",
    name: "铁路统御",
    shortName: "铁路统御",
    suit: "spades",
    suitSymbol: "♠",
    description: "三次：令任意可移动棋子按工兵铁路规则移动，并可攻击终点敌子。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 3,
    effect: {
      kind: "movement",
      mode: "engineer_rail",
      eligible: "any_mobile_piece",
      destination: "empty_or_enemy",
      consumesTurn: true,
    },
  },
  {
    id: "spade-serpentine-offensive",
    name: "穿云迂回",
    shortName: "穿云迂回",
    suit: "spades",
    suitSymbol: "♠",
    description: "两次：一枚非工兵可沿连续铁路转弯至多两次，并可攻击终点敌子。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 2,
    effect: {
      kind: "movement",
      mode: "rail_turn",
      eligible: "non_engineer_mobile_piece",
      maxTurns: 2,
      destination: "empty_or_enemy",
      consumesTurn: true,
    },
  },
  {
    id: "spade-deep-strike",
    name: "长驱突击",
    shortName: "长驱突击",
    suit: "spades",
    suitSymbol: "♠",
    description: "一次：沿相连公路前进恰好三段，中间必须为空，并可攻击终点敌子。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 1,
    effect: {
      kind: "movement",
      mode: "road_dash",
      eligible: "any_mobile_piece",
      exactEdges: 3,
      intermediate: "empty",
      destination: "empty_or_enemy",
      consumesTurn: true,
    },
  },
  {
    id: "spade-global-redeployment",
    name: "全域转进",
    shortName: "全域转进",
    suit: "spades",
    suitSymbol: "♠",
    description: "三次：将行营中的一枚可移动棋子调至棋盘上任意空行营。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 3,
    effect: {
      kind: "movement",
      mode: "camp_transfer",
      eligible: "mobile_piece_in_camp",
      destination: "empty_any_camp",
      consumesTurn: true,
    },
  },
  {
    id: "spade-command-chain",
    name: "连环军令",
    shortName: "连环军令",
    suit: "spades",
    suitSymbol: "♠",
    description: "三次：完成不发生战斗的普通移动后，用另一枚棋子追加一次普通行动。",
    timing: "你的非战斗移动后",
    activation: "automatic",
    charges: 3,
    effect: {
      kind: "extra_turn",
      mode: "after_quiet_move",
      maxExtraMoves: 1,
      requireDifferentPiece: true,
      normalMovesOnly: true,
      canChain: false,
    },
  },
  {
    id: "spade-counteroffensive",
    name: "反攻号角",
    shortName: "反攻号角",
    suit: "spades",
    suitSymbol: "♠",
    description: "三次：完成一次吃子后，用另一枚棋子追加一次普通行动。",
    timing: "你的吃子结算后",
    activation: "automatic",
    charges: 3,
    effect: {
      kind: "extra_turn",
      mode: "after_capture",
      maxExtraMoves: 1,
      requireDifferentPiece: true,
      normalMovesOnly: true,
      canChain: false,
    },
  },
  {
    id: "spade-shadow-retreat",
    name: "影遁",
    shortName: "影遁",
    suit: "spades",
    suitSymbol: "♠",
    description: "三次：进攻方本应落败且守方存活时，进攻方退回起点。",
    timing: "你的进攻战斗结算时",
    activation: "automatic",
    charges: 3,
    effect: {
      kind: "combat",
      mode: "attacker_retreat",
      trigger: "attacker_would_lose_while_defender_survives",
      attackerOutcome: "return_to_origin",
      defenderOutcome: "unchanged",
      eligible: "any_attacker",
    },
  },
  {
    id: "spade-supreme-recon",
    name: "天网侦察",
    shortName: "天网侦察",
    suit: "spades",
    suitSymbol: "♠",
    description: "本轮强化公开后，选择三枚敌子，永久获知其身份。",
    timing: "本轮强化公开后",
    activation: "active",
    charges: 1,
    effect: {
      kind: "reconnaissance",
      mode: "choose_enemy",
      count: 3,
      reveal: "permanent",
      trigger: "after_round_reveal",
    },
  },
  {
    id: "heart-rail-turn",
    name: "铁路转向",
    shortName: "铁路转向",
    suit: "hearts",
    suitSymbol: "♥",
    description: "一次：一枚非工兵可沿连续铁路转一次弯，且必须落到空位。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 1,
    effect: {
      kind: "movement",
      mode: "rail_turn",
      eligible: "non_engineer_mobile_piece",
      maxTurns: 1,
      destination: "empty",
      consumesTurn: true,
    },
  },
  {
    id: "heart-initiative",
    name: "行动先机",
    shortName: "行动先机",
    suit: "hearts",
    suitSymbol: "♥",
    description: "一次：完成不发生战斗的普通移动后，用另一枚棋子追加一次普通行动。",
    timing: "你的非战斗移动后",
    activation: "automatic",
    charges: 1,
    effect: {
      kind: "extra_turn",
      mode: "after_quiet_move",
      maxExtraMoves: 1,
      requireDifferentPiece: true,
      normalMovesOnly: true,
      canChain: false,
    },
  },
  {
    id: "heart-remote-exchange",
    name: "远程换防",
    shortName: "远程换防",
    suit: "hearts",
    suitSymbol: "♥",
    description: "一次：交换任意两枚同军阶、可移动的己方棋子，并消耗本回合。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 1,
    effect: {
      kind: "exchange",
      mode: "same_rank",
      eligible: "two_mobile_friendly_pieces",
      consumesTurn: true,
    },
  },
  {
    id: "heart-bomb-disposal",
    name: "爆破专家",
    shortName: "爆破专家",
    suit: "hearts",
    suitSymbol: "♥",
    description: "一次：工兵主动攻击炸弹时排除炸弹并存活在目标位置。",
    timing: "工兵攻击炸弹时",
    activation: "automatic",
    charges: 1,
    effect: {
      kind: "combat",
      mode: "engineer_defuses_bomb",
      trigger: "engineer_attacks_bomb",
      attackerOutcome: "survives_on_target",
      defenderOutcome: "removed",
    },
  },
  {
    id: "heart-targeted-recon",
    name: "定点侦察",
    shortName: "定点侦察",
    suit: "hearts",
    suitSymbol: "♥",
    description: "本轮强化公开后，选择一枚敌子，永久获知其身份。",
    timing: "本轮强化公开后",
    activation: "active",
    charges: 1,
    effect: {
      kind: "reconnaissance",
      mode: "choose_enemy",
      count: 1,
      reveal: "permanent",
      trigger: "after_round_reveal",
    },
  },
  {
    id: "heart-mobile-rail",
    name: "机动铁军",
    shortName: "机动铁军",
    suit: "hearts",
    suitSymbol: "♥",
    description: "两次：令任意可移动棋子按工兵铁路规则移动，但终点必须为空。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 2,
    effect: {
      kind: "movement",
      mode: "engineer_rail",
      eligible: "any_mobile_piece",
      destination: "empty",
      consumesTurn: true,
    },
  },
  {
    id: "heart-double-turn",
    name: "双向转轨",
    shortName: "双向转轨",
    suit: "hearts",
    suitSymbol: "♥",
    description: "一次：一枚非工兵可沿连续铁路转弯至多两次，终点必须为空。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 1,
    effect: {
      kind: "movement",
      mode: "rail_turn",
      eligible: "non_engineer_mobile_piece",
      maxTurns: 2,
      destination: "empty",
      consumesTurn: true,
    },
  },
  {
    id: "heart-breakthrough",
    name: "纵队突进",
    shortName: "纵队突进",
    suit: "hearts",
    suitSymbol: "♥",
    description: "一次：沿相连公路前进恰好三段，中间与终点必须为空。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 1,
    effect: {
      kind: "movement",
      mode: "road_dash",
      eligible: "any_mobile_piece",
      exactEdges: 3,
      intermediate: "empty",
      destination: "empty",
      consumesTurn: true,
    },
  },
  {
    id: "heart-camp-network",
    name: "行营联络",
    shortName: "行营联络",
    suit: "hearts",
    suitSymbol: "♥",
    description: "一次：将行营中的一枚可移动棋子调至棋盘上任意空行营。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 1,
    effect: {
      kind: "movement",
      mode: "camp_transfer",
      eligible: "mobile_piece_in_camp",
      destination: "empty_any_camp",
      consumesTurn: true,
    },
  },
  {
    id: "heart-victory-momentum",
    name: "胜势推进",
    shortName: "胜势推进",
    suit: "hearts",
    suitSymbol: "♥",
    description: "一次：完成一次吃子后，用同一枚或另一枚棋子追加一次普通行动。",
    timing: "你的吃子结算后",
    activation: "automatic",
    charges: 1,
    effect: {
      kind: "extra_turn",
      mode: "after_capture",
      maxExtraMoves: 1,
      requireDifferentPiece: false,
      normalMovesOnly: true,
      canChain: false,
    },
  },
  {
    id: "heart-orderly-withdrawal",
    name: "有序撤退",
    shortName: "有序撤退",
    suit: "hearts",
    suitSymbol: "♥",
    description: "一次：连长、排长或工兵进攻落败且守方存活时，退回起点。",
    timing: "低阶棋子的进攻战斗结算时",
    activation: "automatic",
    charges: 1,
    effect: {
      kind: "combat",
      mode: "attacker_retreat",
      trigger: "attacker_would_lose_while_defender_survives",
      attackerOutcome: "return_to_origin",
      defenderOutcome: "unchanged",
      eligible: "junior_attacker",
    },
  },
  {
    id: "heart-wide-recon",
    name: "扇区侦察",
    shortName: "扇区侦察",
    suit: "hearts",
    suitSymbol: "♥",
    description: "公开后随机侦察敌方前三排两枚棋子；各自首次移动后失去情报。",
    timing: "本轮强化公开后",
    activation: "automatic",
    charges: 1,
    effect: {
      kind: "reconnaissance",
      mode: "frontline_random",
      count: 2,
      rowsFromFront: 3,
      selection: "server_random",
      reveal: "until_piece_moves",
      trigger: "after_round_reveal",
    },
  },
  {
    id: "heart-reserve-clock",
    name: "后备时限",
    shortName: "后备时限",
    suit: "hearts",
    suitSymbol: "♥",
    description: "一次：你的回合开始且剩余不足60秒时，立即增加90秒。",
    timing: "低时间回合开始时",
    activation: "automatic",
    charges: 1,
    effect: {
      kind: "clock",
      mode: "low_time_rescue",
      trigger: "start_of_turn_below_threshold",
      thresholdMs: 60_000,
      bonusMs: 90_000,
    },
  },
  {
    id: "club-forced-march",
    name: "急行令",
    shortName: "急行令",
    suit: "clubs",
    suitSymbol: "♣",
    description: "一次：沿相连公路前进恰好两段，中间与终点必须为空。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 1,
    effect: {
      kind: "movement",
      mode: "road_dash",
      eligible: "any_mobile_piece",
      exactEdges: 2,
      intermediate: "empty",
      destination: "empty",
      consumesTurn: true,
    },
  },
  {
    id: "club-line-hop",
    name: "越列令",
    shortName: "越列令",
    suit: "clubs",
    suitSymbol: "♣",
    description: "一次：沿直线铁路越过恰好一枚相邻己棋，落到其后空位。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 1,
    effect: {
      kind: "movement",
      mode: "rail_jump",
      eligible: "any_mobile_piece",
      jumpedPieces: 1,
      jumpedSide: "friendly",
      route: "straight_rail",
      destination: "empty",
      consumesTurn: true,
    },
  },
  {
    id: "club-field-exchange",
    name: "就地换防",
    shortName: "就地换防",
    suit: "clubs",
    suitSymbol: "♣",
    description: "一次：交换由一条公路相连的两枚可移动己方棋子，并消耗本回合。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 1,
    effect: {
      kind: "exchange",
      mode: "adjacent_mobile",
      eligible: "two_adjacent_mobile_friendly_pieces",
      adjacency: "road_edge",
      consumesTurn: true,
    },
  },
  {
    id: "club-steady-tempo",
    name: "稳扎稳打",
    shortName: "稳扎稳打",
    suit: "clubs",
    suitSymbol: "♣",
    description: "获得后接下来的五次己方有效行动各返还5秒。",
    timing: "每次己方有效行动后",
    activation: "automatic",
    charges: 5,
    effect: {
      kind: "clock",
      mode: "move_increment",
      trigger: "after_completed_own_move",
      bonusMs: 5_000,
      maxTriggers: 5,
    },
  },
  {
    id: "club-frontline-scout",
    name: "前沿侦察",
    shortName: "前沿侦察",
    suit: "clubs",
    suitSymbol: "♣",
    description: "公开后随机侦察敌方前两排一枚棋子；该棋首次移动后失去情报。",
    timing: "本轮强化公开后",
    activation: "automatic",
    charges: 1,
    effect: {
      kind: "reconnaissance",
      mode: "frontline_random",
      count: 1,
      rowsFromFront: 2,
      selection: "server_random",
      reveal: "until_piece_moves",
      trigger: "after_round_reveal",
    },
  },
  {
    id: "club-rail-passage",
    name: "铁路通行",
    shortName: "铁路通行",
    suit: "clubs",
    suitSymbol: "♣",
    description: "一次：令任意可移动棋子按工兵铁路规则移动，终点必须为空。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 1,
    effect: {
      kind: "movement",
      mode: "engineer_rail",
      eligible: "any_mobile_piece",
      destination: "empty",
      consumesTurn: true,
    },
  },
  {
    id: "club-rail-switch",
    name: "临时转轨",
    shortName: "临时转轨",
    suit: "clubs",
    suitSymbol: "♣",
    description: "一次：连长、排长或工兵可沿连续铁路转一次弯，终点必须为空。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 1,
    effect: {
      kind: "movement",
      mode: "rail_turn",
      eligible: "junior_mobile_piece",
      maxTurns: 1,
      destination: "empty",
      consumesTurn: true,
    },
  },
  {
    id: "club-road-patrol",
    name: "公路巡行",
    shortName: "公路巡行",
    suit: "clubs",
    suitSymbol: "♣",
    description: "两次：沿相连公路前进恰好两段，中间与终点必须为空。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 2,
    effect: {
      kind: "movement",
      mode: "road_dash",
      eligible: "any_mobile_piece",
      exactEdges: 2,
      intermediate: "empty",
      destination: "empty",
      consumesTurn: true,
    },
  },
  {
    id: "club-camp-relay",
    name: "行营接力",
    shortName: "行营接力",
    suit: "clubs",
    suitSymbol: "♣",
    description: "两次：将行营中的一枚可移动棋子调至己方半场另一空行营。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 2,
    effect: {
      kind: "movement",
      mode: "camp_transfer",
      eligible: "mobile_piece_in_camp",
      destination: "empty_friendly_half_camp",
      consumesTurn: true,
    },
  },
  {
    id: "club-local-recon",
    name: "阵前观察",
    shortName: "阵前观察",
    suit: "clubs",
    suitSymbol: "♣",
    description: "公开后随机侦察敌方前三排一枚棋子；该棋首次移动后失去情报。",
    timing: "本轮强化公开后",
    activation: "automatic",
    charges: 1,
    effect: {
      kind: "reconnaissance",
      mode: "frontline_random",
      count: 1,
      rowsFromFront: 3,
      selection: "server_random",
      reveal: "until_piece_moves",
      trigger: "after_round_reveal",
    },
  },
  {
    id: "club-pocket-time",
    name: "整备时间",
    shortName: "整备时间",
    suit: "clubs",
    suitSymbol: "♣",
    description: "本轮强化公开后，立即为你的棋钟增加45秒。",
    timing: "本轮强化公开后",
    activation: "automatic",
    charges: 1,
    effect: {
      kind: "clock",
      mode: "flat_bonus",
      trigger: "after_round_reveal",
      bonusMs: 45_000,
    },
  },
  {
    id: "club-engineer-oath",
    name: "工兵誓约",
    shortName: "工兵誓约",
    suit: "clubs",
    suitSymbol: "♣",
    description: "两次：工兵在非地雷战斗中本应落败时，改为与对手同时移除。",
    timing: "工兵战斗结算时",
    activation: "automatic",
    charges: 2,
    effect: {
      kind: "combat",
      mode: "engineer_last_stand",
      trigger: "engineer_would_lose_non_mine_combat",
      attackerOutcome: "removed",
      defenderOutcome: "removed",
    },
  },
  {
    id: "diamond-camp-transfer",
    name: "行营转进",
    shortName: "行营转进",
    suit: "diamonds",
    suitSymbol: "♦",
    description: "一次：将行营中的一枚可移动棋子调到己方半场另一空行营，不可攻击。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 1,
    effect: {
      kind: "movement",
      mode: "camp_transfer",
      eligible: "mobile_piece_in_camp",
      destination: "empty_friendly_half_camp",
      consumesTurn: true,
    },
  },
  {
    id: "diamond-forward-bomb",
    name: "前置炸弹",
    shortName: "前置炸弹",
    suit: "diamonds",
    suitSymbol: "♦",
    description: "布阵时至多一枚炸弹可以放在本方最前排。",
    timing: "布阵阶段",
    activation: "setup",
    charges: 1,
    effect: {
      kind: "setup",
      mode: "forward_bomb",
      allowance: 1,
      destination: "front_setup_row",
    },
  },
  {
    id: "diamond-deep-mine",
    name: "纵深布雷",
    shortName: "纵深布雷",
    suit: "diamonds",
    suitSymbol: "♦",
    description: "布阵时至多一枚地雷可以放在从本方大本营数第三排。",
    timing: "布阵阶段",
    activation: "setup",
    charges: 1,
    effect: {
      kind: "setup",
      mode: "deep_mine",
      allowance: 1,
      destination: "third_row_from_home",
    },
  },
  {
    id: "diamond-engineer-screen",
    name: "工兵掩护",
    shortName: "工兵掩护",
    suit: "diamonds",
    suitSymbol: "♦",
    description: "一次：工兵在非地雷战斗中本应落败时，改为与对手同时移除。",
    timing: "工兵战斗结算时",
    activation: "automatic",
    charges: 1,
    effect: {
      kind: "combat",
      mode: "engineer_last_stand",
      trigger: "engineer_would_lose_non_mine_combat",
      attackerOutcome: "removed",
      defenderOutcome: "removed",
    },
  },
  {
    id: "diamond-time-cache",
    name: "机动时间",
    shortName: "机动时间",
    suit: "diamonds",
    suitSymbol: "♦",
    description: "本轮强化公开后，立即为你的棋钟增加20秒。",
    timing: "本轮强化公开后",
    activation: "automatic",
    charges: 1,
    effect: {
      kind: "clock",
      mode: "flat_bonus",
      trigger: "after_round_reveal",
      bonusMs: 20_000,
    },
  },
  {
    id: "diamond-road-step",
    name: "短促推进",
    shortName: "短促推进",
    suit: "diamonds",
    suitSymbol: "♦",
    description: "一次：连长、排长或工兵沿相连公路前进恰好两段，中间与终点必须为空。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 1,
    effect: {
      kind: "movement",
      mode: "road_dash",
      eligible: "junior_mobile_piece",
      exactEdges: 2,
      intermediate: "empty",
      destination: "empty",
      consumesTurn: true,
    },
  },
  {
    id: "diamond-camp-relay",
    name: "营地轮换",
    shortName: "营地轮换",
    suit: "diamonds",
    suitSymbol: "♦",
    description: "两次：将行营中的连长、排长或工兵调至己方半场另一空行营。",
    timing: "你的行动阶段",
    activation: "active",
    charges: 2,
    effect: {
      kind: "movement",
      mode: "camp_transfer",
      eligible: "junior_piece_in_camp",
      destination: "empty_friendly_half_camp",
      consumesTurn: true,
    },
  },
  {
    id: "diamond-front-watch",
    name: "前哨观察",
    shortName: "前哨观察",
    suit: "diamonds",
    suitSymbol: "♦",
    description: "公开后随机侦察敌方最前排一枚棋子；该棋首次移动后失去情报。",
    timing: "本轮强化公开后",
    activation: "automatic",
    charges: 1,
    effect: {
      kind: "reconnaissance",
      mode: "frontline_random",
      count: 1,
      rowsFromFront: 1,
      selection: "server_random",
      reveal: "until_piece_moves",
      trigger: "after_round_reveal",
    },
  },
  {
    id: "diamond-pocket-watch",
    name: "怀表",
    shortName: "怀表",
    suit: "diamonds",
    suitSymbol: "♦",
    description: "本轮强化公开后，立即为你的棋钟增加10秒。",
    timing: "本轮强化公开后",
    activation: "automatic",
    charges: 1,
    effect: {
      kind: "clock",
      mode: "flat_bonus",
      trigger: "after_round_reveal",
      bonusMs: 10_000,
    },
  },
  {
    id: "diamond-drill",
    name: "计时操演",
    shortName: "计时操演",
    suit: "diamonds",
    suitSymbol: "♦",
    description: "获得后接下来的五次己方有效行动各返还2秒。",
    timing: "每次己方有效行动后",
    activation: "automatic",
    charges: 5,
    effect: {
      kind: "clock",
      mode: "move_increment",
      trigger: "after_completed_own_move",
      bonusMs: 2_000,
      maxTriggers: 5,
    },
  },
  {
    id: "diamond-forward-pair",
    name: "双弹前置",
    shortName: "双弹前置",
    suit: "diamonds",
    suitSymbol: "♦",
    description: "布阵时至多两枚炸弹可以放在本方最前排。",
    timing: "布阵阶段",
    activation: "setup",
    charges: 1,
    effect: {
      kind: "setup",
      mode: "forward_bomb",
      allowance: 2,
      destination: "front_setup_row",
    },
  },
  {
    id: "diamond-deep-pair",
    name: "双线布雷",
    shortName: "双线布雷",
    suit: "diamonds",
    suitSymbol: "♦",
    description: "布阵时至多两枚地雷可以放在从本方大本营数第三排。",
    timing: "布阵阶段",
    activation: "setup",
    charges: 1,
    effect: {
      kind: "setup",
      mode: "deep_mine",
      allowance: 2,
      destination: "third_row_from_home",
    },
  },
] as const satisfies readonly AugmentDefinition[];

/** The immutable 20-card pool used by rooms persisted before the v2 expansion. */
export const LEGACY_AUGMENT_IDS = [
  "spade-grand-maneuver",
  "spade-relentless-assault",
  "spade-tactical-retreat",
  "spade-total-intelligence",
  "spade-strategic-reserve",
  "heart-rail-turn",
  "heart-initiative",
  "heart-remote-exchange",
  "heart-bomb-disposal",
  "heart-targeted-recon",
  "club-forced-march",
  "club-line-hop",
  "club-field-exchange",
  "club-steady-tempo",
  "club-frontline-scout",
  "diamond-camp-transfer",
  "diamond-forward-bomb",
  "diamond-deep-mine",
  "diamond-engineer-screen",
  "diamond-time-cache",
] as const satisfies readonly AugmentId[];

const AUGMENT_ID_SET = new Set<string>(AUGMENT_CATALOG.map((augment) => augment.id));
const LEGACY_AUGMENT_ID_SET = new Set<string>(LEGACY_AUGMENT_IDS);
const AUGMENT_BY_ID = new Map<AugmentId, AugmentDefinition>(
  AUGMENT_CATALOG.map((augment) => [augment.id, augment]),
);

export function isAugmentId(value: unknown): value is AugmentId {
  return typeof value === "string" && AUGMENT_ID_SET.has(value);
}

export function getAugmentDefinition(id: AugmentId): AugmentDefinition {
  const definition = AUGMENT_BY_ID.get(id);
  if (!definition) throw new AugmentRuleError("UNKNOWN_AUGMENT", `Unknown augment: ${id}`);
  return definition;
}

export function getAugmentsBySuit(suit: AugmentSuit): readonly AugmentDefinition[] {
  return AUGMENT_CATALOG.filter((augment) => augment.suit === suit);
}

export type AugmentRandomSource = () => number;

export const systemAugmentRandom: AugmentRandomSource = () => Math.random();

export function createSeededAugmentRandom(seed: number | string): AugmentRandomSource {
  let state = typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hashSeed(seed: string): number {
  let hash = 2_166_136_261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

export const AUGMENT_ERROR_CODES = [
  "INVALID_RANDOM_SOURCE",
  "UNKNOWN_AUGMENT",
  "INSUFFICIENT_AUGMENTS",
  "NO_ACTIVE_DRAFT",
  "ROUND_ALREADY_STARTED",
  "FIRST_ROUND_NOT_REVEALED",
  "SAME_SUIT_AS_FIRST_ROUND",
  "SUIT_NOT_AVAILABLE_FOR_ROUND",
  "INVALID_SLOT",
  "SELECTION_LOCKED",
  "REFRESH_ALREADY_USED",
  "AUGMENT_NOT_OFFERED",
  "SELECTION_REQUIRED",
  "BOTH_PLAYERS_NOT_LOCKED",
  "ROUND_ALREADY_REVEALED",
  "INVALID_STATE",
] as const;

export type AugmentErrorCode = (typeof AUGMENT_ERROR_CODES)[number];

export class AugmentRuleError extends Error {
  readonly code: AugmentErrorCode;

  constructor(code: AugmentErrorCode, message: string) {
    super(message);
    this.name = "AugmentRuleError";
    this.code = code;
  }
}

export type AugmentOptions = [AugmentId, AugmentId, AugmentId];

export interface AugmentPlayerRoundState {
  options: AugmentOptions;
  selectedId: AugmentId | null;
  locked: boolean;
  refreshedSlot: AugmentSlot | null;
}

export interface AugmentDraftRoundState {
  number: AugmentDraftRoundNumber;
  trigger: "setup" | "move_10";
  suit: AugmentSuit;
  revealed: boolean;
  players: Record<AugmentSide, AugmentPlayerRoundState>;
}

export interface AugmentDraftState {
  catalogVersion: AugmentCatalogVersion;
  activeRound: AugmentDraftRoundNumber | null;
  rounds: AugmentDraftRoundState[];
  seenBySide: Record<AugmentSide, AugmentId[]>;
  loadouts: Record<AugmentSide, AugmentId[]>;
}

export interface CreateAugmentDraftOptions {
  random?: AugmentRandomSource;
  initialSuit?: AugmentSuit;
}

export interface BeginSecondAugmentDraftOptions {
  random?: AugmentRandomSource;
  suit?: AugmentSuit;
}

export interface ProjectedAugmentPlayerRound {
  options: AugmentOptions | null;
  selectedId: AugmentId | null;
  locked: boolean;
  refreshed: boolean;
  refreshedSlot: AugmentSlot | null;
}

export interface ProjectedAugmentDraftRound {
  number: AugmentDraftRoundNumber;
  trigger: AugmentDraftRoundState["trigger"];
  suit: AugmentSuit;
  revealed: boolean;
  players: Record<AugmentSide, ProjectedAugmentPlayerRound>;
}

export interface ProjectedAugmentDraft {
  catalogVersion: AugmentCatalogVersion;
  activeRound: AugmentDraftRoundNumber | null;
  rounds: ProjectedAugmentDraftRound[];
  seenIds: AugmentId[] | null;
  loadouts: Record<AugmentSide, AugmentId[]>;
}

export function createAugmentDraftState(
  options: CreateAugmentDraftOptions = {},
): AugmentDraftState {
  const random = options.random ?? systemAugmentRandom;
  const initialSuit = options.initialSuit ?? chooseRandomSuit(AUGMENT_SUITS, random);
  const seenBySide: Record<AugmentSide, AugmentId[]> = { black: [], white: [] };
  const round = createRound(1, initialSuit, AUGMENT_CATALOG_VERSION, seenBySide, random);
  const state: AugmentDraftState = {
    catalogVersion: AUGMENT_CATALOG_VERSION,
    activeRound: 1,
    rounds: [round],
    seenBySide,
    loadouts: { black: [], white: [] },
  };
  assertValidAugmentDraftState(state);
  return state;
}

export function beginSecondAugmentDraft(
  state: AugmentDraftState,
  options: BeginSecondAugmentDraftOptions = {},
): AugmentDraftState {
  assertValidAugmentDraftState(state);
  if (state.rounds.some((round) => round.number === 2)) {
    throw new AugmentRuleError("ROUND_ALREADY_STARTED", "The second augment draft already exists.");
  }
  const firstRound = state.rounds.find((round) => round.number === 1);
  if (!firstRound?.revealed || state.activeRound !== null) {
    throw new AugmentRuleError(
      "FIRST_ROUND_NOT_REVEALED",
      "The first augment draft must be revealed before the second begins.",
    );
  }
  const random = options.random ?? systemAugmentRandom;
  if (options.suit === firstRound.suit) {
    throw new AugmentRuleError(
      "SAME_SUIT_AS_FIRST_ROUND",
      "The second augment draft must use a different suit.",
    );
  }
  const eligibleSuits = AUGMENT_SUITS.filter((suit) =>
    suit !== firstRound.suit &&
    getEligibleAugments(state.catalogVersion, 2, suit).length >= 3
  );
  if (options.suit && !eligibleSuits.includes(options.suit)) {
    throw new AugmentRuleError(
      "SUIT_NOT_AVAILABLE_FOR_ROUND",
      "That suit has fewer than three eligible move-10 augments.",
    );
  }
  const suit = options.suit ?? chooseRandomSuit(eligibleSuits, random);
  const next = cloneAugmentDraftState(state);
  next.rounds.push(createRound(2, suit, next.catalogVersion, next.seenBySide, random));
  next.activeRound = 2;
  assertValidAugmentDraftState(next);
  return next;
}

/** Returns true after nine completed moves, immediately before move ten begins. */
export function isSecondAugmentDraftDue(state: AugmentDraftState, moveNumber: number): boolean {
  return (
    Number.isInteger(moveNumber) &&
    moveNumber >= SECOND_AUGMENT_MOVE_NUMBER - 1 &&
    state.activeRound === null &&
    state.rounds.length === 1 &&
    state.rounds[0]?.revealed === true
  );
}

export function refreshAugmentOption(
  state: AugmentDraftState,
  side: AugmentSide,
  slot: AugmentSlot,
  random: AugmentRandomSource = systemAugmentRandom,
): AugmentDraftState {
  assertValidAugmentDraftState(state);
  if (slot !== 0 && slot !== 1 && slot !== 2) {
    throw new AugmentRuleError("INVALID_SLOT", "The augment slot must be 0, 1, or 2.");
  }
  const next = cloneAugmentDraftState(state);
  const round = getActiveRound(next);
  const player = round.players[side];
  if (player.locked) {
    throw new AugmentRuleError("SELECTION_LOCKED", "A locked selection cannot be refreshed.");
  }
  if (player.refreshedSlot !== null) {
    throw new AugmentRuleError(
      "REFRESH_ALREADY_USED",
      "Each player may refresh only one slot in each draft round.",
    );
  }
  const replacedId = player.options[slot];
  const [replacement] = drawAugments(
    round.suit,
    round.number,
    next.catalogVersion,
    1,
    next.seenBySide[side],
    random,
  );
  player.options[slot] = replacement;
  player.refreshedSlot = slot;
  if (player.selectedId === replacedId) player.selectedId = null;
  next.seenBySide[side].push(replacement);
  assertValidAugmentDraftState(next);
  return next;
}

export function selectAugment(
  state: AugmentDraftState,
  side: AugmentSide,
  augmentId: AugmentId,
): AugmentDraftState {
  assertValidAugmentDraftState(state);
  const next = cloneAugmentDraftState(state);
  const player = getActiveRound(next).players[side];
  if (player.locked) {
    throw new AugmentRuleError("SELECTION_LOCKED", "A locked selection cannot be changed.");
  }
  if (!player.options.includes(augmentId)) {
    throw new AugmentRuleError("AUGMENT_NOT_OFFERED", "The selected augment is not in this offer.");
  }
  player.selectedId = augmentId;
  assertValidAugmentDraftState(next);
  return next;
}

export function lockAugmentSelection(
  state: AugmentDraftState,
  side: AugmentSide,
): AugmentDraftState {
  assertValidAugmentDraftState(state);
  const next = cloneAugmentDraftState(state);
  const player = getActiveRound(next).players[side];
  if (player.locked) {
    throw new AugmentRuleError("SELECTION_LOCKED", "This augment selection is already locked.");
  }
  if (!player.selectedId) {
    throw new AugmentRuleError("SELECTION_REQUIRED", "Select an augment before locking it.");
  }
  player.locked = true;
  next.loadouts[side].push(player.selectedId);
  assertValidAugmentDraftState(next);
  return next;
}

export function chooseAndLockAugment(
  state: AugmentDraftState,
  side: AugmentSide,
  augmentId: AugmentId,
): AugmentDraftState {
  return lockAugmentSelection(selectAugment(state, side, augmentId), side);
}

export function revealCurrentAugmentRound(state: AugmentDraftState): AugmentDraftState {
  assertValidAugmentDraftState(state);
  const next = cloneAugmentDraftState(state);
  const round = getActiveRound(next);
  if (round.revealed) {
    throw new AugmentRuleError("ROUND_ALREADY_REVEALED", "This augment round is already revealed.");
  }
  if (!AUGMENT_SIDES.every((side) => round.players[side].locked)) {
    throw new AugmentRuleError(
      "BOTH_PLAYERS_NOT_LOCKED",
      "Both players must lock an augment before the round can be revealed.",
    );
  }
  for (const side of AUGMENT_SIDES) {
    if (!round.players[side].selectedId) {
      throw new AugmentRuleError("INVALID_STATE", "A locked player is missing a selection.");
    }
  }
  round.revealed = true;
  next.activeRound = null;
  assertValidAugmentDraftState(next);
  return next;
}

export function projectAugmentDraft(
  state: AugmentDraftState,
  viewer: AugmentViewer,
): ProjectedAugmentDraft {
  assertValidAugmentDraftState(state);
  return {
    catalogVersion: state.catalogVersion,
    activeRound: state.activeRound,
    rounds: state.rounds.map((round) => ({
      number: round.number,
      trigger: round.trigger,
      suit: round.suit,
      revealed: round.revealed,
      players: {
        black: projectRoundPlayer(round, "black", viewer),
        white: projectRoundPlayer(round, "white", viewer),
      },
    })),
    seenIds: viewer === "spectator" ? null : [...state.seenBySide[viewer]],
    loadouts: {
      black: projectLoadout(state, "black", viewer),
      white: projectLoadout(state, "white", viewer),
    },
  };
}

export function validateAugmentDraftState(state: AugmentDraftState): boolean {
  try {
    assertValidAugmentDraftState(state);
    return true;
  } catch {
    return false;
  }
}

export function assertValidAugmentDraftState(state: AugmentDraftState): void {
  const invalid = (message: string): never => {
    throw new AugmentRuleError("INVALID_STATE", message);
  };
  if (
    state.catalogVersion !== AUGMENT_CATALOG_VERSION &&
    state.catalogVersion !== LEGACY_AUGMENT_CATALOG_VERSION
  ) {
    invalid("Unknown augment catalog version.");
  }
  if (state.rounds.length < 1 || state.rounds.length > 2) invalid("Expected one or two rounds.");
  if (state.rounds[0]?.number !== 1 || state.rounds[0].trigger !== "setup") {
    invalid("The first draft round must be the setup round.");
  }
  if (state.rounds[1] && (state.rounds[1].number !== 2 || state.rounds[1].trigger !== "move_10")) {
    invalid("The second draft round must be the move-10 round.");
  }
  if (state.rounds[1]?.suit === state.rounds[0]?.suit) {
    invalid("Draft rounds must use different suits.");
  }
  if (
    state.catalogVersion === LEGACY_AUGMENT_CATALOG_VERSION &&
    state.rounds[1]?.suit === "diamonds"
  ) {
    invalid("Legacy move-10 drafts cannot offer the diamond tier.");
  }
  const activeRounds = state.rounds.filter((round) => !round.revealed);
  if (activeRounds.length > 1) invalid("Only one augment round can be active.");
  if (
    (state.activeRound === null && activeRounds.length !== 0) ||
    (state.activeRound !== null &&
      (activeRounds.length !== 1 || activeRounds[0]?.number !== state.activeRound))
  ) {
    invalid("activeRound does not match the unrevealed round.");
  }

  for (const side of AUGMENT_SIDES) {
    const seen = state.seenBySide[side];
    if (
      seen.some(
        (id) =>
          !isAugmentId(id) ||
          (state.catalogVersion === LEGACY_AUGMENT_CATALOG_VERSION &&
            !LEGACY_AUGMENT_ID_SET.has(id)),
      ) ||
      new Set(seen).size !== seen.length
    ) {
      invalid(`The ${side} seen list contains an unknown or duplicate augment.`);
    }
    const expectedLoadout: AugmentId[] = [];
    for (const round of state.rounds) {
      const player = round.players[side];
      if (player.options.length !== 3 || new Set(player.options).size !== 3) {
        invalid(`The ${side} offer in round ${round.number} must contain three unique augments.`);
      }
      if (
        player.options.some(
          (id) =>
            !isAugmentId(id) ||
            !isAugmentEligibleForVersionAndRound(id, state.catalogVersion, round.number) ||
            getAugmentDefinition(id).suit !== round.suit ||
            !seen.includes(id),
        )
      ) {
        invalid(`The ${side} offer in round ${round.number} is outside its suit or seen list.`);
      }
      if (player.selectedId !== null && !player.options.includes(player.selectedId)) {
        invalid(`The ${side} selection in round ${round.number} is not offered.`);
      }
      if (player.locked && player.selectedId === null) {
        invalid(`The ${side} selection in round ${round.number} is locked without a card.`);
      }
      if (round.revealed && !player.locked) {
        invalid(`The ${side} selection in round ${round.number} was revealed before locking.`);
      }
      if (player.locked && player.selectedId) expectedLoadout.push(player.selectedId);
    }
    if (
      expectedLoadout.length !== state.loadouts[side].length ||
      expectedLoadout.some((id, index) => state.loadouts[side][index] !== id)
    ) {
      invalid(`The ${side} loadout does not match the revealed selections.`);
    }
  }
}

function createRound(
  number: AugmentDraftRoundNumber,
  suit: AugmentSuit,
  catalogVersion: AugmentCatalogVersion,
  seenBySide: Record<AugmentSide, AugmentId[]>,
  random: AugmentRandomSource,
): AugmentDraftRoundState {
  const blackOptions = drawAugments(
    suit,
    number,
    catalogVersion,
    3,
    seenBySide.black,
    random,
  ) as AugmentOptions;
  const whiteOptions = drawAugments(
    suit,
    number,
    catalogVersion,
    3,
    seenBySide.white,
    random,
  ) as AugmentOptions;
  seenBySide.black.push(...blackOptions);
  seenBySide.white.push(...whiteOptions);
  return {
    number,
    trigger: number === 1 ? "setup" : "move_10",
    suit,
    revealed: false,
    players: {
      black: { options: blackOptions, selectedId: null, locked: false, refreshedSlot: null },
      white: { options: whiteOptions, selectedId: null, locked: false, refreshedSlot: null },
    },
  };
}

function drawAugments(
  suit: AugmentSuit,
  roundNumber: AugmentDraftRoundNumber,
  catalogVersion: AugmentCatalogVersion,
  count: number,
  seen: readonly AugmentId[],
  random: AugmentRandomSource,
): AugmentId[] {
  const pool = getEligibleAugments(catalogVersion, roundNumber, suit)
    .map((augment) => augment.id)
    .filter((id) => !seen.includes(id));
  if (pool.length < count) {
    throw new AugmentRuleError(
      "INSUFFICIENT_AUGMENTS",
      `Not enough unseen ${suit} augments to draw ${count}.`,
    );
  }
  const drawn: AugmentId[] = [];
  for (let draw = 0; draw < count; draw += 1) {
    drawn.push(pool.splice(randomIndex(pool.length, random), 1)[0]);
  }
  return drawn;
}

function getEligibleAugments(
  catalogVersion: AugmentCatalogVersion,
  roundNumber: AugmentDraftRoundNumber,
  suit: AugmentSuit,
) {
  return getAugmentsBySuit(suit).filter((definition) =>
    isAugmentEligibleForVersionAndRound(definition.id, catalogVersion, roundNumber)
  );
}

function isAugmentEligibleForVersionAndRound(
  augmentId: AugmentId,
  catalogVersion: AugmentCatalogVersion,
  roundNumber: AugmentDraftRoundNumber,
) {
  if (
    catalogVersion === LEGACY_AUGMENT_CATALOG_VERSION &&
    !LEGACY_AUGMENT_ID_SET.has(augmentId)
  ) {
    return false;
  }
  if (roundNumber === 1) return true;
  if (catalogVersion === LEGACY_AUGMENT_CATALOG_VERSION) {
    return getAugmentDefinition(augmentId).suit !== "diamonds";
  }
  return getAugmentDefinition(augmentId).activation !== "setup";
}

function chooseRandomSuit(
  suits: readonly AugmentSuit[],
  random: AugmentRandomSource,
): AugmentSuit {
  return suits[randomIndex(suits.length, random)];
}

function randomIndex(length: number, random: AugmentRandomSource): number {
  const value = random();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new AugmentRuleError(
      "INVALID_RANDOM_SOURCE",
      "The random source must return a finite number in [0, 1).",
    );
  }
  return Math.floor(value * length);
}

function getActiveRound(state: AugmentDraftState): AugmentDraftRoundState {
  if (state.activeRound === null) {
    throw new AugmentRuleError("NO_ACTIVE_DRAFT", "There is no active augment draft.");
  }
  const round = state.rounds.find((candidate) => candidate.number === state.activeRound);
  if (!round || round.revealed) {
    throw new AugmentRuleError("INVALID_STATE", "The active augment round is missing or revealed.");
  }
  return round;
}

function projectRoundPlayer(
  round: AugmentDraftRoundState,
  side: AugmentSide,
  viewer: AugmentViewer,
): ProjectedAugmentPlayerRound {
  const player = round.players[side];
  const ownsPrivateView = viewer === side;
  return {
    options: ownsPrivateView ? [...player.options] as AugmentOptions : null,
    selectedId: round.revealed || ownsPrivateView ? player.selectedId : null,
    locked: player.locked,
    refreshed: player.refreshedSlot !== null,
    refreshedSlot: ownsPrivateView ? player.refreshedSlot : null,
  };
}

function projectLoadout(
  state: AugmentDraftState,
  side: AugmentSide,
  viewer: AugmentViewer,
): AugmentId[] {
  return state.rounds.flatMap((round) => {
    const selectedId = round.players[side].selectedId;
    return selectedId && round.players[side].locked && (round.revealed || viewer === side)
      ? [selectedId]
      : [];
  });
}

function cloneAugmentDraftState(state: AugmentDraftState): AugmentDraftState {
  return {
    catalogVersion: state.catalogVersion,
    activeRound: state.activeRound,
    rounds: state.rounds.map((round) => ({
      ...round,
      players: {
        black: { ...round.players.black, options: [...round.players.black.options] },
        white: { ...round.players.white, options: [...round.players.white.options] },
      },
    })),
    seenBySide: {
      black: [...state.seenBySide.black],
      white: [...state.seenBySide.white],
    },
    loadouts: {
      black: [...state.loadouts.black],
      white: [...state.loadouts.white],
    },
  };
}
