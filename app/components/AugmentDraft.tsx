"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type {
  AugmentDefinition,
  AugmentId,
  AugmentSlot,
} from "@/lib/augments";

import AugmentCard, { type AugmentCardState } from "./AugmentCard";
import styles from "./Augments.module.css";

export interface AugmentDraftProps {
  round: 1 | 2;
  options: readonly AugmentDefinition[];
  selectedId?: AugmentId | null;
  locked?: boolean;
  opponentLocked?: boolean;
  refreshUsed?: boolean;
  refreshingSlot?: AugmentSlot | null;
  seenCount?: number;
  deadlineAt?: number | null;
  pending?: boolean;
  onSelect: (augmentId: AugmentId) => void;
  onRefresh: (slot: AugmentSlot) => void;
  onConfirm: () => void;
  onResign?: () => void;
}

function nextOptionIndex(
  key: string,
  currentIndex: number,
  optionCount: number,
) {
  if (key === "Home") return 0;
  if (key === "End") return optionCount - 1;
  if (key === "ArrowRight" || key === "ArrowDown") {
    return (currentIndex + 1) % optionCount;
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return (currentIndex - 1 + optionCount) % optionCount;
  }
  return null;
}

export default function AugmentDraft({
  round,
  options,
  selectedId = null,
  locked = false,
  opponentLocked = false,
  refreshUsed = false,
  refreshingSlot = null,
  seenCount = 0,
  deadlineAt = null,
  pending = false,
  onSelect,
  onRefresh,
  onConfirm,
  onResign,
}: AugmentDraftProps) {
  const draftRef = useRef<HTMLElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [now, setNow] = useState(() => Date.now());
  const selectedIndex = options.findIndex((augment) => augment.id === selectedId);
  const focusableIndex = selectedIndex >= 0 ? selectedIndex : 0;
  const title = round === 1 ? "选择开局强化" : "选择第二项强化";
  const eyebrow = round === 1 ? "布阵阶段 · 第一轮" : "第 10 回合 · 第二轮";
  const description = round === 1
    ? "从三张牌中选择一项。你可以刷新其中一张；双方确认阵型后同时亮出选择。"
    : "棋钟已暂停。选择并锁定后，双方同时亮出第二项强化，再继续对局；超时会保留当前选择，尚未选择则自动锁定第一张。";
  const remainingSeconds = round === 2 && deadlineAt !== null
    ? Math.max(0, Math.ceil((deadlineAt - now) / 1000))
    : null;
  const status = locked
    ? opponentLocked
      ? "双方均已锁定，正在揭示强化。"
      : "你的强化已锁定，正在等待对手。"
    : selectedId
      ? "已选中一项强化；锁定前仍可更换。"
      : "请选择一项强化。";

  useEffect(() => {
    const draft = draftRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (!draft) return;

    const keepFocusInside = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        draft.querySelectorAll<HTMLElement>(
          "button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
        ),
      ).filter((element) => element.getAttribute("aria-hidden") !== "true");
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !draft.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !draft.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };

    draft.addEventListener("keydown", keepFocusInside);
    return () => {
      draft.removeEventListener("keydown", keepFocusInside);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [round]);

  useEffect(() => {
    if (!locked) optionRefs.current[focusableIndex]?.focus();
  }, [focusableIndex, locked, round]);

  useEffect(() => {
    if (round !== 2 || deadlineAt === null) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [deadlineAt, round]);

  const handleOptionKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    const targetIndex = nextOptionIndex(event.key, currentIndex, options.length);
    if (targetIndex === null || !options[targetIndex]) return;
    event.preventDefault();
    onSelect(options[targetIndex].id);
    optionRefs.current[targetIndex]?.focus();
  };

  return (
    <section
      ref={draftRef}
      className={styles.draft}
      aria-labelledby={`augment-draft-title-${round}`}
      aria-busy={pending || refreshingSlot !== null}
    >
      <header className={styles.draftHeader}>
        <div className={styles.draftTitleGroup}>
          <p className={styles.draftEyebrow}>{eyebrow}</p>
          <h2 className={styles.draftTitle} id={`augment-draft-title-${round}`}>{title}</h2>
          <p className={styles.draftDescription}>{description}</p>
        </div>
        <div className={styles.draftHeaderMeta}>
          {remainingSeconds !== null ? (
            <p
              className={`${styles.draftTimer} ${remainingSeconds <= 10 ? styles.draftTimerUrgent : ""}`}
              role="timer"
              aria-label={remainingSeconds > 0 ? `强化选择剩余 ${remainingSeconds} 秒` : "选择已超时，正在自动锁定"}
            >
              <span>{remainingSeconds > 0 ? "剩余" : "超时"}</span>
              <strong>{remainingSeconds > 0 ? `00:${String(remainingSeconds).padStart(2, "0")}` : "自动锁定中"}</strong>
            </p>
          ) : null}
          <p className={styles.draftMeta}>
            {refreshUsed ? "本轮刷新已使用" : "可刷新一张"}
            {seenCount > 0 ? ` · 已见 ${seenCount}` : ""}
          </p>
        </div>
      </header>

      <fieldset
        className={styles.draftOptions}
        role="radiogroup"
        aria-label={`${title}，三选一`}
        disabled={locked || pending}
      >
        <legend className={styles.visuallyHidden}>选择一项强化</legend>
        {options.map((augment, index) => {
          const augmentId = augment.id;
          const selected = augment.id === selectedId;
          const cardState: AugmentCardState = locked && selected
            ? "locked"
            : selected
              ? "selected"
              : "available";
          const refreshing = refreshingSlot === index;

          return (
            <div className={styles.draftOption} key={augment.id}>
              <AugmentCard
                augment={augment}
                state={cardState}
                statusLabel={locked && !selected ? "未选择" : undefined}
                disabled={locked || pending || refreshingSlot !== null}
                onSelect={() => onSelect(augmentId)}
                onKeyDown={(event) => handleOptionKeyDown(event, index)}
                buttonRef={(node) => { optionRefs.current[index] = node; }}
                tabIndex={index === focusableIndex ? 0 : -1}
                role="radio"
                ariaChecked={selected}
              />
              <button
                className={styles.refreshButton}
                type="button"
                disabled={locked || pending || refreshUsed || refreshingSlot !== null}
                onClick={() => onRefresh(index as AugmentSlot)}
                aria-label={`刷新${augment.name}；刷新后本局不会再次出现`}
              >
                {refreshing ? "正在刷新…" : "刷新这张"}
              </button>
            </div>
          );
        })}
      </fieldset>

      <footer className={styles.draftFooter}>
        <p className={styles.draftStatus} role="status" aria-live="polite">{status}</p>
        <div className={styles.draftActions}>
          {onResign ? (
            <button
              className={styles.resignButton}
              type="button"
              disabled={pending}
              onClick={onResign}
            >
              认输
            </button>
          ) : null}
          <button
            className={styles.confirmButton}
            type="button"
            disabled={!selectedId || locked || pending || refreshingSlot !== null}
            onClick={onConfirm}
          >
            {locked ? "已锁定" : pending ? "正在锁定…" : "锁定强化"}
          </button>
        </div>
      </footer>
    </section>
  );
}
