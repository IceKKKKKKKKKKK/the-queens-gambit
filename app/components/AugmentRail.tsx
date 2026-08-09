"use client";

import type { AugmentDefinition, AugmentId } from "@/lib/augments";

import AugmentCard, { type AugmentCardState } from "./AugmentCard";
import styles from "./Augments.module.css";

export interface AugmentRailItem {
  augment?: AugmentDefinition | null;
  hidden?: boolean;
  triggerCount?: number;
}

export interface AugmentRailProps {
  label: string;
  items: readonly AugmentRailItem[];
  activeId?: AugmentId | null;
  canActivate?: boolean;
  pending?: boolean;
  onActivate?: (augmentId: AugmentId) => void;
}

export default function AugmentRail({
  label,
  items,
  activeId = null,
  canActivate = false,
  pending = false,
  onActivate,
}: AugmentRailProps) {
  const visibleCount = items.filter((item) => item.augment && !item.hidden).length;
  const exhaustedCount = items.filter((item) => {
    if (!item.augment || item.hidden) return false;
    return Math.max(0, item.triggerCount ?? 0) >= item.augment.charges;
  }).length;

  return (
    <section className={styles.rail} aria-label={`${label}的强化`} aria-busy={pending}>
      <header className={styles.railHeader}>
        <h3 className={styles.railTitle}>{label} · 强化</h3>
        <p className={styles.railMeta} aria-live="polite">
          {items.length === 0 ? "尚未获得" : `${visibleCount} 张公开${exhaustedCount ? ` · ${exhaustedCount} 张已耗尽` : ""}`}
        </p>
      </header>

      {items.length > 0 ? (
        <ul
          className={`${styles.railCards} ${items.length === 1 ? styles.railCardsSingle : ""}`}
          aria-label={`${label}的强化牌`}
        >
          {items.map((item, index) => {
            const augmentId = item.augment?.id;
            const hidden = item.hidden || !item.augment;
            const active = Boolean(augmentId && activeId === augmentId);
            const charges = item.augment?.charges ?? 0;
            const triggerCount = item.augment
              ? Math.min(charges, Math.max(0, item.triggerCount ?? 0))
              : 0;
            const exhausted = Boolean(item.augment && triggerCount >= charges);
            const partiallyTriggered = Boolean(item.augment && triggerCount > 0 && !exhausted);
            const state: AugmentCardState = hidden
              ? "hidden"
              : exhausted
                ? "used"
                : active
                  ? "selected"
                  : "available";
            const supportsManualActivation = Boolean(
              item.augment && ["movement", "exchange", "reconnaissance"].includes(item.augment.effect.kind),
            );
            const activatable = Boolean(
              augmentId && canActivate && onActivate && !hidden && !exhausted && supportsManualActivation,
            );
            const statusLabel = hidden
              ? "未公开"
              : exhausted
                ? `已耗尽 ${triggerCount}/${charges}`
                : partiallyTriggered
                  ? `已触发 ${triggerCount}/${charges}`
                  : active
                    ? "已启用"
                    : item.augment?.activation === "setup"
                      ? "布阵生效"
                      : supportsManualActivation
                        ? "可用"
                        : "等待触发";

            return (
              <li className={styles.railCardItem} key={hidden ? `hidden-${index}` : augmentId}>
                <AugmentCard
                  augment={item.augment}
                  state={state}
                  compact
                  ownerLabel={label}
                  disabled={pending}
                  statusLabel={statusLabel}
                  onSelect={activatable && augmentId && onActivate
                    ? () => onActivate(augmentId)
                    : undefined}
                />
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.railEmpty}>强化将在选择并公开后显示</p>
      )}
    </section>
  );
}
