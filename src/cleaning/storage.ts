/**
 * 染杯清洗隔离流程 —— 存储层
 *
 * 负责：localStorage 持久化、动作落地、事件履历、回执版本留档、
 * 补录/更正后的失效级联与队列重算。规则判断全部调用 rules.ts。
 */

import { useSyncExternalStore } from "react";
import {
  AffectedResult,
  Batch,
  BlockReason,
  CleaningReceipt,
  CleaningState,
  Cup,
  CupEvent,
  Depth,
  Review,
  ReviewResult,
  RinseReading,
  Schedule,
  CHROMA_LIMIT,
  RECEIPT_REASON_LABEL,
  activeReceipt,
  cupRuntime,
  findAffected,
  latestReleasedReceipt,
  receiptChain,
  resequence,
  validateBeforeDye,
} from "./rules";

const STORAGE_KEY = "hxyfront-62012-cleaning-v1";
const EVENT_LIMIT = 200;

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

const HOUR = 60 * 60 * 1000;

let uidSeq = 0;
export function uid(prefix: string): string {
  uidSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${uidSeq}-${Math.random()
    .toString(36)
    .slice(2, 6)}`;
}

export interface ActionResult {
  ok: boolean;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* 种子数据                                                            */
/* ------------------------------------------------------------------ */

function buildSeed(now: number): CleaningState {
  const cups: Cup[] = [
    { id: "cup-1", code: "C-01", name: "红外打样染杯 1#" },
    { id: "cup-2", code: "C-02", name: "红外打样染杯 2#" },
    { id: "cup-3", code: "C-03", name: "甘油打样染杯 3#" },
  ];

  const batches: Batch[] = [
    {
      id: "LAB-621C",
      orderNo: "SO-8802",
      fabric: "涤纶针织",
      depth: "dark",
      createdAt: now - 27 * HOUR,
    },
    {
      id: "LAB-625A",
      orderNo: "SO-8804",
      fabric: "棉府绸90g",
      depth: "light",
      createdAt: now - 40 * 60000,
    },
    {
      id: "LAB-620A",
      orderNo: "SO-8801",
      fabric: "棉府绸120g",
      depth: "light",
      createdAt: now - 8 * HOUR,
    },
    {
      id: "LAB-624B",
      orderNo: "SO-8803",
      fabric: "混纺斜纹",
      depth: "medium",
      createdAt: now - 2 * HOUR,
    },
    {
      id: "LAB-619N",
      orderNo: "SO-8799",
      fabric: "锦纶泳布",
      depth: "light",
      createdAt: now - 50 * HOUR,
    },
  ];

  const schedules: Schedule[] = [
    {
      id: "sch-1",
      seq: 0,
      batchId: "LAB-621C",
      cupId: "cup-1",
      plannedAt: now - 27 * HOUR,
      createdAt: now - 27 * HOUR,
      status: "done",
      startedAt: now - 24 * HOUR,
      finishedAt: now - 20 * HOUR,
      failReasons: [],
    },
    {
      id: "sch-2",
      seq: 1,
      batchId: "LAB-625A",
      cupId: "cup-1",
      plannedAt: now + HOUR,
      createdAt: now - 40 * 60000,
      status: "awaitingWash",
      failReasons: ["EXPIRED", "DARK_TO_LIGHT"],
    },
    {
      id: "sch-3",
      seq: 0,
      batchId: "LAB-620A",
      cupId: "cup-2",
      plannedAt: now - 8 * HOUR,
      createdAt: now - 8 * HOUR,
      status: "done",
      startedAt: now - 6 * HOUR,
      finishedAt: now - 4 * HOUR,
      failReasons: [],
    },
    {
      id: "sch-4",
      seq: 1,
      batchId: "LAB-624B",
      cupId: "cup-2",
      plannedAt: now + 3 * HOUR,
      createdAt: now - 2 * HOUR,
      status: "queued",
      failReasons: [],
    },
    {
      id: "sch-5",
      seq: 0,
      batchId: "LAB-619N",
      cupId: "cup-3",
      plannedAt: now - 50 * HOUR,
      createdAt: now - 50 * HOUR,
      status: "done",
      startedAt: now - 49 * HOUR,
      finishedAt: now - 48 * HOUR,
      failReasons: [],
    },
  ];

  const receipts: CleaningReceipt[] = [
    {
      id: "rcp-1",
      cupId: "cup-1",
      version: 1,
      reason: "normal",
      washer: "王强",
      checker: "李敏",
      readings: [
        { at: now - 25.5 * HOUR, chroma: 0.41, pass: true },
        { at: now - 25.2 * HOUR, chroma: 0.3, pass: true },
      ],
      residualChroma: 0.32,
      createdAt: now - 25.5 * HOUR,
      releasedAt: now - 25 * HOUR,
      released: true,
      superseded: false,
      note: "深色后常规冲洗",
    },
    {
      id: "rcp-2",
      cupId: "cup-2",
      version: 1,
      reason: "normal",
      washer: "周敏",
      checker: "王强",
      readings: [
        { at: now - 6.5 * HOUR, chroma: 0.38, pass: true },
        { at: now - 6.2 * HOUR, chroma: 0.22, pass: true },
      ],
      residualChroma: 0.21,
      createdAt: now - 6.5 * HOUR,
      releasedAt: now - 6 * HOUR,
      released: true,
      superseded: false,
    },
    {
      id: "rcp-3",
      cupId: "cup-3",
      version: 1,
      reason: "normal",
      washer: "王强",
      readings: [{ at: now - 25 * 60000, chroma: 0.44, pass: true }],
      createdAt: now - 45 * 60000,
      released: false,
      superseded: false,
      note: "第一次冲洗已达标，待第二次",
    },
  ];

  const reviews: Review[] = [
    { id: "rev-1", scheduleId: "sch-1", result: "pass", deltaE: 1.24, valid: true },
    { id: "rev-2", scheduleId: "sch-3", result: "pass", deltaE: 0.84, valid: true },
    { id: "rev-3", scheduleId: "sch-5", result: "pass", deltaE: 0.66, valid: true },
  ];

  const ev = (
    id: string,
    cupId: string,
    at: number,
    category: CupEvent["category"],
    message: string
  ): CupEvent => ({ id, cupId, at, category, message });

  const events: CupEvent[] = [
    ev("evt-s1", "cup-1", now - 24 * HOUR, "dye", "LAB-621C 深色开染占杯"),
    ev("evt-s2", "cup-1", now - 20 * HOUR, "dye", "LAB-621C 深色染色完成"),
    ev(
      "evt-s3",
      "cup-1",
      now - 40 * 60000,
      "validate",
      "LAB-625A 浅色校验拦截：回执过期 + 深色后直接排浅色 → 转待清洗"
    ),
    ev("evt-s4", "cup-2", now - 6 * HOUR, "release", "回执 v1 放行：连续2次达标，残留0.21"),
    ev("evt-s5", "cup-2", now - 6 * HOUR, "dye", "LAB-620A 开染占杯"),
    ev("evt-s6", "cup-2", now - 4 * HOUR, "dye", "LAB-620A 染色完成，评审通过 ΔE 0.84"),
    ev("evt-s7", "cup-3", now - 45 * 60000, "wash", "登记清洗 v1，清洗人：王强"),
    ev("evt-s8", "cup-3", now - 25 * 60000, "wash", "第1次冲洗色度 0.44 达标"),
  ];

  return {
    version: 1,
    cups,
    batches,
    schedules,
    receipts,
    reviews,
    events,
    seq: schedules.length + 1,
  };
}

/* ------------------------------------------------------------------ */
/* 存储与订阅                                                          */
/* ------------------------------------------------------------------ */

function load(): CleaningState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CleaningState;
      if (parsed.version === 1) return parsed;
    }
  } catch {
    /* 读取失败则重新播种 */
  }
  return buildSeed(Date.now());
}

let state: CleaningState = load();

function persist(next: CleaningState) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* 隐私模式等场景下放行内存态 */
  }
}

const listeners = new Set<() => void>();

function commit(mutate: (draft: CleaningState) => void): ActionResult {
  const next = structuredClone(state) as CleaningState;
  try {
    mutate(next);
    next.schedules = resequence(next.schedules);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  state = next;
  persist(state);
  listeners.forEach((fn) => fn());
  return { ok: true };
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 所有视图共用同一份状态引用，刷新后从 localStorage 恢复，天然一致。 */
export function useCleaningStore(): CleaningState {
  return useSyncExternalStore(subscribe, () => state);
}

export function getSnapshot(): CleaningState {
  return state;
}

export function resetDemo(): ActionResult {
  state = buildSeed(Date.now());
  persist(state);
  listeners.forEach((fn) => fn());
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* 内部工具                                                            */
/* ------------------------------------------------------------------ */

function log(
  draft: CleaningState,
  cupId: string,
  category: CupEvent["category"],
  message: string
) {
  draft.events.unshift({ id: uid("evt"), cupId, at: Date.now(), category, message });
  if (draft.events.length > EVENT_LIMIT) {
    draft.events = draft.events.slice(0, EVENT_LIMIT);
  }
}

function precheck(
  draft: CleaningState,
  cupId: string,
  nextDepth: Depth,
  now: number
) {
  const rt = cupRuntime(draft, cupId, now);
  return validateBeforeDye({
    receipt: rt.receipt,
    nextDepth,
    prevDepth: rt.prevDepth,
    lastFinishedAt: rt.lastFinishedAt,
    now,
  });
}

export function cupName(draft: CleaningState, cupId: string): string {
  return draft.cups.find((c) => c.id === cupId)?.code ?? cupId;
}

export function batchOf(draft: CleaningState, batchId: string): Batch | undefined {
  return draft.batches.find((b) => b.id === batchId);
}

/* ------------------------------------------------------------------ */
/* 动作：排产与开染                                                    */
/* ------------------------------------------------------------------ */

export interface NewScheduleInput {
  batchId: string;
  orderNo: string;
  fabric: string;
  depth: Depth;
  cupId: string;
  plannedAt: number;
}

/** 新增排产：落单即做开染前三验，不过只能落“待清洗”，不占染杯。 */
export function addSchedule(input: NewScheduleInput): ActionResult {
  if (!input.batchId.trim()) return { ok: false, error: "请填写批次号" };
  if (Number.isNaN(input.plannedAt))
    return { ok: false, error: "请选择计划时间" };

  return commit((draft) => {
    const exists = draft.batches.some((b) => b.id === input.batchId.trim());
    if (!exists) {
      draft.batches.unshift({
        id: input.batchId.trim(),
        orderNo: input.orderNo.trim() || "未填订单",
        fabric: input.fabric.trim() || "未填面料",
        depth: input.depth,
        createdAt: Date.now(),
      });
    }

    const now = Date.now();
    const check = precheck(draft, input.cupId, input.depth, now);
    const schedule: Schedule = {
      id: uid("sch"),
      seq: 0,
      batchId: input.batchId.trim(),
      cupId: input.cupId,
      plannedAt: input.plannedAt,
      createdAt: now,
      status: check.ok ? "queued" : "awaitingWash",
      failReasons: check.reasons,
    };
    draft.schedules.push(schedule);

    log(
      draft,
      input.cupId,
      "schedule",
      check.ok
        ? `排产 ${schedule.batchId}：三验通过，进入候杯队列`
        : `排产 ${schedule.batchId}：${check.reasons.join("、")} → 转待清洗，不占染杯`
    );
  });
}

/** 开染前再次三验；不通过继续隔离。 */
export function attemptStart(scheduleId: string): ActionResult {
  const sch = state.schedules.find((s) => s.id === scheduleId);
  if (!sch) return { ok: false, error: "排产不存在" };
  if (sch.status === "occupying")
    return { ok: false, error: "该排产已占染杯中" };
  if (sch.status === "done") return { ok: false, error: "该排产已完成" };
  if (sch.status === "invalid")
    return { ok: false, error: "排产已失效，请先按新回执重排" };

  return commit((draft) => {
    const target = draft.schedules.find((s) => s.id === scheduleId)!;
    const occupied = draft.schedules.some(
      (s) => s.cupId === target.cupId && s.status === "occupying"
    );
    if (occupied) throw new Error("染杯已被其它批次占用");

    const batch = batchOf(draft, target.batchId)!;
    const check = precheck(draft, target.cupId, batch.depth, Date.now());
    target.failReasons = check.reasons;

    if (!check.ok) {
      target.status = "awaitingWash";
      log(
        draft,
        target.cupId,
        "validate",
        `${target.batchId} 开染拦截：${check.reasons.join("、")}，维持待清洗`
      );
      throw new Error(`开染校验未通过：${check.reasons.join("、")}`);
    }

    target.status = "occupying";
    target.startedAt = Date.now();
    log(draft, target.cupId, "dye", `${target.batchId} 三验通过，开染占杯`);
  });
}

export interface FinishInput {
  scheduleId: string;
  result: ReviewResult;
  deltaE: number | null;
}

/** 完成染色并登记评审；完成后染杯等待新一轮清洗。 */
export function finishSchedule(input: FinishInput): ActionResult {
  const sch = state.schedules.find((s) => s.id === input.scheduleId);
  if (!sch || sch.status !== "occupying")
    return { ok: false, error: "仅占染中的排产可完工" };

  return commit((draft) => {
    const target = draft.schedules.find((s) => s.id === input.scheduleId)!;
    target.status = "done";
    target.finishedAt = Date.now();

    draft.reviews.push({
      id: uid("rev"),
      scheduleId: target.id,
      result: input.result,
      deltaE: input.deltaE ?? undefined,
      valid: true,
    });

    log(
      draft,
      target.cupId,
      "dye",
      `${target.batchId} 染色完成，评审：${
        input.result === "pass" ? "通过" : "不通过"
      }${input.deltaE != null ? ` ΔE ${input.deltaE.toFixed(2)}` : ""}`
    );
  });
}

/* ------------------------------------------------------------------ */
/* 动作：清洗登记、冲洗、换人复核放行                                  */
/* ------------------------------------------------------------------ */

/** 开新清洗单（同染杯存在未放行清洗单时拒绝重复登记）。 */
export function startWash(cupId: string, washer: string): ActionResult {
  if (!washer.trim()) return { ok: false, error: "请填写清洗人" };
  const occupied = state.schedules.some(
    (s) => s.cupId === cupId && s.status === "occupying"
  );
  if (occupied) return { ok: false, error: "染杯染色中，无法清洗" };

  const current = activeReceipt(state.receipts, cupId);
  if (current && !current.released)
    return { ok: false, error: "存在未放行的清洗单，请先完成冲洗与复核" };

  return commit((draft) => {
    const version = receiptChain(draft.receipts, cupId).length + 1;
    const receipt: CleaningReceipt = {
      id: uid("rcp"),
      cupId,
      version,
      reason: "normal",
      washer: washer.trim(),
      readings: [],
      createdAt: Date.now(),
      released: false,
      superseded: false,
    };
    draft.receipts.push(receipt);
    log(draft, cupId, "wash", `登记清洗 v${version}，清洗人：${washer.trim()}`);
  });
}

/** 追加一次冲洗色度（达标线 0.50）。 */
export function addRinse(receiptId: string, chroma: number): ActionResult {
  const receipt = state.receipts.find((r) => r.id === receiptId);
  if (!receipt) return { ok: false, error: "回执不存在" };
  if (receipt.superseded) return { ok: false, error: "回执已被新版替代，只读留档" };
  if (receipt.released) return { ok: false, error: "回执已放行" };
  if (Number.isNaN(chroma)) return { ok: false, error: "请填写色度数值" };

  return commit((draft) => {
    const target = draft.receipts.find((r) => r.id === receiptId)!;
    const reading: RinseReading = {
      at: Date.now(),
      chroma,
      pass: chroma <= CHROMA_LIMIT,
    };
    target.readings.push(reading);
    log(
      draft,
      target.cupId,
      "wash",
      `第${target.readings.length}次冲洗色度 ${chroma.toFixed(
        2
      )}：${reading.pass ? "达标" : "超标，连续计数清零"}`
    );
  });
}

export interface ReleaseInput {
  receiptId: string;
  checker: string;
  residualChroma: number;
  note?: string;
}

/** 换人复核 + 连续两次达标 + 残留达标，满足后放行，并自动重验隔离队列。 */
export function releaseReceipt(input: ReleaseInput): ActionResult {
  const receipt = state.receipts.find((r) => r.id === input.receiptId);
  if (!receipt) return { ok: false, error: "回执不存在" };
  if (receipt.superseded) return { ok: false, error: "回执已被新版替代" };
  if (receipt.released) return { ok: false, error: "回执已放行" };

  return commit((draft) => {
    const target = draft.receipts.find((r) => r.id === input.receiptId)!;
    const checker = input.checker.trim();
    const residual = input.residualChroma;

    if (checker && checker === target.washer.trim())
      throw new Error("复核人必须与清洗人不同（换人复核）");

    const passes = target.readings.filter((r) => r.pass);
    let run = 0;
    for (let i = target.readings.length - 1; i >= 0; i--) {
      if (target.readings[i].pass) run += 1;
      else break;
    }
    if (run < 2)
      throw new Error(`需连续2次冲洗达标，当前连续${run}次（达标共${passes.length}次）`);
    if (Number.isNaN(residual)) throw new Error("请测定残留色度");
    if (residual > CHROMA_LIMIT)
      throw new Error(`残留色度 ${residual.toFixed(2)} 超限，继续冲洗`);
    if (!checker) throw new Error("请填写复核人");

    target.checker = checker;
    target.residualChroma = residual;
    target.released = true;
    target.releasedAt = Date.now();
    if (input.note?.trim()) target.note = input.note.trim();

    log(
      draft,
      target.cupId,
      "release",
      `回执 v${target.version} 放行：复核人${checker}，连续2次达标，残留${residual.toFixed(
        2
      )}`
    );

    // 放行后按新回执重验该杯候杯 / 隔离排产；通过的自动回到候杯队列并重排序号
    const waiting = draft.schedules.filter(
      (s) =>
        s.cupId === target.cupId &&
        (s.status === "awaitingWash" || s.status === "queued")
    );
    for (const sch of waiting) {
      const batch = batchOf(draft, sch.batchId)!;
      const check = precheck(draft, target.cupId, batch.depth, Date.now());
      sch.failReasons = check.reasons;
      if (check.ok && sch.status === "awaitingWash") {
        sch.status = "queued";
        log(
          draft,
          target.cupId,
          "requeue",
          `${sch.batchId} 新回执三验通过，恢复候杯，队列序号重算`
        );
      } else if (!check.ok && sch.status === "queued") {
        sch.status = "awaitingWash";
        log(
          draft,
          target.cupId,
          "validate",
          `${sch.batchId} 重验未过：${check.reasons.join("、")}，转待清洗`
        );
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* 动作：回执补录 / 更正（旧版留档 + 级联失效 + 重算）                 */
/* ------------------------------------------------------------------ */

export interface ReviseInput {
  oldReceiptId: string;
  reason: "supplement" | "correction";
  createdAt: number; // 回执落款时间（补录为历史时间）
  releasedAt: number; // 放行时间
  washer: string;
  checker: string;
  residualChroma: number;
  note?: string;
}

export function reviseReceipt(input: ReviseInput): ActionResult {
  const old = state.receipts.find((r) => r.id === input.oldReceiptId);
  if (!old) return { ok: false, error: "回执不存在" };
  if (old.superseded) return { ok: false, error: "旧版已留档，只能在当前版本上操作" };
  if (Number.isNaN(input.createdAt) || Number.isNaN(input.releasedAt))
    return { ok: false, error: "请填写落款与放行时间" };
  if (input.releasedAt < input.createdAt)
    return { ok: false, error: "放行时间不能早于落款时间" };
  if (!input.washer.trim() || !input.checker.trim())
    return { ok: false, error: "请填写清洗人与复核人" };
  if (input.washer.trim() === input.checker.trim())
    return { ok: false, error: "补录/更正仍须换人复核" };
  if (
    Number.isNaN(input.residualChroma) ||
    input.residualChroma > CHROMA_LIMIT
  )
    return { ok: false, error: `残留色度须 ≤ ${CHROMA_LIMIT.toFixed(2)}` };

  return commit((draft) => {
    const oldR = draft.receipts.find((r) => r.id === input.oldReceiptId)!;
    const chain = receiptChain(draft.receipts, oldR.cupId);
    const affected: AffectedResult = findAffected(draft, oldR);

    const copy: CleaningReceipt = structuredClone(oldR);
    copy.id = uid("rcp");
    copy.version = chain.length + 1;
    copy.reason = input.reason;
    copy.replacesId = oldR.id;
    copy.washer = input.washer.trim();
    copy.checker = input.checker.trim();
    copy.residualChroma = input.residualChroma;
    copy.createdAt = input.createdAt;
    copy.releasedAt = input.releasedAt;
    copy.released = true;
    copy.superseded = false;
    copy.supersededAt = undefined;
    copy.note = input.note?.trim() || `${RECEIPT_REASON_LABEL[input.reason]}（替代 v${oldR.version}）`;
    // 补录/更正默认沿用连续两次达标的冲洗记录，时间对齐落款
    copy.readings = [
      { at: input.createdAt, chroma: Math.min(0.45, input.residualChroma + 0.12), pass: true },
      {
        at: input.createdAt + 15 * 60000,
        chroma: Math.min(0.4, input.residualChroma + 0.05),
        pass: true,
      },
    ];
    draft.receipts.push(copy);

    // 旧版留档
    oldR.superseded = true;
    oldR.supersededAt = Date.now();

    const label = RECEIPT_REASON_LABEL[input.reason];
    log(
      draft,
      oldR.cupId,
      "revise",
      `${label}：v${oldR.version} 留档，v${copy.version} 生效（落款回执 ${oldR.id.slice(
        -4
      )}），相关排产/评审失效，按新顺序重算`
    );

    // 进行中/候杯排产直接失效
    for (const sch of affected.active) {
      const target = draft.schedules.find((s) => s.id === sch.id)!;
      target.status = "invalid";
      target.failReasons = [];
      log(
        draft,
        target.cupId,
        "revise",
        `排产 ${target.batchId} 因回执${label}失效，需按新回执重排`
      );
    }

    // 已完成排产保留，关联评审失效（待重评）
    for (const rv of affected.reviews) {
      const target = draft.reviews.find((r) => r.id === rv.id);
      if (!target || !target.valid) continue;
      target.valid = false;
      target.invalidReason = `依据的回执 v${oldR.version} 已${label}`;
      const sch = draft.schedules.find((s) => s.id === target.scheduleId)!;
      log(draft, sch.cupId, "revise", `${sch.batchId} 评审结论失效（回执${label}），待重评`);
    }
  });
}

/** 失效排产按当前回执重新校验，通过则回候杯队列并重排序号。 */
export function requeueInvalid(scheduleId: string): ActionResult {
  const sch = state.schedules.find((s) => s.id === scheduleId);
  if (!sch) return { ok: false, error: "排产不存在" };
  if (sch.status !== "invalid") return { ok: false, error: "仅失效排产可重排" };

  return commit((draft) => {
    const target = draft.schedules.find((s) => s.id === scheduleId)!;
    const batch = batchOf(draft, target.batchId)!;
    const check = precheck(draft, target.cupId, batch.depth, Date.now());
    target.failReasons = check.reasons;
    target.status = check.ok ? "queued" : "awaitingWash";
    log(
      draft,
      target.cupId,
      "requeue",
      check.ok
        ? `${target.batchId} 按新回执重排，三验通过，序号已重算`
        : `${target.batchId} 重排仍未过：${check.reasons.join("、")}，保持待清洗`
    );
  });
}

/** 对已完成批次补登/重开评审（回执更正导致失效后使用）。 */
export function recordReview(
  scheduleId: string,
  result: ReviewResult,
  deltaE: number | null
): ActionResult {
  const sch = state.schedules.find((s) => s.id === scheduleId);
  if (!sch || sch.status !== "done")
    return { ok: false, error: "仅已完成批次可登记评审" };

  return commit((draft) => {
    const existing = draft.reviews.find((r) => r.scheduleId === scheduleId);
    if (existing) {
      existing.result = result;
      existing.deltaE = deltaE ?? undefined;
      existing.valid = true;
      existing.invalidReason = undefined;
    } else {
      draft.reviews.push({
        id: uid("rev"),
        scheduleId,
        result,
        deltaE: deltaE ?? undefined,
        valid: true,
      });
    }
    log(
      draft,
      sch.cupId,
      "revise",
      `${sch.batchId} 重新评审：${
        result === "pass" ? "通过" : "不通过"
      }${deltaE != null ? ` ΔE ${deltaE.toFixed(2)}` : ""}`
    );
  });
}

export function reviewOf(scheduleId: string): Review | undefined {
  return state.reviews.find((r) => r.scheduleId === scheduleId);
}

export { latestReleasedReceipt, receiptChain, activeReceipt };
export type { BlockReason };
