/**
 * 染杯清洗隔离流程 —— 规则层（纯函数，不依赖存储与界面）
 *
 * 开染前三验：
 *   1. 染杯最近一次清洗回执是否存在、是否已放行且未过期（24h）
 *   2. 回执登记的残留色度是否 ≤ 限值
 *   3. 上一批为深色、本批为浅色时，是否在深色批次结束后做过放行清洗
 *      （任一不满足：排产只能转“待清洗”隔离，不得占染杯）
 *
 * 清洗放行三条件：
 *   a. 清洗人与复核人非同一人（换人复核）
 *   b. 连续两次冲洗色度达标
 *   c. 放行前残留色度达标
 *
 * 回执补录 / 更正：旧版留档（superseded），相关排产与评审失效，队列按新顺序重算。
 */

export const CHROMA_LIMIT = 0.5; // 冲洗 / 残留色度（吸光度）合格上限
export const RECEIPT_TTL_MS = 24 * 60 * 60 * 1000; // 清洗回执有效期 24h
export const REQUIRED_CONSECUTIVE_RINSES = 2; // 放行所需连续达标冲洗次数

/* ------------------------------------------------------------------ */
/* 领域类型                                                            */
/* ------------------------------------------------------------------ */

export type Depth = "light" | "medium" | "dark";

export const DEPTH_LABEL: Record<Depth, string> = {
  light: "浅色",
  medium: "中色",
  dark: "深色",
};

export type ScheduleStatus =
  | "queued" // 已排产，候杯
  | "occupying" // 开染占杯中
  | "done" // 已完成染色
  | "awaitingWash" // 校验未过：转待清洗隔离，不占杯
  | "invalid"; // 回执补录/更正后失效，待重排

export type BlockReason =
  | "NO_RECEIPT"
  | "NOT_RELEASED"
  | "EXPIRED"
  | "RESIDUAL"
  | "DARK_TO_LIGHT";

export const BLOCK_REASON_LABEL: Record<BlockReason, string> = {
  NO_RECEIPT: "无清洗回执",
  NOT_RELEASED: "清洗尚未放行",
  EXPIRED: "回执已过期（超过24小时）",
  RESIDUAL: `残留色度超限（>${CHROMA_LIMIT.toFixed(2)}）`,
  DARK_TO_LIGHT: "深色后未清洗，直接排浅色",
};

export type ReceiptReason = "normal" | "supplement" | "correction";

export const RECEIPT_REASON_LABEL: Record<ReceiptReason, string> = {
  normal: "常规清洗",
  supplement: "补录回执",
  correction: "更正回执",
};

export interface Cup {
  id: string;
  code: string;
  name: string;
}

export interface Batch {
  id: string; // 小样批次号，如 LAB-620A
  orderNo: string; // 客户订单号
  fabric: string; // 面料成分 / 品种
  depth: Depth; // 色深
  createdAt: number;
}

export interface RinseReading {
  at: number;
  chroma: number;
  pass: boolean;
}

export interface CleaningReceipt {
  id: string;
  cupId: string;
  version: number; // 同一染杯回执版本号，更正/补录递增
  reason: ReceiptReason;
  replacesId?: string; // 被本版替代的旧回执 id
  washer: string; // 清洗人
  checker?: string; // 复核人（放行时填写）
  readings: RinseReading[]; // 逐次冲洗色度记录
  residualChroma?: number; // 放行前残留色度
  createdAt: number; // 首次登记 / 回执落款时间
  releasedAt?: number; // 放行时间（有效期起算点）
  released: boolean;
  superseded: boolean; // 旧版留档标记
  supersededAt?: number;
  note?: string;
}

export interface Schedule {
  id: string;
  seq: number; // 队列序号（重算后更新）
  batchId: string;
  cupId: string;
  plannedAt: number;
  createdAt: number;
  status: ScheduleStatus;
  startedAt?: number;
  finishedAt?: number;
  failReasons: BlockReason[]; // 最近一次开染校验未过原因
}

export type ReviewResult = "pending" | "pass" | "fail";

export const REVIEW_RESULT_LABEL: Record<ReviewResult, string> = {
  pending: "待评审",
  pass: "评审通过",
  fail: "评审不通过",
};

export interface Review {
  id: string;
  scheduleId: string;
  result: ReviewResult;
  deltaE?: number; // 色差值
  valid: boolean; // 回执补录/更正后关联评审失效
  invalidReason?: string;
}

export interface CupEvent {
  id: string;
  cupId: string;
  at: number;
  category:
    | "schedule"
    | "validate"
    | "dye"
    | "wash"
    | "release"
    | "revise"
    | "requeue";
  message: string;
}

export interface CleaningState {
  version: 1;
  cups: Cup[];
  batches: Batch[];
  schedules: Schedule[];
  receipts: CleaningReceipt[];
  reviews: Review[];
  events: CupEvent[];
  seq: number;
}

/* ------------------------------------------------------------------ */
/* 时间展示                                                            */
/* ------------------------------------------------------------------ */

const pad = (n: number) => String(n).padStart(2, "0");

export function fmtDateTime(ts?: number): string {
  if (ts == null) return "—";
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

export function toDatetimeLocal(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

export function fmtRemaining(ms: number): string {
  if (ms <= 0) return "已过期";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `剩余${h}小时${m}分` : `剩余${m}分钟`;
}

/* ------------------------------------------------------------------ */
/* 回执查询                                                            */
/* ------------------------------------------------------------------ */

/** 同一染杯的回执版本链（旧版留档一并返回），按版本升序。 */
export function receiptChain(
  receipts: CleaningReceipt[],
  cupId: string
): CleaningReceipt[] {
  return receipts
    .filter((r) => r.cupId === cupId)
    .sort((a, b) => a.version - b.version || a.createdAt - b.createdAt);
}

/** 当前生效回执：未被作废的最新版本（可能仍是清洗中草稿）。 */
export function activeReceipt(
  receipts: CleaningReceipt[],
  cupId: string
): CleaningReceipt | undefined {
  return receiptChain(receipts, cupId)
    .filter((r) => !r.superseded)
    .pop();
}

export function latestReleasedReceipt(
  receipts: CleaningReceipt[],
  cupId: string
): CleaningReceipt | undefined {
  return receiptChain(receipts, cupId)
    .filter((r) => !r.superseded && r.released)
    .pop();
}

/* ------------------------------------------------------------------ */
/* 开染前三验                                                          */
/* ------------------------------------------------------------------ */

export interface PreDyeInput {
  receipt: CleaningReceipt | undefined; // 当前生效回执
  nextDepth: Depth; // 本批色深
  prevDepth?: Depth; // 上一批色深
  lastFinishedAt?: number; // 上一批染色完成时间
  now: number;
}

export interface PreDyeResult {
  ok: boolean;
  reasons: BlockReason[];
}

export function validateBeforeDye(input: PreDyeInput): PreDyeResult {
  const { receipt, nextDepth, prevDepth, lastFinishedAt, now } = input;
  const reasons: BlockReason[] = [];

  if (!receipt) {
    reasons.push("NO_RECEIPT");
  } else if (!receipt.released || receipt.releasedAt == null) {
    reasons.push("NOT_RELEASED");
  } else {
    if (now - receipt.releasedAt > RECEIPT_TTL_MS) reasons.push("EXPIRED");
    if (
      receipt.residualChroma == null ||
      receipt.residualChroma > CHROMA_LIMIT
    ) {
      reasons.push("RESIDUAL");
    }
  }

  // 深色后“直接”排浅色：放行回执晚于深色批次完成时间，才算中间隔了清洗。
  if (prevDepth === "dark" && nextDepth === "light") {
    const washedAfterDark =
      receipt?.released &&
      receipt.releasedAt != null &&
      lastFinishedAt != null &&
      receipt.releasedAt > lastFinishedAt;
    if (!washedAfterDark) reasons.push("DARK_TO_LIGHT");
  }

  return { ok: reasons.length === 0, reasons };
}

/* ------------------------------------------------------------------ */
/* 清洗放行规则                                                        */
/* ------------------------------------------------------------------ */

/** 从末尾起连续达标的冲洗次数。 */
export function consecutivePassed(readings: RinseReading[]): number {
  let n = 0;
  for (let i = readings.length - 1; i >= 0; i--) {
    if (readings[i].pass) n += 1;
    else break;
  }
  return n;
}

export interface ReleaseCheckInput {
  washer: string;
  checker: string;
  readings: RinseReading[];
  residualChroma: number | null;
}

export interface ReleaseCheckResult {
  ok: boolean;
  errors: string[];
}

export function evaluateRelease(input: ReleaseCheckInput): ReleaseCheckResult {
  const errors: string[] = [];
  if (!input.washer.trim()) errors.push("缺少清洗人");
  if (!input.checker.trim()) errors.push("缺少复核人");
  if (input.washer.trim() && input.washer.trim() === input.checker.trim()) {
    errors.push("复核人必须与清洗人不同（换人复核）");
  }
  if (consecutivePassed(input.readings) < REQUIRED_CONSECUTIVE_RINSES) {
    errors.push(
      `需连续${REQUIRED_CONSECUTIVE_RINSES}次冲洗色度≤${CHROMA_LIMIT.toFixed(
        2
      )}，当前连续${consecutivePassed(input.readings)}次`
    );
  }
  if (input.residualChroma == null || Number.isNaN(input.residualChroma)) {
    errors.push("未测定残留色度");
  } else if (input.residualChroma > CHROMA_LIMIT) {
    errors.push(`残留色度${input.residualChroma.toFixed(2)}超限`);
  }
  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ */
/* 染杯运行态聚合                                                      */
/* ------------------------------------------------------------------ */

export type CupRuntimeStatus = "idle" | "occupied" | "isolated";

export const CUP_STATUS_LABEL: Record<CupRuntimeStatus, string> = {
  idle: "可用",
  occupied: "占染中",
  isolated: "待清洗隔离",
};

export interface CupRuntime {
  cup: Cup;
  status: CupRuntimeStatus;
  receipt: CleaningReceipt | undefined; // 当前版本（含清洗中草稿）
  residualChroma?: number;
  prevDepth?: Depth;
  lastFinishedAt?: number;
  queued: Schedule[]; // 候杯 + 待清洗队列，按计划顺序
  occupying?: Schedule;
}

export function cupRuntime(
  state: CleaningState,
  cupId: string,
  now: number
): CupRuntime {
  const cup = state.cups.find((c) => c.id === cupId)!;
  const schedules = state.schedules.filter((s) => s.cupId === cupId);

  const occupying = schedules.find((s) => s.status === "occupying");

  const done = schedules
    .filter((s) => s.status === "done" && s.finishedAt != null)
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
  const prevBatch = done
    ? state.batches.find((b) => b.id === done.batchId)
    : undefined;

  const queued = schedules
    .filter((s) => s.status === "queued" || s.status === "awaitingWash")
    .sort((a, b) => a.plannedAt - b.plannedAt || a.createdAt - b.createdAt);

  const receipt = activeReceipt(state.receipts, cupId);
  const hasWaiting = schedules.some((s) => s.status === "awaitingWash");
  const washInProgress = receipt != null && !receipt.released;

  const status: CupRuntimeStatus = occupying
    ? "occupied"
    : hasWaiting || washInProgress
    ? "isolated"
    : "idle";

  return {
    cup,
    status,
    occupying,
    queued,
    receipt,
    residualChroma: receipt?.released ? receipt.residualChroma : undefined,
    prevDepth: prevBatch?.depth,
    lastFinishedAt: done?.finishedAt,
  };
}

/* ------------------------------------------------------------------ */
/* 回执补录/更正的影响面与队列重算                                     */
/* ------------------------------------------------------------------ */

export interface AffectedResult {
  /** 进行中/候杯中排产：直接置失效。 */
  active: Schedule[];
  /** 已完成排产：保留记录，仅关联评审失效。 */
  finished: Schedule[];
  reviews: Review[];
}

/**
 * 找到依赖某张回执的相关排产与评审：
 * 同染杯、时间点不早于该回执落款，即视为“在旧版回执基础上做出的安排/结论”。
 */
export function findAffected(
  state: CleaningState,
  receipt: CleaningReceipt
): AffectedResult {
  const since = receipt.createdAt;
  const sameCup = state.schedules.filter((s) => s.cupId === receipt.cupId);

  const active = sameCup.filter((s) => {
    if (s.status === "queued" || s.status === "awaitingWash") {
      return s.plannedAt >= since;
    }
    if (s.status === "occupying") return (s.startedAt ?? 0) >= since;
    return false;
  });

  const finished = sameCup.filter(
    (s) => s.status === "done" && (s.startedAt ?? 0) >= since
  );

  const ids = new Set([...active, ...finished].map((s) => s.id));
  const reviews = state.reviews.filter((r) => ids.has(r.scheduleId));

  return { active, finished, reviews };
}

/**
 * 按新顺序重算队列：候杯 / 待清洗排产按计划时间重排序号；
 * 占杯中、已完成、已失效的不参与编号。返回新数组（不改原状态）。
 */
export function resequence(schedules: Schedule[]): Schedule[] {
  const order = [...schedules].sort(
    (a, b) => a.plannedAt - b.plannedAt || a.createdAt - b.createdAt
  );
  let seq = 1;
  return order.map((s) => ({
    ...s,
    seq:
      s.status === "queued" || s.status === "awaitingWash" ? seq++ : s.seq,
  }));
}
