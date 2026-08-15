import os
import glob
import csv
import re
import subprocess
import sys
import shutil
import time

# Directory paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INCOMING_CSV_DIR = os.path.join(BASE_DIR, 'data', 'incoming', 'csv')
PROCESSED_CSV_DIR = os.path.join(BASE_DIR, 'data', 'processed', 'csv')

def sanitize_identifier(name):
    """Sanitize filename to valid SQL identifier."""
    clean = re.sub(r'[^a-zA-Z0-9_]', '_', name.lower())
    clean = re.sub(r'_+', '_', clean).strip('_')
    if clean and clean[0].isdigit():
        clean = 'tbl_' + clean
    return clean or 'sample_table'

def infer_sql_type(val):
    """Infer Trino SQL data type from string value."""
    val = val.strip()
    if not val:
        return 'VARCHAR'
    if val.isdigit() or (val.startswith('-') and val[1:].isdigit()):
        return 'BIGINT'
    try:
        float(val)
        return 'DOUBLE'
    except ValueError:
        pass
    if re.match(r'^\d{4}-\d{2}-\d{2}$', val):
        return 'DATE'
    return 'VARCHAR'

def escape_sql_val(val, sql_type):
    """Format Python string to SQL value literal for Trino."""
    val = val.strip()
    if not val:
        return 'NULL'
    if sql_type in ('BIGINT', 'DOUBLE'):
        try:
            float(val)
            return val
        except ValueError:
            return 'NULL'
    safe_val = val.replace("'", "''")
    if sql_type == 'DATE':
        if re.match(r'^\d{4}-\d{2}-\d{2}$', val):
            return f"DATE '{safe_val}'"
        return f"'{safe_val}'"
    return f"'{safe_val}'"

def run_trino_query(sql):
    """Run Trino SQL query using docker compose exec."""
    cmd = [
        'docker', 'compose', 'exec', '-T', 'trino',
        'trino', '--user', 'psu-admin', '--execute', sql
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, cwd=BASE_DIR)
    if res.returncode != 0:
        raise RuntimeError(f"Trino Query Error: {res.stderr.strip() or res.stdout.strip()}")
    return res.stdout.strip()

def process_csv_file(filepath):
    """Read CSV file, create Iceberg table if not exists, insert data, and archive file."""
    filename = os.path.basename(filepath)
    if filename.startswith('.'):
        return

    table_name = sanitize_identifier(os.path.splitext(filename)[0])
    print(f"\n[Processing file] {filename} -> Table: polaris.raw.{table_name}")

    with open(filepath, 'r', encoding='utf-8-sig') as f:
        reader = csv.reader(f)
        headers = next(reader, None)
        if not headers:
            print(f"[Warning] File {filename} is empty. Skipping.")
            return
        rows = list(reader)

    if not rows:
        print(f"[Warning] File {filename} has no data rows. Skipping.")
        return

    col_names = [sanitize_identifier(h) for h in headers]
    col_types = []

    # Infer types from first 50 rows
    for col_idx in range(len(col_names)):
        types_found = set()
        for r in rows[:50]:
            if col_idx < len(r) and r[col_idx].strip():
                types_found.add(infer_sql_type(r[col_idx]))
        
        if 'VARCHAR' in types_found:
            col_types.append('VARCHAR')
        elif 'DOUBLE' in types_found:
            col_types.append('DOUBLE')
        elif 'DATE' in types_found:
            col_types.append('DATE')
        elif 'BIGINT' in types_found:
            col_types.append('BIGINT')
        else:
            col_types.append('VARCHAR')

    schema_cols = [f"{name} {col_type}" for name, col_type in zip(col_names, col_types)]
    create_sql = f"CREATE TABLE IF NOT EXISTS polaris.raw.{table_name} ({', '.join(schema_cols)}) WITH (format = 'PARQUET');"

    print(f"[Creating table] polaris.raw.{table_name}...")
    try:
        run_trino_query(create_sql)
        print(f"[Ready] Table polaris.raw.{table_name} is ready.")
    except Exception as e:
        print(f"[Error] Error creating table: {e}")
        return

    # Insert data in batches of 50 rows
    print(f"[Inserting] {len(rows)} rows into polaris.raw.{table_name}...")
    batch_size = 50
    inserted = 0
    for i in range(0, len(rows), batch_size):
        batch = rows[i:i+batch_size]
        value_tuples = []
        for r in batch:
            formatted_vals = []
            for col_idx in range(len(col_names)):
                v = r[col_idx] if col_idx < len(r) else ''
                formatted_vals.append(escape_sql_val(v, col_types[col_idx]))
            value_tuples.append(f"({', '.join(formatted_vals)})")

        insert_sql = f"INSERT INTO polaris.raw.{table_name} VALUES {', '.join(value_tuples)};"
        try:
            run_trino_query(insert_sql)
            inserted += len(batch)
            print(f"   Inserted {inserted}/{len(rows)} rows...")
        except Exception as e:
            print(f"[Error] Error inserting batch: {e}")
            break

    print(f"[Success] Ingested {filename} into polaris.raw.{table_name} ({inserted} rows)!")

    # Move processed file to processed directory
    os.makedirs(PROCESSED_CSV_DIR, exist_ok=True)
    dest_path = os.path.join(PROCESSED_CSV_DIR, filename)
    try:
        if os.path.exists(dest_path):
            os.remove(dest_path)
        shutil.move(filepath, dest_path)
        print(f"[Archived] Moved {filename} -> data/processed/csv/")
    except Exception as e:
        print(f"[Warning] Could not move file {filename}: {e}")

def run_once():
    if not os.path.exists(INCOMING_CSV_DIR):
        return 0

    csv_files = glob.glob(os.path.join(INCOMING_CSV_DIR, '*.csv'))
    if not csv_files:
        return 0

    print(f"\n[Auto-Ingest] Found {len(csv_files)} CSV file(s) in incoming folder.")
    for f in csv_files:
        process_csv_file(f)
    return len(csv_files)

def main():
    watch_mode = '--watch' in sys.argv or '-w' in sys.argv
    print(f"PSU Lakehouse Auto-Ingest Service (Watch Mode: {watch_mode})...")

    if not watch_mode:
        count = run_once()
        if count == 0:
            print("No new CSV files found in incoming directory.")
    else:
        print("Watching data/incoming/csv/ for new CSV files. Press Ctrl+C to stop.\n")
        try:
            while True:
                run_once()
                time.sleep(5)
        except KeyboardInterrupt:
            print("\nAuto-Ingest Service Stopped.")

if __name__ == '__main__':
    main()
