-- =====================================================================
-- 분석용 뷰 / materialized view
--   적재 후 SELECT refresh_analytics(); 로 갱신 (load_biometrics.py 가 자동 호출)
--
-- 날짜 기준
--   * local_date : 한국시간 달력 날짜 (00:00~24:00)
--   * sleep_date : 정오~다음날 정오 기준 수면일 (전날 밤 잠 → 다음날 sleep_date 아님, 잠든 날 저녁 날짜)
-- =====================================================================

-- ---------- 1. 한글 라벨 조회 뷰 ----------
CREATE OR REPLACE VIEW v_reading_ko AS
SELECT f.facility_code                         AS 시설코드,
       f.facility_name                         AS 시설명,
       s.subject_id,
       s.subject_name                          AS 대상자,
       (r.measured_at AT TIME ZONE 'Asia/Seoul') AS 시간,
       ps.label_ko                             AS 재실상태,
       ss.label_ko                             AS 수면상태,
       r.sleep_depth                           AS 수면깊이,
       r.movement_sleep                        AS 수면중움직임,
       r.movement_awake                        AS 각성중움직임,
       r.movement_vacant                       AS 공실상태움직임,
       r.heart_rate                            AS 심박,
       r.heart_rate_z                          AS 심박z,
       r.pobc_heart                            AS pobc심박,
       r.resp_rate                             AS 호흡,
       r.resp_rate_z                           AS 호흡z,
       r.pobc_resp                             AS pobc호흡,
       r.distance_m                            AS 거리m
FROM vital_reading r
JOIN subject  s USING (subject_id)
JOIN facility f USING (facility_id)
JOIN code_label ps ON ps.code_type = 'presence_state' AND ps.code = r.presence_state::text
LEFT JOIN code_label ss ON ss.code_type = 'sleep_state' AND ss.code = r.sleep_state::text;

-- ---------- 2. 수면 에피소드 ----------
-- 수면 상태는 '취침(bedtime) → 수면 중(asleep) → 기상(wake)' 순환으로 기록된다.
-- 연속된 수면상태 구간에서 '취침'이 새로 시작될 때마다(또는 공백 뒤 첫 행) 새 에피소드로 본다.
DROP MATERIALIZED VIEW IF EXISTS mv_sleep_episode CASCADE;
CREATE MATERIALIZED VIEW mv_sleep_episode AS
WITH r AS (
    SELECT subject_id, measured_at, sleep_state, sleep_depth, movement_sleep, heart_rate, resp_rate,
           lag(sleep_state) OVER w AS prev_state,
           lag(measured_at) OVER w AS prev_at
    FROM vital_reading
    WHERE sleep_state IS NOT NULL
    WINDOW w AS (PARTITION BY subject_id ORDER BY measured_at)
), flagged AS (
    SELECT *,
           sum(CASE WHEN prev_at IS NULL
                      OR measured_at - prev_at > interval '5 minutes'
                      OR (sleep_state = 'bedtime' AND prev_state <> 'bedtime')
                    THEN 1 ELSE 0 END) OVER (PARTITION BY subject_id ORDER BY measured_at) AS episode_no
    FROM r
)
SELECT subject_id,
       episode_no::int,
       min(measured_at)                                         AS start_at,
       max(measured_at) + interval '5 minutes'                  AS end_at,
       ((min(measured_at) AT TIME ZONE 'Asia/Seoul') - interval '12 hours')::date AS sleep_date,
       count(*) * 5                                             AS in_bed_min,
       count(*) FILTER (WHERE sleep_state = 'asleep')  * 5      AS asleep_min,
       count(*) FILTER (WHERE sleep_state = 'bedtime') * 5      AS bedtime_min,
       count(*) FILTER (WHERE sleep_state = 'wake')    * 5      AS wake_min,
       min(measured_at) FILTER (WHERE sleep_state = 'asleep')   AS sleep_onset_at,
       round(avg(sleep_depth)  FILTER (WHERE sleep_state = 'asleep')::numeric, 1) AS avg_sleep_depth,
       round(sum(movement_sleep)::numeric, 2)                   AS movement_sleep_sum,
       round(avg(heart_rate)   FILTER (WHERE sleep_state = 'asleep')::numeric, 1) AS avg_hr_asleep,
       round(min(heart_rate)   FILTER (WHERE sleep_state = 'asleep')::numeric, 1) AS min_hr_asleep,
       round(avg(resp_rate)    FILTER (WHERE sleep_state = 'asleep')::numeric, 1) AS avg_rr_asleep
FROM flagged
GROUP BY subject_id, episode_no;
CREATE UNIQUE INDEX ON mv_sleep_episode (subject_id, episode_no);
CREATE INDEX ON mv_sleep_episode (subject_id, sleep_date);

-- ---------- 3. 일별 수면 요약 (정오 기준 수면일) ----------
CREATE OR REPLACE VIEW v_sleep_daily AS
SELECT subject_id,
       sleep_date,
       count(*)                                         AS episodes,
       sum(asleep_min)                                  AS asleep_min,
       sum(in_bed_min)                                  AS in_bed_min,
       round(100.0 * sum(asleep_min) / nullif(sum(in_bed_min), 0), 1) AS sleep_efficiency_pct,
       max(asleep_min)                                  AS longest_asleep_min,
       (array_agg(start_at ORDER BY asleep_min DESC))[1] AS main_start_at,
       (array_agg(end_at   ORDER BY asleep_min DESC))[1] AS main_end_at,
       round(sum(avg_sleep_depth * asleep_min) / nullif(sum(asleep_min), 0), 1) AS avg_sleep_depth,
       round(sum(avg_hr_asleep * asleep_min) FILTER (WHERE avg_hr_asleep IS NOT NULL)
             / nullif(sum(asleep_min) FILTER (WHERE avg_hr_asleep IS NOT NULL), 0), 1) AS avg_hr_asleep,
       round(sum(avg_rr_asleep * asleep_min) FILTER (WHERE avg_rr_asleep IS NOT NULL)
             / nullif(sum(asleep_min) FILTER (WHERE avg_rr_asleep IS NOT NULL), 0), 1) AS avg_rr_asleep
FROM mv_sleep_episode
GROUP BY subject_id, sleep_date;

-- ---------- 4. 일별 대상자 생체/재실 통계 (달력일 기준) ----------
DROP MATERIALIZED VIEW IF EXISTS mv_daily_subject CASCADE;
CREATE MATERIALIZED VIEW mv_daily_subject AS
WITH r AS (
    SELECT r.*,
           (measured_at AT TIME ZONE 'Asia/Seoul')::date AS local_date,
           lag(presence_state) OVER (PARTITION BY subject_id ORDER BY measured_at) AS prev_presence
    FROM vital_reading r
)
SELECT subject_id,
       local_date,
       count(*)                                                       AS slots,          -- 최대 288 (5분 × 288 = 24h)
       count(*) FILTER (WHERE presence_state = 'present')      * 5    AS present_min,
       count(*) FILTER (WHERE presence_state = 'absent')       * 5    AS absent_min,
       count(*) FILTER (WHERE presence_state IN ('disconnected', 'booting')) * 5 AS offline_min,
       count(*) FILTER (WHERE presence_state = 'absent' AND prev_presence = 'present') AS exit_count,  -- 재실→비움 전환
       count(*) FILTER (WHERE sleep_state = 'asleep')          * 5    AS asleep_min,
       count(heart_rate)                                              AS hr_samples,
       round(avg(heart_rate)::numeric, 1)                             AS hr_avg,
       round(min(heart_rate)::numeric, 1)                             AS hr_min,
       round(max(heart_rate)::numeric, 1)                             AS hr_max,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY heart_rate))::numeric, 1) AS hr_median,
       count(resp_rate)                                               AS rr_samples,
       round(avg(resp_rate)::numeric, 1)                              AS rr_avg,
       round(min(resp_rate)::numeric, 1)                              AS rr_min,
       round(max(resp_rate)::numeric, 1)                              AS rr_max,
       round((percentile_cont(0.5) WITHIN GROUP (ORDER BY resp_rate))::numeric, 1) AS rr_median,
       count(*) FILTER (WHERE abs(heart_rate_z) >= 4)                 AS hr_z_outliers,
       count(*) FILTER (WHERE abs(resp_rate_z)  >= 4)                 AS rr_z_outliers,
       round(sum(coalesce(movement_sleep, 0) + coalesce(movement_awake, 0))::numeric, 2) AS movement_sum
FROM r
GROUP BY subject_id, local_date;
CREATE UNIQUE INDEX ON mv_daily_subject (subject_id, local_date);
CREATE INDEX ON mv_daily_subject (local_date);

-- ---------- 5. 생체신호 이상치 후보 ----------
-- Z-점수는 개인 기준선 대비 편차. 전체 분포의 0.1/99.9 백분위가 대략 심박 -5.4/8.4, 호흡 -7.3/9.5
CREATE OR REPLACE VIEW v_vital_anomaly AS
SELECT r.subject_id, s.subject_name, r.measured_at,
       r.presence_state, r.sleep_state,
       r.heart_rate, r.heart_rate_z, r.resp_rate, r.resp_rate_z,
       CASE WHEN abs(r.heart_rate_z) >= 4 THEN 'heart_rate' END AS hr_flag,
       CASE WHEN abs(r.resp_rate_z)  >= 4 THEN 'resp_rate'  END AS rr_flag
FROM vital_reading r
JOIN subject s USING (subject_id)
WHERE abs(r.heart_rate_z) >= 4 OR abs(r.resp_rate_z) >= 4;

-- ---------- 6. 대상자 현황 ----------
CREATE OR REPLACE VIEW v_subject_overview AS
SELECT s.subject_id, f.facility_code, f.facility_name, s.subject_name,
       a.first_at, a.last_at, a.days, a.readings,
       round(100.0 * a.online / a.readings, 1) AS sensor_online_pct,
       round(100.0 * a.present / a.readings, 1) AS present_pct,
       a.hr_avg, a.rr_avg,
       l.presence_state AS latest_presence, l.sleep_state AS latest_sleep, l.heart_rate AS latest_hr, l.resp_rate AS latest_rr
FROM subject s
JOIN facility f USING (facility_id)
LEFT JOIN LATERAL (
    SELECT min(local_date) AS first_at, max(local_date) AS last_at, count(*) AS days,
           sum(slots) AS readings, sum(slots) - sum(offline_min) / 5 AS online, sum(present_min) / 5 AS present,
           round(sum(hr_avg * hr_samples) / nullif(sum(hr_samples), 0), 1) AS hr_avg,
           round(sum(rr_avg * rr_samples) / nullif(sum(rr_samples), 0), 1) AS rr_avg
    FROM mv_daily_subject d WHERE d.subject_id = s.subject_id
) a ON true
LEFT JOIN LATERAL (
    SELECT presence_state, sleep_state, heart_rate, resp_rate
    FROM vital_reading v WHERE v.subject_id = s.subject_id
    ORDER BY measured_at DESC LIMIT 1
) l ON true;

-- ---------- 갱신 함수 ----------
CREATE OR REPLACE FUNCTION refresh_analytics() RETURNS void LANGUAGE plpgsql AS $$
BEGIN
    REFRESH MATERIALIZED VIEW mv_sleep_episode;
    REFRESH MATERIALIZED VIEW mv_daily_subject;
    ANALYZE vital_reading;
END $$;
