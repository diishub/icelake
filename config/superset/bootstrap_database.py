from superset.app import create_app


app = create_app()
with app.app_context():
    from superset import db
    from superset.models.core import Database

    database = (
        db.session.query(Database).filter_by(database_name="PSU Iceberg").one_or_none()
    )
    if database is None:
        database = Database(database_name="PSU Iceberg")
        db.session.add(database)

    database.sqlalchemy_uri = "trino://superset@trino:8080/polaris"
    database.impersonate_user = True
    database.expose_in_sqllab = True
    database.allow_ctas = False
    database.allow_cvas = False
    database.allow_dml = False
    db.session.commit()

    print("Superset database PSU Iceberg is configured with user impersonation")
