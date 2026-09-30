"""Create the dotBlue usage dashboard.

The dashboard answers the questions the DIIS team actually asked of the
dotBlue (LibreChat) deployment: what people use it for, when they use it, and
which population they belong to.

Every dataset behind it is an AGGREGATE published to polaris.published. No
chart can reach a user id, an e-mail address, a conversation title or a
message body, because those columns were never extracted -- see
config/nifi/scripts/dotblue_tables.json. Group and period cells covering
fewer than ten distinct users are suppressed in the extract itself, so a
single-person cell cannot be read back out of a difference between two charts.

Reads through Trino with user impersonation on, like every other dashboard
here, so the same OPA policy decides who may see it.

Idempotent. Re-running reconciles the datasets and the charts without
duplicating them.
"""

import json
import os
from urllib.parse import quote

from superset.app import create_app

DATABASE_NAME = "PSU Iceberg"
DASHBOARD_TITLE = "dotBlue Usage Analytics"
DASHBOARD_SLUG = "dotblue-usage"
SCHEMA = "published"

TRINO_PASSWORD = os.environ["SUPERSET_TRINO_PASSWORD"]

# Self-signed certificate from this stack: the transport is unverified, the
# identity is not.
ENGINE_EXTRA = json.dumps(
    {"engine_params": {"connect_args": {"http_scheme": "https", "verify": False}}}
)


def metric(column, label, aggregate="SUM"):
    return {
        "expressionType": "SIMPLE",
        "column": {"column_name": column},
        "aggregate": aggregate,
        "label": label,
        "optionName": f"metric_{column}_{aggregate.lower()}",
    }


# width is in Superset's 12-column grid; height is in its own row units.
CHARTS = [
    {
        "slice_name": "รวมบทสนทนาทั้งหมด",
        "table": "v_dotblue_conv_by_month",
        "viz_type": "big_number_total",
        "params": {"metric": metric("conversations", "บทสนทนา")},
        "width": 4,
        "height": 50,
    },
    {
        "slice_name": "รวมข้อความทั้งหมด",
        "table": "v_dotblue_conv_by_month",
        "viz_type": "big_number_total",
        "params": {"metric": metric("messages", "ข้อความ")},
        "width": 4,
        "height": 50,
    },
    {
        "slice_name": "ผู้ใช้ทั้งหมด",
        "table": "v_dotblue_user_by_group",
        "viz_type": "big_number_total",
        "params": {"metric": metric("users", "ผู้ใช้")},
        "width": 4,
        "height": 50,
    },
    {
        "slice_name": "ใช้งานตามชั่วโมง (เวลาไทย)",
        "table": "v_dotblue_conv_by_hour",
        "viz_type": "echarts_timeseries_bar",
        "params": {
            "x_axis": "hour_th",
            "metrics": [
                metric("conversations", "บทสนทนา"),
                metric("unique_users", "ผู้ใช้ที่ไม่ซ้ำ"),
            ],
            "groupby": [],
            "orientation": "vertical",
            "x_axis_sort_asc": True,
            "row_limit": 1000,
        },
        "width": 12,
        "height": 60,
    },
    {
        "slice_name": "แนวโน้มรายเดือน",
        "table": "v_dotblue_conv_by_month",
        "viz_type": "echarts_timeseries_bar",
        "params": {
            "x_axis": "month",
            "metrics": [
                metric("conversations", "บทสนทนา"),
                metric("unique_users", "ผู้ใช้ที่ไม่ซ้ำ"),
            ],
            "groupby": [],
            "orientation": "vertical",
            "x_axis_sort_asc": True,
            "row_limit": 1000,
        },
        "width": 12,
        "height": 60,
    },
    {
        "slice_name": "สัดส่วนกลุ่มผู้ใช้",
        "table": "v_dotblue_user_by_group",
        "viz_type": "pie",
        "params": {
            "groupby": ["user_group"],
            "metric": metric("users", "ผู้ใช้"),
            "row_limit": 100,
            "show_legend": True,
        },
        "width": 6,
        "height": 60,
    },
    {
        "slice_name": "ใช้งานรายวันในสัปดาห์",
        "table": "v_dotblue_conv_by_dow",
        "viz_type": "echarts_timeseries_bar",
        "params": {
            "x_axis": "dow_th",
            "metrics": [metric("conversations", "บทสนทนา")],
            "groupby": [],
            "orientation": "vertical",
            "row_limit": 100,
        },
        "width": 6,
        "height": 60,
    },
    {
        "slice_name": "กลุ่มผู้ใช้รายเดือน",
        "table": "v_dotblue_conv_by_group_month",
        "viz_type": "table",
        "params": {
            "query_mode": "raw",
            "all_columns": ["month", "user_group", "conversations", "unique_users"],
            "order_by_cols": ['["month", false]'],
            "row_limit": 500,
            "include_search": True,
        },
        "width": 6,
        "height": 60,
    },
    {
        "slice_name": "ผู้ใช้ใหม่รายเดือน",
        "table": "v_dotblue_user_cohort",
        "viz_type": "echarts_timeseries_bar",
        "params": {
            "x_axis": "signup_month",
            "metrics": [metric("new_users", "ผู้ใช้ใหม่")],
            "groupby": [],
            "orientation": "vertical",
            "x_axis_sort_asc": True,
            "row_limit": 500,
        },
        "width": 6,
        "height": 60,
    },
    {
        "slice_name": "ภาพรวมทุก collection",
        "table": "v_dotblue_collection_profile",
        "viz_type": "table",
        "params": {
            "query_mode": "raw",
            "all_columns": ["collection", "doc_count", "data_mb"],
            "order_by_cols": ['["doc_count", false]'],
            "row_limit": 100,
            "include_search": True,
        },
        "width": 6,
        "height": 60,
    },
    {
        "slice_name": "การใช้งานตาม endpoint และ preset",
        "table": "v_dotblue_conv_by_endpoint",
        "viz_type": "table",
        "params": {
            "query_mode": "raw",
            "all_columns": ["endpoint", "spec", "conversations"],
            "order_by_cols": ['["conversations", false]'],
            "row_limit": 200,
            "include_search": True,
        },
        "width": 6,
        "height": 60,
    },
    {
        "slice_name": "สัดส่วน provider และ role",
        "table": "v_dotblue_user_mix",
        "viz_type": "table",
        "params": {
            "query_mode": "raw",
            "all_columns": ["dimension", "value", "users"],
            "order_by_cols": ['["users", false]'],
            "row_limit": 100,
            "include_search": True,
        },
        "width": 6,
        "height": 60,
    },
]


def chart_params(chart):
    base = {"viz_type": chart["viz_type"], "row_limit": 1000}
    base.update(chart["params"])
    return json.dumps(base)


def query_context(chart, dataset, slice_id):
    """Persist the query alongside the chart.

    Without this the chart still draws in the browser -- the front end rebuilds
    the query from params -- but every headless caller (the /data API, alerts
    and reports, thumbnails) fails with "Chart has no query context saved".
    Building it here means the dashboard is verifiable from a script rather
    than only by eye.
    """
    params = chart["params"]
    viz = chart["viz_type"]

    if viz == "table":
        columns = list(params.get("all_columns", []))
        metrics = []
        # order_by_cols entries are JSON strings of [column, ascending].
        orderby = [tuple(json.loads(entry)) for entry in params.get("order_by_cols", [])]
    elif viz == "big_number_total":
        columns, metrics, orderby = [], [params["metric"]], []
    elif viz == "pie":
        columns = list(params.get("groupby", []))
        metrics = [params["metric"]]
        orderby = [(params["metric"], False)]
    else:  # echarts_timeseries_bar
        columns = ([params["x_axis"]] if params.get("x_axis") else []) + list(
            params.get("groupby", [])
        )
        metrics = list(params.get("metrics", []))
        orderby = []

    form_data = dict(chart_params_dict(chart))
    form_data["datasource"] = f"{dataset.id}__table"
    form_data["slice_id"] = slice_id

    return json.dumps(
        {
            "datasource": {"id": dataset.id, "type": "table"},
            "force": False,
            "queries": [
                {
                    "filters": [],
                    "extras": {"having": "", "where": ""},
                    "applied_time_extras": {},
                    "columns": columns,
                    "metrics": metrics,
                    "orderby": orderby,
                    "annotation_layers": [],
                    "row_limit": params.get("row_limit", 1000),
                    "series_limit": 0,
                    "order_desc": True,
                    "url_params": {},
                    "custom_params": {},
                    "custom_form_data": {},
                }
            ],
            "form_data": form_data,
            "result_format": "json",
            "result_type": "full",
        }
    )


def chart_params_dict(chart):
    base = {"viz_type": chart["viz_type"], "row_limit": 1000}
    base.update(chart["params"])
    return base


def position_json(entries):
    """Lay the charts out in rows, packing to Superset's 12-column grid."""
    position = {
        "DASHBOARD_VERSION_KEY": "v2",
        "ROOT_ID": {"type": "ROOT", "id": "ROOT_ID", "children": ["GRID_ID"]},
        "GRID_ID": {"type": "GRID", "id": "GRID_ID", "children": [], "parents": ["ROOT_ID"]},
        "HEADER_ID": {"type": "HEADER", "id": "HEADER_ID", "meta": {"text": DASHBOARD_TITLE}},
    }

    rows, current, used = [], [], 0
    for entry in entries:
        width = entry["chart"]["width"]
        if used + width > 12 and current:
            rows.append(current)
            current, used = [], 0
        current.append(entry)
        used += width
    if current:
        rows.append(current)

    for row_index, row in enumerate(rows, start=1):
        row_id = f"ROW-{row_index}"
        position["GRID_ID"]["children"].append(row_id)
        position[row_id] = {
            "type": "ROW",
            "id": row_id,
            "children": [],
            "parents": ["ROOT_ID", "GRID_ID"],
            "meta": {"background": "BACKGROUND_TRANSPARENT"},
        }
        for entry in row:
            slc, chart = entry["slice"], entry["chart"]
            chart_id = f"CHART-{slc.id}"
            position[row_id]["children"].append(chart_id)
            position[chart_id] = {
                "type": "CHART",
                "id": chart_id,
                "children": [],
                "parents": ["ROOT_ID", "GRID_ID", row_id],
                "meta": {
                    "chartId": slc.id,
                    "sliceName": slc.slice_name,
                    "uuid": str(slc.uuid),
                    "width": chart["width"],
                    "height": chart["height"],
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
    database.sqlalchemy_uri = (
        f"trino://superset:{quote(TRINO_PASSWORD, safe='')}@trino:8443/polaris"
    )
    database.extra = ENGINE_EXTRA
    database.impersonate_user = True
    database.expose_in_sqllab = True
    database.allow_ctas = False
    database.allow_cvas = False
    database.allow_dml = False
    db.session.commit()

    entries = []
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
            # A dataset with no columns still renders once the view exists;
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
        slc.viz_type = chart["viz_type"]
        slc.datasource_type = "table"
        slc.datasource_id = dataset.id
        slc.params = chart_params(chart)
        db.session.commit()
        # Needs slc.id, so it is set after the first commit.
        slc.query_context = query_context(chart, dataset, slc.id)
        db.session.commit()
        entries.append({"slice": slc, "chart": chart})

    dashboard = (
        db.session.query(Dashboard)
        .filter_by(dashboard_title=DASHBOARD_TITLE)
        .one_or_none()
    )
    if dashboard is None:
        dashboard = Dashboard(dashboard_title=DASHBOARD_TITLE)
        db.session.add(dashboard)

    dashboard.slug = DASHBOARD_SLUG
    dashboard.slices = [entry["slice"] for entry in entries]
    dashboard.published = True
    dashboard.position_json = position_json(entries)
    db.session.commit()

    print(
        f"Superset dashboard [{DASHBOARD_TITLE}] is configured with "
        f"{len(entries)} chart(s) over polaris.{SCHEMA}"
    )
