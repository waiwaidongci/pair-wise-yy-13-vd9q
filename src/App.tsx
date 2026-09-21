import "./styles.css";

const project = {
  "sourceNo": 7,
  "id": "hxyfront-62012",
  "port": 62012,
  "title": "纺织染整小样管理",
  "domain": "纺织染整",
  "prompt": "我需要一个纺织染整实验室的小样管理前端系统，可以记录面料成分、克重、染料配方、浴比、温度曲线、保温时间、后整理方式、色差值和评审结果。页面需要有小样批次列表、配方比例展示、Lab色差对比、工艺曲线摘要和按客户订单筛选。",
  "palette": [
    "#be123c",
    "#4f46e5",
    "#16a34a"
  ],
  "metrics": [
    "小样批次",
    "色差超限",
    "客户订单",
    "通过率"
  ],
  "filters": [
    "棉",
    "涤纶",
    "锦纶",
    "混纺"
  ],
  "fields": [
    "面料成分",
    "克重",
    "染料配方",
    "浴比",
    "保温时间",
    "色差值"
  ],
  "records": [
    [
      "LAB-620A",
      "棉府绸120g",
      "ΔE 0.84",
      "评审通过"
    ],
    [
      "LAB-621C",
      "涤纶针织",
      "升温曲线偏快",
      "待复染"
    ],
    [
      "LAB-624B",
      "混纺斜纹",
      "后整理柔软剂2%",
      "客户确认中"
    ]
  ]
};

function App() {
  return (
    <main className="app">
      <section className="hero">
        <p>{project.id} · 源提示词{project.sourceNo} · Port {project.port}</p>
        <h1>{project.title}</h1>
        <span>{project.prompt}</span>
      </section>

      <section className="metrics">
        {project.metrics.map((metric: string, index: number) => (
          <article key={metric}>
            <small>{metric}</small>
            <strong>{[28, 6, 14, 91][index] ?? 10}</strong>
          </article>
        ))}
      </section>

      <section className="workspace">
        <aside className="panel">
          <h2>{project.domain}分类</h2>
          <div className="chips">
            {project.filters.map((item: string) => (
              <button key={item}>{item}</button>
            ))}
          </div>
        </aside>

        <section className="panel form-panel">
          <div className="heading">
            <div>
              <p>专业字段</p>
              <h2>新增记录</h2>
            </div>
            <button className="primary">保存记录</button>
          </div>
          <div className="field-grid">
            {project.fields.map((field: string) => (
              <label key={field}>
                <span>{field}</span>
                <input placeholder={"填写" + field} />
              </label>
            ))}
          </div>
        </section>
      </section>

      <section className="panel">
        <div className="heading">
          <div>
            <p>近期记录</p>
            <h2>工作台摘要</h2>
          </div>
          <button>导出CSV</button>
        </div>
        <div className="records">
          {project.records.map((record: string[], index: number) => (
            <article key={record.join("-")}>
              <b>{String(index + 1).padStart(2, "0")}</b>
              <div>
                <h3>{record[0]}</h3>
                <p>{record.slice(1).join(" · ")}</p>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}

export default App;
