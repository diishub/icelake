-- Development seed: English titles and descriptions for the synthetic tables.
-- Idempotent and non-destructive, the same way 011 is: only columns that are
-- still null are filled, so an operator's edit survives a re-run.

UPDATE ingest.source_table AS st
SET display_name_en = COALESCE(st.display_name_en, v.title),
    description_en  = COALESCE(st.description_en, v.description)
FROM (VALUES
  ('sim_academic_course',
   'Courses offered',
   'Course catalogue with credits and the programme each course belongs to. Reference table for teaching and learning reports.'),
  ('sim_academic_enrollment',
   'Course enrolments',
   'Enrolment records per term, ingested incrementally by enrolment number.'),
  ('sim_academic_student',
   'Student register',
   'Person-level student records. Only the columns the data owner classified as public are published.'),
  ('sim_hr_department',
   'Departments and units',
   'Faculties, offices and sub-units. Reference table for staff affiliation and budget reporting.'),
  ('sim_hr_position',
   'Positions and grades',
   'Job titles and grades, used as the reference for workforce structure.'),
  ('sim_hr_employee',
   'Staff register',
   'Person-level staff records. Only the columns the data owner classified as public are published.'),
  ('sim_hr_employee_health',
   'Staff health records',
   'Sensitive throughout, so the pipeline selects no column at all and records why. Nothing from this table reaches the lakehouse.'),
  ('sim_hr_retired_lookup',
   'Withdrawn reference table',
   'The data owner withdrew this table from publication and ingestion is disabled. Listed so a search shows it once existed.')
) AS v (target_table_name, title, description)
WHERE st.target_table_name = v.target_table_name;
