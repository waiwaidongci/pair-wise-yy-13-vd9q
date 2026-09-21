/**
 * 染杯清洗隔离流程 —— 业务规则层（纯函数，不依赖 React / localStorage）
 *
 * 负责：
 * 1. 开染前校验：最近一次清洗回执有效期、残留色度、深色后直接排浅色；
 * 2. 清洗放行：换人复核、连续两次冲洗色度达标；
 * 3. 排产重算：回执补录/更正后按排产顺序重新占杯，违规则只能“待清洗”。
 */

// ---------- 常量与阈值 ----------

/** 残留色度上限（水洗液比色，≤ 该值视为达标） */
export const RESIDUAL_LIMIT = 0.5;
/** 清洗回执有效期：24 小时 */
export const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000;
/** 放行所需的连续达标冲洗次数 */
export const REQUIRED_RINSES = 2;

// ---------- 类型定义 ----------

export type CupStatus = "可用" | "待清洗" | "清洗中";
export type ColorDepth = "浅" | "中" | "深";
export type ScheduleStatus = "排队中" | "待清洗" | "已占杯" | "已完成";
export type ReviewVerdict = "待评审" | "通过" | "不通过";

/** 开染阻断原因 */
export type BlockerCode =
  | "NO_RECEIPT" // 无有效清洗回执
  | "RECEIPT_EXPIRED" // 回执过期
  | "RESIDUAL_OVER_LIMIT" // 残留色度超限
  | "DARK_TO_LIGHT"; // 深色后未清洗直接排浅色

export interface RinseReading {
  at: number;
  residual: number;
}

export interface CleaningReceipt {
  id: string;
  cupId: string;
  /** 版本号，更正一次 +1；旧版 superseded=true 留档 */
  version: number;
  superseded: boolean;
  washedBy: string;
  reviewedBy: string;
  /** 回执签发时间（补录时可为历史时间） */
  issuedAt: number;
  /** 放行时的连续冲洗读数 */
  rinses: RinseReading[];
  /** 放行时残留色度（取末次冲洗值） */
  residual: number;
  note?: string;
}

export interface BatchSchedule {
  id: string;
  orderNo: string;
  fabric: string;
  depth: ColorDepth;
  /** 排产顺序，重算时按该值升序占杯 */
  seq: number;
  status: ScheduleStatus;
  cupId?: string;
  assignedAt?: number;
  startedAt?: number;
  completedAt?: number;
  review: ReviewVerdict;
  /** 回执补录/更正导致评审失效时置 true，回到待评审 */
  reviewInvalid?: boolean;
  blockers?: BlockerCode[];
}

export interface DyeCup {
  id: string;
  label: string;
  status: CupStatus;
  /** 当前残留色度快检值 */
  residual: number;
  /** 当前占用该杯的排产单（染色中） */
  occupiedBy?: string;
  lastBatchId?: string;
  lastBatchDepth?: ColorDepth;
  lastBatchCompletedAt?: number;
  /** 清洗中暂存：清洗人、逐次冲洗读数、复核人 */
  draft?: {
    startedAt: number;
    washer: string;
    rinses: RinseReading[];
    reviewedBy?: string;
  };
}

export interface AuditEvent {
  at: number;
  type:
    | "占杯"
    | "转待清洗"
    | "开染"
    | "完成"
    | "评审"
    | "开始清洗"
    | "冲洗"
    | "放行"
    | "回执补录"
    | "回执更正"
    | "旧版留档"
    | "排产重算"
    | "残留快检";
  cupId?: string;
  batchId?: string;
  receiptId?: string;
  version?: number;
  detail: string;
}

// ---------- 回执查询 ----------

export function receiptsOfCup(receipts: CleaningReceipt[], cupId: string): CleaningReceipt[] {
  return receipts
    .filter((r) => r.cupId === cupId)
    .sort((a, b) => b.version - a.version || b.issuedAt - a.issuedAt);
}

/** 最近一次生效回执（旧版留档不参与校验） */
export function latestReceipt(
  receipts: CleaningReceipt[],
  cupId: string
): CleaningReceipt | undefined {
  return receiptsOfCup(receipts, cupId).find((r) => !r.superseded);
}

export function isReceiptExpired(receipt: CleaningReceipt, now: number): boolean {
  return now - receipt.issuedAt > RECEIPT_TTL_MS;
}

// ---------- 开染前校验 ----------

export interface CupReadiness {
  ready: boolean;
  blockers: BlockerCode[];
  receipt?: CleaningReceipt;
}

/**
 * 校验某染杯能否承接指定色深的排产：
 * - 回执过期 / 无回执（曾用过的杯）→ 阻断；
 * - 残留色度超 0.5 → 阻断；
 * - 上一批为深色、本批为浅色，且没有一批完成后签发的回执 → 深色直排浅色，阻断。
 */
export function evaluateCupForBatch(
  cup: DyeCup,
  targetDepth: ColorDepth,
  receipts: CleaningReceipt[],
  now: number
): CupReadiness {
  const blockers: BlockerCode[] = [];
  const receipt = latestReceipt(receipts, cup.id);
  const usedBefore = Boolean(cup.lastBatchId);

  // 深色后直接排浅色：回执必须晚于上一批深色完成时间
  const darkToLightWithoutCleaning =
    cup.lastBatchDepth === "深" &&
    targetDepth === "浅" &&
    (!receipt ||
      (cup.lastBatchCompletedAt !== undefined && receipt.issuedAt < cup.lastBatchCompletedAt));
  if (darkToLightWithoutCleaning) blockers.push("DARK_TO_LIGHT");

  if (usedBefore && !receipt) blockers.push("NO_RECEIPT");
  if (receipt && isReceiptExpired(receipt, now)) blockers.push("RECEIPT_EXPIRED");
  if (cup.residual > RESIDUAL_LIMIT) blockers.push("RESIDUAL_OVER_LIMIT");

  return { ready: blockers.length === 0, blockers, receipt };
}

export const BLOCKER_LABEL: Record<BlockerCode, string> = {
  NO_RECEIPT: "无清洗回执",
  RECEIPT_EXPIRED: "回执已过期(>24h)",
  RESIDUAL_OVER_LIMIT: "残留色度超限(>0.5)",
  DARK_TO_LIGHT: "深色后直排浅色",
};

// ---------- 清洗放行校验 ----------

export type ReleaseErrorCode =
  | "NOT_IN_CLEANING"
  | "MISSING_WASHER"
  | "MISSING_REVIEWER"
  | "SAME_PERSON"
  | "NOT_ENOUGH_RINSES"
  | "RINSE_NOT_QUALIFIED";

export const RELEASE_ERROR_LABEL: Record<ReleaseErrorCode, string> = {
  NOT_IN_CLEANING: "染杯不在清洗中",
  MISSING_WASHER: "缺少清洗执行人",
  MISSING_REVIEWER: "缺少换人复核人",
  SAME_PERSON: "复核人与清洗人不能为同一人",
  NOT_ENOUGH_RINSES: `需连续 ${REQUIRED_RINSES} 次冲洗记录`,
  RINSE_NOT_QUALIFIED: `最后 ${REQUIRED_RINSES} 次冲洗色度须均 ≤ ${RESIDUAL_LIMIT}`,
};

/** 清洗放行：换人复核 + 连续两次冲洗达标 */
export function validateRelease(cup: DyeCup): ReleaseErrorCode[] {
  const errors: ReleaseErrorCode[] = [];
  const draft = cup.draft;
  if (cup.status !== "清洗中" || !draft) {
    errors.push("NOT_IN_CLEANING");
    return errors;
  }
  const washer = draft.washer.trim();
  const reviewer = draft.reviewedBy?.trim() ?? "";
  if (!washer) errors.push("MISSING_WASHER");
  if (!reviewer) errors.push("MISSING_REVIEWER");
  if (washer && reviewer && washer === reviewer) errors.push("SAME_PERSON");
  if (draft.rinses.length < REQUIRED_RINSES) {
    errors.push("NOT_ENOUGH_RINSES");
  } else {
    const lastTwo = draft.rinses.slice(-REQUIRED_RINSES);
    if (lastTwo.some((r) => r.residual > RESIDUAL_LIMIT)) errors.push("RINSE_NOT_QUALIFIED");
  }
  return errors;
}

// ---------- 排产重算 ----------

export interface RecomputeResult {
  batches: BatchSchedule[];
  cups: DyeCup[];
  /** 本次重算新发生的占杯 / 转待清洗审计项 */
  events: AuditEvent[];
}

/**
 * 按排产顺序（seq 升序）重新为所有未完成排产分配染杯：
 * - 只允许状态“可用”且未被占用的染杯占杯；
 * - 任一校验不通过 → 排产转“待清洗”，不占杯，并把候选染杯挂入清洗队列；
 * - 已占杯（染色中）与已完成的排产不受影响。
 */
export function recomputeScheduling(
  batchesInput: BatchSchedule[],
  cupsInput: DyeCup[],
  receipts: CleaningReceipt[],
  now: number
): RecomputeResult {
  const events: AuditEvent[] = [];
  // 占杯关系完全由本函数重算，先清空再重建
  const cups: DyeCup[] = cupsInput.map((c) => ({ ...c, occupiedBy: undefined }));

  // 已占杯（含已开染）排产继续锁定染杯；已完成批次不占杯
  for (const b of batchesInput) {
    if (b.cupId && b.status === "已占杯") {
      const cup = cups.find((c) => c.id === b.cupId);
      if (cup) cup.occupiedBy = b.id;
    }
  }

  const locked = new Set(["已占杯", "已完成"] as ScheduleStatus[]);
  const open = batchesInput
    .filter((b) => !locked.has(b.status))
    .slice()
    .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id))
    .map<BatchSchedule>((b) => ({
      ...b,
      status: "排队中",
      cupId: undefined,
      assignedAt: undefined,
      blockers: undefined,
    }));

  const nextBatches: BatchSchedule[] = batchesInput
    .filter((b) => locked.has(b.status))
    .map((b) => ({ ...b }));

  for (const batch of open) {
    const available = cups.filter((c) => c.status === "可用" && !c.occupiedBy);
    const good = available.find(
      (c) => evaluateCupForBatch(c, batch.depth, receipts, now).ready
    );

    if (good) {
      good.occupiedBy = batch.id;
      nextBatches.push({
        ...batch,
        status: "已占杯",
        cupId: good.id,
        assignedAt: now,
      });
      events.push({
        at: now,
        type: "占杯",
        cupId: good.id,
        batchId: batch.id,
        detail: `排产 ${batch.id}（${batch.depth}色）按顺序占用 ${good.id}`,
      });
      continue;
    }

    // 没有可直接占杯的：优先选一只可用染杯挂入清洗队列；否则挂第一只非清洗中的候选
    const candidate =
      available[0] ?? cups.filter((c) => c.status !== "清洗中" && !c.occupiedBy)[0];
    const blockers = candidate
      ? evaluateCupForBatch(candidate, batch.depth, receipts, now).blockers
      : (["NO_RECEIPT"] as BlockerCode[]);

    if (candidate && candidate.status === "可用") {
      candidate.status = "待清洗";
      events.push({
        at: now,
        type: "转待清洗",
        cupId: candidate.id,
        batchId: batch.id,
        detail: `排产 ${batch.id} 校验未过（${blockers
          .map((x) => BLOCKER_LABEL[x])
          .join("、")}），${candidate.id} 转待清洗，不占杯`,
      });
    }

    nextBatches.push({
      ...batch,
      status: "待清洗",
      cupId: candidate?.id,
      blockers: blockers.length ? blockers : ["NO_RECEIPT"],
    });
  }

  nextBatches.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  return { batches: nextBatches, cups, events };
}

/** 回执补录/更正后，找出受影响的对象 */
export function affectedByReceiptChange(
  batchesInput: BatchSchedule[],
  cupId: string
): { openSchedules: BatchSchedule[]; invalidReviews: BatchSchedule[] } {
  return {
    openSchedules: batchesInput.filter(
      (b) => b.cupId === cupId && (b.status === "排队中" || b.status === "待清洗")
    ),
    invalidReviews: batchesInput.filter(
      (b) => b.cupId === cupId && b.status === "已完成" && b.review !== "待评审"
    ),
  };
}
