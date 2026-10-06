# 생체 데이터 DB

레이더 생체센서의 **실시간(5분) 데이터 내보내기 CSV**(심박·호흡·수면·재실)를 PostgreSQL 에 적재하고 분석할 수 있도록 만든 스키마와 적재 도구입니다.

> ⚠️ 원본 CSV와 DB 덤프에는 입소자 이름과 건강정보가 들어 있습니다. `.gitignore` 로 `data/`, `*.csv`, `*.zip`, `*.dump` 를 제외했으니 저장소에 커밋하지 마세요.

## 1. 원본 데이터 분석

| 항목 | 내용 |
|---|---|
| 파일 | 36개 CSV (UTF-8 BOM), 1개 파일 = 대상자 1명 |
| 시설 | 4곳 — `02` 동탄 효벤트(5명), `04` 동탄 효드림 요양원(5명), `05` 현대 실버 요양원(2명), `06` 봄마을(미오림복지재단)(24명) |
| 기간 | 2026-04-01 ~ 2026-10-06 (대상자마다 시작일 다름) |
| 측정 행 | **1,154,919행**, 모든 행이 정확히 5분 간격(빈 구간 없음), 대상자 내 시각 중복 없음 |
| 이름 | 6명은 `나O례`처럼 `O`로 가려짐 → `subject.is_name_masked` |

파일 구조:

```
김OO | 시설명: 06 봄마을(미오림복지재단)       ← 대상자 / 시설코드 / 시설명
날짜 범위:: 2026-07-01 - 2026-10-06
=== 데이터 요약 ===                              ← 내보낸 시점 기준 최근 하루 요약 (재실+공실 ≈ 24h)
항목,값  (호흡 16 rpm, 수면 시간 6 h 31 m, 이탈 수 8 …)
=== 실시간 (5분) 데이터 ===
시간,수면 상태,수면 깊이,수면 중 움직임,각성 중 움직임,공실 상태 움직임,심박,심박 Z-점수,POBC 심박,호흡,호흡 Z-점수,POBC 호흡,거리 (m),재실 상태
2026년 7월 3일 11:35,,,,,,,,,,,,0.729,부팅중
```

값 분석 결과 (스키마/뷰 설계 근거):

| 재실 상태 | 수면 상태 | 행 수 | 채워지는 값 |
|---|---|---:|---|
| 재실 | 취침 | 42,790 | 수면깊이, 수면 중 움직임, 심박/호흡(일부), 거리 |
| 재실 | 수면 중 | 310,183 | 수면깊이(평균 56.7), 수면 중 움직임, 심박/호흡, 거리 |
| 재실 | 기상 | 40,869 | 수면깊이, 각성 중 움직임, 심박/호흡, 거리 |
| 재실 | (없음) | 531,842 | 수면깊이(≈1), 각성 중 움직임, 심박/호흡(일부), 거리 |
| 비움 | (없음/기상) | 179,355 | 공실 상태 움직임만 |
| 연결 끊김 | | 49,105 | 없음 |
| 부팅중 | | 775 | 거리, 일부 심박/호흡 |

- 수면은 **취침(정확히 5분 1칸) → 수면 중 → 기상** 순서로 반복 → 이 패턴으로 수면 에피소드를 나눔 (총 42,790개, 낮잠 포함)
- 범위: 심박 39.5~128.9 bpm, 호흡 1.2~49.2 rpm, 수면깊이 0~100, 거리 0.71~2.73 m, POBC −100~100(정수, 값이 있는 행은 0.3% 미만)
- Z-점수 0.1/99.9 백분위: 심박 −5.4/8.4, 호흡 −7.3/9.5 → 이상치 기준 `|z| ≥ 4` 사용
- POBC 의 정확한 의미는 데이터만으로는 알 수 없어 원값(정수) 그대로 저장

## 2. DB 설계

```mermaid
erDiagram
    facility ||--o{ subject : has
    subject ||--o{ vital_reading : "5분 측정"
    subject ||--o{ import_file : "내보내기 파일"
    import_file ||--|| export_summary : "데이터 요약"
    import_file ||--o{ vital_reading : "적재 출처"

    facility {
        int facility_id PK
        varchar facility_code UK
        text facility_name
    }
    subject {
        int subject_id PK
        int facility_id FK
        text subject_name
        bool is_name_masked
    }
    import_file {
        int import_id PK
        int subject_id FK
        text file_name
        char file_sha256 UK
        date range_start
        date range_end
        int row_count
    }
    export_summary {
        int import_id PK
        smallint sleep_score
        int sleep_minutes
        int presence_minutes
        int exit_count
        jsonb raw
    }
    vital_reading {
        int subject_id PK
        timestamptz measured_at PK
        presence_state presence_state
        sleep_state sleep_state
        real sleep_depth
        real heart_rate
        real heart_rate_z
        real resp_rate
        real resp_rate_z
        real distance_m
    }
```

| 테이블 | 설명 |
|---|---|
| `facility` | 시설 (코드 `06`, 이름 분리) |
| `subject` | 대상자. `(facility_id, subject_name)` 유니크 |
| `vital_reading` | **핵심 시계열**. PK `(subject_id, measured_at)` → 대상자별 기간 조회가 인덱스 범위 스캔. `measured_at` B-tree 인덱스로 전체 기간 조회 |
| `import_file` | 적재 이력. SHA-256 으로 같은 파일 중복 적재 방지 |
| `export_summary` | 파일 상단 '데이터 요약' (시간은 분 단위로 변환, 원본은 `raw` jsonb 보존) |
| `code_label` | enum 코드 → 한글 라벨 |

원본 컬럼 매핑 (`vital_reading`):

| 원본 | 컬럼 | 타입 |
|---|---|---|
| 시간 | `measured_at` | timestamptz (KST로 해석) |
| 재실 상태 | `presence_state` | enum: `present` 재실 / `absent` 비움 / `disconnected` 연결 끊김 / `booting` 부팅중 |
| 수면 상태 | `sleep_state` | enum: `bedtime` 취침 / `asleep` 수면 중 / `wake` 기상 / NULL |
| 수면 깊이 | `sleep_depth` | real (0~100) |
| 수면 중 / 각성 중 / 공실 상태 움직임 | `movement_sleep` / `movement_awake` / `movement_vacant` | real |
| 심박, 심박 Z-점수, POBC 심박 | `heart_rate`, `heart_rate_z`, `pobc_heart` | real, real, smallint |
| 호흡, 호흡 Z-점수, POBC 호흡 | `resp_rate`, `resp_rate_z`, `pobc_resp` | real, real, smallint |
| 거리 (m) | `distance_m` | real |

분석 뷰 (`db/02_analytics.sql`):

| 이름 | 종류 | 내용 |
|---|---|---|
| `v_reading_ko` | view | 한글 컬럼명·라벨·한국시간으로 본 5분 데이터 |
| `mv_sleep_episode` | materialized | 수면 에피소드별 시작/종료, 수면·침상 시간, 잠들기까지 시간, 평균 수면깊이, 수면 중 심박/호흡 |
| `v_sleep_daily` | view | 정오~정오 기준 수면일별 총 수면, 수면 효율, 가장 긴 수면, 수면 중 심박/호흡 |
| `mv_daily_subject` | materialized | 달력일별 재실/비움/오프라인 시간, 이탈 횟수, 심박·호흡 평균/최소/최대/중앙값, Z 이상치 수 |
| `v_vital_anomaly` | view | `|z| ≥ 4` 인 측정 |
| `v_subject_overview` | view | 대상자별 기간, 센서 가동률, 재실률, 평균 심박/호흡, 최근 상태 |

materialized view 는 `SELECT refresh_analytics();` 로 갱신하며 적재 스크립트가 자동 호출합니다.

## 3. 사용법

### DB 띄우기

```bash
docker compose up -d          # PostgreSQL 16 + 스키마/뷰 자동 생성
export DATABASE_URL=postgresql://biometric:biometric@localhost:5432/biometric
```

기존 PostgreSQL 을 쓸 경우:

```bash
psql "$DATABASE_URL" -f db/01_schema.sql -f db/02_analytics.sql
```

### 데이터 적재

Python 3.9+ 와 `psql` 만 있으면 됩니다 (추가 패키지 없음). zip, 디렉터리, CSV 파일 모두 받습니다.

```bash
python3 etl/load_biometrics.py --dry-run data/biometrics.zip   # 형식 검증만
python3 etl/load_biometrics.py data/biometrics.zip             # 적재 (115만 행 약 30초)
```

- 이미 적재한 파일은 건너뜁니다 (`--force` 로 재적재).
- 다음 달 새로 내보낸 파일처럼 기간이 겹쳐도 `(subject_id, measured_at)` 기준으로 최신 값으로 갱신되므로 그대로 넣으면 됩니다.
- 파일 형식(컬럼, 시간 형식, 상태값)이 다르면 적재 전에 오류로 멈춥니다.

### 덤프로 바로 복원

적재가 끝난 DB 덤프(`data/biometric.dump`, 약 23MB)가 있으면:

```bash
createdb biometric && pg_restore -d biometric --no-owner data/biometric.dump
```

### 활용 예시

`db/queries/examples.sql` 참고 — 대상자 현황, 수면 추이, 개인 기준선 대비 이상 탐지, 야간 이탈, 일주기 패턴, 데이터 품질 점검, 시간 단위 다운샘플링.

```sql
SELECT subject_name, sleep_date, asleep_min/60.0 AS 수면시간, sleep_efficiency_pct, avg_hr_asleep
FROM v_sleep_daily JOIN subject USING (subject_id)
WHERE sleep_date >= current_date - 7
ORDER BY 1, 2;
```
