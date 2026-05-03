/**
 * Chokepoint Intelligence — Cloudflare Workers API Relay
 * 
 * 역할: 브라우저에서 직접 호출하면 API 키 노출 + CORS 에러가 나는 외부 API들을
 *       Workers가 대신 호출하고 CORS 헤더를 붙여서 응답해준다.
 * 
 * 배포: wrangler deploy
 * 엔드포인트:
 *   GET /data          → 전체 live data 묶음 (지도가 쓰는 메인 엔드포인트)
 *   GET /brent         → EIA 유가만
 *   GET /freight       → Freightos 운임 지수만
 *   GET /news?q=query  → NewsAPI 헤드라인만
 *   GET /helium        → FRED 헬륨 대리 지표만
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 프리플라이트 처리
    if (request.method === "OPTIONS") {
      return corsResponse(null, 204);
    }

    try {
      // 캐시 키 설정 (Cloudflare Cache API 사용)
      const cache = caches.default;

      if (path === "/data") {
        return await handleFullData(request, env, ctx, cache);
      } else if (path === "/brent") {
        return await handleBrent(request, env, ctx, cache);
      } else if (path === "/freight") {
        return await handleFreight(request, env, ctx, cache);
      } else if (path === "/news") {
        const query = url.searchParams.get("q") || "Hormuz strait";
        return await handleNews(request, env, ctx, cache, query);
      } else if (path === "/helium") {
        return await handleHelium(request, env, ctx, cache);
      } else {
        return corsResponse({ error: "Not found", endpoints: ["/data", "/brent", "/freight", "/news", "/helium"] }, 404);
      }
    } catch (err) {
      return corsResponse({ error: "Internal error", message: err.message }, 500);
    }
  },
};

// ── /data  전체 데이터 묶음 ──────────────────────────────────────
async function handleFullData(request, env, ctx, cache) {
  const cacheKey = new Request("https://cache.chokepoint/data", request);
  const cached = await cache.match(cacheKey);
  if (cached) return addCorsHeaders(cached);

  // 병렬 fetch로 응답 속도 최적화
  const [brent, freight, helium, newsHormuz, newsTaiwan, newsMalacca] = await Promise.allSettled([
    fetchBrent(env),
    fetchFreight(env),
    fetchHelium(env),
    fetchNews(env, "Hormuz OR blockade oil shipping"),
    fetchNews(env, "Taiwan Strait military China"),
    fetchNews(env, "Malacca strait shipping piracy"),
  ]);

  const data = {
    meta: {
      generated_at: new Date().toISOString(),
      ttl_seconds: 900, // 15분
    },
    indicators: {
      brent:   getValue(brent,   { price: null, change_pct: null, unit: "USD/bbl" }),
      freight: getValue(freight, { asia_europe: null, asia_us_wc: null, unit: "USD/FEU" }),
      helium:  getValue(helium,  { price_index: null, unit: "proxy index" }),
    },
    news: {
      hormuz:  getValue(newsHormuz,  []),
      taiwan:  getValue(newsTaiwan,  []),
      malacca: getValue(newsMalacca, []),
    },
    // 정적 임계값 (변경 시 여기서만 관리)
    thresholds: {
      brent_alert:    110,   // USD/bbl 초과 시 UI 경보
      wrs_alert:      1.5,   // 전쟁위험할증료 % 초과 시
      helium_days_alert: 30, // 재고 일수 미만 시
    },
  };

  const response = corsResponse(data, 200);

  // 15분 캐시 (Cloudflare 엣지 + 브라우저 모두)
  response.headers.set("Cache-Control", "public, max-age=900");
  ctx.waitUntil(cache.put(cacheKey, response.clone()));

  return response;
}

// ── EIA Brent 유가 ────────────────────────────────────────────
async function fetchBrent(env) {
  // EIA Open Data v2 — 무료, API 키 필요
  // 키 발급: https://www.eia.gov/opendata/
  const res = await fetch(
    `https://api.eia.gov/v2/petroleum/pri/spt/data/?` +
    `api_key=${env.EIA_API_KEY}` +
    `&frequency=daily&data[0]=value` +
    `&facets[product][]=EPCBRENT` +
    `&sort[0][column]=period&sort[0][direction]=desc` +
    `&offset=0&length=2`
  );
  const json = await res.json();
  const rows = json?.response?.data ?? [];

  if (rows.length < 1) throw new Error("EIA: no data");

  const latest   = parseFloat(rows[0].value);
  const previous = rows[1] ? parseFloat(rows[1].value) : latest;
  const change   = previous ? ((latest - previous) / previous) * 100 : 0;

  return {
    price:      Math.round(latest * 100) / 100,
    change_pct: Math.round(change * 10) / 10,
    date:       rows[0].period,
    unit:       "USD/bbl",
  };
}

async function handleBrent(request, env, ctx, cache) {
  const cacheKey = new Request("https://cache.chokepoint/brent", request);
  const cached = await cache.match(cacheKey);
  if (cached) return addCorsHeaders(cached);

  const data = await fetchBrent(env);
  const res = corsResponse(data, 200);
  res.headers.set("Cache-Control", "public, max-age=900");
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// ── Freightos 운임 지수 ────────────────────────────────────────
async function fetchFreight(env) {
  // Freightos Baltic Daily Index
  // 가입: https://fbx.freightos.com/
  // 무료 티어: 제한적 but MVP에 충분
  const res = await fetch("https://fbx.freightos.com/api/v1/rates", {
    headers: {
      "Authorization": `Bearer ${env.FREIGHTOS_API_KEY}`,
      "Content-Type":  "application/json",
    },
  });

  if (!res.ok) {
    // API 미가입 시 FRED의 컨테이너운임 프록시 사용
    return fetchFreightProxy(env);
  }

  const json = await res.json();
  // Freightos 응답 구조에 맞게 파싱 (실제 응답 구조는 가입 후 확인)
  return {
    asia_europe: json?.routes?.["CSHA-NLRTM"]?.rate ?? null,
    asia_us_wc:  json?.routes?.["CSHA-USLAX"]?.rate ?? null,
    unit:        "USD/FEU",
    date:        new Date().toISOString().split("T")[0],
  };
}

async function fetchFreightProxy(env) {
  // 대안: FRED FRED/WPUIP2311001 (해운 운임 지수) — 무료
  const res = await fetch(
    `https://api.stlouisfed.org/fred/series/observations?` +
    `series_id=WPU30&api_key=${env.FRED_API_KEY}` +
    `&sort_order=desc&limit=1&file_type=json`
  );
  const json = await res.json();
  const val  = json?.observations?.[0]?.value;

  return {
    asia_europe: null,
    asia_us_wc:  null,
    freight_index: val ? parseFloat(val) : null,
    note:          "FRED WPU30 proxy — Freightos API not connected",
    unit:          "index",
  };
}

async function handleFreight(request, env, ctx, cache) {
  const cacheKey = new Request("https://cache.chokepoint/freight", request);
  const cached = await cache.match(cacheKey);
  if (cached) return addCorsHeaders(cached);

  const data = await fetchFreight(env);
  const res = corsResponse(data, 200);
  res.headers.set("Cache-Control", "public, max-age=3600"); // 1시간 캐시 (운임은 느리게 변함)
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// ── NewsAPI 지정학 뉴스 ────────────────────────────────────────
async function fetchNews(env, query) {
  // NewsAPI.org — 무료 티어: 100 req/일
  // 가입: https://newsapi.org/
  const encoded = encodeURIComponent(query);
  const res = await fetch(
    `https://newsapi.org/v2/everything?` +
    `q=${encoded}` +
    `&language=en` +
    `&sortBy=publishedAt` +
    `&pageSize=5` +
    `&apiKey=${env.NEWSAPI_KEY}`
  );
  const json = await res.json();

  if (json.status !== "ok") throw new Error(`NewsAPI: ${json.message}`);

  return (json.articles ?? []).map((a) => ({
    title:      a.title,
    source:     a.source?.name ?? "Unknown",
    url:        a.url,
    published:  a.publishedAt,
    // 제목 기반 간단 감성 분류
    sentiment:  classifySentiment(a.title),
  }));
}

function classifySentiment(title) {
  if (!title) return "neutral";
  const t = title.toLowerCase();
  const danger  = ["blockade","attack","strike","war","closure","seized","threat","escalat"];
  const neutral = ["ceasefire","talks","negotiat","relief","reopen","resume"];
  if (danger.some((w) => t.includes(w)))  return "danger";
  if (neutral.some((w) => t.includes(w))) return "neutral";
  return "watch";
}

async function handleNews(request, env, ctx, cache, query) {
  const cacheKey = new Request(`https://cache.chokepoint/news?q=${encodeURIComponent(query)}`, request);
  const cached = await cache.match(cacheKey);
  if (cached) return addCorsHeaders(cached);

  const data = await fetchNews(env, query);
  const res = corsResponse(data, 200);
  res.headers.set("Cache-Control", "public, max-age=3600"); // 1시간
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// ── FRED 헬륨 대리 지표 ────────────────────────────────────────
async function fetchHelium(env) {
  // 헬륨 현물가는 공개 API 없음 → FRED의 천연가스 가격을 대리 지표로 사용
  // (카타르 Ras Laffan은 LNG + 헬륨 동시 생산 → 상관관계 있음)
  const res = await fetch(
    `https://api.stlouisfed.org/fred/series/observations?` +
    `series_id=PNGASEUUSDM&api_key=${env.FRED_API_KEY}` +
    `&sort_order=desc&limit=2&file_type=json`
  );
  const json  = await res.json();
  const obs   = json?.observations ?? [];

  const latest   = obs[0] ? parseFloat(obs[0].value) : null;
  const previous = obs[1] ? parseFloat(obs[1].value) : null;
  const change   = (latest && previous) ? ((latest - previous) / previous) * 100 : null;

  return {
    price_index:   latest   ? Math.round(latest * 100) / 100   : null,
    change_pct:    change   ? Math.round(change * 10)  / 10    : null,
    date:          obs[0]?.date ?? null,
    note:          "FRED PNGASEUUSDM (EU nat-gas USD) — helium proxy via Qatar LNG correlation",
    // 실제 헬륨 가격 추적은 Gasworld.com 구독 필요 ($200+/yr)
    // MVP에서는 이 지표로 방향성만 표시
    unit:          "USD/MMBtu (proxy)",
  };
}

async function handleHelium(request, env, ctx, cache) {
  const cacheKey = new Request("https://cache.chokepoint/helium", request);
  const cached = await cache.match(cacheKey);
  if (cached) return addCorsHeaders(cached);

  const data = await fetchHelium(env);
  const res = corsResponse(data, 200);
  res.headers.set("Cache-Control", "public, max-age=86400"); // 24시간 (월별 데이터)
  ctx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}

// ── 헬퍼 함수 ─────────────────────────────────────────────────
function corsResponse(body, status) {
  const headers = {
    "Content-Type":                "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
  return new Response(body ? JSON.stringify(body) : null, { status, headers });
}

function addCorsHeaders(response) {
  const res = new Response(response.body, response);
  res.headers.set("Access-Control-Allow-Origin", "*");
  return res;
}

function getValue(settled, fallback) {
  return settled.status === "fulfilled" ? settled.value : fallback;
}
