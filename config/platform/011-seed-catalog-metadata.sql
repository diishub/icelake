-- Development seed: Thai titles, one-line descriptions and a domain for each
-- synthetic table. Idempotent and non-destructive: an operator who edits a
-- title in the database keeps that edit, because the update only fills columns
-- that are still null.
--
-- Domain choices worth stating, since they are judgement rather than fact:
--   * the student register sits under student on its own, because that is the
--     table people mean when they ask for "student data".
--   * the course catalogue and enrolment are left with no domain (NULL, shown
--     as "unsorted") rather than forced into one of the five categories
--     config/platform/015-catalog-domains-expand.sql introduced -- teaching
--     data is neither research nor an academic service, and the domain this
--     table used to carry ('academic') was retired, not renamed. See 015 for
--     why.

UPDATE ingest.source_table AS st
SET domain          = COALESCE(st.domain, v.domain),
    display_name_th = COALESCE(st.display_name_th, v.title),
    description_th  = COALESCE(st.description_th, v.description)
FROM (VALUES
  ('sim_academic_course',
   NULL,
   'รายวิชาที่เปิดสอน',
   'บัญชีรายวิชาพร้อมหน่วยกิตและหลักสูตรที่สังกัด ใช้เป็นตารางอ้างอิงของรายงานด้านการเรียนการสอน'),
  ('sim_academic_enrollment',
   NULL,
   'การลงทะเบียนเรียน',
   'รายการลงทะเบียนรายภาคการศึกษา นำเข้าแบบเพิ่มทีละรอบตามเลขที่ลงทะเบียน'),
  ('sim_academic_student',
   'student',
   'ทะเบียนนักศึกษา',
   'ข้อมูลนักศึกษาระดับบุคคล เผยแพร่เฉพาะคอลัมน์ที่เจ้าของข้อมูลจัดชั้นเป็นสาธารณะ'),
  ('sim_hr_department',
   'personnel',
   'หน่วยงานและสังกัด',
   'รายชื่อคณะ สำนัก และหน่วยงานย่อย ใช้อ้างอิงสังกัดของบุคลากรและงบประมาณ'),
  ('sim_hr_position',
   'personnel',
   'ตำแหน่งและระดับ',
   'บัญชีตำแหน่งงานและระดับ ใช้อ้างอิงโครงสร้างกำลังคน'),
  ('sim_hr_employee',
   'personnel',
   'ทะเบียนบุคลากร',
   'ข้อมูลบุคลากรระดับบุคคล เผยแพร่เฉพาะคอลัมน์ที่เจ้าของข้อมูลจัดชั้นเป็นสาธารณะ'),
  ('sim_hr_employee_health',
   'personnel',
   'ข้อมูลสุขภาพบุคลากร',
   'อ่อนไหวทั้งตาราง ท่อนำเข้าจึงไม่คัดคอลัมน์ใดออกมาเลยและบันทึกเหตุผลไว้ ไม่มีข้อมูลชุดนี้ในคลัง'),
  ('sim_hr_retired_lookup',
   'personnel',
   'ตารางอ้างอิงที่ยกเลิกแล้ว',
   'เจ้าของข้อมูลถอนออกจากการเผยแพร่ ปิดการนำเข้าไว้ คงรายการไว้เพื่อให้ค้นแล้วรู้ว่าเคยมี')
) AS v (target_table_name, domain, title, description)
WHERE st.target_table_name = v.target_table_name;
