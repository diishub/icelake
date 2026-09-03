-- Generated content for the synthetic source. Deterministic, so two people
-- who rebuild this container get the same rows and can compare results.
--
-- Nothing here is derived from a real record. Identifiers are prefixed
-- SYNTHETIC-, addresses are fictional, and every email uses the reserved
-- .invalid top-level domain so an accidental send cannot reach anyone.

INSERT INTO hr.department (department_id, department_code, department_name, org_unit)
SELECT n,
       'DEPT' || lpad(n::text, 3, '0'),
       'Synthetic Department ' || n,
       (ARRAY['eng', 'med', 'sci', 'mgt'])[1 + (n % 4)]
FROM generate_series(1, 12) AS n;

INSERT INTO hr.position (position_id, position_code, position_name, position_band)
SELECT n,
       'POS' || lpad(n::text, 3, '0'),
       'Synthetic Position ' || n,
       1 + (n % 8)
FROM generate_series(1, 20) AS n;

INSERT INTO academic.course (course_id, course_code, course_name, credits, department_id)
SELECT n,
       'CRS' || lpad(n::text, 4, '0'),
       'Synthetic Course ' || n,
       1 + (n % 4),
       1 + (n % 12)
FROM generate_series(1, 200) AS n;

INSERT INTO hr.employee (
  employee_id, department_id, position_id, employment_type, start_date,
  is_active, citizen_id, full_name_thai, full_name_eng, birth_date, phone,
  email, home_address, monthly_salary
)
SELECT n,
       1 + (n % 12),
       1 + (n % 20),
       (ARRAY['permanent', 'contract', 'temporary'])[1 + (n % 3)],
       DATE '2005-01-01' + ((n % 7000) || ' days')::interval,
       (n % 20) <> 0,
       'SYNTHETIC-CID-' || lpad(n::text, 9, '0'),
       'ทดสอบ นามสมมติ ' || lpad(n::text, 6, '0'),
       'Synthetic Employee ' || lpad(n::text, 6, '0'),
       DATE '1960-01-01' + ((n % 14000) || ' days')::interval,
       '000-000-' || lpad((n % 10000)::text, 4, '0'),
       'synthetic.employee.' || lpad(n::text, 6, '0') || '@example.invalid',
       'Synthetic Address ' || n || ', Fictional District',
       20000 + ((n % 60) * 1250)
FROM generate_series(1, 5000) AS n;

INSERT INTO academic.student (
  student_id, department_id, admit_year, study_status, citizen_id,
  full_name_thai, birth_date, phone, email
)
SELECT n,
       1 + (n % 12),
       2018 + (n % 8),
       (ARRAY['enrolled', 'leave', 'graduated'])[1 + (n % 3)],
       'SYNTHETIC-CID-S' || lpad(n::text, 8, '0'),
       'ทดสอบ นักศึกษา ' || lpad(n::text, 6, '0'),
       DATE '1995-01-01' + ((n % 9000) || ' days')::interval,
       '000-111-' || lpad((n % 10000)::text, 4, '0'),
       'synthetic.student.' || lpad(n::text, 6, '0') || '@example.invalid'
FROM generate_series(1, 20000) AS n;

INSERT INTO academic.enrollment (enrollment_id, student_id, course_id, term, grade)
SELECT n,
       1 + (n % 20000),
       1 + (n % 200),
       (2023 + (n % 3))::text || '/' || (1 + (n % 2))::text,
       (ARRAY['A', 'B+', 'B', 'C+', 'C', 'D', 'F', NULL])[1 + (n % 8)]
FROM generate_series(1, 60000) AS n;

INSERT INTO hr.employee_health (employee_id, blood_type, chronic_illness, disability_note)
SELECT n,
       (ARRAY['A', 'B', 'AB', 'O'])[1 + (n % 4)],
       CASE WHEN n % 9 = 0 THEN 'Synthetic condition ' || (n % 5) END,
       CASE WHEN n % 25 = 0 THEN 'Synthetic note ' || (n % 3) END
FROM generate_series(1, 5000) AS n;

INSERT INTO hr.retired_lookup (code, label)
SELECT 'R' || lpad(n::text, 2, '0'), 'Retired lookup value ' || n
FROM generate_series(1, 10) AS n;

INSERT INTO hr.unregistered_scratch (scratch_id, note)
SELECT n, 'Scratch note ' || n
FROM generate_series(1, 5) AS n;

-- ---------------------------------------------------------------------------
-- Classification registry content
-- ---------------------------------------------------------------------------
--
-- hr.unregistered_scratch is deliberately left out: a table with no registry
-- entry has no classification, and the pipeline must skip it rather than
-- assume it is safe.

INSERT INTO meta.db_table (schema_name, table_name, description, is_active) VALUES
  ('hr',       'department',       'Organisational units',                 true),
  ('hr',       'position',         'Position reference data',              true),
  ('hr',       'employee',         'Employee records, mixed sensitivity',  true),
  ('hr',       'employee_health',  'Health records, entirely sensitive',   true),
  ('hr',       'retired_lookup',   'Withdrawn from ingestion by the owner', false),
  ('academic', 'course',           'Course reference data',                true),
  ('academic', 'student',          'Student records, mixed sensitivity',   true),
  ('academic', 'enrollment',       'Enrollment records, grade is sensitive', true);

-- Start every registered column at 'public', then mark the exceptions. Doing
-- it this way means a column added to a table later still gets a registry row
-- when this database is rebuilt, instead of silently having no entry.
INSERT INTO meta.db_column (schema_name, table_name, column_name, data_type, classification, secret_level)
SELECT c.table_schema, c.table_name, c.column_name, c.data_type, 'public', 0
FROM information_schema.columns AS c
JOIN meta.db_table AS t
  ON t.schema_name = c.table_schema
 AND t.table_name = c.table_name;

UPDATE meta.db_column
SET classification = 'internal', secret_level = 1
WHERE column_name IN ('updated_at');

UPDATE meta.db_column
SET classification = 'sensitive', secret_level = 3
WHERE (schema_name, table_name, column_name) IN (
  ('hr', 'employee', 'citizen_id'),
  ('hr', 'employee', 'full_name_thai'),
  ('hr', 'employee', 'full_name_eng'),
  ('hr', 'employee', 'birth_date'),
  ('hr', 'employee', 'phone'),
  ('hr', 'employee', 'email'),
  ('hr', 'employee', 'home_address'),
  ('hr', 'employee', 'monthly_salary'),
  ('academic', 'student', 'citizen_id'),
  ('academic', 'student', 'full_name_thai'),
  ('academic', 'student', 'birth_date'),
  ('academic', 'student', 'phone'),
  ('academic', 'student', 'email'),
  ('academic', 'enrollment', 'grade')
);

-- Health data leaves no safe column at all, including the identifier, which
-- on its own already says who has a health record.
UPDATE meta.db_column
SET classification = 'sensitive', secret_level = 4
WHERE schema_name = 'hr' AND table_name = 'employee_health';
