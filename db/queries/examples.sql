-- 활용 예시 쿼리 모음

-- 1) 대상자 현황 (센서 가동률, 평균 심박/호흡, 최근 상태)
SELECT facility_code, subject_name, first_at, last_at, days, sensor_online_pct, present_pct,
       hr_avg, rr_avg, latest_presence, latest_sleep
FROM v_subject_overview ORDER BY facility_code, subject_name;

-- 2) 특정 대상자의 하루 5분 데이터 (한글 컬럼, 가명으로 조회)
SELECT 시간, 재실상태, 수면상태, 수면깊이, 심박, 호흡
FROM v_reading_ko
WHERE 대상자 = '박O진' AND 시간 >= '2026-09-10 20:00' AND 시간 < '2026-09-11 08:00'
ORDER BY 시간;

-- 3) 최근 14일 수면 추이 (정오 기준 수면일)
SELECT s.subject_name, d.sleep_date, d.asleep_min / 60.0 AS asleep_h, d.episodes,
       d.sleep_efficiency_pct, d.avg_hr_asleep, d.avg_rr_asleep
FROM v_sleep_daily d JOIN subject s USING (subject_id)
WHERE d.sleep_date >= current_date - 14
ORDER BY s.subject_name, d.sleep_date;

-- 4) 개인 기준선(최근 30일 평균) 대비 오늘 심박/호흡이 크게 벗어난 대상자
WITH base AS (
    SELECT subject_id, avg(hr_avg) AS hr_base, stddev(hr_avg) AS hr_sd,
           avg(rr_avg) AS rr_base, stddev(rr_avg) AS rr_sd
    FROM mv_daily_subject
    WHERE local_date BETWEEN current_date - 31 AND current_date - 1 AND slots = 288
    GROUP BY subject_id
)
SELECT s.subject_name, d.local_date, d.hr_avg, round(b.hr_base::numeric, 1) AS hr_base,
       d.rr_avg, round(b.rr_base::numeric, 1) AS rr_base
FROM mv_daily_subject d JOIN base b USING (subject_id) JOIN subject s USING (subject_id)
WHERE d.local_date = current_date
  AND (abs(d.hr_avg - b.hr_base) > 2 * b.hr_sd OR abs(d.rr_avg - b.rr_base) > 2 * b.rr_sd);

-- 5) 야간(22~06시) 이탈(재실→비움) 횟수 — 낙상/배회 위험 모니터링
SELECT s.subject_name, (r.measured_at AT TIME ZONE 'Asia/Seoul')::date AS local_date, count(*) AS night_exits
FROM (
    SELECT subject_id, measured_at, presence_state,
           lag(presence_state) OVER (PARTITION BY subject_id ORDER BY measured_at) AS prev
    FROM vital_reading
    WHERE measured_at >= now() - interval '30 days'
) r JOIN subject s USING (subject_id)
WHERE r.presence_state = 'absent' AND r.prev = 'present'
  AND extract(hour FROM r.measured_at AT TIME ZONE 'Asia/Seoul') NOT BETWEEN 6 AND 21
GROUP BY 1, 2 ORDER BY 3 DESC;

-- 6) 시간대별 평균 심박 패턴 (일주기 리듬)
SELECT extract(hour FROM measured_at AT TIME ZONE 'Asia/Seoul') AS hour,
       round(avg(heart_rate)::numeric, 1) AS hr, round(avg(resp_rate)::numeric, 1) AS rr
FROM vital_reading WHERE subject_id = 1 AND heart_rate IS NOT NULL
GROUP BY 1 ORDER BY 1;

-- 7) 센서 연결 끊김이 잦은 날 (데이터 품질 점검)
SELECT s.subject_name, d.local_date, d.offline_min
FROM mv_daily_subject d JOIN subject s USING (subject_id)
WHERE d.offline_min >= 60 ORDER BY d.offline_min DESC LIMIT 50;

-- 8) 시간 단위 다운샘플링 (차트/ML 피처용)
SELECT subject_id, date_trunc('hour', measured_at) AS hour,
       avg(heart_rate) AS hr, avg(resp_rate) AS rr, avg(sleep_depth) AS depth,
       count(*) FILTER (WHERE sleep_state = 'asleep') * 5 AS asleep_min
FROM vital_reading
WHERE measured_at >= '2026-09-01' AND measured_at < '2026-10-01'
GROUP BY 1, 2 ORDER BY 1, 2;
