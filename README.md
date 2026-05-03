# Chokepoint Live — 셋업 가이드

## 전체 구조

```
chokepoint-live/
├── workers/
│   └── index.js              ← Cloudflare Workers API 중계
├── scripts/
│   └── fetch-data.js         ← GitHub Actions가 실행하는 fetch 스크립트
├── public/
│   ├── data.json             ← Actions가 자동 갱신하는 실시간 데이터
│   └── index.html            ← 기존 chokepoint_map_v2.html을 여기로 이동
├── .github/
│   └── workflows/
│       └── refresh-data.yml  ← 15분마다 자동 실행
├── wrangler.toml             ← Cloudflare Workers 설정
├── package.json
└── .env.local                ← 로컬 전용 (gitignore됨)
```

---

## 1단계 — API 키 발급 (30분)

| API | URL | 소요 시간 | 비용 |
|-----|-----|----------|------|
| EIA Open Data | https://www.eia.gov/opendata/ | 5분 (즉시 발급) | 무료 |
| NewsAPI | https://newsapi.org/register | 2분 | 무료 (100 req/일) |
| FRED API | https://fred.stlouisfed.org/docs/api/api_key.html | 2분 | 무료 |
| Cloudflare 계정 | https://dash.cloudflare.com/sign-up | 5분 | 무료 |

---

## 2단계 — 로컬 테스트

```bash
# 리포 클론 또는 파일 복사
git clone https://github.com/YOUR_USERNAME/chokepoint-live
cd chokepoint-live

# 패키지 설치
npm install

# 환경변수 설정
cp .env.local.template .env.local
# .env.local 파일을 열어서 API 키 입력

# 데이터 fetch 테스트
npm run dev
# → public/data.json 생성 확인
```

---

## 3단계 — Cloudflare Workers 배포

```bash
# Wrangler CLI 로그인
npx wrangler login
# 브라우저에서 Cloudflare 계정 연동

# API 키를 Workers 환경변수(Secret)로 등록
# (이 방법으로만 키가 암호화되어 저장됨. wrangler.toml에 넣으면 안됨)
npx wrangler secret put EIA_API_KEY
# 프롬프트에서 키 입력

npx wrangler secret put NEWSAPI_KEY
npx wrangler secret put FRED_API_KEY

# Workers 배포
npm run deploy:worker
# → 배포 완료 URL 출력 예:
#   https://chokepoint-api.YOUR_ACCOUNT.workers.dev

# 브라우저에서 확인
# https://chokepoint-api.YOUR_ACCOUNT.workers.dev/data
```

---

## 4단계 — GitHub 리포 + Secrets 설정

```bash
# GitHub에 새 리포 생성 후
git remote add origin https://github.com/YOUR_USERNAME/chokepoint-live
git push -u origin main
```

GitHub 리포 → Settings → Secrets and variables → Actions → New repository secret:

| Secret 이름 | 값 |
|-------------|-----|
| `EIA_API_KEY` | EIA에서 발급한 키 |
| `NEWSAPI_KEY` | NewsAPI 키 |
| `FRED_API_KEY` | FRED 키 |
| `WORKERS_URL` | 3단계에서 나온 Workers URL |

---

## 5단계 — GitHub Pages 배포

GitHub 리포 → Settings → Pages:
- Source: `Deploy from a branch`
- Branch: `main` / `/ (root)` 또는 `/public`

첫 Actions 실행:
- Actions 탭 → "Live Data Feed — Auto Refresh" → "Run workflow"
- `public/data.json` 생성 확인

---

## 6단계 — index.html에서 data.json 연동

`public/index.html` (기존 지도 파일) 상단에 추가:

```html
<script>
// 페이지 로드 시 data.json fetch
async function loadLiveData() {
  try {
    const res  = await fetch('./data.json');
    const data = await res.json();
    updateDashboard(data);
    // 15분마다 자동 갱신
    setInterval(() => loadLiveData(), 15 * 60 * 1000);
  } catch (err) {
    console.warn('Live data 없음 — 정적 데이터로 표시:', err);
  }
}

function updateDashboard(data) {
  const { indicators, news, thresholds } = data;

  // 상단 바 Brent 유가 업데이트
  if (indicators.brent?.price) {
    document.querySelector('.tsv.warn').textContent =
      `$${indicators.brent.price}`;
  }

  // 헬륨 지표 업데이트
  // (실제 헬륨 재고일은 없으므로 대리 지표로 방향성만 표시)
  if (indicators.helium?.change_pct !== null) {
    const heliumEl = document.querySelector('.tsv.danger');
    if (heliumEl && indicators.helium.change_pct > 5) {
      heliumEl.style.color = 'var(--red)';
    }
  }

  // Brent 임계값 초과 시 경보 배너 표시
  if (indicators.brent?.price > thresholds.brent_alert) {
    showAlertBanner(
      `Brent $${indicators.brent.price} — $${thresholds.brent_alert} alert threshold exceeded`
    );
  }

  // 뉴스 피드 업데이트
  updateNewsFeed(news);

  // 마지막 갱신 시각 표시
  const ts = new Date(data.meta.generated_at);
  const ago = Math.round((Date.now() - ts) / 60000);
  console.log(`Data refreshed ${ago}m ago`);
}

function showAlertBanner(message) {
  const existing = document.getElementById('alert-banner');
  if (existing) return;

  const banner = document.createElement('div');
  banner.id = 'alert-banner';
  Object.assign(banner.style, {
    position: 'fixed', top: '52px', left: '0', right: 'var(--panel)',
    background: 'rgba(224,80,80,.15)', borderBottom: '1px solid rgba(224,80,80,.4)',
    color: '#ff7a7a', padding: '8px 20px', fontSize: '12px',
    fontFamily: 'var(--mono)', zIndex: '999', textAlign: 'center',
  });
  banner.innerHTML = `⚠ ${message} <span onclick="this.parentElement.remove()" style="cursor:pointer;margin-left:12px;opacity:.6">✕</span>`;
  document.body.prepend(banner);
}

function updateNewsFeed(news) {
  // 사이드 패널의 뉴스 피드 영역을 실제 뉴스로 교체
  // (구체적인 선택자는 index.html 구조에 맞게 수정)
  const feeds = {
    hormuz:  document.querySelector('[data-news="hormuz"]'),
    taiwan:  document.querySelector('[data-news="taiwan"]'),
    malacca: document.querySelector('[data-news="malacca"]'),
  };

  Object.entries(feeds).forEach(([key, el]) => {
    if (!el || !news[key]?.length) return;
    el.innerHTML = news[key].map((n) => `
      <div style="padding:8px 0;border-bottom:0.5px solid var(--border);font-size:11px">
        <div style="color:var(--text);margin-bottom:2px">${n.title}</div>
        <div style="color:var(--dim);font-family:var(--mono)">${n.source} · ${timeAgo(n.published)}</div>
      </div>`).join('');
  });
}

function timeAgo(isoString) {
  const diff = Math.round((Date.now() - new Date(isoString)) / 60000);
  if (diff < 60)   return `${diff}m ago`;
  if (diff < 1440) return `${Math.round(diff / 60)}h ago`;
  return `${Math.round(diff / 1440)}d ago`;
}

// 실행
loadLiveData();
</script>
```

---

## 완료 후 체크리스트

- [ ] `npm run dev` → `public/data.json` 생성 확인
- [ ] Workers 배포 → `/data` 엔드포인트 브라우저에서 확인
- [ ] GitHub Secrets 4개 등록 확인
- [ ] Actions 수동 실행 → `data.json` 커밋 확인
- [ ] 15분 후 자동 커밋 확인
- [ ] GitHub Pages URL에서 지도 로딩 확인
- [ ] 상단 바 유가 숫자가 실제 값인지 확인
