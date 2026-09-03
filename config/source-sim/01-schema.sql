-- Synthetic stand-in for a PSU source warehouse.
--
-- Every row in this database is generated, not extracted: no real person,
-- employee, student, salary, or grade appears anywhere in it. It exists so
-- the metadata-driven ingestion work can be built and tested against a
-- source that has the same *shape* as a real warehouse -- including columns
-- that must never be ingested -- without any real system being involved.
--
-- The shape being mirrored is a source that carries its own column-level
-- classification registry (meta.db_table / meta.db_column). The pipeline
-- reads that registry to decide which columns it may select, so the registry
-- here has to be realistic even though the data does not.

CREATE SCHEMA meta;
CREATE SCHEMA hr;
CREATE SCHEMA academic;

COMMENT ON SCHEMA meta IS 'Source-owned classification registry that drives ingestion column selection';
COMMENT ON SCHEMA hr IS 'Synthetic HR-shaped tables';
COMMENT ON SCHEMA academic IS 'Synthetic academic-shaped tables';

-- ---------------------------------------------------------------------------
-- Classification registry
-- ---------------------------------------------------------------------------

CREATE TABLE meta.db_table (
  table_id      integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schema_name   text    NOT NULL,
  table_name    text    NOT NULL,
  description   text,
  -- A table the source has withdrawn from ingestion. The pipeline must skip
  -- it even though the table itself still exists and is readable.
  is_active     boolean NOT NULL DEFAULT true,
  UNIQUE (schema_name, table_name)
);

CREATE TABLE meta.db_column (
  column_id       integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  schema_name     text    NOT NULL,
  table_name      text    NOT NULL,
  column_name     text    NOT NULL,
  data_type       text    NOT NULL,
  -- 'public'    -- reference/lookup content, safe to ingest
  -- 'internal'  -- operational, not personal
  -- 'sensitive' -- personal data under the PDPA; must never be selected
  classification  text    NOT NULL,
  -- Mirrors the numeric level a real registry usually carries alongside the
  -- label. Anything above 0 is treated as not-safe by the pipeline, so a new
  -- label nobody has taught the pipeline about still fails closed.
  secret_level    integer NOT NULL DEFAULT 0,
  UNIQUE (schema_name, table_name, column_name),
  CONSTRAINT db_column_classification_known
    CHECK (classification IN ('public', 'internal', 'sensitive'))
);

-- ---------------------------------------------------------------------------
-- Lookup tables: no personal data at all
-- ---------------------------------------------------------------------------

CREATE TABLE hr.department (
  department_id   integer PRIMARY KEY,
  department_code text    NOT NULL,
  department_name text    NOT NULL,
  org_unit        text    NOT NULL,
  is_active       boolean NOT NULL DEFAULT true
);

CREATE TABLE hr.position (
  position_id   integer PRIMARY KEY,
  position_code text    NOT NULL,
  position_name text    NOT NULL,
  position_band integer NOT NULL
);

CREATE TABLE academic.course (
  course_id     integer PRIMARY KEY,
  course_code   text    NOT NULL,
  course_name   text    NOT NULL,
  credits       integer NOT NULL,
  department_id integer NOT NULL REFERENCES hr.department (department_id)
);

-- ---------------------------------------------------------------------------
-- Person-level tables: a mix of safe and sensitive columns
-- ---------------------------------------------------------------------------

CREATE TABLE hr.employee (
  employee_id     integer PRIMARY KEY,
  department_id   integer NOT NULL REFERENCES hr.department (department_id),
  position_id     integer NOT NULL REFERENCES hr.position (position_id),
  employment_type text    NOT NULL,
  start_date      date    NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  citizen_id      text    NOT NULL,
  full_name_thai  text    NOT NULL,
  full_name_eng   text    NOT NULL,
  birth_date      date    NOT NULL,
  phone           text    NOT NULL,
  email           text    NOT NULL,
  home_address    text    NOT NULL,
  monthly_salary  numeric(12, 2) NOT NULL,
  updated_at      timestamp NOT NULL DEFAULT now()
);

CREATE TABLE academic.student (
  student_id      integer PRIMARY KEY,
  department_id   integer NOT NULL REFERENCES hr.department (department_id),
  admit_year      integer NOT NULL,
  study_status    text    NOT NULL,
  citizen_id      text    NOT NULL,
  full_name_thai  text    NOT NULL,
  birth_date      date    NOT NULL,
  phone           text    NOT NULL,
  email           text    NOT NULL,
  updated_at      timestamp NOT NULL DEFAULT now()
);

CREATE TABLE academic.enrollment (
  enrollment_id integer PRIMARY KEY,
  student_id    integer NOT NULL REFERENCES academic.student (student_id),
  course_id     integer NOT NULL REFERENCES academic.course (course_id),
  term          text    NOT NULL,
  grade         text,
  updated_at    timestamp NOT NULL DEFAULT now()
);

-- Every column is sensitive. A pipeline that filters columns correctly ends
-- up with nothing safe to select here, and must skip the table rather than
-- fall back to selecting everything.
CREATE TABLE hr.employee_health (
  employee_id      integer PRIMARY KEY REFERENCES hr.employee (employee_id),
  blood_type       text NOT NULL,
  chronic_illness  text,
  disability_note  text
);

-- Present in the database but deliberately absent from meta.db_column. The
-- pipeline has no classification for it, so it must be skipped rather than
-- guessed at.
CREATE TABLE hr.unregistered_scratch (
  scratch_id integer PRIMARY KEY,
  note       text
);

-- Registered but withdrawn (is_active = false in meta.db_table below).
CREATE TABLE hr.retired_lookup (
  code  text PRIMARY KEY,
  label text NOT NULL
);
