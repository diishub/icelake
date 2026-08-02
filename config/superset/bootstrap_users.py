import os

from superset.app import create_app


app = create_app()
with app.app_context():
    security = app.appbuilder.sm
    users = [
        (
            os.environ["PSU_ANALYST_USERNAME"],
            os.environ["PSU_ANALYST_PASSWORD"],
            "Analyst",
            "Alpha",
        ),
        (
            os.environ["PSU_VIEWER_USERNAME"],
            os.environ["PSU_VIEWER_PASSWORD"],
            "Viewer",
            "Gamma",
        ),
    ]
    for username, password, last_name, role_name in users:
        if security.find_user(username=username) is None:
            security.add_user(
                username=username,
                first_name="PSU",
                last_name=last_name,
                email=f"{username}@localhost",
                role=security.find_role(role_name),
                password=password,
            )
            print(f"Created local Superset user {username} with role {role_name}")
