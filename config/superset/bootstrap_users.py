import os
import re

from superset.app import create_app


ACCOUNT_SPECS = (
    ("PSU_ADMIN_USERNAME", "PSU_ADMIN_PASSWORD", "Administrator", "Admin"),
    ("PSU_ANALYST_USERNAME", "PSU_ANALYST_PASSWORD", "Analyst", "Alpha"),
    ("PSU_VIEWER_USERNAME", "PSU_VIEWER_PASSWORD", "Viewer", "Gamma"),
)


def required_environment(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def load_account_specs() -> list[tuple[str, str, str, str]]:
    accounts = []
    usernames = set()

    for username_variable, password_variable, last_name, role_name in ACCOUNT_SPECS:
        username = required_environment(username_variable)
        password = required_environment(password_variable)

        if not re.fullmatch(r"[A-Za-z0-9._-]+", username):
            raise RuntimeError(
                f"{username_variable} must contain only letters, numbers, dot, "
                "underscore, or hyphen"
            )
        if username in usernames:
            raise RuntimeError("Superset dev persona usernames must be distinct")
        if password.startswith("change-me"):
            raise RuntimeError(f"Replace the placeholder value in {password_variable}")

        usernames.add(username)
        accounts.append((username, password, last_name, role_name))

    return accounts


def reconcile_accounts() -> None:
    app = create_app()
    with app.app_context():
        security = app.appbuilder.sm

        for username, password, last_name, role_name in load_account_specs():
            role = security.find_role(role_name)
            if role is None:
                raise RuntimeError(f"Superset role {role_name} does not exist")

            user = security.find_user(username=username)
            if user is None:
                user = security.add_user(
                    username=username,
                    first_name="PSU",
                    last_name=last_name,
                    email=f"{username}@localhost",
                    role=role,
                    password=password,
                )
                if user is None:
                    raise RuntimeError(
                        f"Could not create Superset dev account {username}"
                    )
                action = "Created"
            else:
                user.first_name = "PSU"
                user.last_name = last_name
                user.email = f"{username}@localhost"
                user.active = True
                user.roles = [role]
                if security.update_user(user) is False:
                    raise RuntimeError(
                        f"Could not update Superset dev account {username}"
                    )
                security.reset_password(user.id, password)
                action = "Reconciled"

            if security.auth_user_db(username, password) is None:
                raise RuntimeError(
                    f"Could not authenticate reconciled Superset account {username}"
                )
            print(f"{action} Superset dev account {username} with role {role_name}")


if __name__ == "__main__":
    reconcile_accounts()
