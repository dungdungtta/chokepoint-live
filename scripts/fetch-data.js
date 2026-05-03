#!/usr/bin/env node
/**
 * scripts/fetch-data.js
 * GitHub Actions에서 실행되는 데이터 fetch 스크립트.
 * 결과를 public/data.json에 저장한다.
 * 
 * 실행 방법:
 *   node scripts/fetch-data.js              # Actions 자동 실행
 *   node scripts/fetch-data.js --local      # 로컬 테스트
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isLocal   = process.argv.includes("--local");

// ── 환경변수 로드 ─────────────────────────────────────────────
const ENV = {
  EIA_API_KEY:       process.env.EIA_API_KEY       || "",
  NEWSAPI_KEY:       process.env.NEWSAPI_KEY        || "",
  FRED_API_KEY:      process.env.FRED_API_KEY       || "",
  FREIGHTOS_API_KEY: process.env.FREIGHTOS_API_KEY  || "",
  WORKERS_URL:       process.env.WORKERS_URL        || "",
};

// 로컬 테스트 시 .env.local 파일 읽기
if (isLocal) {
  try {
    const { config } = await import("dotenv");
    config({ path: ".env.local" });
    Object.keys(ENV).forEach((k) => {
      if (!ENV[k] && process.env[k]) ENV[k] = process.env[k];
    });
  } catch {
    console.log("dotenv 미설치 — 환경변수를 직접 export해서 사용하세요");
  }
}

// ── 메인 실행 ────────────────────────────────────────────────
async function main() {
  console.log(`[${new Date().toISOString()}] 데이터 fetch 시작`);

  let data;

  // Workers URL이 있으면 Workers에서 한번에 가져오기 (가장 빠름)
  if (ENV.WORKERS_URL) {
    console.log("Workers URL 감지 → Workers에서 통합 fetch");
    data = await fetchFromWorkers();
  } else {
    // Workers 미배포 시 직접 API 호출
    console.log("Workers 없음 → 각 API 직접 호출");
    data = await fetchDirect();
  }

  // public/ 디렉토리 없으면 생성
  const outputDir  = join(__dirname, "..", "public");
  const outputPath = join(outputDir, "data.json");
  mkdirSync(outputDir, { recursive: true });

  writeFileSync(outputPath, JSON.stringify(data, null, 2));
  console.log(`[OK] public/data.json 저장 완료 (${JSON.stringify(data).length} bytes)`);
}

// ── Workers에서 통합 fetch ───────────────────────────────────
async function fetchFromWorkers() {
  const res = await fetch(`${ENV.WORKERS_URL}/data`);
  if (!res.ok) throw new Error(`Workers /data 실패: ${res.status}`);
  return res.json();
}

// ── 직접 API 호출 (Workers 없을 때) ─────────────────────────
async function fetchDirect() {
  const [brent, freight, helium, newsHormuz, newsTaiwan, newsMalacca] =
    await Promise.allSettled([
      fetchBrent(),
      fetchFreight(),
      fetchHelium(),
      fetchNews("Hormuz OR blockade oil shipping"),
      fetchNews("Taiwan Strait military China"),
      fetchNews("Malacca strait shipping piracy"),
    ]);

  return {
    meta: {
      generated_at: new Date().toISOString(),
      source:       "direct",
      ttl_seconds:  900,
    },
    indicators: {
      brent:   settled(brent,   { price: null, change_pct: null, unit: "USD/bbl" }),
      freight: settled(freight, { asia_europe: null, asia_us_wc: null, unit: "USD/FEU" }),
      helium:  settled(helium,  { price_index: null, unit: "proxy" }),
    },
    news: {
      hormuz:  settled(newsHormuz,  []),
      taiwan:  settled(newsTaiwan,  []),
      malacca: settled(newsMalacca, []),
    },
    thresholds: {
      brent_alert:       110,
      wrs_alert:         1.5,
      helium_days_alert: 30,
    },
  };
}

// ── EIA Brent 유가 ───────────────────────────────────────────
async function fetchBrent() {
  if (!ENV.EIA_API_KEY) {
    console.warn("[SKIP] EIA_API_KEY 없음 — Brent 더미 데이터 사용");
    return { price: 103.0, change_pct: 0.4, date: today(), unit: "USD/bbl", note: "demo" };
  }

  const url =
    `https://api.eia.gov/v2/petroleum/pri/spt/data/?` +
    `api_key=${ENV.EIA_API_KEY}` +
    `&frequency=daily&data[0]=value` +
    `&facets[product][]=EPCBRENT` +
    `&sort[0][column]=period&sort[0][direction]=desc` +
    `&offset=0&length=2`;

  const res  = await fetch(url);
  const json = await res.json();
  const rows = json?.response?.data ?? [];

  if (!rows.length) throw new Error("EIA: 데이터 없음");

  const latest   = parseFloat(rows[0].value);
  const previous = rows[1] ? parseFloat(rows[1].value) : latest;
  const change   = previous ? ((latest - previous) / previous) * 100 : 0;

  return {
    price:      round(latest, 2),
    change_pct: round(change, 1),
    date:       rows[0].period,
    unit:       "USD/bbl",
  };
}

// ── Freightos / FRED 운임 지수 ───────────────────────────────
async function fetchFreight() {
  // FRED WPU30: 해운 운임 지수 (무료, 월별)
  if (!ENV.FRED_API_KEY) {
    console.warn("[SKIP] FRED_API_KEY 없음 — 운임 더미 데이터 사용");
    return { freight_index: 210.5, unit: "index", note: "demo" };
  }

  const url =
    `https://api.stlouisfed.org/fred/series/observations?` +
    `series_id=WPU30&api_key=${ENV.FRED_API_KEY}` +
    `&sort_order=desc&limit=2&file_type=json`;

  const res  = await fetch(url);
  const json = await res.json();
  const obs  = json?.observations ?? [];

  const latest   = obs[0] ? parseFloat(obs[0].value) : null;
  const previous = obs[1] ? parseFloat(obs[1].value) : null;
  const change   = (latest && previous) ? ((latest - previous) / previous) * 100 : null;

  return {
    freight_index: latest   ? round(latest, 1)  : null,
    change_pct:    change   ? round(change, 1)  : null,
    date:          obs[0]?.date ?? null,
    unit:          "index (WPU30 proxy)",
  };
}

// ── FRED 헬륨 대리 지표 ──────────────────────────────────────
async function fetchHelium() {
  if (!ENV.FRED_API_KEY) {
    return { price_index: 8.4, change_pct: 2.1, unit: "proxy", note: "demo" };
  }

  const url =
    `https://api.stlouisfed.org/fred/series/observations?` +
    `series_id=PNGASEUUSDM&api_key=${ENV.FRED_API_KEY}` +
    `&sort_order=desc&limit=2&file_type=json`;

  const res  = await fetch(url);
  const json = await res.json();
  const obs  = json?.observations ?? [];

  const latest   = obs[0] ? parseFloat(obs[0].value) : null;
  const previous = obs[1] ? parseFloat(obs[1].value) : null;
  const change   = (latest && previous) ? ((latest - previous) / previous) * 100 : null;

  return {
    price_index: latest ? round(latest, 2) : null,
    change_pct:  change ? round(change, 1) : null,
    date:        obs[0]?.date ?? null,
    unit:        "USD/MMBtu (EU nat-gas proxy)",
  };
}

// ── NewsAPI ───────────────────────────────────────────────────
async function fetchNews(query) {
  if (!ENV.NEWSAPI_KEY) {
    console.warn("[SKIP] NEWSAPI_KEY 없음 — 뉴스 빈 배열 반환");
    return [];
  }

  const url =
    `https://newsapi.org/v2/everything?` +
    `q=${encodeURIComponent(query)}` +
    `&language=en&sortBy=publishedAt&pageSize=5` +
    `&apiKey=${ENV.NEWSAPI_KEY}`;

  const res  = await fetch(url);
  const json = await res.json();

  if (json.status !== "ok") {
    throw new Error(`NewsAPI error: ${json.message}`);
  }

  return (json.articles ?? []).map((a) => ({
    title:     a.title,
    source:    a.source?.name ?? "Unknown",
    url:       a.url,
    published: a.publishedAt,
    sentiment: classifySentiment(a.title),
  }));
}

function classifySentiment(title = "") {
  const t       = title.toLowerCase();
  const danger  = ["blockade", "attack", "strike", "war", "closure", "seized", "threat", "escalat", "sank"];
  const calm    = ["ceasefire", "talks", "negotiat", "relief", "reopen", "resume", "agreement"];
  if (danger.some((w) => t.includes(w))) return "danger";
  if (calm.some((w)   => t.includes(w))) return "neutral";
  return "watch";
}

// ── 헬퍼 ─────────────────────────────────────────────────────
function settled(result, fallback) {
  if (result.status === "fulfilled") return result.value;
  console.error(`[WARN] fetch 실패: ${result.reason?.message}`);
  return fallback;
}

function round(n, decimals = 0) {
  const factor = Math.pow(10, decimals);
  return Math.round(n * factor) / factor;
}

function today() {
  return new Date().toISOString().split("T")[0];
}

// ── 실행 ─────────────────────────────────────────────────────
main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
