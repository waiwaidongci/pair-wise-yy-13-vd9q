import "./styles.css";
import { CleaningStation } from "./cleaning/CleaningStation";

const project = {
  "sourceNo": 7,
  "id": "hxyfront-62012",
  "port": 62012,
  "title": "纺织染整小样管理",
  "domain": "纺织染整",
  "prompt":
    "染杯清洗隔离流程：开染前校验最近清洗回执、残留色度与上一批色深；回执过期、残留超限或深色后直接排浅色只能转待清洗，不得占杯。清洗须换人复核、连续两次冲洗色度达标才放行；补录/更正回执级联失效并重算，旧版留档。",
  "palette": ["#be123c", "#4f46e5", "#16a34a"]
};

function App() {
  return (
    <main className="app">
      <section className="hero">
        <p>{project.id} · 源提示词{project.sourceNo} · Port {project.port}</p>
        <h1>{project.title}</h1>
        <span>{project.prompt}</span>
      </section>

      <CleaningStation />
    </main>
  );
}

export default App;
