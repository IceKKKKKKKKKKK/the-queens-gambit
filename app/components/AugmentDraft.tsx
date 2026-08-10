"use client";

import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from "react";

import type {
  AugmentDefinition,
  AugmentId,
  AugmentSlot,
} from "@/lib/augments";

import AugmentCard, { type AugmentCardState } from "./AugmentCard";
import styles from "./Augments.module.css";
import {
  AUGMENT_DRAFT_MOTION_MS,
  augmentDraftPhaseDuration,
  reduceAugmentDraftMotion,
  type AugmentDraftMotionEvent,
  type AugmentDraftMotionPhase,
} from "./augmentMotion";

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
  onConfirm: () => boolean | void | Promise<boolean | void>;
  onResign?: () => void;
  resignLabel?: string;
  onMotionComplete?: (outcome: "docked" | "recovered") => void;
}

interface MotionVector {
  centerX: number;
  centerY: number;
  dockX: number;
  dockY: number;
}

const ZERO_VECTOR: MotionVector = {
  centerX: 0,
  centerY: 0,
  dockX: 0,
  dockY: 0,
};

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

function timerEventForPhase(phase: AugmentDraftMotionPhase): AugmentDraftMotionEvent | null {
  switch (phase) {
    case "dealing": return { type: "DEAL_FINISHED" };
    case "fading": return { type: "FADE_FINISHED" };
    case "centering": return { type: "CENTER_FINISHED" };
    case "turning": return { type: "TURN_FINISHED" };
    case "awaiting-server": return { type: "SERVER_TIMEOUT" };
    case "docking": return { type: "DOCK_FINISHED" };
    case "recovering": return { type: "RECOVERY_FINISHED" };
    default: return null;
  }
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
  resignLabel = "认输",
  onMotionComplete,
}: AugmentDraftProps) {
  const draftRef = useRef<HTMLElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const optionShellRefs = useRef<Array<HTMLDivElement | null>>([]);
  const lockRequestedRef = useRef(false);
  const pendingObservedRef = useRef(false);
  const completionReportedRef = useRef(false);
  const mountedRef = useRef(true);
  const lockAttemptRef = useRef(0);
  const previousMotionPhaseRef = useRef<AugmentDraftMotionPhase>(locked ? "settled" : "dealing");
  const [now, setNow] = useState(() => Date.now());
  const [reducedMotion, setReducedMotion] = useState(false);
  const [motionVector, setMotionVector] = useState<MotionVector>(ZERO_VECTOR);
  const [motion, dispatchMotion] = useReducer(reduceAugmentDraftMotion, {
    phase: locked ? "settled" : "dealing",
    serverAcknowledged: locked,
  });
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
  const inLockSequence = [
    "fading",
    "centering",
    "turning",
    "awaiting-server",
    "awaiting-late-server",
    "docking",
  ].includes(motion.phase);
  const motionBusy = inLockSequence || motion.phase === "recovering" || motion.phase === "settled";
  const status = motion.phase === "awaiting-server"
    ? "牌面已确认，正在等待服务器回执。"
    : motion.phase === "awaiting-late-server"
      ? "服务器响应较慢；已保留本次锁定，仍在等待最终结果。"
    : motion.phase === "recovering"
      ? "本次锁定未完成，正在恢复选择。"
      : motion.phase === "docking"
        ? "强化已锁定，正在归入你的牌盒。"
        : locked
          ? opponentLocked
            ? "双方均已锁定，正在揭示强化。"
            : "你的强化已锁定，正在等待对手。"
          : selectedId
            ? "已选中一项强化；锁定前仍可更换。"
            : "请选择一项强化。";

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      lockAttemptRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncPreference = () => setReducedMotion(media.matches);
    syncPreference();
    media.addEventListener("change", syncPreference);
    return () => media.removeEventListener("change", syncPreference);
  }, []);

  useEffect(() => {
    const draft = draftRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    if (!draft) return;

    const overlay = draft.closest<HTMLElement>(".augment-draft-overlay");
    const backgroundSiblings = overlay?.parentElement
      ? Array.from(overlay.parentElement.children)
          .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay)
          .map((element) => ({
            element,
            hadInert: element.hasAttribute("inert"),
            ariaHidden: element.getAttribute("aria-hidden"),
          }))
      : [];
    for (const { element } of backgroundSiblings) {
      element.setAttribute("inert", "");
      element.setAttribute("aria-hidden", "true");
    }

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
      for (const { element, hadInert, ariaHidden } of backgroundSiblings) {
        if (!hadInert) element.removeAttribute("inert");
        if (ariaHidden === null) element.removeAttribute("aria-hidden");
        else element.setAttribute("aria-hidden", ariaHidden);
      }
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [round]);

  useEffect(() => {
    if (!locked && !motionBusy) optionRefs.current[focusableIndex]?.focus();
  }, [focusableIndex, locked, motionBusy, round]);

  useEffect(() => {
    if (round !== 2 || deadlineAt === null) return;
    const tick = () => setNow(Date.now());
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [deadlineAt, round]);

  useEffect(() => {
    const event = timerEventForPhase(motion.phase);
    const duration = augmentDraftPhaseDuration(motion.phase, options.length, reducedMotion);
    if (!event || duration === null) return;
    const timer = window.setTimeout(() => {
      dispatchMotion(event);
    }, Math.max(0, duration));
    return () => window.clearTimeout(timer);
  }, [motion.phase, options.length, reducedMotion]);

  useEffect(() => {
    if (!locked) return;
    dispatchMotion({
      type: lockRequestedRef.current ? "SERVER_LOCKED" : "SERVER_LOCKED_PASSIVE",
    });
  }, [locked]);

  useEffect(() => {
    if (!lockRequestedRef.current) return;
    if (pending) pendingObservedRef.current = true;
    if (
      !pending &&
      pendingObservedRef.current &&
      !locked &&
      ["fading", "centering", "turning", "awaiting-server", "awaiting-late-server"].includes(motion.phase)
    ) {
      pendingObservedRef.current = false;
      dispatchMotion({ type: "SERVER_REJECTED" });
    }
  }, [locked, motion.phase, pending]);

  useEffect(() => {
    const previousPhase = previousMotionPhaseRef.current;
    previousMotionPhaseRef.current = motion.phase;
    if (!lockRequestedRef.current || completionReportedRef.current) return;
    if (motion.phase === "settled") {
      completionReportedRef.current = true;
      onMotionComplete?.("docked");
    } else if (
      motion.phase === "choosing" &&
      (previousPhase === "recovering" || previousPhase === "awaiting-late-server")
    ) {
      completionReportedRef.current = true;
      lockRequestedRef.current = false;
      onMotionComplete?.("recovered");
    }
  }, [motion.phase, onMotionComplete]);

  const handleOptionKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) => {
    const targetIndex = nextOptionIndex(event.key, currentIndex, options.length);
    if (targetIndex === null || !options[targetIndex] || motionBusy) return;
    event.preventDefault();
    onSelect(options[targetIndex].id);
    optionRefs.current[targetIndex]?.focus();
  };

  const measureMotionVector = () => {
    const selectedShell = optionShellRefs.current[selectedIndex];
    if (!selectedShell) return ZERO_VECTOR;
    const cardRect = selectedShell.getBoundingClientRect();
    const cardCenterX = cardRect.left + cardRect.width / 2;
    const cardCenterY = cardRect.top + cardRect.height / 2;
    const draftRect = draftRef.current?.getBoundingClientRect();
    const centerX = (draftRect ? draftRect.left + draftRect.width / 2 : window.innerWidth / 2) - cardCenterX;
    const centerY = Math.max(
      -window.innerHeight,
      Math.min(window.innerHeight, window.innerHeight / 2 - cardCenterY),
    );
    const dockTarget = document.querySelector<HTMLElement>("[data-augment-dock-target='true']");
    const dockRect = dockTarget?.getBoundingClientRect();
    const fallbackX = Math.max(24, window.innerWidth * 0.12);
    const fallbackY = Math.min(window.innerHeight - 60, window.innerHeight * 0.72);
    const dockCenterX = dockRect ? dockRect.left + dockRect.width / 2 : fallbackX;
    const dockCenterY = dockRect
      ? dockRect.top + Math.min(dockRect.height * 0.58, 132)
      : fallbackY;
    return {
      centerX,
      centerY,
      dockX: dockCenterX - cardCenterX,
      dockY: dockCenterY - cardCenterY,
    };
  };

  const requestLock = () => {
    if (!selectedId || locked || pending || motion.phase !== "choosing" || lockRequestedRef.current) return;
    lockRequestedRef.current = true;
    pendingObservedRef.current = false;
    completionReportedRef.current = false;
    setMotionVector(measureMotionVector());
    dispatchMotion({ type: "LOCK_REQUESTED" });
    const attempt = lockAttemptRef.current + 1;
    lockAttemptRef.current = attempt;
    try {
      const result = onConfirm();
      if (result && typeof (result as PromiseLike<boolean | void>).then === "function") {
        void Promise.resolve(result).then(
          (accepted) => {
            if (!mountedRef.current || lockAttemptRef.current !== attempt) return;
            dispatchMotion({ type: accepted === false ? "SERVER_REJECTED" : "SERVER_LOCKED" });
          },
          () => {
            if (!mountedRef.current || lockAttemptRef.current !== attempt) return;
            dispatchMotion({ type: "SERVER_REJECTED" });
          },
        );
      } else if (result === false) {
        dispatchMotion({ type: "SERVER_REJECTED" });
      }
    } catch {
      dispatchMotion({ type: "SERVER_REJECTED" });
    }
  };

  return (
    <section
      ref={draftRef}
      className={styles.draft}
      aria-labelledby={`augment-draft-title-${round}`}
      aria-busy={pending || refreshingSlot !== null || inLockSequence}
      data-animation-phase={motion.phase}
      data-reduced-motion={reducedMotion ? "true" : "false"}
      style={{
        "--augment-deal-ms": `${AUGMENT_DRAFT_MOTION_MS.dealCard}ms`,
        "--augment-deal-stagger-ms": `${AUGMENT_DRAFT_MOTION_MS.dealStagger}ms`,
        "--augment-fade-ms": `${AUGMENT_DRAFT_MOTION_MS.fadeAlternatives}ms`,
        "--augment-center-ms": `${AUGMENT_DRAFT_MOTION_MS.centerSelection}ms`,
        "--augment-turn-ms": `${AUGMENT_DRAFT_MOTION_MS.turnSelection}ms`,
        "--augment-dock-ms": `${AUGMENT_DRAFT_MOTION_MS.dockSelection}ms`,
        "--augment-recover-ms": `${AUGMENT_DRAFT_MOTION_MS.recoverSelection}ms`,
      } as CSSProperties}
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
        disabled={locked || pending || motionBusy}
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
          const shellStyle = {
            "--card-motion-index": index,
            "--card-center-x": `${selected ? motionVector.centerX : 0}px`,
            "--card-center-y": `${selected ? motionVector.centerY : 0}px`,
            "--card-dock-x": `${selected ? motionVector.dockX : 0}px`,
            "--card-dock-y": `${selected ? motionVector.dockY : 0}px`,
          } as CSSProperties;

          return (
            <div
              className={styles.draftOption}
              key={augment.id}
              ref={(node) => { optionShellRefs.current[index] = node; }}
              data-card-motion-index={index}
              data-selected={selected ? "true" : "false"}
              data-card-motion={selected ? motion.phase : motion.phase === "dealing" ? "dealing" : "alternative"}
              style={shellStyle}
            >
              <AugmentCard
                augment={augment}
                state={cardState}
                statusLabel={locked && !selected ? "未选择" : undefined}
                disabled={locked || pending || refreshingSlot !== null || motionBusy}
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
                disabled={locked || pending || refreshUsed || refreshingSlot !== null || motionBusy}
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
              {resignLabel}
            </button>
          ) : null}
          <button
            className={styles.confirmButton}
            type="button"
            disabled={!selectedId || locked || pending || refreshingSlot !== null || motion.phase !== "choosing"}
            onClick={requestLock}
          >
            {locked ? "已锁定" : pending ? "正在锁定…" : inLockSequence ? "正在收牌…" : "锁定强化"}
          </button>
        </div>
      </footer>
    </section>
  );
}
