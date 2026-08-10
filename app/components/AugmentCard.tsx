"use client";

import type { KeyboardEvent, Ref } from "react";

import {
  AUGMENT_SUIT_META,
  type AugmentDefinition,
} from "@/lib/augments";

import styles from "./Augments.module.css";

export type AugmentCardState =
  | "available"
  | "selected"
  | "locked"
  | "hidden"
  | "used";

export type AugmentCardBurnState = "none" | "burning" | "burnt";

export interface AugmentCardProps {
  augment?: AugmentDefinition | null;
  state?: AugmentCardState;
  compact?: boolean;
  disabled?: boolean;
  statusLabel?: string;
  ownerLabel?: string;
  onSelect?: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  buttonRef?: Ref<HTMLButtonElement>;
  tabIndex?: number;
  role?: "radio";
  ariaChecked?: boolean;
  actionCard?: boolean;
  burnState?: AugmentCardBurnState;
}

function cardLayers(
  augment: AugmentDefinition | null | undefined,
  hidden: boolean,
  status: string,
  burnState: AugmentCardBurnState,
) {
  return (
    <>
      <span className={styles.cardBody}>
        <span className={`${styles.cardFace} ${styles.cardFront}`}>
          {cardContents(augment, hidden, status)}
        </span>
        <span className={`${styles.cardFace} ${styles.cardBack}`} aria-hidden="true">
          <span className={styles.backFrame}>
            <span className={styles.backLattice} />
            <span className={styles.backMedallion}>
              <span>令</span>
            </span>
          </span>
          <span className={styles.backStatus}>{status}</span>
        </span>
      </span>
      {burnState !== "none" ? (
        <span className={styles.burnLayer} aria-hidden="true">
          <span className={styles.burnEdge} />
          <span className={`${styles.ember} ${styles.emberOne}`} />
          <span className={`${styles.ember} ${styles.emberTwo}`} />
          <span className={`${styles.ember} ${styles.emberThree}`} />
          <span className={styles.burnLabel}>牌令已尽</span>
        </span>
      ) : null}
    </>
  );
}

const STATE_LABELS: Record<AugmentCardState, string> = {
  available: "可用",
  selected: "已选择",
  locked: "已锁定",
  hidden: "尚未公开",
  used: "已耗尽",
};

function joinClasses(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

function cardContents(
  augment: AugmentDefinition | null | undefined,
  hidden: boolean,
  status: string,
) {
  if (hidden || !augment) {
    return (
      <>
        <span className={styles.stateBadge}>{status}</span>
        <span className={styles.hiddenFace} aria-hidden="true">
          <span className={styles.hiddenMark}>Q</span>
          <span className={styles.hiddenText}>强化待揭示</span>
        </span>
      </>
    );
  }

  const suitLabel = AUGMENT_SUIT_META[augment.suit].label;
  const usageLabel = augment.charges === 1 ? "一次" : `${augment.charges} 次`;
  const activationLabel = augment.activation === "setup"
    ? "布阵"
    : ["movement", "exchange", "reconnaissance"].includes(augment.effect.kind)
      ? "主动"
      : "自动";

  return (
    <>
      <span className={styles.corner} aria-hidden="true">
        <span>{augment.suitSymbol}</span>
        <span className={styles.suitGlyph}>{augment.suitSymbol}</span>
      </span>
      <span className={styles.stateBadge}>{status}</span>
      <span className={styles.face}>
        <span className={styles.mainSuit} aria-hidden="true">{augment.suitSymbol}</span>
        <span className={styles.name}>{augment.shortName || augment.name}</span>
        <span className={styles.description}>{augment.description}</span>
        <span className={styles.cardDetails}>
          <span>{activationLabel}</span>
          <span>{augment.timing}</span>
          <span>{usageLabel}</span>
        </span>
        <span className={styles.tierLabel}>{suitLabel}强化</span>
      </span>
      <span className={joinClasses(styles.corner, styles.cornerBottom)} aria-hidden="true">
        <span>{augment.suitSymbol}</span>
        <span className={styles.suitGlyph}>{augment.suitSymbol}</span>
      </span>
    </>
  );
}

export default function AugmentCard({
  augment,
  state = "available",
  compact = false,
  disabled = false,
  statusLabel,
  ownerLabel,
  onSelect,
  onKeyDown,
  buttonRef,
  tabIndex,
  role,
  ariaChecked,
  actionCard = false,
  burnState = "none",
}: AugmentCardProps) {
  const hidden = state === "hidden" || !augment;
  const status = statusLabel ?? STATE_LABELS[hidden ? "hidden" : state];
  const suitLabel = augment ? AUGMENT_SUIT_META[augment.suit].label : "未知花色";
  const accessibleName = hidden
    ? `${ownerLabel ? `${ownerLabel}，` : ""}强化尚未公开`
    : `${ownerLabel ? `${ownerLabel}，` : ""}${augment.name}，${suitLabel}，${status}。${augment.description}，${augment.timing}，可触发 ${augment.charges} 次`;
  const className = joinClasses(
    styles.card,
    compact && styles.cardCompact,
    state === "selected" && styles.cardSelected,
    state === "locked" && styles.cardLocked,
    state === "used" && styles.cardUsed,
    hidden && styles.cardHidden,
    actionCard && styles.cardAction,
    burnState === "burning" && styles.cardBurning,
    burnState === "burnt" && styles.cardBurnt,
  );

  if (onSelect) {
    return (
      <button
        ref={buttonRef}
        className={className}
        type="button"
        data-augment-id={hidden ? undefined : augment?.id}
        data-state={hidden ? "hidden" : state}
        data-suit={hidden ? undefined : augment?.suit}
        data-action-card={actionCard ? "true" : "false"}
        data-exhausted-transition={burnState}
        disabled={disabled}
        onClick={onSelect}
        onKeyDown={onKeyDown}
        tabIndex={tabIndex}
        role={role}
        aria-checked={role === "radio" ? ariaChecked : undefined}
        aria-pressed={role ? undefined : state === "selected"}
        aria-label={accessibleName}
      >
        {cardLayers(augment, hidden, status, burnState)}
      </button>
    );
  }

  return (
    <article
      className={className}
      data-augment-id={hidden ? undefined : augment?.id}
      data-state={hidden ? "hidden" : state}
      data-suit={hidden ? undefined : augment?.suit}
      data-action-card={actionCard ? "true" : "false"}
      data-exhausted-transition={burnState}
      aria-label={accessibleName}
    >
      {cardLayers(augment, hidden, status, burnState)}
    </article>
  );
}
