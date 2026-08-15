import os
import glob
import csv
import re
import json
import hashlib
import subprocess
import shutil
import time
import sys
import urllib.request

# Ensure UTF-8 output on Windows console for Thai characters
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8')

# Directory paths
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
INCOMING_DIR = os.path.join(BASE_DIR, 'data', 'incoming')
PROCESSED_DIR = os.path.join(BASE_DIR, 'data', 'processed')

QDRANT_API_KEY = os.getenv('QDRANT_API_KEY', 'change-me')
QDRANT_URL = 'http://qdrant:6333'

def sanitize_identifier(name):
    """Sanitize filename to valid SQL identifier."""
    clean = re.sub(r'[^a-zA-Z0-9_]', '_', name.lower())
    clean = re.sub(r'_+', '_', clean).strip('_')
    if clean and clean[0].isdigit():
        clean = 'tbl_' + clean
    return clean or 'sample_table'

def infer_sql_type(val):
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
    cmd = [
        'docker', 'compose', 'exec', '-T', 'trino',
        'trino', '--user', 'psu-admin', '--execute', sql
    ]
    res = subprocess.run(cmd, capture_output=True, text=True, cwd=BASE_DIR)
    if res.returncode != 0:
        raise RuntimeError(f"Trino Query Error: {res.stderr.strip() or res.stdout.strip()}")
    return res.stdout.strip()

def drop_polaris_table(namespace, table_name):
    import urllib.request
    try:
        url_token = "http://polaris:8181/api/catalog/v1/oauth/tokens"
        req_token = urllib.request.Request(
            url_token,
            data=b'grant_type=client_credentials&client_id=root&client_secret=change-me&scope=PRINCIPAL_ROLE:ALL',
            headers={'Polaris-Realm': 'PSU', 'Content-Type': 'application/x-www-form-urlencoded'}
        )
        token = json.loads(urllib.request.urlopen(req_token).read())['access_token']
        del_url = f"http://polaris:8181/api/catalog/v1/psu/namespaces/{namespace}/tables/{table_name}"
        del_req = urllib.request.Request(
            del_url,
            headers={'Authorization': f'Bearer {token}', 'Polaris-Realm': 'PSU'},
            method='DELETE'
        )
        urllib.request.urlopen(del_req)
        print(f"[Polaris API] Dropped table polaris.{namespace}.{table_name}")
    except Exception as e:
        pass

def generate_embedding(text, dim=384):
    """Generate a lightweight deterministic feature vector from text content."""
    vec = [0.0] * dim
    if not text:
        return vec
    words = text.lower().split()
    for w in words:
        h = int(hashlib.md5(w.encode('utf-8')).hexdigest(), 16)
        idx = h % dim
        vec[idx] += 1.0
    norm = sum(x*x for x in vec) ** 0.5
    if norm > 0:
        vec = [round(x / norm, 6) for x in vec]
    return vec

def index_to_qdrant(point_id, vector, payload):
    """Index payload and vector into Qdrant collection multimodal_docs via Superset Python container."""
    py_code = f"""
import urllib.request, json
url = 'http://qdrant:6333/collections/multimodal_docs/points'
data = json.dumps({{
    'points': [{{
        'id': '{point_id}',
        'vector': {vector},
        'payload': {json.dumps(payload)}
    }}]
}}).encode('utf-8')
req = urllib.request.Request(url, data=data, headers={{'Content-Type': 'application/json', 'api-key': '{QDRANT_API_KEY}'}}, method='PUT')
res = urllib.request.urlopen(req).read().decode()
print(res)
"""
    cmd = ['docker', 'compose', 'exec', '-T', 'superset', 'python3', '-c', py_code]
    subprocess.run(cmd, capture_output=True, text=True, cwd=BASE_DIR)

def archive_file(filepath, category):
    if not os.path.exists(filepath):
        return
    dest_dir = os.path.join(PROCESSED_DIR, category)
    os.makedirs(dest_dir, exist_ok=True)
    filename = os.path.basename(filepath)
    dest_path = os.path.join(dest_dir, filename)
    try:
        if os.path.exists(dest_path):
            os.remove(dest_path)
        shutil.move(filepath, dest_path)
        print(f"[Archived] Moved {filename} -> data/processed/{category}/")
    except Exception as e:
        print(f"[Warning] Could not move file {filename}: {e}")

def clean_timestamp_val(val):
    val = str(val).strip()
    if not val or val.upper() in ('N/A', 'INVALID_DATE', 'BAD_TIMESTAMP', 'NULL', 'NONE', 'UNKNOWN', 'NAN'):
        return None
    try:
        dt = pd.to_datetime(val, errors='coerce')
        if pd.notnull(dt):
            return dt.strftime('%Y-%m-%d %H:%M:%S')
    except Exception:
        pass
    return None

def clean_numeric_val(val, is_float=False):
    val = str(val).strip()
    if not val or val.upper() in ('N/A', 'NULL', 'NONE', 'UNKNOWN', 'NAN'):
        return None
    if val.lower() == 'free':
        return 0.0 if is_float else 0
    # Remove commas, symbols, and units
    val = val.replace(',', '')
    val = re.sub(r'(?i)(ms|%|\$|tokens|usd)', '', val).strip()
    word_map = {'zero': 0, 'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5}
    if val.lower() in word_map:
        return float(word_map[val.lower()]) if is_float else word_map[val.lower()]
    try:
        num = float(val)
        if num < -500 or num > 900000:
            return None
        return num if is_float else int(num)
    except ValueError:
        return None

def read_structured_rows(filepath):
    """Read CSV or JSON file into (headers, rows_list_of_dicts)."""
    filename = os.path.basename(filepath)
    ext = os.path.splitext(filename)[1].lower()
    
    if ext == '.csv':
        with open(filepath, 'r', encoding='utf-8-sig') as f:
            reader = csv.reader(f)
            headers = next(reader, None)
            if not headers:
                return [], []
            raw_rows = list(reader)
        col_names = [sanitize_identifier(h) for h in headers]
        dicts = []
        for r in raw_rows:
            d = {}
            for col_idx, col_name in enumerate(col_names):
                d[col_name] = r[col_idx] if col_idx < len(r) else ''
            dicts.append(d)
        return col_names, dicts
    elif ext in ('.json', '.jsonl'):
        dicts = []
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            try:
                content = f.read().strip()
                if content.startswith('['):
                    arr = json.loads(content)
                    if isinstance(arr, list):
                        dicts = [x for x in arr if isinstance(x, dict)]
                else:
                    for line in content.splitlines():
                        line = line.strip()
                        if line:
                            obj = json.loads(line)
                            if isinstance(obj, dict):
                                dicts.append(obj)
            except Exception as e:
                print(f"[Warning] Could not parse JSON file {filename}: {e}")
                return [], []
        if not dicts:
            return [], []
        # Union of all keys
        col_set = []
        for d in dicts:
            for k in d.keys():
                s_k = sanitize_identifier(k)
                if s_k not in col_set:
                    col_set.append(s_k)
        # Normalize dict keys
        norm_dicts = []
        for d in dicts:
            nd = {}
            for k, v in d.items():
                nd[sanitize_identifier(k)] = str(v) if v is not None else ''
            norm_dicts.append(nd)
        return col_set, norm_dicts
    return [], []

import pandas as pd
import numpy as np
from sklearn.impute import KNNImputer

def ml_clean_structured_rows(col_names, row_dicts):
    """
    ML-Driven Dynamic Data Cleaner & Imputer (Schema-Agnostic):
    1. Dynamic Type Inference per column (Datetime, Metric, Category, ID) without hardcoding column names!
    2. Primary Key & Timestamp Integrity Filtering.
    3. Multi-variate ML KNN Imputation for missing/dirty numerical metrics using Scikit-Learn!
    4. Categorical & DateTime Normalization.
    """
    if not row_dicts:
        return col_names, []

    df = pd.DataFrame(row_dicts)
    
    # 1. Primary Key / ID Column Detection
    pk_cols = [c for c in col_names if 'id' in c.lower() or 'key' in c.lower() or c.lower() == 'id']
    if not pk_cols:
        pk_cols = [col_names[0]]
        
    main_pk = pk_cols[0]
    
    # Deduplicate exact rows
    df['__hash'] = df.apply(lambda r: hashlib.md5("|".join([str(v).strip().lower() for v in r]).encode('utf-8')).hexdigest(), axis=1)
    df = df.drop_duplicates(subset=['__hash']).drop(columns=['__hash'])
    
    # Drop rows where main PK is empty or N/A
    df[main_pk] = df[main_pk].astype(str).str.strip()
    df = df[~df[main_pk].str.upper().isin(['', 'N/A', 'NULL', 'NONE', 'NAN'])].copy()
    
    # 2. DateTime Column Profiling
    dt_cols = [c for c in col_names if any(k in c.lower() for k in ('time', 'date', 'created', 'updated'))]
    for col in dt_cols:
        df[col] = df[col].astype(str).apply(clean_timestamp_val)
        
    if dt_cols:
        main_dt = dt_cols[0]
        df = df[df[main_dt].notnull()].copy()
        
    # 3. Dynamic Metric vs Categorical Profiling
    numeric_cols = []
    categorical_cols = []
    
    for col in col_names:
        if col in dt_cols or col in pk_cols:
            continue
        cleaned_series = df[col].astype(str).apply(lambda x: clean_numeric_val(x, is_float=True))
        valid_ratio = cleaned_series.notnull().mean() if len(df) > 0 else 0
        if valid_ratio >= 0.3:
            numeric_cols.append(col)
            df[col + '_num'] = cleaned_series
        else:
            categorical_cols.append(col)

    # 4. ML Multivariate KNN Imputation for Numerical Features (Scikit-Learn)
    if numeric_cols and len(df) > 0:
        num_cols_temp = [c + '_num' for c in numeric_cols]
        num_df = df[num_cols_temp].copy()
        
        for col in num_df.columns:
            if num_df[col].isnull().all():
                num_df[col] = 0.0
                
        n_neighbors = min(3, len(df))
        if n_neighbors >= 1:
            try:
                imputer = KNNImputer(n_neighbors=n_neighbors, weights='distance')
                imputed_matrix = imputer.fit_transform(num_df)
                for idx, col in enumerate(numeric_cols):
                    df[col] = np.round(imputed_matrix[:, idx], 2)
            except Exception as e:
                print(f"[ML Imputer Note] {e}")
                for col in numeric_cols:
                    df[col] = df[col + '_num'].fillna(df[col + '_num'].mean()).round(2)
        else:
            for col in numeric_cols:
                df[col] = df[col + '_num'].fillna(df[col + '_num'].mean()).round(2)
                
    # 5. Categorical & Text Normalization
    for col in categorical_cols:
        df[col] = df[col].astype(str).str.strip()
        if col.lower() == 'status':
            df[col] = df[col].apply(lambda x: x.upper() if x and x.upper() not in ('N/A', 'NULL', 'NONE', 'NAN', '') else 'UNKNOWN')
        elif col.lower() in ('service', 'department'):
            df[col] = df[col].apply(lambda x: x.lower() if x and x.lower() not in ('n/a', 'null', 'none', 'nan', '') else 'general-service')
        else:
            df[col] = df[col].apply(lambda x: x if x and x.upper() not in ('N/A', 'NULL', 'NONE', 'NAN', '') else 'N/A')

    # Reconstruct cleaned rows for SQL Insert matching exact Trino column types
    cleaned_rows = []
    for _, row in df.iterrows():
        r = []
        for col in col_names:
            v = row[col]
            if col in dt_cols:
                ts_str = str(v).strip() if pd.notnull(v) and str(v).strip() and str(v) not in ('None', 'nan', 'NaT') else ''
                r.append(f"TIMESTAMP '{ts_str}'" if ts_str else "NULL")
            elif col in numeric_cols:
                try:
                    num_val = float(v)
                    if np.isnan(num_val):
                        r.append("0.0")
                    else:
                        r.append(str(round(num_val, 2)))
                except (ValueError, TypeError):
                    r.append("0.0")
            elif col in pk_cols:
                safe_pk = str(v).replace("'", "''")
                r.append(f"'{safe_pk}'" if safe_pk and safe_pk not in ('None', 'nan') else "'usr_unknown'")
            else:
                safe_val = str(v).replace("'", "''")
                r.append(f"'{safe_val}'" if safe_val and safe_val not in ('None', 'nan') else "'N/A'")
        cleaned_rows.append(r)
        
    return col_names, cleaned_rows, dt_cols, numeric_cols, categorical_cols, pk_cols


def process_structured_file(filepath):
    filename = os.path.basename(filepath)
    if filename.startswith('.'):
        return

    table_name = sanitize_identifier(os.path.splitext(filename)[0])
    print(f"\n[ML-Driven Auto-Cleaner Pipeline] Processing {filename} -> polaris.raw.{table_name} & polaris.curated.{table_name}")

    col_names, row_dicts = read_structured_rows(filepath)
    if not col_names or not row_dicts:
        print(f"[Warning] No structured records found in {filename}. Skipping.")
        return

    # Infer column types for Bronze Layer
    col_types = []
    for col_name in col_names:
        types_found = set()
        for d in row_dicts[:50]:
            v = d.get(col_name, '').strip()
            if v:
                types_found.add(infer_sql_type(v))
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

    # 1. BRONZE LAYER (polaris.raw.<table_name>) - RAW INGESTION
    schema_cols = [f"{name} {col_type}" for name, col_type in zip(col_names, col_types)]
    create_raw_sql = f"CREATE TABLE IF NOT EXISTS polaris.raw.{table_name} ({', '.join(schema_cols)}) WITH (format = 'PARQUET');"
    run_trino_query(create_raw_sql)

    batch_size = 50
    inserted = 0
    for i in range(0, len(row_dicts), batch_size):
        batch = row_dicts[i:i+batch_size]
        value_tuples = []
        for d in batch:
            formatted_vals = []
            for col_idx, col_name in enumerate(col_names):
                v = d.get(col_name, '')
                formatted_vals.append(escape_sql_val(v, col_types[col_idx]))
            value_tuples.append(f"({', '.join(formatted_vals)})")

        insert_sql = f"INSERT INTO polaris.raw.{table_name} VALUES {', '.join(value_tuples)};"
        run_trino_query(insert_sql)
        inserted += len(batch)

    print(f"[Bronze Success] Raw table polaris.raw.{table_name} populated with {inserted} records.")

    # 2. SILVER LAYER (polaris.curated.<table_name>) - ML-DRIVEN SMART DATA CLEANER
    run_trino_query("CREATE SCHEMA IF NOT EXISTS polaris.curated;")

    col_names, cleaned_rows, dt_cols, numeric_cols, categorical_cols, pk_cols = ml_clean_structured_rows(col_names, row_dicts)

    # Build Dynamic Curated SQL Table Schema based on ML Inferred Types
    curated_cols = []
    for col_name in col_names:
        if col_name in dt_cols:
            curated_cols.append(f"{col_name} TIMESTAMP")
        elif col_name in numeric_cols:
            curated_cols.append(f"{col_name} DOUBLE")
        else:
            curated_cols.append(f"{col_name} VARCHAR")

    # Reset curated table metadata via Polaris API to ensure schema always matches ML-inferred types
    drop_polaris_table('curated', table_name)
    time.sleep(1.0)

    create_curated_sql = f"CREATE TABLE IF NOT EXISTS polaris.curated.{table_name} ({', '.join(curated_cols)}) WITH (format = 'PARQUET');"
    try:
        run_trino_query(create_curated_sql)
    except Exception:
        time.sleep(1.0)
        run_trino_query(create_curated_sql)

    # Purge old records in curated table before inserting fresh clean records
    try:
        run_trino_query(f"DELETE FROM polaris.curated.{table_name};")
    except Exception:
        pass

    curated_inserted = 0
    for i in range(0, len(cleaned_rows), batch_size):
        batch = cleaned_rows[i:i+batch_size]
        value_tuples = [f"({', '.join(r)})" for r in batch]
        insert_curated_sql = f"INSERT INTO polaris.curated.{table_name} VALUES {', '.join(value_tuples)};"
        try:
            run_trino_query(insert_curated_sql)
        except Exception as err:
            if 'mismatched column types' in str(err).lower() or 'failed to drop table' in str(err).lower():
                print(f"[Schema Recovery] Resetting curated schema for {table_name}...")
                drop_polaris_table('curated', table_name)
                time.sleep(2.5)
                strict_create_sql = f"CREATE TABLE polaris.curated.{table_name} ({', '.join(curated_cols)}) WITH (format = 'PARQUET');"
                try:
                    run_trino_query(strict_create_sql)
                except Exception:
                    time.sleep(2.0)
                    run_trino_query(strict_create_sql)
                run_trino_query(insert_curated_sql)
            else:
                raise err
        curated_inserted += len(batch)

    print(f"[Silver ML Success] ML-Cleaned table polaris.curated.{table_name} populated with {curated_inserted} clean records (KNN Imputed & Dynamically Profiled).")
    archive_file(filepath, 'structured')



def process_unstructured_document(filepath):
    filename = os.path.basename(filepath)
    if filename.startswith('.'):
        return

    print(f"\n[Unstructured Document Pipeline] Processing {filename}")
    ext = os.path.splitext(filename)[1].lower().replace('.', '') or 'txt'
    file_size = os.path.getsize(filepath)
    file_id = hashlib.md5(f"{filename}_{time.time()}".encode('utf-8')).hexdigest()

    content = ""
    try:
        with open(filepath, 'r', encoding='utf-8', errors='ignore') as f:
            content = f.read()
    except Exception:
        content = f"Binary content of {filename}"

    # Clean whitespace and extract summary
    clean_content = re.sub(r'\s+', ' ', content).strip()
    summary = clean_content[:200] + ('...' if len(clean_content) > 200 else '')
    safe_summary = summary.replace("'", "''")

    # Generate vector and index in Qdrant
    vec = generate_embedding(clean_content)
    payload = {
        'file_id': file_id,
        'file_name': filename,
        'file_type': ext,
        'summary': summary
    }
    # Integer point ID derived from file_id hash
    int_point_id = int(file_id[:8], 16)
    index_to_qdrant(int_point_id, vec, payload)

    # Register in Iceberg polaris.documents.multimodal_catalog
    s3_url = f"s3://psu-lakehouse/raw/documents/{filename}"
    catalog_sql = f"""
    INSERT INTO polaris.documents.multimodal_catalog VALUES (
        '{file_id}',
        '{filename.replace("'", "''")}',
        '{ext}',
        '{s3_url}',
        '{safe_summary}',
        ARRAY['document', '{ext}'],
        {file_size},
        CURRENT_TIMESTAMP,
        'PROCESSED',
        '{int_point_id}'
    );
    """
    run_trino_query(catalog_sql)
    print(f"[Success] Cataloged {filename} in polaris.documents.multimodal_catalog and indexed vector in Qdrant.")
    archive_file(filepath, 'documents')

def process_unstructured_media(filepath, category):
    filename = os.path.basename(filepath)
    if filename.startswith('.'):
        return

    print(f"\n[Unstructured Media Pipeline] Processing {category} -> {filename}")
    ext = os.path.splitext(filename)[1].lower().replace('.', '') or category
    file_size = os.path.getsize(filepath)
    file_id = hashlib.md5(f"{filename}_{time.time()}".encode('utf-8')).hexdigest()

    summary = f"Media file {filename} ({category}, {file_size} bytes)"
    safe_summary = summary.replace("'", "''")

    vec = generate_embedding(f"{filename} {category} media asset")
    payload = {
        'file_id': file_id,
        'file_name': filename,
        'file_type': ext,
        'summary': summary
    }
    int_point_id = int(file_id[:8], 16)
    index_to_qdrant(int_point_id, vec, payload)

    s3_url = f"s3://psu-lakehouse/raw/{category}/{filename}"
    catalog_sql = f"""
    INSERT INTO polaris.documents.multimodal_catalog VALUES (
        '{file_id}',
        '{filename.replace("'", "''")}',
        '{ext}',
        '{s3_url}',
        '{safe_summary}',
        ARRAY['{category}', '{ext}'],
        {file_size},
        CURRENT_TIMESTAMP,
        'PROCESSED',
        '{int_point_id}'
    );
    """
    run_trino_query(catalog_sql)
    print(f"[Success] Cataloged {filename} in polaris.documents.multimodal_catalog and indexed in Qdrant.")
    archive_file(filepath, category)

def run_once():
    # Structured CSV & JSON
    structured_dir = os.path.join(INCOMING_DIR, 'structured')
    if os.path.exists(structured_dir):
        for ext in ('*.csv', '*.json', '*.jsonl'):
            for f in glob.glob(os.path.join(structured_dir, ext)):
                process_structured_file(f)

    # Documents (PDF, TXT, DOCX, MD)
    doc_dir = os.path.join(INCOMING_DIR, 'documents')
    if os.path.exists(doc_dir):
        for ext in ('*.txt', '*.pdf', '*.docx', '*.md'):
            for f in glob.glob(os.path.join(doc_dir, ext)):
                process_unstructured_document(f)

    # Images
    img_dir = os.path.join(INCOMING_DIR, 'images')
    if os.path.exists(img_dir):
        for ext in ('*.jpg', '*.jpeg', '*.png', '*.webp'):
            for f in glob.glob(os.path.join(img_dir, ext)):
                process_unstructured_media(f, 'images')

    # Audio
    audio_dir = os.path.join(INCOMING_DIR, 'audio')
    if os.path.exists(audio_dir):
        for ext in ('*.mp3', '*.wav', '*.flac'):
            for f in glob.glob(os.path.join(audio_dir, ext)):
                process_unstructured_media(f, 'audio')

def main():
    watch_mode = '--watch' in sys.argv or '-w' in sys.argv
    print(f"PSU Lakehouse Multimodal Data Pipeline Service (Watch Mode: {watch_mode})...")

    if not watch_mode:
        run_once()
        print("Pipeline execution completed.")
    else:
        print("Watching data/incoming/ taxonomy for new files...\n")
        try:
            while True:
                run_once()
                time.sleep(5)
        except KeyboardInterrupt:
            print("\nMultimodal Data Pipeline Service Stopped.")

if __name__ == '__main__':
    main()
