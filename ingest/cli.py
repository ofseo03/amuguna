"""CLI 진입점.

    python -m ingest --fixtures --dry-run          # 픽스처 + mock 임베딩 + 인메모리 DB
    python -m ingest --since 2026-08-07            # 일일 증분 (GitHub Actions 심야 배치)
    python -m ingest --weekly-reconcile            # 일요일 전량 대조 (SPEC §3.2)
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import logging
import os
import sys
from typing import Sequence

from .collectors import COLLECTORS
from .config import Settings
from .db import Database, InMemoryDatabase
from .embedder import Embedder
from .llm_fallback import LLMFallback
from .pipeline import Pipeline, check_volume_drop, render_report
from .summarize import Summarizer

log = logging.getLogger("ingest")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="python -m ingest",
        description="amuguna 공공 금융정보 수집·파싱 배치 (SPEC §3)",
    )
    parser.add_argument(
        "--fixtures",
        action="store_true",
        help="실 API 대신 ingest/fixtures/*.json 을 읽는다 (키 없이 전체 경로 실행)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Postgres 대신 InMemoryDatabase 를 쓴다. DB 쓰기 없음",
    )
    parser.add_argument(
        "--source",
        action="append",
        choices=sorted(COLLECTORS),
        help="특정 소스만 실행 (반복 지정 가능). 기본은 전체",
    )
    parser.add_argument(
        "--since",
        help="증분 수집 기준일 (YYYY-MM-DD). 소스가 수정일 파라미터를 지원할 때만 쓰인다",
    )
    parser.add_argument(
        "--weekly-reconcile",
        action="store_true",
        help="전량 대조 — 원본에서 사라진 상시 공고를 expired 처리 (SPEC §3.2)",
    )
    parser.add_argument(
        "--no-llm",
        action="store_true",
        help="LLM 보완·요약을 끄고 정규식/mock 만 쓴다 (파서 커버리지 측정용)",
    )
    parser.add_argument(
        "--previous-counts",
        help="전일 소스별 건수 JSON ('{\"bizinfo\": 120}') — 50%% 이상 감소 시 경고 (SPEC §10)",
    )
    parser.add_argument(
        "--no-purge",
        action="store_true",
        help="보존기간 경과 익명 프로필 자동 파기(SPEC §8)를 건너뛴다. 기본은 실행",
    )
    parser.add_argument("--json-report", help="리포트를 JSON 으로 저장할 경로")
    parser.add_argument("-v", "--verbose", action="store_true")
    return parser


class ConfigError(RuntimeError):
    """실행 전 구성 오류. 배치를 시작하지 않고 실패로 끝낸다."""


def _make_database(dry_run: bool, settings: Settings) -> tuple[Database, bool]:
    if dry_run:
        return InMemoryDatabase(), True
    if not settings.database_url:
        # 예전에는 여기서 InMemoryDatabase 로 조용히 강등했다. 그러면 스케줄러의
        # DATABASE_URL 시크릿이 비었을 때 수집·파싱을 다 하고 아무것도 저장하지 않은 채
        # 성공 종료한다 — 워크플로는 계속 녹색인데 서비스 데이터는 무기한 정지한다.
        # InMemoryDatabase 는 명시적 --dry-run 전용이다.
        raise ConfigError(
            "DATABASE_URL 이 비어 있습니다. 실 적재에는 필수입니다 "
            "(쓰기 없이 돌려보려면 --dry-run 을 주세요)."
        )
    from .db import PostgresDatabase  # psycopg 는 여기서만 필요

    return PostgresDatabase(settings.database_url), False


def _report_to_json(report) -> dict:
    parse = report.parse
    return {
        "dry_run": report.dry_run,
        "embedding_provider": report.embedding_provider,
        "reconciled": report.reconciled,
        "started_at": report.started_at.isoformat(),
        "sources": {
            key: {
                "fetched": s.fetched,
                "created": s.created,
                "updated": s.updated,
                "unchanged": s.unchanged,
                "expired": s.expired,
                "reactivated": s.reactivated,
                "errors": s.errors,
            }
            for key, s in report.sources.items()
        },
        "privacy": {
            "profiles_purged": report.profiles_purged,
            "purge_error": report.purge_error,
        },
        "parse": {
            "parsed": parse.parsed,
            "field_hits": dict(parse.field_hits),
            "methods": dict(parse.methods),
            "needs_review": parse.needs_review,
            "review_reasons": dict(parse.review_reasons),
            "status_needs_review": parse.blocked,
            "with_extra_conditions": parse.with_extra_conditions,
            "mean_confidence": round(parse.mean_confidence, 4),
        },
        "embeddings": {
            "programs": report.embeddings_written,
            "chunks": report.chunks_written,
        },
        "llm_calls": {
            "parse": report.llm_parse_calls,
            "summary": report.llm_summary_calls,
        },
    }


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
    )

    settings = Settings.from_env()
    if args.fixtures and not os.environ.get("EMBEDDING_PROVIDER"):
        # 픽스처 데모는 항상 재현 가능해야 한다 → mock 임베딩 고정.
        settings = dataclasses.replace(settings, mock_embeddings=True)

    try:
        db, in_memory = _make_database(args.dry_run, settings)
    except ConfigError as exc:
        print(f"구성 오류: {exc}", file=sys.stderr)
        log.error("%s", exc)
        return 2
    embedder = Embedder(settings)
    summarizer = Summarizer(
        settings if not args.no_llm else dataclasses.replace(settings, anthropic_api_key="")
    )
    llm = None if args.no_llm else LLMFallback(settings)
    if llm is not None and not llm.available:
        log.info("LLM 보완 비활성 (anthropic 미설치 또는 ANTHROPIC_API_KEY 없음) — "
                 "미추출 필드는 NULL + needs_review 로 남습니다")
    if not summarizer.available:
        log.info("요약·절차 생성이 mock 모드입니다 (본문 첫 문장 + 일반 3단계)")

    keys = args.source or sorted(COLLECTORS)
    collectors = [COLLECTORS[k](settings, use_fixtures=args.fixtures) for k in keys]

    pipeline = Pipeline(
        db, embedder=embedder, summarizer=summarizer, llm=llm, dry_run=in_memory
    )
    try:
        report = pipeline.run(
            collectors,
            since=args.since,
            reconcile=args.weekly_reconcile,
            # 인메모리에는 profiles 가 없다. 실 적재 실행에서만 파기가 의미 있다.
            purge_profiles=not in_memory and not args.no_purge,
        )
    finally:
        db.close()

    print(render_report(report))

    previous = json.loads(args.previous_counts) if args.previous_counts else None
    for warning in check_volume_drop(report, previous):
        print(f"[WARN] {warning}")
        log.warning(warning)

    if args.json_report:
        with open(args.json_report, "w", encoding="utf-8") as fh:
            json.dump(_report_to_json(report), fh, ensure_ascii=False, indent=2)
        print(f"\nJSON 리포트 저장: {args.json_report}")

    if report.purge_error:
        print(
            "\n[WARN] 프로필 90일 자동 파기가 실행되지 않았습니다 (SPEC §8): "
            f"{report.purge_error}",
            file=sys.stderr,
        )

    total = report.totals
    if total.fetched == 0 and total.errors:
        # 전 소스 실패 = 배치 실패. 직전 성공 스냅샷은 DB에 그대로 남아 있다.
        print("\n전 소스 수집 실패 — 기존 데이터를 유지합니다.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
