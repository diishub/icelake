"""Create the platform operations dashboard.

The dashboard answers the questions an operator actually asks: did last night
run, what did it skip and why, and when did maintenance last delete anything.
Those answers live in the control plane, and they are read through Trino like
everything else -- with user impersonation on, so the same OPA policy decides
who may see them. Viewers cannot, by design: run history names source systems
and tables a report reader has no reason to see.

Idempotent. Re-running reconciles the database, the datasets and the charts
without duplicating them.
"""

import json

from superset.app import create_app

DATABASE_NAME = "PSU Platform Ops"
DASHBOARD_TITLE = "PSU Platform Operations"
SCHEMA = "ingest"

# Raw-records tables rather than aggregates: an operator reading this wants the
# rows, including the ones with an awkward status.
CHARTS = [
    {
        "slice_name": "Ingestion freshness",
        "table": "v_table_freshness",
        "columns": [
            "target_table",
            "source_key",
            "load_mode",
            "last_status",
            "last_success_rows",
            "last_success_started_at",
            "age_since_last_success",
            "skip_reason",
        ],
        "order_by": '["target_table", true]',
        "row_limit": 200,
    },
    {
        "slice_name": "Recent ingestion runs",
        "table": "ingest_run",
        "columns": [
            "started_at",
            "target_table",
            "status",
            "rows_read",
            "rows_written",
            "columns_selected",
            "columns_excluded",
            "skip_reason",
            "error_message",
        ],
        "order_by": '["started_at", false]',
        "row_limit": 200,
    },
    {
        "slice_name": "Maintenance history",
        "table": "maintenance_run",
        "columns": [
            "started_at",
            "target_table",
            "action",
            "status",
            "retention_applied",
            "detail",
        ],
        "order_by": '["started_at", false]',
        "row_limit": 200,
    },
]


def chart_params(chart):
    return json.dumps(
        {
            "viz_type": "table",
            "query_mode": "raw",
            "all_columns": chart["columns"],
            "order_by_cols": [chart["order_by"]],
            "row_limit": chart["row_limit"],
            "server_pagination": False,
            "include_search": True,
        }
    )


def position_json(slices):
    position = {
        "DASHBOARD_VERSION_KEY": "v2",
        "ROOT_ID": {"type": "ROOT", "id": "ROOT_ID", "children": ["GRID_ID"]},
        "GRID_ID": {"type": "GRID", "id": "GRID_ID", "children": [], "parents": ["ROOT_ID"]},
        "HEADER_ID": {"type": "HEADER", "id": "HEADER_ID", "meta": {"text": DASHBOARD_TITLE}},
    }
    for index, slc in enumerate(slices, start=1):
        row_id = f"ROW-{index}"
        chart_id = f"CHART-{index}"
        position["GRID_ID"]["children"].append(row_id)
        position[row_id] = {
            "type": "ROW",
            "id": row_id,
            "children": [chart_id],
            "parents": ["ROOT_ID", "GRID_ID"],
            "meta": {"background": "BACKGROUND_TRANSPARENT"},
        }
        position[chart_id] = {
            "type": "CHART",
            "id": chart_id,
            "children": [],
            "parents": ["ROOT_ID", "GRID_ID", row_id],
            "meta": {
                "chartId": slc.id,
                "sliceName": slc.slice_name,
                "uuid": str(slc.uuid),
                "width": 12,
                "height": 50,
            },
        }
    return json.dumps(position)


app = create_app()
with app.app_context():
    from superset import db
    from superset.connectors.sqla.models import SqlaTable
    from superset.models.core import Database
    from superset.models.dashboard import Dashboard
    from superset.models.slice import Slice

    database = (
        db.session.query(Database).filter_by(database_name=DATABASE_NAME).one_or_none()
    )
    if database is None:
        database = Database(database_name=DATABASE_NAME)
        db.session.add(database)

    # Impersonation is the point: the query reaches Trino as the signed-in
    # user, so OPA decides, not this connection.
    database.sqlalchemy_uri = "trino://superset@trino:8080/platform"
    database.impersonate_user = True
    database.expose_in_sqllab = True
    database.allow_ctas = False
    database.allow_cvas = False
    database.allow_dml = False
    db.session.commit()

    slices = []
    for chart in CHARTS:
        dataset = (
            db.session.query(SqlaTable)
            .filter_by(table_name=chart["table"], schema=SCHEMA, database_id=database.id)
            .one_or_none()
        )
        if dataset is None:
            dataset = SqlaTable(
                table_name=chart["table"], schema=SCHEMA, database=database
            )
            db.session.add(dataset)
            db.session.commit()
        try:
            dataset.fetch_metadata()
        except Exception as error:  # noqa: BLE001
            # A dataset with no columns still renders once the table exists;
            # failing the whole bootstrap over it would be worse.
            print(f"could not read columns for {chart['table']}: {error}")
        db.session.commit()

        slc = (
            db.session.query(Slice)
            .filter_by(slice_name=chart["slice_name"])
            .one_or_none()
        )
        if slc is None:
            slc = Slice(slice_name=chart["slice_name"])
            db.session.add(slc)
        slc.viz_type = "table"
        slc.datasource_type = "table"
        slc.datasource_id = dataset.id
        slc.params = chart_params(chart)
        db.session.commit()
        slices.append(slc)

    dashboard = (
        db.session.query(Dashboard)
        .filter_by(dashboard_title=DASHBOARD_TITLE)
        .one_or_none()
    )
    if dashboard is None:
        dashboard = Dashboard(dashboard_title=DASHBOARD_TITLE)
        db.session.add(dashboard)

    dashboard.slug = "psu-platform-operations"
    dashboard.slices = slices
    dashboard.published = True
    dashboard.position_json = position_json(slices)
    db.session.commit()

    print(
        f"Superset dashboard [{DASHBOARD_TITLE}] is configured with "
        f"{len(slices)} chart(s) over the ingestion control plane"
    )
