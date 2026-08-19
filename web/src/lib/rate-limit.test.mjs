import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_IP_LIMIT,
  DEFAULT_SESSION_LIMIT,
  checkSessionAndIpRateLimit,
  envLimit,
  rateLimitMessage,
} from "./rate-limit.ts";

/** 같은 공인 IP 를 공유하는 요청 — NAT 를 흉내낸다 */
function req(ip) {
  return new Request("https://amuguna.test/api/match", {
    method: "POST",
    headers: { "x-forwarded-for": ip },
  });
}

const uuid = (n) => `0f8fad5b-d9cb-469f-a165-${String(n).padStart(12, "0")}`;

test("NAT 뒤 여러 사용자가 한 IP 를 공유해도 서로의 한도를 잡아먹지 않는다", () => {
  // 심사위원 여러 명이 같은 망(대학·회사·캐리어 NAT)에서 동시에 접속하는 상황.
  // 20명이 각자 세션 한도(10회)를 꽉 채워도 200회 < IP 한도(600회) 이므로 전원 통과해야 한다.
  const ip = "203.0.113.10";
  const now = 1_000_000;
  for (let user = 0; user < 20; user++) {
    for (let i = 0; i < DEFAULT_SESSION_LIMIT; i++) {
      const r = checkSessionAndIpRateLimit(uuid(user), req(ip), now, {});
      assert.equal(r.allowed, true, `user=${user} i=${i} 가 차단되었다`);
    }
  }
});

test("같은 세션이 한도를 넘으면 세션 축에서 걸린다", () => {
  const ip = "203.0.113.11";
  const sid = uuid(100);
  const now = 2_000_000;
  for (let i = 0; i < DEFAULT_SESSION_LIMIT; i++) {
    assert.equal(checkSessionAndIpRateLimit(sid, req(ip), now, {}).allowed, true);
  }
  const blocked = checkSessionAndIpRateLimit(sid, req(ip), now, {});
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, "session");
  assert.equal(blocked.limit, DEFAULT_SESSION_LIMIT);
  assert.ok(blocked.retryAfter >= 1);
});

test("세션을 갈아끼워 우회해도 IP 안전망에서 걸린다", () => {
  const ip = "203.0.113.12";
  const now = 3_000_000;
  let allowed = 0;
  // 매 요청 새 세션 = 세션 축은 항상 통과. IP 축만이 방어선이다.
  for (let i = 0; i < DEFAULT_IP_LIMIT + 5; i++) {
    if (checkSessionAndIpRateLimit(uuid(1000 + i), req(ip), now, {}).allowed) allowed++;
  }
  assert.equal(allowed, DEFAULT_IP_LIMIT);
  const blocked = checkSessionAndIpRateLimit(uuid(9999), req(ip), now, {});
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.scope, "ip");
});

test("세션 쿠키가 없으면 IP 축만 적용한다 (세션 한도를 IP 로 대신 물리지 않는다)", () => {
  const ip = "203.0.113.13";
  const now = 4_000_000;
  // 세션 한도(10)보다 많이 보내도 IP 한도 안이면 통과해야 한다.
  for (let i = 0; i < DEFAULT_SESSION_LIMIT * 3; i++) {
    assert.equal(checkSessionAndIpRateLimit(null, req(ip), now, {}).allowed, true);
  }
});

test("환경변수로 한도를 재배포 없이 완화·해제할 수 있다 (심사 구간 스위치)", () => {
  const ip = "203.0.113.14";
  const sid = uuid(200);
  const now = 5_000_000;
  const relaxed = { RATE_LIMIT_SESSION_PER_MIN: "100" };
  for (let i = 0; i < 100; i++) {
    assert.equal(checkSessionAndIpRateLimit(sid, req(ip), now, relaxed).allowed, true);
  }
  assert.equal(checkSessionAndIpRateLimit(sid, req(ip), now, relaxed).allowed, false);

  // 0 = 전면 해제
  const off = { RATE_LIMIT_SESSION_PER_MIN: "0", RATE_LIMIT_IP_PER_MIN: "0" };
  const sid2 = uuid(201);
  for (let i = 0; i < 5_000; i++) {
    assert.equal(checkSessionAndIpRateLimit(sid2, req("203.0.113.15"), now, off).allowed, true);
  }
});

test("잘못된 환경변수 값은 기본값으로 되돌린다 — 오타가 서비스를 막지 않는다", () => {
  assert.equal(envLimit("X", 10, { X: "abc" }), 10);
  assert.equal(envLimit("X", 10, { X: "-5" }), 10);
  assert.equal(envLimit("X", 10, { X: "2.5" }), 10);
  assert.equal(envLimit("X", 10, { X: "" }), 10);
  assert.equal(envLimit("X", 10, {}), 10);
  assert.equal(envLimit("X", 10, { X: "0" }), 0);
  assert.equal(envLimit("X", 10, { X: "900" }), 900);
});

test("차단 문구는 원인이 아니라 재시도 방법을 알린다", () => {
  const message = rateLimitMessage(17);
  assert.match(message, /17초 후에 다시 시도/);
  // 0초 후 재시도하라는 안내는 사용자에게 무의미하다
  assert.match(rateLimitMessage(0), /1초 후에 다시 시도/);
});
