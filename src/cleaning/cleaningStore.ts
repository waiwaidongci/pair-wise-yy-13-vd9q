/**
 * 染杯清洗隔离流程 —— 存储层
 *
 * 单一数据源：批次排产、染杯队列、清洗回执（含旧版留档）、审计履历。
 * - localStorage 持久化，刷新后列表 / 染杯队列 / 单杯履历仍一致；
 * - 回执补录或更正：旧版回执 superseded 留档，相关排产与评审失效，
 *   按 seq 新顺序整体重算占杯；
 * - 对外暴露 subscribe/getSnapshot，供界面层用 useSyncExternalStore 订阅。
 */

import {
  AuditEvent,
  BatchSchedule,
  CleaningReceipt,
  ColorDepth,
  DyeCup,
  REQUIRED_RINSES,
  RESIDUAL_LIMIT,
  ReviewVerdict,
  RinseReading,
  ReleaseErrorCode,
  recomputeScheduling,
  validateRelease,
} from "./cleaningRules";

const STORAGE_KEY = "dye-lab-cleaning-store-v1";

export interface StoreState {
  cups: DyeCup[];
  batches: BatchSchedule[];
  receipts: CleaningReceipt[];
  audit: AuditEvent[];
}

export interface ReceiptInput {
  washedBy: string;
  reviewedBy: string;
  issuedAt: number;
  /** 放行/补录时登记的冲洗读数，长度可为 1~N，取末两次判达标 */
  rinses: RinseReading[];
  note?: string;
}

// ---------- 初始演示数据 ----------

function seedState(): StoreState {
  const now = Date.now();
  const h = (n: number) => now - n * 60 * 60 * 1000;

  const receipts: CleaningReceipt[] = [
    {
      id: "RC-C01-1",
      cupId: "C01",
      version: 1,
      superseded: false,
      washedBy: "王秀兰",
      reviewedBy: "李建国",
      issuedAt: h(2),
      rinses: [
        { at: h(2.2), residual: 0.42 },
        { at: h(2.1), residual: 0.28 },
      ],
      residual: 0.28,
      note: "浅色批后常规清洗",
    },
    {
      id: "RC-C03-1",
      cupId: "C03",
      version: 1,
      superseded: false,
      washedBy: "赵敏",
      reviewedBy: "孙志强",
      issuedAt: h(3),
      rinses: [
        { at: h(3.2), residual: 0.48 },
        { at: h(3.1), residual: 0.36 },
      ],
      residual: 0.36,
    },
    {
      id: "RC-C02-1",
      cupId: "C02",
      version: 1,
      superseded: false,
      washedBy: "王秀兰",
      reviewedBy: "李建国",
      issuedAt: h(26),
      rinses: [
        { at: h(26.2), residual: 0.45 },
        { at: h(26.1), residual: 0.3 },
      ],
      residual: 0.3,
      note: "回执已超过 24 小时",
    },
  ];

  const cups: DyeCup[] = [
    {
      id: "C01",
      label: "染杯 1 号 · 300ml",
      status: "可用",
      residual: 0.28,
      lastBatchId: "LAB-618X",
      lastBatchDepth: "浅",
      lastBatchCompletedAt: h(5),
    },
    {
      id: "C02",
      label: "染杯 2 号 · 300ml",
      status: "可用",
      residual: 1.9,
      lastBatchId: "LAB-615K",
      lastBatchDepth: "深",
      lastBatchCompletedAt: h(6),
    },
    {
      id: "C03",
      label: "染杯 3 号 · 500ml",
      status: "可用",
      residual: 0.62,
      lastBatchId: "LAB-617M",
      lastBatchDepth: "中",
      lastBatchCompletedAt: h(8),
    },
    { id: "C04", label: "染杯 4 号 · 500ml", status: "可用", residual: 0.12 },
  ];

  const batches: BatchSchedule[] = [
    {
      id: "LAB-620A",
      orderNo: "SO-2401",
      fabric: "棉府绸120g",
      depth: "浅",
      seq: 1,
      status: "排队中",
      review: "待评审",
    },
    {
      id: "LAB-621C",
      orderNo: "SO-2402",
      fabric: "涤纶针织",
      depth: "深",
      seq: 2,
      status: "排队中",
      review: "待评审",
    },
    {
      id: "LAB-624B",
      orderNo: "SO-2403",
      fabric: "混纺斜纹",
      depth: "浅",
      seq: 3,
      status: "排队中",
      review: "待评审",
    },
    {
      id: "LAB-618X",
      orderNo: "SO-2388",
      fabric: "棉针织180g",
      depth: "浅",
      seq: 0,
      status: "已完成",
      cupId: "C01",
      completedAt: h(5),
      review: "通过",
    },
  ];

  const audit: AuditEvent[] = [
    { at: h(26), type: "放行", cupId: "C02", receiptId: "RC-C02-1", version: 1, detail: "C02 清洗放行（旧回执）" },
    { at: h(8), type: "完成", cupId: "C03", batchId: "LAB-617M", detail: "LAB-617M 中色批完成" },
    { at: h(6), type: "完成", cupId: "C02", batchId: "LAB-615K", detail: "LAB-615K 深色批完成" },
    { at: h(5), type: "完成", cupId: "C01", batchId: "LAB-618X", detail: "LAB-618X 完成" },
    { at: h(4.8), type: "评审", cupId: "C01", batchId: "LAB-618X", detail: "LAB-618X 评审通过" },
    { at: h(2), type: "放行", cupId: "C01", receiptId: "RC-C01-1", version: 1, detail: "C01 清洗放行" },
  ];

  // 初始排产按 seq 重算一遍，使队列与规则一致
  const result = recomputeScheduling(batches, cups, receipts, now);
  return { cups: result.cups, batches: result.batches, receipts, audit: [...audit, ...result.events] };
}

function loadState(): StoreState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as StoreState;
  } catch {
    // 存档损坏时回退到演示数据
  }
  return seedState();
}

// ---------- Store ----------

let state: StoreState = loadState();
const listeners = new Set<() => void>();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 隐私模式等场景下仅内存可用
  }
}

function commit(next: StoreState) {
  state = next;
  persist();
  listeners.forEach((fn) => fn());
}

export const cleaningStore = {
  getState: () => state,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  resetDemo() {
    commit(seedState());
  },

  // ---------- 排产 ----------

  addSchedule(input: { orderNo: string; fabric: string; depth: ColorDepth }) {
    const now = Date.now();
    const seq = state.batches.reduce((m, b) => Math.max(m, b.seq), 0) + 1;
    const id = `LAB-${Math.floor(600 + Math.random() * 399)}${String.fromCharCode(
      65 + Math.floor(Math.random() * 26)
    )}`;
    const batch: BatchSchedule = {
      id,
      orderNo: input.orderNo.trim() || "SO-待定",
      fabric: input.fabric.trim() || "未填面料",
      depth: input.depth,
      seq,
      status: "排队中",
      review: "待评审",
    };
    const result = recomputeScheduling([...state.batches, batch], state.cups, state.receipts, now);
    commit({
      ...state,
      batches: result.batches,
      cups: result.cups,
      audit: [
        ...state.audit,
        { at: now, type: "排产重算", batchId: id, detail: `新增排产 ${id}（${input.depth}色），按顺序重算` },
        ...result.events,
      ],
    });
  },

  /** 开染：仅已占杯排产可执行 */
  startDyeing(batchId: string) {
    const now = Date.now();
    const batch = state.batches.find((b) => b.id === batchId);
    if (!batch || batch.status !== "已占杯" || !batch.cupId || batch.startedAt) return;
    commit({
      ...state,
      batches: state.batches.map((b) =>
        b.id === batchId ? { ...b, startedAt: now } : b
      ),
      audit: [
        ...state.audit,
        { at: now, type: "开染", cupId: batch.cupId, batchId, detail: `${batchId} 在 ${batch.cupId} 开染` },
      ],
    });
  },

  /** 完工：释放染杯并按色深污染残留，必须重新清洗才能再占杯 */
  completeBatch(batchId: string) {
    const now = Date.now();
    const batch = state.batches.find((b) => b.id === batchId);
    if (!batch || !batch.cupId || batch.status !== "已占杯") return;
    const dirtyResidual = batch.depth === "深" ? 2.1 : batch.depth === "中" ? 1.1 : 0.75;
    const cups = state.cups.map((c) =>
      c.id === batch.cupId
        ? {
            ...c,
            occupiedBy: undefined,
            residual: dirtyResidual,
            lastBatchId: batch.id,
            lastBatchDepth: batch.depth,
            lastBatchCompletedAt: now,
          }
        : c
    );
    const batches = state.batches.map((b) =>
      b.id === batchId
        ? { ...b, status: "已完成" as const, completedAt: now, review: "待评审" as ReviewVerdict }
        : b
    );
    // 完工腾出的杯不能直接再占（残留超限），后续排队单整体重算
    const result = recomputeScheduling(batches, cups, state.receipts, now);
    commit({
      ...state,
      batches: result.batches,
      cups: result.cups,
      audit: [
        ...state.audit,
        { at: now, type: "完成", cupId: batch.cupId, batchId, detail: `${batchId}（${batch.depth}色）完工，染杯残留 ${dirtyResidual}` },
        ...result.events,
      ],
    });
  },

  reviewBatch(batchId: string, verdict: Extract<ReviewVerdict, "通过" | "不通过">) {
    const now = Date.now();
    const batch = state.batches.find((b) => b.id === batchId);
    if (!batch || batch.status !== "已完成") return;
    commit({
      ...state,
      batches: state.batches.map((b) =>
        b.id === batchId ? { ...b, review: verdict, reviewInvalid: false } : b
      ),
      audit: [
        ...state.audit,
        { at: now, type: "评审", cupId: batch.cupId, batchId, detail: `${batchId} 评审${verdict}` },
      ],
    });
  },

  // ---------- 染杯清洗 ----------

  startCleaning(cupId: string, washer: string) {
    const now = Date.now();
    const cup = state.cups.find((c) => c.id === cupId);
    if (!cup || cup.status === "清洗中" || !washer.trim()) return;
    commit({
      ...state,
      cups: state.cups.map((c) =>
        c.id === cupId
          ? { ...c, status: "清洗中", draft: { startedAt: now, washer: washer.trim(), rinses: [] } }
          : c
      ),
      audit: [
        ...state.audit,
        { at: now, type: "开始清洗", cupId, detail: `${cupId} 开始清洗，执行人 ${washer.trim()}` },
      ],
    });
  },

  addRinse(cupId: string, residual: number) {
    const now = Date.now();
    const cup = state.cups.find((c) => c.id === cupId);
    if (!cup || cup.status !== "清洗中" || !cup.draft || Number.isNaN(residual)) return;
    const rinses = [...cup.draft.rinses, { at: now, residual }];
    commit({
      ...state,
      cups: state.cups.map((c) => (c.id === cupId && c.draft ? { ...c, draft: { ...c.draft, rinses } } : c)),
      audit: [
        ...state.audit,
        { at: now, type: "冲洗", cupId, detail: `${cupId} 第 ${rinses.length} 次冲洗残留色度 ${residual}` },
      ],
    });
  },

  /** 放行：换人复核 + 连续两次冲洗达标；校验不过返回错误码，不产生任何变更 */
  releaseCup(cupId: string, reviewer: string): ReleaseErrorCode[] {
    const cup = state.cups.find((c) => c.id === cupId);
    if (!cup) return ["NOT_IN_CLEANING"];
    const draft = { ...(cup.draft ?? { startedAt: 0, washer: "", rinses: [] }), reviewedBy: reviewer };
    const probe: DyeCup = { ...cup, draft };
    const errors = validateRelease(probe);
    if (errors.length) return errors;

    const now = Date.now();
    const version = state.receipts.filter((r) => r.cupId === cupId).reduce((m, r) => Math.max(m, r.version), 0) + 1;
    const receipt: CleaningReceipt = {
      id: `RC-${cupId}-${version}`,
      cupId,
      version,
      superseded: false,
      washedBy: draft.washer,
      reviewedBy: reviewer.trim(),
      issuedAt: now,
      rinses: draft.rinses,
      residual: draft.rinses[draft.rinses.length - 1].residual,
    };

    const cups = state.cups.map((c) =>
      c.id === cupId ? { ...c, status: "可用" as const, residual: receipt.residual, draft: undefined } : c
    );
    const base: StoreState = {
      ...state,
      cups,
      receipts: [...state.receipts, receipt],
      audit: [
        ...state.audit,
        { at: now, type: "放行", cupId, receiptId: receipt.id, version, detail: `${cupId} 连续两次达标，${draft.washer} 清洗 / ${reviewer.trim()} 复核，放行` },
      ],
    };
    commit(reopenAndRecompute(base, now));
    return [];
  },

  /** 残留色度快检：更新当前值并重算（可能触发新的阻断或放行排队） */
  quickCheck(cupId: string, residual: number) {
    const now = Date.now();
    const cup = state.cups.find((c) => c.id === cupId);
    if (!cup || Number.isNaN(residual)) return;
    const base: StoreState = {
      ...state,
      cups: state.cups.map((c) => (c.id === cupId ? { ...c, residual } : c)),
      audit: [
        ...state.audit,
        { at: now, type: "残留快检", cupId, detail: `${cupId} 快检残留色度 ${residual}${residual > RESIDUAL_LIMIT ? "（超限）" : ""}` },
      ],
    };
    commit(reopenAndRecompute(base, now));
  },

  // ---------- 回执补录 / 更正 ----------

  /** 补录回执：旧版全部留档，相关排产与评审失效，按新顺序重算 */
  backfillReceipt(cupId: string, input: ReceiptInput) {
    const now = Date.now();
    const cup = state.cups.find((c) => c.id === cupId);
    if (!cup) return;
    const errors = validateReceiptInput(input);
    if (errors.length) return;

    const version = nextVersion(cupId) ;
    const receipt: CleaningReceipt = {
      id: `RC-${cupId}-${version}`,
      cupId,
      version,
      superseded: false,
      washedBy: input.washedBy.trim(),
      reviewedBy: input.reviewedBy.trim(),
      issuedAt: input.issuedAt,
      rinses: input.rinses,
      residual: input.rinses[input.rinses.length - 1].residual,
      note: input.note?.trim() || "补录回执",
    };
    commit(applyReceiptChange(state, receipt, "回执补录", now));
  },

  /** 更正回执：以被更正回执为底新建版本，旧版留档 */
  correctReceipt(receiptId: string, patch: Partial<ReceiptInput>) {
    const now = Date.now();
    const old = state.receipts.find((r) => r.id === receiptId && !r.superseded);
    if (!old) return;
    const merged: ReceiptInput = {
      washedBy: patch.washedBy ?? old.washedBy,
      reviewedBy: patch.reviewedBy ?? old.reviewedBy,
      issuedAt: patch.issuedAt ?? old.issuedAt,
      rinses: patch.rinses ?? old.rinses,
      note: patch.note ?? old.note,
    };
    const errors = validateReceiptInput(merged);
    if (errors.length) return;

    const receipt: CleaningReceipt = {
      id: `RC-${old.cupId}-${nextVersion(old.cupId)}`,
      cupId: old.cupId,
      version: old.version + 1,
      superseded: false,
      washedBy: merged.washedBy.trim(),
      reviewedBy: merged.reviewedBy.trim(),
      issuedAt: merged.issuedAt,
      rinses: merged.rinses,
      residual: merged.rinses[merged.rinses.length - 1].residual,
      note: merged.note?.trim() || `更正自 v${old.version}`,
    };
    commit(applyReceiptChange(state, receipt, "回执更正", now, old.id));
  },
};

// ---------- 内部：失效 + 留档 + 重算 ----------

function nextVersion(cupId: string): number {
  return state.receipts.filter((r) => r.cupId === cupId).reduce((m, r) => Math.max(m, r.version), 0) + 1;
}

function validateReceiptInput(input: ReceiptInput): string[] {
  const errors: string[] = [];
  if (!input.washedBy.trim()) errors.push("缺少清洗执行人");
  if (!input.reviewedBy.trim()) errors.push("缺少复核人");
  if (input.washedBy.trim() && input.reviewedBy.trim() && input.washedBy.trim() === input.reviewedBy.trim()) {
    errors.push("复核人与清洗人不能为同一人");
  }
  if (input.rinses.length < REQUIRED_RINSES) errors.push(`需连续 ${REQUIRED_RINSES} 次冲洗记录`);
  if (input.rinses.slice(-REQUIRED_RINSES).some((r) => r.residual > RESIDUAL_LIMIT)) {
    errors.push(`最后 ${REQUIRED_RINSES} 次冲洗色度须均 ≤ ${RESIDUAL_LIMIT}`);
  }
  return errors;
}

/**
 * 回执变更的统一处理：
 * 1. 该杯所有现行回执标记 superseded（旧版留档）；
 * 2. 未开工的相关排产失效（回到排队中，清掉占杯）；
 * 3. 已完成且已有评审结论的批次评审失效（回到待评审）；
 * 4. 全部在制排产按 seq 新顺序重算占杯。
 */
function applyReceiptChange(
  prev: StoreState,
  receipt: CleaningReceipt,
  mode: "回执补录" | "回执更正",
  now: number,
  correctedFromId?: string
): StoreState {
  const archivedEvents: AuditEvent[] = [];
  const receipts = prev.receipts.map((r) => {
    if (r.cupId === receipt.cupId && !r.superseded) {
      archivedEvents.push({
        at: now,
        type: "旧版留档",
        cupId: r.cupId,
        receiptId: r.id,
        version: r.version,
        detail: `${r.id}（v${r.version}）被${mode}替代，旧版留档`,
      });
      return { ...r, superseded: true };
    }
    return r;
  });

  const invalidScheduleEvents: AuditEvent[] = [];
  const invalidReviewEvents: AuditEvent[] = [];
  const batches = prev.batches.map((b) => {
    if (b.cupId !== receipt.cupId) return b;
    // 未开染（排队/待清洗/已占杯未开染）的相关排产一律失效，回到队列
    if (b.status === "排队中" || b.status === "待清洗" || (b.status === "已占杯" && !b.startedAt)) {
      invalidScheduleEvents.push({
        at: now,
        type: "排产重算",
        cupId: receipt.cupId,
        batchId: b.id,
        detail: `${b.id} 的占杯依据回执变更，排产失效，回到队列重算`,
      });
      return { ...b, status: "排队中" as const, cupId: undefined, assignedAt: undefined, blockers: undefined };
    }
    if (b.status === "已完成" && b.review !== "待评审") {
      invalidReviewEvents.push({
        at: now,
        type: "评审",
        cupId: receipt.cupId,
        batchId: b.id,
        detail: `${b.id} 原评审「${b.review}」因回执${mode}失效，需重新评审`,
      });
      return { ...b, review: "待评审" as const, reviewInvalid: true };
    }
    return b;
  });

  // 回执合规后染杯可重新参与占杯：若当前挂在“待清洗”，按回执状态复位
  const cups = prev.cups.map((c) =>
    c.id === receipt.cupId && c.status === "待清洗"
      ? { ...c, status: "可用" as const, residual: receipt.residual }
      : c
  );

  const base: StoreState = {
    ...prev,
    cups,
    batches,
    receipts: [...receipts, receipt],
    audit: [
      ...prev.audit,
      ...archivedEvents,
      {
        at: now,
        type: mode,
        cupId: receipt.cupId,
        receiptId: receipt.id,
        version: receipt.version,
        detail:
          mode === "回执补录"
            ? `补录 ${receipt.cupId} 回执 v${receipt.version}（签发于 ${new Date(receipt.issuedAt).toLocaleString()}）`
            : `更正 ${receipt.cupId} 回执（原 ${correctedFromId ?? "?"} → v${receipt.version}）`,
      },
      ...invalidScheduleEvents,
      ...invalidReviewEvents,
    ],
  };

  return reopenAndRecompute(base, now, true);
}

/**
 * 把所有未开工排产复位为排队中后整体重算。
 * 已开染 / 已完成的排产保持锁定，其染杯继续被占用。
 */
function reopenAndRecompute(prev: StoreState, now: number, auditRecompute = false): StoreState {
  const reopened = prev.batches.map((b) => {
    if (b.startedAt && b.status === "已占杯") return b; // 染色中，锁定
    if (b.status === "排队中" || b.status === "待清洗") {
      return { ...b, status: "排队中" as const, cupId: undefined, assignedAt: undefined, blockers: undefined };
    }
    return b;
  });
  const result = recomputeScheduling(reopened, prev.cups, prev.receipts, now);
  const events = auditRecompute
    ? [{ at: now, type: "排产重算" as const, detail: "回执变更后按排产顺序重新占杯" }, ...result.events]
    : result.events;
  return { ...prev, batches: result.batches, cups: result.cups, audit: [...prev.audit, ...events] };
}
