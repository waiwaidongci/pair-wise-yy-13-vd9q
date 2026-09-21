import { useMemo, useState, useSyncExternalStore } from "react";
import {
  BLOCKER_LABEL,
  BatchSchedule,
  BlockerCode,
  CleaningReceipt,
  ColorDepth,
  DyeCup,
  RECEIPT_TTL_MS,
  RELEASE_ERROR_LABEL,
  RESIDUAL_LIMIT,
  ReleaseErrorCode,
  isReceiptExpired,
  latestReceipt,
} from "./cleaningRules";
import { cleaningStore } from "./cleaningStore";

// 三个视图订阅同一数据源，刷新后列表 / 队列 / 单杯履历保持一致
function useStore() {
  return useSyncExternalStore(
    cleaningStore.subscribe,
    cleaningStore.getState,
    cleaningStore.getState
  );
}

const STATUS_STYLE: Record<string, string> = {
  排队中: "tag tag-idle",
  待清洗: "tag tag-warn",
  已占杯: "tag tag-ok",
  已完成: "tag tag-done",
  清洗中: "tag tag-info",
  可用: "tag tag-ok",
  待评审: "tag tag-idle",
  通过: "tag tag-ok",
  不通过: "tag tag-warn",
};

const DEPTH_STYLE: Record<ColorDepth, string> = {
  浅: "depth depth-light",
  中: "depth depth-mid",
  深: "depth depth-dark",
};

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtReceiptAge(receipt: CleaningReceipt, now: number): string {
  const hours = (now - receipt.issuedAt) / 3600 / 1000;
  return hours < 1 ? `${Math.round(hours * 60)} 分钟前` : `${hours.toFixed(1)} 小时前`;
}

// ---------- 排产列表 ----------

function ScheduleList({ fabricFilter }: { fabricFilter: string }) {
  const s = useStore();
  const rows = s.batches
    .filter((b) => !fabricFilter || b.fabric.includes(fabricFilter) || b.orderNo.includes(fabricFilter))
    .slice()
    .sort((a, b) => a.seq - b.seq);

  return (
    <div className="panel">
      <div className="heading">
        <div>
          <p>开染前校验</p>
          <h2>小样批次排产</h2>
        </div>
        <span className="hint">回执 · 残留 · 深浅序，三重校验通过才占杯</span>
      </div>
      <table className="grid">
        <thead>
          <tr>
            <th>#</th>
            <th>批次 / 订单</th>
            <th>面料 · 色深</th>
            <th>状态 / 染杯</th>
            <th>校验与评审</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((b) => (
            <ScheduleRow key={b.id} batch={b} />
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="empty">没有匹配的排产单</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ScheduleRow({ batch }: { batch: BatchSchedule }) {
  const s = useStore();
  const cup = batch.cupId ? s.cups.find((c) => c.id === batch.cupId) : undefined;

  return (
    <tr className={batch.status === "待清洗" ? "row-blocked" : undefined}>
      <td className="seq">{batch.seq}</td>
      <td>
        <strong>{batch.id}</strong>
        <small>{batch.orderNo}</small>
      </td>
      <td>
        {batch.fabric}
        <span className={DEPTH_STYLE[batch.depth]}>{batch.depth}色</span>
      </td>
      <td>
        <span className={STATUS_STYLE[batch.status]}>{batch.status}</span>
        {cup && <small>{cup.id}</small>}
        {batch.startedAt && <small className="dim">已开染 {fmtTime(batch.startedAt)}</small>}
        {batch.completedAt && <small className="dim">完工 {fmtTime(batch.completedAt)}</small>}
      </td>
      <td>
        {batch.blockers && batch.blockers.length > 0 ? (
          <div className="blockers">
            {batch.blockers.map((code: BlockerCode) => (
              <span key={code} className="tag tag-warn">
                {BLOCKER_LABEL[code]}
              </span>
            ))}
            <small className="dim">只能转待清洗，不占染杯</small>
          </div>
        ) : (
          <span className={STATUS_STYLE[batch.review]}>
            {batch.reviewInvalid ? "评审已失效 · " : ""}
            {batch.review}
          </span>
        )}
      </td>
      <td className="ops">
        {batch.status === "已占杯" && !batch.startedAt && (
          <button className="primary" onClick={() => cleaningStore.startDyeing(batch.id)}>
            开染
          </button>
        )}
        {batch.status === "已占杯" && batch.startedAt && !batch.completedAt && (
          <button className="primary" onClick={() => cleaningStore.completeBatch(batch.id)}>
            完工
          </button>
        )}
        {batch.status === "已完成" && batch.review === "待评审" && (
          <>
            <button onClick={() => cleaningStore.reviewBatch(batch.id, "通过")}>评审通过</button>
            <button onClick={() => cleaningStore.reviewBatch(batch.id, "不通过")}>不通过</button>
          </>
        )}
        {batch.status === "已完成" && batch.review !== "待评审" && (
          <span className="dim">评审：{batch.review}</span>
        )}
        {(batch.status === "排队中" || batch.status === "待清洗") && (
          <span className="dim">等待可用染杯…</span>
        )}
      </td>
    </tr>
  );
}

// ---------- 染杯队列 ----------

function CupQueue({ onSelect, selectedId }: { onSelect: (id: string) => void; selectedId: string }) {
  const s = useStore();
  const now = Date.now();

  return (
    <div className="panel">
      <div className="heading">
        <div>
          <p>隔离流程</p>
          <h2>染杯清洗队列</h2>
        </div>
        <span className="hint">连续两次冲洗 ≤ {RESIDUAL_LIMIT} 且换人复核才放行</span>
      </div>
      <div className="cup-list">
        {s.cups.map((cup) => {
          const receipt = latestReceipt(s.receipts, cup.id);
          const expired = receipt ? isReceiptExpired(receipt, now) : false;
          const over = cup.residual > RESIDUAL_LIMIT;
          const occupant = s.batches.find((b) => b.id === cup.occupiedBy);
          return (
            <article
              key={cup.id}
              className={`cup-card ${cup.id === selectedId ? "selected" : ""}`}
              onClick={() => onSelect(cup.id)}
            >
              <header>
                <strong>{cup.id}</strong>
                <span className={STATUS_STYLE[cup.status]}>{cup.status}</span>
              </header>
              <small className="cup-label">{cup.label}</small>
              <div className="cup-metrics">
                <span className={over ? "bad" : "good"}>
                  残留 {cup.residual.toFixed(2)}
                  {over ? " 超限" : ""}
                </span>
                {receipt ? (
                  <span className={expired ? "bad" : "good"}>
                    回执 v{receipt.version} · {fmtReceiptAge(receipt, now)}
                    {expired ? " 已过期" : ""}
                  </span>
                ) : (
                  <span className={cup.lastBatchId ? "bad" : "dim"}>
                    {cup.lastBatchId ? "无清洗回执" : "全新杯"}
                  </span>
                )}
              </div>
              {cup.lastBatchDepth && (
                <small className="dim">
                  上一批 {cup.lastBatchId} · {cup.lastBatchDepth}色
                </small>
              )}
              {occupant && (
                <small className="dim">
                  占用：{occupant.id}（{occupant.depth}色）
                </small>
              )}
              <CupCardActions cup={cup} />
            </article>
          );
        })}
      </div>
    </div>
  );
}

function CupCardActions({ cup }: { cup: DyeCup }) {
  const [washer, setWasher] = useState("");
  const [rinseValue, setRinseValue] = useState("");
  const [reviewer, setReviewer] = useState("");
  const [errors, setErrors] = useState<ReleaseErrorCode[]>([]);

  if (cup.status === "清洗中" && cup.draft) {
    const draft = cup.draft;
    const lastTwo = draft.rinses.slice(-2);
    return (
      <div className="clean-form" onClick={(e) => e.stopPropagation()}>
        <small>
          清洗人：{draft.washer} · 已冲洗 {draft.rinses.length} 次
        </small>
        <div className="rinse-row">
          {draft.rinses.length === 0 && <span className="dim">尚无冲洗读数</span>}
          {draft.rinses.map((r, i) => (
            <span key={i} className={r.residual > RESIDUAL_LIMIT ? "bad" : "good"}>
              #{i + 1} {r.residual.toFixed(2)}
            </span>
          ))}
        </div>
        <div className="inline">
          <input
            placeholder="本次残留色度"
            value={rinseValue}
            onChange={(e) => setRinseValue(e.target.value)}
          />
          <button
            onClick={() => {
              const v = Number(rinseValue);
              if (!Number.isNaN(v) && rinseValue !== "") {
                cleaningStore.addRinse(cup.id, v);
                setRinseValue("");
              }
            }}
          >
            登记冲洗
          </button>
        </div>
        <div className="inline">
          <input
            placeholder="复核人（须不同于清洗人）"
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
          />
          <button
            className="primary"
            disabled={lastTwo.length < 2 || lastTwo.some((r) => r.residual > RESIDUAL_LIMIT)}
            title="连续两次冲洗达标后方可复核放行"
            onClick={() => {
              const errs = cleaningStore.releaseCup(cup.id, reviewer);
              if (errs.length === 0) {
                setReviewer("");
                setErrors([]);
              } else {
                setErrors(errs as ReleaseErrorCode[]);
              }
            }}
          >
            复核放行
          </button>
        </div>
        {errors.map((e) => (
          <small key={e} className="bad">
            {RELEASE_ERROR_LABEL[e] ?? (e as string)}
          </small>
        ))}
      </div>
    );
  }

  return (
    <div className="clean-form" onClick={(e) => e.stopPropagation()}>
      <div className="inline">
        <input placeholder="清洗执行人" value={washer} onChange={(e) => setWasher(e.target.value)} />
        <button
          className="primary"
          disabled={cup.status === "清洗中" || Boolean(cup.occupiedBy)}
          onClick={() => {
            if (washer.trim()) {
              cleaningStore.startCleaning(cup.id, washer);
              setWasher("");
            }
          }}
        >
          开始清洗
        </button>
      </div>
      <QuickCheck cup={cup} />
    </div>
  );
}

function QuickCheck({ cup }: { cup: DyeCup }) {
  const [value, setValue] = useState("");
  if (cup.status === "清洗中" || cup.occupiedBy) return null;
  return (
    <div className="inline">
      <input placeholder="快检残留色度" value={value} onChange={(e) => setValue(e.target.value)} />
      <button
        onClick={() => {
          const v = Number(value);
          if (!Number.isNaN(v) && value !== "") {
            cleaningStore.quickCheck(cup.id, v);
            setValue("");
          }
        }}
      >
        快检
      </button>
    </div>
  );
}

// ---------- 单杯履历 + 回执管理 ----------

function CupHistory({ cupId }: { cupId: string }) {
  const s = useStore();
  const cup = s.cups.find((c) => c.id === cupId);
  const [mode, setMode] = useState<"none" | "backfill" | "correct">("none");
  if (!cup) return null;

  const receipts = s.receipts
    .filter((r) => r.cupId === cupId)
    .sort((a, b) => b.version - a.version);
  const history = s.audit
    .filter((e) => e.cupId === cupId || e.batchId === cup?.lastBatchId)
    .sort((a, b) => b.at - a.at);
  const current = receipts.find((r) => !r.superseded);

  return (
    <div className="panel">
      <div className="heading">
        <div>
          <p>单杯履历</p>
          <h2>
            {cup.id} 回执与留档
          </h2>
        </div>
        <div className="btn-row">
          <button onClick={() => setMode(mode === "backfill" ? "none" : "backfill")}>补录回执</button>
          {current && (
            <button onClick={() => setMode(mode === "correct" ? "none" : "correct")}>更正回执</button>
          )}
        </div>
      </div>

      {mode !== "none" && (
        <ReceiptForm
          cupId={cupId}
          mode={mode}
          base={mode === "correct" ? current : undefined}
          onDone={() => setMode("none")}
        />
      )}

      <div className="receipt-list">
        {receipts.map((r) => (
          <article key={r.id} className={`receipt ${r.superseded ? "archived" : ""}`}>
            <header>
              <strong>
                {r.id} · v{r.version}
              </strong>
              {r.superseded ? (
                <span className="tag tag-archived">旧版留档 · 已失效</span>
              ) : (
                <span className="tag tag-ok">现行</span>
              )}
            </header>
            <p>
              {r.washedBy} 清洗 / {r.reviewedBy} 换人复核 · 签发 {fmtTime(r.issuedAt)}
            </p>
            <p className="rinse-line">
              {r.rinses.map((x, i) => (
                <span key={i} className={x.residual > RESIDUAL_LIMIT ? "bad" : "good"}>
                  冲洗{i + 1} {x.residual.toFixed(2)}
                </span>
              ))}
              <span className="dim">放行残留 {r.residual.toFixed(2)}</span>
            </p>
            {r.note && <small className="dim">{r.note}</small>}
          </article>
        ))}
        {receipts.length === 0 && <p className="empty">该杯尚无回执（全新杯可直接排中/深色）</p>}
      </div>

      <h3 className="sub">操作履历</h3>
      <ul className="timeline">
        {history.map((e, i) => (
          <li key={`${e.at}-${i}`}>
            <span className="time">{fmtTime(e.at)}</span>
            <span className="event-type">{e.type}</span>
            <span>{e.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ReceiptForm({
  cupId,
  mode,
  base,
  onDone,
}: {
  cupId: string;
  mode: "backfill" | "correct";
  base?: CleaningReceipt;
  onDone: () => void;
}) {
  const [washedBy, setWashedBy] = useState(base?.washedBy ?? "");
  const [reviewedBy, setReviewedBy] = useState(base?.reviewedBy ?? "");
  const [r1, setR1] = useState(base ? String(base.rinses[0]?.residual ?? "") : "");
  const [r2, setR2] = useState(base ? String(base.rinses[1]?.residual ?? "") : "");
  const [hoursAgo, setHoursAgo] = useState(mode === "backfill" ? "2" : "0");
  const [note, setNote] = useState(base?.note ?? "");
  const [error, setError] = useState("");

  const submit = () => {
    const now = Date.now();
    const issuedAt = mode === "backfill" ? now - Number(hoursAgo || 0) * 3600_000 : base?.issuedAt ?? now;
    const input = {
      washedBy,
      reviewedBy,
      issuedAt,
      rinses: [
        { at: issuedAt, residual: Number(r1) },
        { at: issuedAt + 60_000, residual: Number(r2) },
      ],
      note,
    };
    if (!washedBy.trim() || !reviewedBy.trim()) return setError("清洗人与复核人必填");
    if (washedBy.trim() === reviewedBy.trim()) return setError("复核人必须换人，不能与清洗人相同");
    if (Number.isNaN(Number(r1)) || Number.isNaN(Number(r2))) return setError("请输入两次冲洗色度");
    if (Number(r1) > RESIDUAL_LIMIT || Number(r2) > RESIDUAL_LIMIT)
      return setError(`两次冲洗色度都须 ≤ ${RESIDUAL_LIMIT}`);

    if (mode === "backfill") {
      cleaningStore.backfillReceipt(cupId, input);
    } else if (base) {
      cleaningStore.correctReceipt(base.id, input);
    }
    onDone();
  };

  return (
    <div className="receipt-form">
      <h4>{mode === "backfill" ? "补录清洗回执" : `更正回执 ${base?.id}`}</h4>
      <small className="dim">
        保存后旧版回执自动留档；该杯相关排产与评审失效，全部在制排产按顺序重算。
      </small>
      <div className="field-grid">
        <label>
          <span>清洗执行人</span>
          <input value={washedBy} onChange={(e) => setWashedBy(e.target.value)} />
        </label>
        <label>
          <span>换人复核</span>
          <input value={reviewedBy} onChange={(e) => setReviewedBy(e.target.value)} />
        </label>
        <label>
          <span>第一次冲洗色度</span>
          <input value={r1} onChange={(e) => setR1(e.target.value)} placeholder={`≤ ${RESIDUAL_LIMIT}`} />
        </label>
        <label>
          <span>第二次冲洗色度</span>
          <input value={r2} onChange={(e) => setR2(e.target.value)} placeholder={`≤ ${RESIDUAL_LIMIT}`} />
        </label>
        {mode === "backfill" && (
          <label>
            <span>回执签发于几小时前</span>
            <input value={hoursAgo} onChange={(e) => setHoursAgo(e.target.value)} />
          </label>
        )}
        <label className="wide">
          <span>备注</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>
      {error && <small className="bad">{error}</small>}
      <div className="btn-row">
        <button className="primary" onClick={submit}>
          {mode === "backfill" ? "提交补录" : "提交更正"}
        </button>
        <button onClick={onDone}>取消</button>
      </div>
    </div>
  );
}

// ---------- 新增排产 ----------

function NewSchedule() {
  const [orderNo, setOrderNo] = useState("");
  const [fabric, setFabric] = useState("");
  const [depth, setDepth] = useState<ColorDepth>("浅");
  return (
    <div className="panel">
      <div className="heading">
        <div>
          <p>排产入队</p>
          <h2>新增小样批次</h2>
        </div>
      </div>
      <div className="field-grid">
        <label>
          <span>客户订单号</span>
          <input value={orderNo} onChange={(e) => setOrderNo(e.target.value)} placeholder="SO-24xx" />
        </label>
        <label>
          <span>面料成分</span>
          <input value={fabric} onChange={(e) => setFabric(e.target.value)} placeholder="如 棉府绸120g" />
        </label>
        <label>
          <span>目标色深</span>
          <div className="seg">
            {(["浅", "中", "深"] as ColorDepth[]).map((d) => (
              <button
                key={d}
                className={depth === d ? "seg-on" : ""}
                onClick={() => setDepth(d)}
              >
                {d}色
              </button>
            ))}
          </div>
        </label>
        <div className="grow-end">
          <button
            className="primary"
            onClick={() => {
              if (!orderNo.trim() && !fabric.trim()) return;
              cleaningStore.addSchedule({ orderNo, fabric, depth });
              setOrderNo("");
              setFabric("");
            }}
          >
            加入排产并占杯校验
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- 主面板 ----------

export default function CleaningConsole() {
  const s = useStore();
  const [selected, setSelected] = useState("C02");
  const [keyword, setKeyword] = useState("");

  const metrics = useMemo(() => {
    const waiting = s.batches.filter((b) => b.status === "排队中" || b.status === "待清洗").length;
    const blocked = s.batches.filter((b) => b.status === "待清洗").length;
    const cleaning = s.cups.filter((c) => c.status === "清洗中" || c.status === "待清洗").length;
    const passed = s.batches.filter((b) => b.status === "已完成" && b.review === "通过").length;
    const done = s.batches.filter((b) => b.status === "已完成").length;
    return { waiting, blocked, cleaning, rate: done ? Math.round((passed / done) * 100) : 100 };
  }, [s]);

  return (
    <section className="cleaning-console">
      <div className="metrics">
        <article>
          <small>在制排产</small>
          <strong>{metrics.waiting}</strong>
        </article>
        <article>
          <small>待清洗隔离</small>
          <strong>{metrics.blocked}</strong>
        </article>
        <article>
          <small>清洗/隔离染杯</small>
          <strong>{metrics.cleaning}</strong>
        </article>
        <article>
          <small>评审通过率</small>
          <strong>{metrics.rate}%</strong>
        </article>
      </div>

      <div className="rules-banner panel">
        <strong>染杯清洗隔离规则</strong>
        <ul>
          <li>开染前校验最近一次清洗回执（{Math.round(RECEIPT_TTL_MS / 3600_000)}h 有效）、残留色度（≤ {RESIDUAL_LIMIT}）与上一批色深；</li>
          <li>回执过期、残留超限、深色后直排浅色，一律只能转待清洗，不得占杯；</li>
          <li>清洗须换人复核，连续两次冲洗色度达标才放行；</li>
          <li>补录 / 更正回执 → 旧版留档，相关排产与评审失效并按新顺序重算。</li>
        </ul>
        <button className="ghost" onClick={cleaningStore.resetDemo}>
          重置演示数据
        </button>
      </div>

      <NewSchedule />

      <div className="toolbar panel-flush">
        <input
          placeholder="按客户订单号 / 面料筛选排产"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
      </div>
      <ScheduleList fabricFilter={keyword.trim()} />

      <div className="two-col">
        <CupQueue onSelect={setSelected} selectedId={selected} />
        <CupHistory cupId={selected} />
      </div>
    </section>
  );
}
