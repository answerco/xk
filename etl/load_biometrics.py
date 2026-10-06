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
"""
import argparse
import csv
import hashlib
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


def parse_file(file_name, data):
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

    return {
        "file_name": file_name,
        "sha256": hashlib.sha256(data).hexdigest(),
        "subject_name": m.group("name").strip(),
        "facility_code": m.group("code"),
        "facility_name": m.group("facility").strip(),
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
INSERT INTO facility (facility_code, facility_name) VALUES ({q(rec['facility_code'])}, {q(rec['facility_name'])})
    ON CONFLICT (facility_code) DO UPDATE SET facility_name = EXCLUDED.facility_name
    RETURNING facility_id AS fid \\gset
INSERT INTO subject (facility_id, subject_name) VALUES (:fid, {q(rec['subject_name'])})
    ON CONFLICT (facility_id, subject_name) DO UPDATE SET subject_name = EXCLUDED.subject_name
    RETURNING subject_id AS sid \\gset
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
\\echo 적재 완료: {rec['facility_code']} / {rec['subject_name'].replace(chr(10), ' ')} / {rec['row_count']}행
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
    args = ap.parse_args()

    loaded = set()
    if not args.dry_run and not args.force:
        loaded = set(psql(args, "SELECT file_sha256 FROM import_file;", capture=True).split())

    total, skipped = 0, 0
    proc = None if args.dry_run else subprocess.Popen(
        [args.psql, "-X", "-q", "-v", "ON_ERROR_STOP=1"] + ([args.dsn] if args.dsn else []),
        stdin=subprocess.PIPE, text=True)
    try:
        for name, data in iter_inputs(args.inputs):
            try:
                rec = parse_file(name, data)
            except (FormatError, ValueError) as e:
                sys.exit(f"[오류] {name}: {e}")
            if rec["sha256"] in loaded:
                skipped += 1
                print(f"건너뜀(이미 적재): {name}", file=sys.stderr)
                continue
            total += rec["row_count"]
            if proc:
                proc.stdin.write(build_sql(rec))
            else:
                print(f"검증 OK: {rec['facility_code']} / {rec['subject_name']} / {rec['row_count']}행 {rec['first']} ~ {rec['last']}")
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
