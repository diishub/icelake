from bootstrap_users import load_account_specs
from superset.app import create_app


app = create_app()
with app.app_context():
    security = app.appbuilder.sm

    for username, password, _last_name, role_name in load_account_specs():
        user = security.find_user(username=username)
        if user is None:
            raise RuntimeError(f"Missing Superset dev account {username}")
        if not user.active:
            raise RuntimeError(f"Superset dev account {username} is inactive")

        actual_roles = {role.name for role in user.roles}
        if actual_roles != {role_name}:
            raise RuntimeError(
                f"Superset dev account {username} has roles {sorted(actual_roles)}, "
                f"expected only {role_name}"
            )

        authenticated_user = security.auth_user_db(username, password)
        if authenticated_user is None:
            raise RuntimeError(f"Local password verification failed for {username}")

        print(
            f"PASS Superset dev account {username}: "
            f"active, role={role_name}, password=verified"
        )
