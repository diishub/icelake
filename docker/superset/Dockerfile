FROM apache/superset:6.1.0

USER root
RUN uv pip install --python /app/.venv/bin/python \
    "apache-superset[fastmcp]==6.1.0" \
    "Authlib==1.7.1" \
    "psycopg2-binary==2.9.11" \
    "trino==0.338.0"
USER superset
