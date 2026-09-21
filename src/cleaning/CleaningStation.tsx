/**
 * 染杯清洗隔离流程 —— 界面层
 *
 * 三个视图共享 useCleaningStore() 同一份状态：
 *   1. 批次列表：排产/开染三验/完工评审，按订单与色深筛选
 *   2. 染杯队列：三验状态、清洗登记、冲洗登记、换人复核放行
 *   3. 单杯履历：回执版本链（旧版留档）、补录/更正与影响面、事件履历
 */

import { useEffect, useMemo, useState } from "react";
import {
  BLOCK_REASON_LABEL,
  CHROMA_LIMIT,
  CleaningState,
  CupRuntime,
  Depth,
  DEPTH_LABEL,
  RECEIPT_REASON_LABEL,
  RECEIPT_TTL_MS,
  REQUIRED_CONSECUTIVE_RINSES,
  REVIEW_RESULT_LABEL,
  ReviewResult,
  Schedule,
  ScheduleStatus,
  activeReceipt,
  consecutivePassed,
  cupRuntime,
  findAffected,
  fmtDateTime,
  fmtRemaining,
  toDatetimeLocal,
} from "./rules";
import {
  ActionResult,
  addRinse,
  addSchedule,
  attemptStart,
  batchOf,
  cupName,
  finishSchedule,
  recordReview,
  releaseReceipt,
  resetDemo,
  requeueInvalid,
  reviseReceipt,
  startWash,
  uid,
  useCleaningStore,
} from "./storage";

/* ------------------------------------------------------------------ */
/* 小组件                                                              */
/* ------------------------------------------------------------------ */

const STATUS_STYLE: Record<ScheduleStatus, string> = {
  queued: "tag tag-green",
  occupying: "tag tag-red",
  done: "tag tag-gray",
  awaitingWash: "tag tag-amber",
  invalid: "tag tag-line",
};

const STATUS_LABEL: Record<ScheduleStatus, string> = {
  queued: "候杯中",
  occupying: "占染中",
  done: "已完成",
  awaitingWash: "待清洗隔离",
  invalid: "回执失效·待重排",
};

function Tag({ children, className }: { children: React.ReactNode; className?: string }) {
  return <span className={className ?? "tag"}>{children}</span>;
}

function DepthTag({ depth }: { depth: Depth }) {
  return (
    <span className={`tag depth-${depth}`}>{DEPTH_LABEL[depth]}</span>
  );
}

function FailReasons({ reasons }: { reasons: Schedule["failReasons"] }) {
  if (reasons.length === 0) return null;
  return (
    <div className="reasons">
      {reasons.map((r) => (
        <span key={r} className="reason">
          ⚠ {BLOCK_REASON_LABEL[r]}
        </span>
      ))}
    </div>
  );
}

/** 30 秒一跳的本地时钟，驱动回执有效期倒计时刷新。 */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function ReceiptReadings({ receipt }: { receipt: NonNullable<CupRuntime["receipt"]> }) {
  const run = consecutivePassed(receipt.readings);
  return (
    <div className="readings">
      <div className="reading-head">
        冲洗记录（需连续{REQUIRED_CONSECUTIVE_RINSES}次达标，当前连续
        <b className={run >= REQUIRED_CONSECUTIVE_RINSES ? "ok" : "warn"}>{run}</b>
        次，线 {CHROMA_LIMIT.toFixed(2)}）
      </div>
      {receipt.readings.length === 0 ? (
        <p className="muted">尚未登记冲洗</p>
      ) : (
        <ol className="reading-list">
          {receipt.readings.map((r, i) => (
            <li key={i} className={r.pass ? "pass" : "fail"}>
              第{i + 1}次 · {fmtDateTime(r.at)} · 色度 {r.chroma.toFixed(2)} ·{" "}
              {r.pass ? "达标" : "超标"}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 主容器                                                              */
/* ------------------------------------------------------------------ */

type TabKey = "batches" | "queue" | "history";

const TABS: { key: TabKey; label: string; hint: string }[] = [
  { key: "batches", label: "小样批次列表", hint: "排产 / 开染三验 / 评审" },
  { key: "queue", label: "染杯队列", hint: "清洗登记与换人复核放行" },
  { key: "history", label: "单杯履历", hint: "回执版本链 · 补录更正 · 事件流" },
];

export function CleaningStation() {
  const state = useCleaningStore();
  const now = useNow();
  const [tab, setTab] = useState<TabKey>("queue");
  const [toast, setToast] = useState<{ ok: boolean; text: string } | null>(null);

  const notify = (r: ActionResult, success: string) => {
    setToast({ ok: r.ok, text: r.ok ? success : r.error ?? "操作失败" });
  };
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const metrics = useMemo(() => {
    const active = state.schedules.filter(
      (s) => s.status === "queued" || s.status === "awaitingWash" || s.status === "occupying"
    );
    return {
      total: active.length,
      waiting: state.schedules.filter((s) => s.status === "awaitingWash").length,
      occupying: state.schedules.filter((s) => s.status === "occupying").length,
      invalidReviews: state.reviews.filter((r) => !r.valid).length,
    };
  }, [state]);

  return (
    <section className="cleaning">
      <div className="cleaning-bar">
        <div className="tabs">
          {TABS.map((t) => (
            <button
              key={t.key}
              className={tab === t.key ? "tab active" : "tab"}
              onClick={() => setTab(t.key)}
            >
              <b>{t.label}</b>
              <small>{t.hint}</small>
            </button>
          ))}
        </div>
        <button className="ghost" onClick={() => resetDemo()}>
          重置演示数据
        </button>
      </div>

      <div className="cleaning-metrics">
        <div><small>在途排产</small><strong>{metrics.total}</strong></div>
        <div><small>待清洗隔离</small><strong className="amber">{metrics.waiting}</strong></div>
        <div><small>占染中</small><strong className="red">{metrics.occupying}</strong></div>
        <div><small>失效评审待重评</small><strong className="line">{metrics.invalidReviews}</strong></div>
      </div>

      {toast && (
        <div className={toast.ok ? "toast ok" : "toast err"}>{toast.text}</div>
      )}

      {tab === "batches" && <BatchList state={state} notify={notify} />}
      {tab === "queue" && <CupQueue state={state} now={now} notify={notify} />}
      {tab === "history" && <CupHistory state={state} notify={notify} />}
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 视图一：小样批次列表                                                */
/* ------------------------------------------------------------------ */

interface ViewProps {
  state: CleaningState;
  notify: (r: ActionResult, success: string) => void;
}

function BatchList({ state, notify }: ViewProps) {
  const [orderFilter, setOrderFilter] = useState("");
  const [depthFilter, setDepthFilter] = useState<Depth | "">("");
  const [form, setForm] = useState({
    batchId: "",
    orderNo: "",
    fabric: "",
    depth: "light" as Depth,
    cupId: state.cups[0]?.id ?? "",
    plannedAt: toDatetimeLocal(Date.now() + 3600000),
  });
  const [modal, setModal] = useState<{
    mode: "finish" | "review";
    scheduleId: string;
  } | null>(null);

  const rows = useMemo(() => {
    return state.schedules
      .map((s) => ({ s, b: batchOf(state, s.batchId)! }))
      .filter(({ b }) =>
        orderFilter.trim()
          ? b.orderNo.toLowerCase().includes(orderFilter.trim().toLowerCase()) ||
            b.id.toLowerCase().includes(orderFilter.trim().toLowerCase())
          : true
      )
      .filter(({ b }) => (depthFilter ? b.depth === depthFilter : true))
      .sort(
        (x, y) =>
          y.s.createdAt - x.s.createdAt ||
          x.s.cupId.localeCompare(y.s.cupId)
      );
  }, [state, orderFilter, depthFilter]);

  const submit = () => {
    const plannedMs = new Date(form.plannedAt).getTime();
    notify(
      addSchedule({
        batchId: form.batchId,
        orderNo: form.orderNo,
        fabric: form.fabric,
        depth: form.depth,
        cupId: form.cupId,
        plannedAt: plannedMs,
      }),
      "排产已登记（未过三验者已自动转待清洗）"
    );
    setForm((f) => ({ ...f, batchId: "", orderNo: "", fabric: "" }));
  };

  const modalSchedule = modal
    ? state.schedules.find((s) => s.id === modal.scheduleId)
    : undefined;

  return (
    <div className="view">
      <div className="panel-filters">
        <input
          placeholder="按客户订单号 / 批次号筛选"
          value={orderFilter}
          onChange={(e) => setOrderFilter(e.target.value)}
        />
        <select
          value={depthFilter}
          onChange={(e) => setDepthFilter(e.target.value as Depth | "")}
        >
          <option value="">全部色深</option>
          <option value="light">浅色</option>
          <option value="medium">中色</option>
          <option value="dark">深色</option>
        </select>
        <span className="muted">
          深色后直接排浅色一律转待清洗；回执过期/残留超限同样不得占杯
        </span>
      </div>

      <div className="card new-card">
        <h3>新增排产（落单即做开染前三验）</h3>
        <div className="form-row">
          <label><span>小样批次号</span>
            <input value={form.batchId} onChange={(e) => setForm({ ...form, batchId: e.target.value })} placeholder="LAB-626D" />
          </label>
          <label><span>客户订单号</span>
            <input value={form.orderNo} onChange={(e) => setForm({ ...form, orderNo: e.target.value })} placeholder="SO-8805" />
          </label>
          <label><span>面料成分</span>
            <input value={form.fabric} onChange={(e) => setForm({ ...form, fabric: e.target.value })} placeholder="棉府绸100g" />
          </label>
          <label><span>本批色深</span>
            <select value={form.depth} onChange={(e) => setForm({ ...form, depth: e.target.value as Depth })}>
              <option value="light">浅色</option>
              <option value="medium">中色</option>
              <option value="dark">深色</option>
            </select>
          </label>
          <label><span>指定染杯</span>
            <select value={form.cupId} onChange={(e) => setForm({ ...form, cupId: e.target.value })}>
              {state.cups.map((c) => (
                <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
              ))}
            </select>
          </label>
          <label><span>计划开染时间</span>
            <input type="datetime-local" value={form.plannedAt} onChange={(e) => setForm({ ...form, plannedAt: e.target.value })} />
          </label>
          <button className="primary" onClick={submit}>登记排产</button>
        </div>
      </div>

      <div className="table-wrap">
        <table className="grid">
          <thead>
            <tr>
              <th>队列#</th>
              <th>批次 / 订单</th>
              <th>面料</th>
              <th>色深</th>
              <th>染杯</th>
              <th>计划时间</th>
              <th>状态与校验</th>
              <th>评审</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ s, b }) => {
              const review = state.reviews.find((r) => r.scheduleId === s.id);
              return (
                <tr key={s.id} className={s.status === "awaitingWash" ? "row-warn" : s.status === "invalid" ? "row-invalid" : ""}>
                  <td>{s.status === "queued" || s.status === "awaitingWash" ? s.seq : "—"}</td>
                  <td><b>{b.id}</b><br /><small className="muted">{b.orderNo}</small></td>
                  <td>{b.fabric}</td>
                  <td><DepthTag depth={b.depth} /></td>
                  <td>{cupName(state, s.cupId)}</td>
                  <td>{fmtDateTime(s.plannedAt)}</td>
                  <td>
                    <Tag className={STATUS_STYLE[s.status]}>{STATUS_LABEL[s.status]}</Tag>
                    <FailReasons reasons={s.failReasons} />
                  </td>
                  <td>
                    {review ? (
                      review.valid ? (
                        <span className="muted">
                          {REVIEW_RESULT_LABEL[review.result]}
                          {review.deltaE != null ? ` ΔE ${review.deltaE.toFixed(2)}` : ""}
                        </span>
                      ) : (
                        <span className="reason">结论失效·待重评</span>
                      )
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="actions-cell">
                    {(s.status === "queued" || s.status === "awaitingWash") && (
                      <button onClick={() => notify(attemptStart(s.id), `${b.id} 开染占杯成功`)}>
                        {s.status === "awaitingWash" ? "重新三验开染" : "开染占杯"}
                      </button>
                    )}
                    {s.status === "occupying" && (
                      <button className="primary" onClick={() => setModal({ mode: "finish", scheduleId: s.id })}>
                        完工并评审
                      </button>
                    )}
                    {s.status === "done" && (
                      <button onClick={() => setModal({ mode: "review", scheduleId: s.id })}>
                        {review && !review.valid ? "重新评审" : "更正评审"}
                      </button>
                    )}
                    {s.status === "invalid" && (
                      <button className="ghost" onClick={() => notify(requeueInvalid(s.id), `${b.id} 已按新回执重排`)}>
                        按新回执重排
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr><td colSpan={9} className="muted center">没有匹配的排产记录</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {modal && modalSchedule && (
        <ReviewModal
          title={modal.mode === "finish" ? "完工登记与评审" : "重新评审"}
          state={state}
          schedule={modalSchedule}
          onClose={() => setModal(null)}
          onSubmit={(result, deltaE) => {
            const r =
              modal.mode === "finish"
                ? finishSchedule({ scheduleId: modalSchedule.id, result, deltaE })
                : recordReview(modalSchedule.id, result, deltaE);
            notify(r, modal.mode === "finish" ? "已完工并登记评审，染杯等待清洗" : "评审已更新");
            if (r.ok) setModal(null);
          }}
        />
      )}
    </div>
  );
}

function ReviewModal({
  title,
  state,
  schedule,
  onClose,
  onSubmit,
}: {
  title: string;
  state: CleaningState;
  schedule: Schedule;
  onClose: () => void;
  onSubmit: (r: ReviewResult, deltaE: number | null) => void;
}) {
  const batch = batchOf(state, schedule.batchId)!;
  const existing = state.reviews.find((r) => r.scheduleId === schedule.id);
  const [result, setResult] = useState<ReviewResult>(existing?.result ?? "pass");
  const [deltaText, setDeltaText] = useState(
    existing?.deltaE != null ? String(existing.deltaE) : ""
  );

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title} · {batch.id}</h3>
        <p className="muted">{cupName(state, schedule.cupId)} · {batch.fabric} · {DEPTH_LABEL[batch.depth]}</p>
        <label>
          <span>评审结论</span>
          <select value={result} onChange={(e) => setResult(e.target.value as ReviewResult)}>
            <option value="pass">评审通过</option>
            <option value="fail">评审不通过（待复染）</option>
            <option value="pending">待客户确认</option>
          </select>
        </label>
        <label>
          <span>色差值 ΔE（可空）</span>
          <input value={deltaText} onChange={(e) => setDeltaText(e.target.value)} placeholder="0.84" inputMode="decimal" />
        </label>
        <div className="modal-actions">
          <button className="ghost" onClick={onClose}>取消</button>
          <button
            className="primary"
            onClick={() =>
              onSubmit(result, deltaText.trim() === "" ? null : Number(deltaText))
            }
          >
            保存评审
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 视图二：染杯队列                                                    */
/* ------------------------------------------------------------------ */

function CupQueue({
  state,
  now,
  notify,
}: ViewProps & { now: number }) {
  return (
    <div className="cup-grid">
      {state.cups.map((cup) => (
        <CupCard key={cup.id} state={state} cupId={cup.id} now={now} notify={notify} />
      ))}
    </div>
  );
}

const CUP_RUNTIME_STYLE = {
  idle: "tag tag-green",
  occupied: "tag tag-red",
  isolated: "tag tag-amber",
} as const;

const CUP_RUNTIME_LABEL = {
  idle: "可用",
  occupied: "占染中",
  isolated: "待清洗隔离",
} as const;

function CupCard({
  state,
  cupId,
  now,
  notify,
}: ViewProps & { cupId: string; now: number }) {
  const rt = cupRuntime(state, cupId, now);
  const [washer, setWasher] = useState("");
  const [rinseChroma, setRinseChroma] = useState("");
  const [checker, setChecker] = useState("");
  const [residual, setResidual] = useState("");
  const [note, setNote] = useState("");

  const receipt = rt.receipt;
  const expired =
    receipt?.released && receipt.releasedAt != null
      ? now - receipt.releasedAt > RECEIPT_TTL_MS
      : false;

  const addWash = () => {
    const r = startWash(cupId, washer);
    notify(r, "清洗单已登记");
    if (r.ok) setWasher("");
  };

  const addReading = () => {
    if (!receipt) return;
    const v = Number(rinseChroma);
    const r = addRinse(receipt.id, v);
    notify(r, "冲洗色度已登记");
    if (r.ok) setRinseChroma("");
  };

  const release = () => {
    if (!receipt) return;
    const r = releaseReceipt({
      receiptId: receipt.id,
      checker,
      residualChroma: Number(residual),
      note,
    });
    notify(r, "复核通过，回执放行；隔离队列已重验重排");
    if (r.ok) {
      setChecker("");
      setResidual("");
      setNote("");
    }
  };

  return (
    <article className="card cup-card">
      <header className="cup-head">
        <div>
          <h3>{rt.cup.code} · {rt.cup.name}</h3>
          <small className="muted">
            上一批：{rt.prevDepth ? DEPTH_LABEL[rt.prevDepth] : "无记录"}
            {rt.lastFinishedAt ? `（完成于 ${fmtDateTime(rt.lastFinishedAt)}）` : ""}
          </small>
        </div>
        <Tag className={CUP_RUNTIME_STYLE[rt.status]}>{CUP_RUNTIME_LABEL[rt.status]}</Tag>
      </header>

      <div className="receipt-box">
        {!receipt ? (
          <p className="muted">无清洗回执 —— 开染将被拦截，只能先清洗。</p>
        ) : (
          <>
            <div className="receipt-line">
              <Tag className={receipt.released ? "tag tag-green" : "tag tag-amber"}>
                回执 v{receipt.version} · {RECEIPT_REASON_LABEL[receipt.reason]}
              </Tag>
              {receipt.released && receipt.releasedAt != null && (
                <span className={expired ? "reason" : "ok"}>
                  {fmtDateTime(receipt.releasedAt)} 放行 ·{" "}
                  {expired ? "已过期" : fmtRemaining(RECEIPT_TTL_MS - (now - receipt.releasedAt))}
                </span>
              )}
              {!receipt.released && <span className="reason">清洗中，未放行</span>}
            </div>
            <div className="receipt-line muted">
              清洗人 {receipt.washer} · 复核人 {receipt.checker ?? "未复核"} ·
              残留色度 {receipt.residualChroma != null ? receipt.residualChroma.toFixed(2) : "未测"}
            </div>
            <ReceiptReadings receipt={receipt} />
            {receipt.note && <p className="muted note-line">备注：{receipt.note}</p>}
          </>
        )}
      </div>

      {/* 清洗操作区：占染中禁用 */}
      {rt.status !== "occupied" && (
        <div className="wash-ops">
          {!receipt || receipt.released ? (
            <div className="op-row">
              <input
                placeholder="清洗人姓名"
                value={washer}
                onChange={(e) => setWasher(e.target.value)}
              />
              <button onClick={addWash}>
                {receipt?.released ? "回执已用/到期，登记新一轮清洗" : "登记清洗"}
              </button>
            </div>
          ) : (
            <>
              <div className="op-row">
                <input
                  placeholder={`第${receipt.readings.length + 1}次冲洗色度（≤${CHROMA_LIMIT.toFixed(2)}）`}
                  value={rinseChroma}
                  onChange={(e) => setRinseChroma(e.target.value)}
                  inputMode="decimal"
                />
                <button onClick={addReading} disabled={!rinseChroma.trim()}>
                  登记冲洗
                </button>
              </div>
              <div className="op-row">
                <input
                  placeholder="复核人（须与清洗人不同）"
                  value={checker}
                  onChange={(e) => setChecker(e.target.value)}
                />
                <input
                  placeholder="放行前残留色度"
                  value={residual}
                  onChange={(e) => setResidual(e.target.value)}
                  inputMode="decimal"
                />
              </div>
              <div className="op-row">
                <input placeholder="复核备注（可空）" value={note} onChange={(e) => setNote(e.target.value)} />
                <button className="primary" onClick={release}>换人复核放行</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* 该杯候杯 / 隔离队列 */}
      <div className="cup-queue">
        <h4>本杯队列（序号全局限序一致）</h4>
        {rt.queued.length === 0 && <p className="muted">无候杯 / 待清洗排产</p>}
        {rt.queued.map((s) => {
          const b = batchOf(state, s.batchId)!;
          return (
            <div key={s.id} className={`queue-item ${s.status === "awaitingWash" ? "is-wait" : ""}`}>
              <span className="queue-seq">#{s.seq}</span>
              <div>
                <b>{b.id}</b> <DepthTag depth={b.depth} />
                <small className="muted"> {b.fabric} · 计划 {fmtDateTime(s.plannedAt)}</small>
                <FailReasons reasons={s.failReasons} />
              </div>
              <button onClick={() => notify(attemptStart(s.id), `${b.id} 开染占杯成功`)}>
                {s.status === "awaitingWash" ? "重新三验" : "开染"}
              </button>
            </div>
          );
        })}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */
/* 视图三：单杯履历（回执版本链 + 补录/更正 + 事件流）                 */
/* ------------------------------------------------------------------ */

function CupHistory({ state, notify }: ViewProps) {
  const [cupId, setCupId] = useState(state.cups[0]?.id ?? "");
  const cup = state.cups.find((c) => c.id === cupId);
  const chain = useMemo(
    () =>
      state.receipts
        .filter((r) => r.cupId === cupId)
        .sort((a, b) => b.version - a.version),
    [state, cupId]
  );
  const current = chain.find((r) => !r.superseded);
  const events = state.events.filter((e) => e.cupId === cupId);

  const [form, setForm] = useState({
    reason: "supplement" as "supplement" | "correction",
    createdAt: current ? toDatetimeLocal(current.createdAt) : "",
    releasedAt: current?.releasedAt ? toDatetimeLocal(current.releasedAt) : "",
    washer: current?.washer ?? "",
    checker: current?.checker ?? "",
    residual: current?.residualChroma != null ? String(current.residualChroma) : "",
    note: "",
  });

  // 切换染杯后同步表单默认值
  useEffect(() => {
    setForm({
      reason: "supplement",
      createdAt: current ? toDatetimeLocal(current.createdAt) : "",
      releasedAt: current?.releasedAt ? toDatetimeLocal(current.releasedAt) : "",
      washer: current?.washer ?? "",
      checker: current?.checker ?? "",
      residual: current?.residualChroma != null ? String(current.residualChroma) : "",
      note: "",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cupId, current?.id]);

  const affected = current ? findAffected(state, current) : undefined;

  const submitRevise = () => {
    if (!current) return;
    const r = reviseReceipt({
      oldReceiptId: current.id,
      reason: form.reason,
      createdAt: new Date(form.createdAt).getTime(),
      releasedAt: new Date(form.releasedAt).getTime(),
      washer: form.washer,
      checker: form.checker,
      residualChroma: Number(form.residual),
      note: form.note,
    });
    notify(r, "新版回执已生效：旧版留档，相关排产/评审已失效并重算");
  };

  return (
    <div className="history-layout">
      <div className="history-side">
        <label>
          <span>选择染杯</span>
          <select value={cupId} onChange={(e) => setCupId(e.target.value)}>
            {state.cups.map((c) => (
              <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
            ))}
          </select>
        </label>

        <h3>回执版本链（旧版留档只读）</h3>
        {chain.map((r) => (
          <div key={r.id} className={`receipt-version ${r.superseded ? "archived" : ""}`}>
            <div className="receipt-line">
              <Tag className={r.superseded ? "tag tag-line" : "tag tag-green"}>
                v{r.version} · {r.superseded ? "已留档（被新版替代）" : "当前版本"}
              </Tag>
              <Tag>{RECEIPT_REASON_LABEL[r.reason]}</Tag>
            </div>
            <p className="muted">
              落款 {fmtDateTime(r.createdAt)} · 放行 {fmtDateTime(r.releasedAt)}
              <br />
              清洗 {r.washer} / 复核 {r.checker ?? "—"} · 残留 {r.residualChroma?.toFixed(2) ?? "—"}
            </p>
            <ol className="reading-list compact">
              {r.readings.map((x, i) => (
                <li key={i} className={x.pass ? "pass" : "fail"}>
                  第{i + 1}次 {x.chroma.toFixed(2)}
                </li>
              ))}
            </ol>
            {r.note && <p className="muted note-line">备注：{r.note}</p>}
          </div>
        ))}
        {chain.length === 0 && <p className="muted">该杯暂无回执</p>}
      </div>

      <div className="history-main">
        <div className="card">
          <h3>补录 / 更正回执</h3>
          {!current ? (
            <p className="muted">该杯尚无回执版本；如需补录请先在染杯队列登记清洗并放行。</p>
          ) : (
            <>
              <div className="radio-row">
                <label className="inline">
                  <input
                    type="radio"
                    name={`reason-${cupId}`}
                    checked={form.reason === "supplement"}
                    onChange={() => setForm({ ...form, reason: "supplement" })}
                  />
                  补录回执（漏登历史回执）
                </label>
                <label className="inline">
                  <input
                    type="radio"
                    name={`reason-${cupId}`}
                    checked={form.reason === "correction"}
                    onChange={() => setForm({ ...form, reason: "correction" })}
                  />
                  更正回执（色度/人员登记错误）
                </label>
              </div>
              <div className="form-row">
                <label><span>回执落款时间</span>
                  <input type="datetime-local" value={form.createdAt} onChange={(e) => setForm({ ...form, createdAt: e.target.value })} />
                </label>
                <label><span>放行时间</span>
                  <input type="datetime-local" value={form.releasedAt} onChange={(e) => setForm({ ...form, releasedAt: e.target.value })} />
                </label>
                <label><span>清洗人</span>
                  <input value={form.washer} onChange={(e) => setForm({ ...form, washer: e.target.value })} />
                </label>
                <label><span>复核人（换人）</span>
                  <input value={form.checker} onChange={(e) => setForm({ ...form, checker: e.target.value })} />
                </label>
                <label><span>残留色度（≤{CHROMA_LIMIT.toFixed(2)}）</span>
                  <input value={form.residual} onChange={(e) => setForm({ ...form, residual: e.target.value })} inputMode="decimal" />
                </label>
                <label><span>说明</span>
                  <input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="更正原因 / 补录来源" />
                </label>
              </div>

              {affected && (affected.active.length > 0 || affected.reviews.length > 0) && (
                <div className="impact-box">
                  <b>提交后影响面（旧版 v{current.version} 留档）：</b>
                  <ul>
                    {affected.active.map((s) => (
                      <li key={s.id}>
                        排产 {s.batchId}（{cupName(state, s.cupId)}）将失效，需按新回执重排
                      </li>
                    ))}
                    {affected.reviews.filter((r) => r.valid).map((r) => {
                      const s = state.schedules.find((x) => x.id === r.scheduleId)!;
                      return (
                        <li key={r.id}>
                          {s.batchId} 的评审结论将失效，需重新评审
                        </li>
                      );
                    })}
                  </ul>
                  <span className="muted">队列随后按计划时间新顺序重算序号，三个视图同步刷新。</span>
                </div>
              )}

              <button className="primary" onClick={submitRevise}>
                生成新版回执并级联失效重算
              </button>
            </>
          )}
        </div>

        <div className="card">
          <h3>{cup?.code} 单杯事件履历</h3>
          <ul className="event-log">
            {events.map((e) => (
              <li key={e.id}>
                <span className="event-time">{fmtDateTime(e.at)}</span>
                <Tag className={`evt evt-${e.category}`}>{e.category}</Tag>
                <span>{e.message}</span>
              </li>
            ))}
            {events.length === 0 && <li className="muted">暂无事件</li>}
          </ul>
        </div>
      </div>
    </div>
  );
}
