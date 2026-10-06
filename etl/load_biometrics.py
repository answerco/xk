#!/usr/bin/env python3
"""생체 데이터 CSV(실시간 5분 데이터 내보내기) → PostgreSQL 적재기.

의존성: Python 3.9+ 표준 라이브러리 + psql 클라이언트.

사용 예:
    python3 etl/load_biometrics.py data/biometrics.zip
    python3 etl/load_biometrics.py data/raw/            # 디렉터리 내 *.csv 전체
    python3 etl/load_biometrics.py --dsn postgresql://user:pw@host:5432/db a.csv b.csv

- 같은 파일(SHA-256 동일)은 건너뜀 (--force 로 재적재)
- (subject_id, measured_at) 가 겹치면 나중에 적재한 파일 값으로 갱신 → 기간이 겹치는 재내보내기 파일도 안전
- 파일 하나가 한 트랜잭션. 형식이 다르면 해당 파일 적재 전에 오류로 중단

가명 처리 (DB 에 실명/실제 시설명을 저장하지 않음):
- 이름: 가운데 글자를 O 로 (홍길동 → 홍O동, 김철수B → 김O수B). 같은 시설에서 겹치면 '김O순(2)'
- 시설: 처음 보는 시설번호 순서대로 A요양원, B요양원, ... (원본 시설명은 버림)
- 같은 사람 재식별: HMAC-SHA256(비밀키, 시설번호|실명) 을 subject.source_key 로 저장.
  비밀키는 $BIOMETRIC_PSEUDONYM_KEY 또는 --key-file (기본 data/pseudonym.key, 없으면 생성).
  ※ 키를 잃어버리면 다음 적재 때 같은 사람이 새 대상자로 등록되므로 안전하게 보관할 것.
"""
import argparse
import csv
import hashlib
import hmac
import secrets
import io
import json
import os
import re
import subprocess
import sys
import zipfile
from datetime import datetime

EXPECTED_COLUMNS = [
    "시간", "수면 상태", "수면 깊이", "수면 중 움직임", "각성 중 움직임", "공실 상태 움직임",
    "심박", "심박 Z-점수", "POBC 심박", "호흡", "호흡 Z-점수", "POBC 호흡", "거리 (m)", "재실 상태",
]
# vital_reading 컬럼 (EXPECTED_COLUMNS[1:] 순서와 동일)
DB_COLUMNS = [
    "sleep_state", "sleep_depth", "movement_sleep", "movement_awake", "movement_vacant",
    "heart_rate", "heart_rate_z", "pobc_heart", "resp_rate", "resp_rate_z", "pobc_resp",
    "distance_m", "presence_state",
]
SLEEP_STATE = {"": "", "취침": "bedtime", "수면 중": "asleep", "기상": "wake"}
PRESENCE_STATE = {"재실": "present", "비움": "absent", "연결 끊김": "disconnected", "부팅중": "booting"}
SUMMARY_KEYS = {  # 요약 항목 → (컬럼, 파서)
    "호흡": ("resp_rate_rpm", "int"), "심박": ("heart_rate_bpm", "int"),
    "호흡 카운트": ("resp_count", "int"), "심박 카운트": ("heart_count", "int"),
    "POBC 호흡": ("pobc_resp", "int"), "POBC 심박": ("pobc_heart", "int"),
    "수면 점수": ("sleep_score", "int"), "수면 시간": ("sleep_minutes", "dur"),
    "움직임 지속 시간": ("movement_minutes", "dur"), "# 움직임": ("movement_count", "int"),
    "# 얕은 호흡": ("shallow_breath_count", "int"), "재실 시간": ("presence_minutes", "dur"),
    "공실 시간": ("absence_minutes", "dur"), "이탈 수": ("exit_count", "int"),
}
TIME_RE = re.compile(r"^(\d{4})년 (\d{1,2})월 (\d{1,2})일 (\d{1,2}):(\d{2})$")
HEADER_RE = re.compile(r"^(?P<name>.+?) \| 시설명: (?P<code>\S+) (?P<facility>.+)$")
RANGE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})\s*-\s*(\d{4}-\d{2}-\d{2})")
DUR_RE = re.compile(r"^(\d+) h (\d+) m$")
ZIP_NAME_RE = re.compile(r"#U([0-9a-fA-F]{4})")


class FormatError(Exception):
    pass


def mask_name(name):
    """가운데 글자를 O 로: 홍길동 → 홍O동, 남궁민수 → 남OO수, 김철 → 김O, 김철수B → 김O수B."""
    m = re.match(r"^(.*?)([A-Za-z0-9]*)$", name)
    base, suffix = m.group(1), m.group(2)
    if len(base) == 2:
        base = base[0] + "O"
    elif len(base) > 2:
        base = base[0] + "O" * (len(base) - 2) + base[-1]
    return base + suffix


def load_key(path):
    env = os.environ.get("BIOMETRIC_PSEUDONYM_KEY")
    if env:
        return env.encode()
    if not os.path.exists(path):
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        with open(path, "w") as f:
            f.write(secrets.token_hex(32))
        os.chmod(path, 0o600)
        print(f"가명 키를 새로 만들었습니다: {path} (잃어버리지 않게 보관하세요)", file=sys.stderr)
    with open(path) as f:
        return f.read().strip().encode()


def decode_name(name):
    """일부 zip 도구가 '#Uae40' 형태로 저장한 한글 파일명을 복원."""
    return ZIP_NAME_RE.sub(lambda m: chr(int(m.group(1), 16)), name)


def q(value):
    """SQL 문자열 리터럴."""
    if value is None:
        return "NULL"
    return "'" + str(value).replace("'", "''") + "'"


def parse_int(text):
    m = re.match(r"^\s*(-?\d+)", text)
    return int(m.group(1)) if m else None


def parse_duration(text):
    m = DUR_RE.match(text.strip())
    return int(m.group(1)) * 60 + int(m.group(2)) if m else None


def parse_file(file_name, data, key):
    text = data.decode("utf-8-sig")
    lines = text.splitlines()
    m = HEADER_RE.match(lines[0].strip())
    if not m:
        raise FormatError(f"첫 줄(이름 | 시설명) 형식 불일치: {lines[0]!r}")
    rng = RANGE_RE.search(lines[1]) if len(lines) > 1 else None

    try:
        i_sum = lines.index("=== 데이터 요약 ===")
        i_data = lines.index("=== 실시간 (5분) 데이터 ===")
    except ValueError:
        raise FormatError("'=== 데이터 요약 ===' 또는 '=== 실시간 (5분) 데이터 ===' 구역이 없음")

    raw_summary, summary = {}, {}
    for row in csv.reader(lines[i_sum + 2:i_data]):
        if len(row) < 2 or not row[0] or not row[1]:
            continue
        raw_summary[row[0]] = row[1]
        if row[0] in SUMMARY_KEYS:
            col, kind = SUMMARY_KEYS[row[0]]
            summary[col] = parse_duration(row[1]) if kind == "dur" else parse_int(row[1])

    reader = csv.reader(lines[i_data + 1:])
    header = next(reader)
    if header != EXPECTED_COLUMNS:
        raise FormatError(f"데이터 컬럼 불일치: {header}")

    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\n")
    count, first, last = 0, None, None
    for lineno, row in enumerate(reader, start=i_data + 3):
        if not row or not any(row):
            continue
        if len(row) != len(EXPECTED_COLUMNS):
            raise FormatError(f"{lineno}행: 컬럼 수 {len(row)}")
        tm = TIME_RE.match(row[0])
        if not tm:
            raise FormatError(f"{lineno}행: 시간 형식 {row[0]!r}")
        ts = datetime(*map(int, tm.groups())).strftime("%Y-%m-%d %H:%M:00+09")
        try:
            sleep = SLEEP_STATE[row[1]]
            presence = PRESENCE_STATE[row[13]]
        except KeyError as e:
            raise FormatError(f"{lineno}행: 알 수 없는 상태값 {e}")
        values = row[2:13]
        for v in values:
            if v:
                float(v)  # 숫자 검증 (실패 시 ValueError)
        # POBC 는 정수 컬럼
        values[6] = str(int(float(values[6]))) if values[6] else ""
        values[9] = str(int(float(values[9]))) if values[9] else ""
        writer.writerow([ts, sleep] + values + [presence])
        count += 1
        first = first or ts
        last = ts

    real_name = m.group("name").strip()
    masked = mask_name(real_name)
    return {
        "file_name": file_name.replace(real_name, masked),
        "sha256": hashlib.sha256(data).hexdigest(),
        "subject_name": masked,
        "source_key": hmac.new(key, f"{m.group('code')}|{real_name}".encode(), hashlib.sha256).hexdigest(),
        "source_code": m.group("code"),
        "range_start": rng.group(1) if rng else None,
        "range_end": rng.group(2) if rng else None,
        "summary": summary,
        "raw_summary": raw_summary,
        "rows_csv": out.getvalue(),
        "row_count": count,
        "first": first,
        "last": last,
    }


def iter_inputs(paths):
    for p in paths:
        if os.path.isdir(p):
            for name in sorted(os.listdir(p)):
                if name.lower().endswith(".csv"):
                    with open(os.path.join(p, name), "rb") as f:
                        yield decode_name(name), f.read()
        elif zipfile.is_zipfile(p):
            with zipfile.ZipFile(p) as zf:
                for info in zf.infolist():
                    if info.filename.lower().endswith(".csv") and not info.is_dir():
                        yield decode_name(os.path.basename(info.filename)), zf.read(info)
        else:
            with open(p, "rb") as f:
                yield decode_name(os.path.basename(p)), f.read()


def build_sql(rec):
    cols = ", ".join(DB_COLUMNS)
    upd = ", ".join(f"{c} = EXCLUDED.{c}" for c in DB_COLUMNS + ["import_id"])
    s = rec["summary"]
    sum_cols = [c for c, _ in SUMMARY_KEYS.values()]
    sum_vals = ", ".join("NULL" if s.get(c) is None else str(s[c]) for c in sum_cols)
    return f"""
BEGIN;
-- 새 시설이면 다음 알파벳(A, B, ...) 가명 부여
INSERT INTO facility (facility_code, facility_name, source_code)
    SELECT l, l || '요양원', {q(rec['source_code'])} FROM (SELECT chr(65 + count(*)::int) AS l FROM facility) x
    ON CONFLICT (source_code) DO UPDATE SET source_code = EXCLUDED.source_code
    RETURNING facility_id AS fid, facility_code AS fcode \\gset
-- 새 대상자면 가명 등록 (같은 시설에 같은 가명이 있으면 '(2)', '(3)' ...)
INSERT INTO subject (facility_id, subject_name, source_key)
    SELECT :fid, CASE WHEN n = 0 THEN {q(rec['subject_name'])} ELSE {q(rec['subject_name'])} || '(' || (n + 1) || ')' END, {q(rec['source_key'])}
    FROM (SELECT count(*) AS n FROM subject WHERE facility_id = :fid
          AND (subject_name = {q(rec['subject_name'])} OR subject_name LIKE {q(rec['subject_name'] + '(%)')})) c
    ON CONFLICT (source_key) DO UPDATE SET source_key = EXCLUDED.source_key
    RETURNING subject_id AS sid, subject_name AS sname \\gset
DELETE FROM import_file WHERE file_sha256 = {q(rec['sha256'])};
INSERT INTO import_file (subject_id, file_name, file_sha256, range_start, range_end, row_count, first_measured_at, last_measured_at)
    VALUES (:sid, {q(rec['file_name'])}, {q(rec['sha256'])}, {q(rec['range_start'])}, {q(rec['range_end'])},
            {rec['row_count']}, {q(rec['first'])}, {q(rec['last'])})
    RETURNING import_id AS iid \\gset
INSERT INTO export_summary (import_id, subject_id, as_of, {', '.join(sum_cols)}, raw)
    VALUES (:iid, :sid, {q(rec['last'])}, {sum_vals}, {q(json.dumps(rec['raw_summary'], ensure_ascii=False))}::jsonb);
CREATE TEMP TABLE stg (measured_at timestamptz, {', '.join(c + (' text' if c.endswith('state') else ' real') for c in DB_COLUMNS)}) ON COMMIT DROP;
COPY stg (measured_at, {cols}) FROM STDIN WITH (FORMAT csv);
{rec['rows_csv']}\\.
INSERT INTO vital_reading (subject_id, measured_at, {cols}, import_id)
    SELECT :sid, measured_at, sleep_state::sleep_state, sleep_depth, movement_sleep, movement_awake, movement_vacant,
           heart_rate, heart_rate_z, pobc_heart::smallint, resp_rate, resp_rate_z, pobc_resp::smallint,
           distance_m, presence_state::presence_state, :iid
    FROM stg
    ON CONFLICT (subject_id, measured_at) DO UPDATE SET {upd};
COMMIT;
\\echo 적재 완료: :fcode / :sname / {rec['row_count']}행
"""


def psql(args, sql=None, capture=False):
    cmd = [args.psql, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-At"]
    if args.dsn:
        cmd.append(args.dsn)
    return subprocess.run(cmd, input=sql, text=True, check=True,
                          stdout=subprocess.PIPE if capture else None).stdout


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("inputs", nargs="+", help="CSV 파일, CSV 디렉터리, 또는 zip")
    ap.add_argument("--dsn", default=os.environ.get("DATABASE_URL"), help="PostgreSQL 접속 문자열 (기본: $DATABASE_URL 또는 PG* 환경변수)")
    ap.add_argument("--psql", default="psql")
    ap.add_argument("--force", action="store_true", help="이미 적재한 파일도 다시 적재")
    ap.add_argument("--no-refresh", action="store_true", help="적재 후 분석용 materialized view 갱신 생략")
    ap.add_argument("--dry-run", action="store_true", help="파싱/검증만 수행")
    ap.add_argument("--key-file", default=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "pseudonym.key"),
                    help="가명 HMAC 비밀키 파일 (기본: data/pseudonym.key, $BIOMETRIC_PSEUDONYM_KEY 우선)")
    args = ap.parse_args()

    key = load_key(os.path.normpath(args.key_file))
    loaded = set()
    if not args.dry_run and not args.force:
        loaded = set(psql(args, "SELECT file_sha256 FROM import_file;", capture=True).split())

    total, skipped = 0, 0
    proc = None if args.dry_run else subprocess.Popen(
        [args.psql, "-X", "-q", "-v", "ON_ERROR_STOP=1"] + ([args.dsn] if args.dsn else []),
        stdin=subprocess.PIPE, text=True)
    try:
        records = []
        for name, data in iter_inputs(args.inputs):
            try:
                records.append(parse_file(name, data, key))
            except (FormatError, ValueError) as e:
                sys.exit(f"[오류] {name}: {e}")
        # 시설번호 순으로 적재해야 A, B, C ... 가 원본 번호 순서를 따른다
        records.sort(key=lambda r: (r["source_code"], r["file_name"]))
        for rec in records:
            name = rec["file_name"]
            if rec["sha256"] in loaded:
                skipped += 1
                print(f"건너뜀(이미 적재): {name}", file=sys.stderr)
                continue
            total += rec["row_count"]
            if proc:
                proc.stdin.write(build_sql(rec))
            else:
                print(f"검증 OK: 시설 {rec['source_code']} / {rec['subject_name']} / {rec['row_count']}행 {rec['first']} ~ {rec['last']}")
        if proc and not args.no_refresh:
            proc.stdin.write("DO $$ BEGIN PERFORM refresh_analytics(); END $$;\n\\echo 분석 뷰 갱신 완료\n")
    finally:
        if proc:
            proc.stdin.close()
            if proc.wait() != 0:
                sys.exit("[오류] psql 실행 실패 — 실패한 파일의 트랜잭션은 롤백됨")
    print(f"총 {total:,}행 처리, {skipped}개 파일 건너뜀", file=sys.stderr)


if __name__ == "__main__":
    main()
