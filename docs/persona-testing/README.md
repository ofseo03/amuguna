# 페르소나 실사용 점검 도구

[docs/persona-usability-2026-09.md](../persona-usability-2026-09.md) 를 만든 도구다.
10대~80대 각 10명씩 80명의 페르소나로 랜딩 → 온보딩 6단계 → 결과 → 상세 → 뒤로가기를
브라우저로 실제 조작한다.

| 파일 | 내용 |
|---|---|
| `personas.json` | 페르소나 80명. `knownAs` 는 사람이 아는 동네 이름이 시·군·구 목록에 없어 다른 이름으로 고른 경우다 |
| `run.mjs` | 한 명당 한 세션(새 브라우저 컨텍스트)으로 전체 흐름을 조작하고 결과를 수확한다 → `results.json` |
| `probe.mjs` | 세션 한도 · 조건 수정 프리필 · 브라우저 뒤로가기 · 큰 글씨 · 키보드 이동 · 미성년 안내 |
| `probe2.mjs` | 근접탈락 문구 전문 · 법령 카드 상세 · 소득 단계 세부 · 상세 왕복 한도 |
| `verify.mjs` | 1번(뒤로가기 재검색·스크롤)과 3번(근접탈락 나이 상한) 수정의 회귀 검증 |

## 실행

Playwright 는 저장소 의존성이 아니다. 전역 설치본을 링크해서 쓴다.

```bash
# 프로덕션 빌드로 띄운다 — dev 는 StrictMode 때문에 요청이 두 번씩 나가 계측이 어긋난다
(cd ../../web && npm run build && SESSION_SECRET=$(openssl rand -hex 24) npx next start -p 3100)

mkdir -p node_modules && ln -s "$(npm root -g)/playwright" node_modules/playwright   # 최초 1회
BASE=http://localhost:3100 node run.mjs              # 80명 완주
BASE=http://localhost:3100 node run.mjs 80-01,10-02  # 일부만
BASE=http://localhost:3100 node probe.mjs
BASE=http://localhost:3100 node probe2.mjs
BASE=http://localhost:3100 node verify.mjs
```

`results.json` · `probes.json` · `probes2.json` · `verify.json` 은 실행하면 생기는 산출물이라 커밋하지 않는다.
