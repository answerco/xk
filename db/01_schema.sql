-- =====================================================================
-- 생체 데이터(레이더 센서 기반 5분 실시간 데이터) 저장 스키마
-- Target: PostgreSQL 14+
--
--   facility ─┬─< subject ─┬─< vital_reading      (5분 단위 시계열, 핵심 팩트 테이블)
--             │            ├─< import_file ──1:1── export_summary (내보내기 파일의 '데이터 요약' 블록)
--             │            │        └─< vital_reading.import_id (어느 파일에서 적재됐는지 추적)
--
-- 모든 시각은 timestamptz 로 저장하며 원본(한국시간, KST)을 Asia/Seoul 로 해석한다.
-- =====================================================================

-- ---------- 코드 타입 ----------
DO $$ BEGIN
    -- 원본 '수면 상태' : 취침 / 수면 중 / 기상 / (빈값 = 수면 판정 구간 아님)
    CREATE TYPE sleep_state AS ENUM ('bedtime', 'asleep', 'wake');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    -- 원본 '재실 상태' : 재실 / 비움 / 연결 끊김 / 부팅중
    CREATE TYPE presence_state AS ENUM ('present', 'absent', 'disconnected', 'booting');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 코드 → 한글 라벨 (화면/리포트용)
CREATE TABLE IF NOT EXISTS code_label (
    code_type  text NOT NULL,
    code       text NOT NULL,
    label_ko   text NOT NULL,
    PRIMARY KEY (code_type, code)
);
INSERT INTO code_label (code_type, code, label_ko) VALUES
    ('sleep_state',    'bedtime',      '취침'),
    ('sleep_state',    'asleep',       '수면 중'),
    ('sleep_state',    'wake',         '기상'),
    ('presence_state', 'present',      '재실'),
    ('presence_state', 'absent',       '비움'),
    ('presence_state', 'disconnected', '연결 끊김'),
    ('presence_state', 'booting',      '부팅중')
ON CONFLICT DO NOTHING;

-- ---------- 마스터 ----------
CREATE TABLE IF NOT EXISTS facility (
    facility_id    serial PRIMARY KEY,
    facility_code  varchar(10) NOT NULL UNIQUE,   -- 가명 코드: 'A', 'B', ... (원본 시설코드 순서대로 부여)
    facility_name  text        NOT NULL,          -- 가명: 'A요양원'
    source_code    varchar(10) NOT NULL UNIQUE,   -- 내보내기 파일의 시설 번호 (예: '06'). 실제 시설명은 저장하지 않음
    created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS subject (                -- 대상자(입소자) = 센서 1대
    subject_id     serial PRIMARY KEY,
    facility_id    int  NOT NULL REFERENCES facility,
    subject_name   text NOT NULL,                   -- 가명: 가운데 글자를 O 로 (홍길동 → 홍O동). 겹치면 '김O순(2)'
    source_key     char(64) NOT NULL UNIQUE,        -- HMAC-SHA256(비밀키, 시설번호|실명): 재적재 시 같은 사람 식별용. 키 없이는 실명 역추적 불가
    note           text,
    created_at     timestamptz NOT NULL DEFAULT now(),
    UNIQUE (facility_id, subject_name)
);

-- ---------- 적재 이력 ----------
CREATE TABLE IF NOT EXISTS import_file (
    import_id         serial PRIMARY KEY,
    subject_id        int  NOT NULL REFERENCES subject,
    file_name         text NOT NULL,                -- 파일명 속 실명은 가명으로 치환해 저장
    file_sha256       char(64) NOT NULL UNIQUE,     -- 같은 파일 중복 적재 방지
    range_start       date,                          -- 파일 헤더 '날짜 범위'
    range_end         date,
    row_count         int,
    first_measured_at timestamptz,
    last_measured_at  timestamptz,
    imported_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS import_file_subject_idx ON import_file (subject_id);

-- 내보내기 파일 상단 '데이터 요약' 블록 (내보낸 시점 기준 최근 1일 요약으로 보임)
CREATE TABLE IF NOT EXISTS export_summary (
    import_id             int PRIMARY KEY REFERENCES import_file ON DELETE CASCADE,
    subject_id            int NOT NULL REFERENCES subject,
    as_of                 timestamptz,   -- 파일의 마지막 측정 시각
    resp_rate_rpm         smallint,      -- 호흡 (rpm)
    heart_rate_bpm        smallint,      -- 심박 (bpm)
    resp_count            int,           -- 호흡 카운트
    heart_count           int,           -- 심박 카운트
    pobc_resp             smallint,      -- POBC 호흡
    pobc_heart            smallint,      -- POBC 심박
    sleep_score           smallint,      -- 수면 점수
    sleep_minutes         int,           -- 수면 시간
    movement_minutes      int,           -- 움직임 지속 시간
    movement_count        int,           -- # 움직임
    shallow_breath_count  int,           -- # 얕은 호흡
    presence_minutes      int,           -- 재실 시간
    absence_minutes       int,           -- 공실 시간
    exit_count            int,           -- 이탈 수
    raw                   jsonb NOT NULL -- 원본 key/value 전체 보존
);

-- ---------- 5분 시계열 (핵심) ----------
CREATE TABLE IF NOT EXISTS vital_reading (
    subject_id        int            NOT NULL REFERENCES subject,
    measured_at       timestamptz    NOT NULL,      -- 시간 (5분 버킷 시작)
    presence_state    presence_state NOT NULL,      -- 재실 상태
    sleep_state       sleep_state,                  -- 수면 상태
    sleep_depth       real CHECK (sleep_depth BETWEEN 0 AND 100),  -- 수면 깊이
    movement_sleep    real,                         -- 수면 중 움직임
    movement_awake    real,                         -- 각성 중 움직임
    movement_vacant   real,                         -- 공실 상태 움직임
    heart_rate        real,                         -- 심박 (bpm)
    heart_rate_z      real,                         -- 심박 Z-점수 (개인 기준선 대비 편차)
    pobc_heart        smallint CHECK (pobc_heart BETWEEN -100 AND 100),  -- POBC 심박
    resp_rate         real,                         -- 호흡 (rpm)
    resp_rate_z       real,                         -- 호흡 Z-점수
    pobc_resp         smallint CHECK (pobc_resp BETWEEN -100 AND 100),   -- POBC 호흡
    distance_m        real CHECK (distance_m >= 0), -- 거리 (m), 센서-대상자
    import_id         int REFERENCES import_file ON DELETE SET NULL,
    PRIMARY KEY (subject_id, measured_at)           -- 대상자별 기간 조회에 최적
);
-- 전체 대상자 대상 기간 조회용 (적재가 대상자 단위라 물리적 시간순이 아니므로 BRIN 대신 B-tree)
CREATE INDEX IF NOT EXISTS vital_reading_measured_idx ON vital_reading (measured_at);

COMMENT ON TABLE vital_reading IS '레이더 생체센서 5분 단위 측정값. PK(subject_id, measured_at), 재적재 시 최신 파일 값으로 갱신';
