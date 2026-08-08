"""amuguna 수집·파싱 파이프라인 (SPEC §3, §6, §7.1, §7.5).

배치 전용 패키지. 사용자 요청 경로에서는 절대 호출되지 않는다 (SPEC §7.5).

    python -m ingest --fixtures --dry-run
"""

__all__ = ["__version__"]

__version__ = "0.1.0"
