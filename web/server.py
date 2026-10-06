#!/usr/bin/env python3
"""생체 데이터 뷰어 웹 서버.

    pip install -r requirements.txt
    export DATABASE_URL=postgresql://biometric:biometric@localhost:5432/biometric
    python3 web/server.py            # http://127.0.0.1:8000

- DB 에는 읽기 전용 트랜잭션으로만 접속한다.
- 기본은 127.0.0.1 에만 열린다. 다른 PC 에서 보려면 --host 0.0.0.0 과 함께
  VIEWER_USER / VIEWER_PASSWORD 환경변수로 Basic 인증을 켤 것 (개인 건강정보).
"""
import argparse
import base64
import csv
import hmac
import io
import json
import mimetypes
import os
import re
import sys
from datetime import date, datetime, timedelta
from decimal import Decimal
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import psycopg
from psycopg.rows import dict_row

STATIC_DIR = Path(__file__).resolve().parent / "static"
DSN = os.environ.get("DATABASE_URL", "")
AUTH = None  # (user, password)


def db():
    return psycopg.connect(
        DSN, autocommit=True, row_factory=dict_row,
        options="-c default_transaction_read_only=on -c timezone=Asia/Seoul -c statement_timeout=30000",
    )


def query(sql, params=None):
    with db() as conn:
        return conn.execute(sql, params or {}).fetchall()


def to_json(obj):
    def default(o):
        if isinstance(o, Decimal):
            return float(o)
        if isinstance(o, (date, datetime)):
            return o.isoformat()
        raise TypeError(type(o))
    return json.dumps(obj, default=default, ensure_ascii=False).encode()


def parse_date(text):
    try:
        return date.fromisoformat(text)
    except (TypeError, ValueError):
        raise ApiError(HTTPStatus.BAD_REQUEST, "date 는 YYYY-MM-DD 형식이어야 합니다")


class ApiError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


# ---------------------------------------------------------------- API ----

def api_meta(_q):
    row = query("""
        SELECT (SELECT sum(slots) FROM mv_daily_subject)        AS readings,
               (SELECT count(*) FROM subject)                    AS subjects,
               (SELECT min(local_date) FROM mv_daily_subject)    AS first_date,
               (SELECT max(local_date) FROM mv_daily_subject)    AS last_date,
               (SELECT max(imported_at) FROM import_file)        AS last_import
    """)[0]
    row["facilities"] = query("""
        SELECT f.facility_id, f.facility_code, f.facility_name, count(s.subject_id) AS subjects
        FROM facility f LEFT JOIN subject s USING (facility_id)
        GROUP BY f.facility_id ORDER BY f.facility_code
    """)
    return row


SUBJECT_SQL = """
    WITH last AS (SELECT max(local_date) AS d FROM mv_daily_subject)
    SELECT o.subject_id, o.facility_code, o.facility_name, o.subject_name, o.is_name_masked,
           o.first_at, o.last_at, o.days, o.readings, o.sensor_online_pct, o.present_pct,
           o.hr_avg, o.rr_avg, o.latest_presence, o.latest_sleep, o.latest_hr, o.latest_rr,
           lm.latest_at,
           w.sleep_avg_min_7d, w.hr_avg_7d, w.rr_avg_7d, w.present_pct_7d, w.exits_7d, w.anomalies_7d,
           sp.sleep_14d
    FROM v_subject_overview o
    CROSS JOIN last
    LEFT JOIN LATERAL (
        SELECT to_char(max(measured_at), 'YYYY-MM-DD"T"HH24:MI') AS latest_at
        FROM vital_reading v WHERE v.subject_id = o.subject_id
    ) lm ON true
    LEFT JOIN LATERAL (
        SELECT round(sum(hr_avg * hr_samples) / nullif(sum(hr_samples), 0), 1) AS hr_avg_7d,
               round(sum(rr_avg * rr_samples) / nullif(sum(rr_samples), 0), 1) AS rr_avg_7d,
               round(100.0 * sum(present_min) / nullif(sum(slots) * 5, 0), 1)  AS present_pct_7d,
               sum(exit_count)                                                  AS exits_7d,
               sum(hr_z_outliers + rr_z_outliers)                               AS anomalies_7d,
               (SELECT round(avg(asleep_min)) FROM v_sleep_daily s
                 WHERE s.subject_id = o.subject_id AND s.sleep_date > last.d - 8 AND s.sleep_date < last.d) AS sleep_avg_min_7d
        FROM mv_daily_subject d
        WHERE d.subject_id = o.subject_id AND d.local_date > last.d - 7
    ) w ON true
    LEFT JOIN LATERAL (
        SELECT array_agg(s.asleep_min ORDER BY g.d) AS sleep_14d
        FROM generate_series(last.d - 14, last.d - 1, interval '1 day') g(d)
        LEFT JOIN v_sleep_daily s ON s.subject_id = o.subject_id AND s.sleep_date = g.d::date
    ) sp ON true
"""


def api_subjects(_q):
    return query(SUBJECT_SQL + " ORDER BY o.facility_code, o.subject_name")


def api_subject(_q, sid):
    rows = query(SUBJECT_SQL + " WHERE o.subject_id = %(sid)s", {"sid": sid})
    if not rows:
        raise ApiError(HTTPStatus.NOT_FOUND, "대상자를 찾을 수 없습니다")
    return rows[0]


def api_daily(_q, sid):
    return query("""
        SELECT d.local_date AS date, d.slots, d.present_min, d.absent_min, d.offline_min, d.exit_count,
               d.asleep_min AS asleep_min_calendar,
               d.hr_avg, d.hr_min, d.hr_max, d.rr_avg, d.rr_min, d.rr_max,
               d.hr_z_outliers + d.rr_z_outliers AS anomalies,
               s.asleep_min, s.in_bed_min, s.episodes, s.sleep_efficiency_pct, s.longest_asleep_min,
               s.avg_sleep_depth, s.avg_hr_asleep, s.avg_rr_asleep
        FROM mv_daily_subject d
        LEFT JOIN v_sleep_daily s ON s.subject_id = d.subject_id AND s.sleep_date = d.local_date
        WHERE d.subject_id = %(sid)s
        ORDER BY d.local_date
    """, {"sid": sid})


def day_window(q):
    d = parse_date((q.get("date") or [None])[0])
    night = (q.get("window") or ["day"])[0] == "night"
    start = datetime(d.year, d.month, d.day, 12 if night else 0)
    return start, start + timedelta(days=1), night


READING_SQL = """
    SELECT to_char(measured_at, 'YYYY-MM-DD"T"HH24:MI') AS t,
           presence_state AS presence, sleep_state AS sleep, sleep_depth AS depth,
           heart_rate AS hr, heart_rate_z AS hr_z, pobc_heart, resp_rate AS rr, resp_rate_z AS rr_z, pobc_resp,
           movement_sleep AS mv_sleep, movement_awake AS mv_awake, movement_vacant AS mv_vacant, distance_m AS dist
    FROM vital_reading
    WHERE subject_id = %(sid)s AND measured_at >= %(start)s AND measured_at < %(end)s
    ORDER BY measured_at
"""


def api_day(q, sid):
    start, end, night = day_window(q)
    p = {"sid": sid, "start": start, "end": end}
    return {
        "start": start.strftime("%Y-%m-%dT%H:%M"),
        "end": end.strftime("%Y-%m-%dT%H:%M"),
        "window": "night" if night else "day",
        "readings": query(READING_SQL, p),
        "episodes": query("""
            SELECT episode_no, to_char(start_at, 'YYYY-MM-DD"T"HH24:MI') AS start_at,
                   to_char(end_at, 'YYYY-MM-DD"T"HH24:MI') AS end_at,
                   to_char(sleep_onset_at, 'YYYY-MM-DD"T"HH24:MI') AS onset_at,
                   in_bed_min, asleep_min, avg_sleep_depth, avg_hr_asleep, min_hr_asleep, avg_rr_asleep
            FROM mv_sleep_episode
            WHERE subject_id = %(sid)s AND start_at < %(end)s AND end_at > %(start)s
            ORDER BY start_at
        """, p),
    }


CSV_HEADER = ["시간", "재실 상태", "수면 상태", "수면 깊이", "심박", "심박 Z-점수", "POBC 심박",
              "호흡", "호흡 Z-점수", "POBC 호흡", "수면 중 움직임", "각성 중 움직임", "공실 상태 움직임", "거리 (m)"]
LABEL = {"present": "재실", "absent": "비움", "disconnected": "연결 끊김", "booting": "부팅중",
         "bedtime": "취침", "asleep": "수면 중", "wake": "기상", None: ""}


def csv_day(q, sid):
    start, end, _ = day_window(q)
    rows = query(READING_SQL, {"sid": sid, "start": start, "end": end})
    buf = io.StringIO()
    buf.write("﻿")  # Excel 한글
    w = csv.writer(buf)
    w.writerow(CSV_HEADER)
    for r in rows:
        w.writerow([r["t"].replace("T", " "), LABEL[r["presence"]], LABEL[r["sleep"]], r["depth"], r["hr"], r["hr_z"],
                    r["pobc_heart"], r["rr"], r["rr_z"], r["pobc_resp"], r["mv_sleep"], r["mv_awake"],
                    r["mv_vacant"], r["dist"]])
    name = query("SELECT subject_name FROM subject WHERE subject_id = %(sid)s", {"sid": sid})
    filename = f"{name[0]['subject_name'] if name else sid}_{start:%Y%m%d}.csv"
    return buf.getvalue().encode("utf-8"), filename


def api_anomalies(q, sid):
    limit = min(int((q.get("limit") or ["300"])[0]), 2000)
    return query("""
        SELECT to_char(measured_at, 'YYYY-MM-DD"T"HH24:MI') AS t, presence_state AS presence, sleep_state AS sleep,
               heart_rate AS hr, heart_rate_z AS hr_z, resp_rate AS rr, resp_rate_z AS rr_z,
               hr_flag IS NOT NULL AS hr_flag, rr_flag IS NOT NULL AS rr_flag
        FROM v_vital_anomaly WHERE subject_id = %(sid)s
        ORDER BY measured_at DESC LIMIT %(limit)s
    """, {"sid": sid, "limit": limit})


ROUTES = [
    (re.compile(r"^/api/meta$"), api_meta),
    (re.compile(r"^/api/subjects$"), api_subjects),
    (re.compile(r"^/api/subjects/(\d+)$"), api_subject),
    (re.compile(r"^/api/subjects/(\d+)/daily$"), api_daily),
    (re.compile(r"^/api/subjects/(\d+)/day$"), api_day),
    (re.compile(r"^/api/subjects/(\d+)/anomalies$"), api_anomalies),
]


# ------------------------------------------------------------- server ----

class Handler(BaseHTTPRequestHandler):
    server_version = "BiometricViewer/1.0"

    def log_message(self, fmt, *args):
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    def authorized(self):
        if not AUTH:
            return True
        header = self.headers.get("Authorization", "")
        if header.startswith("Basic "):
            try:
                user, _, pw = base64.b64decode(header[6:]).decode().partition(":")
            except Exception:
                return False
            return hmac.compare_digest(user, AUTH[0]) and hmac.compare_digest(pw, AUTH[1])
        return False

    def send(self, status, body, content_type, extra=None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not self.authorized():
            self.send(HTTPStatus.UNAUTHORIZED, b"auth required", "text/plain",
                      {"WWW-Authenticate": 'Basic realm="biometric", charset="UTF-8"'})
            return
        url = urlparse(self.path)
        q = parse_qs(url.query)
        try:
            m = re.match(r"^/api/subjects/(\d+)/day\.csv$", url.path)
            if m:
                body, filename = csv_day(q, int(m.group(1)))
                from urllib.parse import quote
                self.send(HTTPStatus.OK, body, "text/csv; charset=utf-8",
                          {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(filename)}"})
                return
            for pattern, fn in ROUTES:
                m = pattern.match(url.path)
                if m:
                    data = fn(q, *map(int, m.groups()))
                    self.send(HTTPStatus.OK, to_json(data), "application/json; charset=utf-8")
                    return
            if url.path.startswith("/api/"):
                raise ApiError(HTTPStatus.NOT_FOUND, "없는 API 입니다")
            self.serve_static(url.path)
        except ApiError as e:
            self.send(e.status, to_json({"error": str(e)}), "application/json; charset=utf-8")
        except psycopg.Error as e:
            self.log_message("DB error: %s", e)
            self.send(HTTPStatus.SERVICE_UNAVAILABLE, to_json({"error": "DB 조회 실패: " + str(e).splitlines()[0]}),
                      "application/json; charset=utf-8")

    def serve_static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (STATIC_DIR / rel).resolve()
        if STATIC_DIR not in target.parents or not target.is_file():
            target = STATIC_DIR / "index.html"
        ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        self.send(HTTPStatus.OK, target.read_bytes(), ctype)


def main():
    global DSN, AUTH
    ap = argparse.ArgumentParser(description="생체 데이터 뷰어")
    ap.add_argument("--host", default=os.environ.get("VIEWER_HOST", "127.0.0.1"))
    ap.add_argument("--port", type=int, default=int(os.environ.get("VIEWER_PORT", "8000")))
    ap.add_argument("--dsn", default=DSN, help="PostgreSQL 접속 문자열 (기본: $DATABASE_URL)")
    args = ap.parse_args()
    DSN = args.dsn
    if os.environ.get("VIEWER_PASSWORD"):
        AUTH = (os.environ.get("VIEWER_USER", "admin"), os.environ["VIEWER_PASSWORD"])
    elif args.host not in ("127.0.0.1", "localhost", "::1"):
        print("경고: 외부에 공개하면서 인증이 꺼져 있습니다. VIEWER_PASSWORD 를 설정하세요.", file=sys.stderr)
    with db() as conn:
        conn.execute("SELECT 1 FROM vital_reading LIMIT 1")
    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"생체 데이터 뷰어: http://{args.host}:{args.port}", file=sys.stderr)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
