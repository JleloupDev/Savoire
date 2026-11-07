# SPDX-License-Identifier: AGPL-3.0-or-later
# SPDX-FileCopyrightText: 2026 Jean Leloup
#
# Prepare GlitchTip (suivi des erreurs) pour Savoire, sans clic. Relance sans
# risque : ce qui existe est retrouve, rien n'est cree deux fois.
#
#  - le compte administrateur (ADMIN_EMAIL, GLITCHTIP_ADMIN_PASSWORD) ;
#  - l'organisation « Savoire » et trois projets : web (appli web et bureau),
#    api (serveur .NET), indexer (pair indexeur) ;
#  - dans OUT_DIR, ce que lisent l'API et le pair :
#      savoire-errors.json : ErrorReporting (DSN de l'API, DSN de l'appli,
#                            adresse interne de GlitchTip) ;
#      indexer-error-dsn   : DSN du pair.
#
# Lance par le service glitchtip-bootstrap (docker-compose.ops.yml) :
#   python manage.py shell --command "exec(open('/bootstrap/bootstrap.py').read())"
#
# Ne bloque jamais le demarrage de Savoire : en cas d'echec, un message, et
# l'API demarre sans suivi des erreurs.
import json
import os
import sys
import time


def main():
    from django.db import connection
    from django.db.migrations.executor import MigrationExecutor
    from django.db.utils import OperationalError, ProgrammingError

    # Le conteneur glitchtip applique ses migrations au demarrage : on attend
    # qu'il n'en reste aucune.
    for _ in range(120):
        try:
            executor = MigrationExecutor(connection)
            if not executor.migration_plan(executor.loader.graph.leaf_nodes()):
                break
        except (OperationalError, ProgrammingError):
            pass
        connection.close()
        time.sleep(5)
    else:
        raise RuntimeError("base de GlitchTip pas prete apres 10 minutes")

    # Table du cache (creee aussi par le conteneur glitchtip, apres ses migrations).
    from django.core.management import call_command
    call_command("createcachetable")

    from apps.organizations_ext.models import Organization
    from apps.projects.models import Project, ProjectKey
    from apps.users.models import User

    email = os.environ["ADMIN_EMAIL"].strip().lower()
    password = os.environ["GLITCHTIP_ADMIN_PASSWORD"]
    user = User.objects.filter(email=email).first()
    if user is None:
        user = User.objects.create_superuser(email=email, password=password)

    org = Organization.objects.filter(name="Savoire").first()
    if org is None:
        org = Organization.objects.create(name="Savoire")
    if not org.users.filter(pk=user.pk).exists():
        org.add_user(user)

    def key_of(name, platform):
        project = Project.objects.filter(organization=org, name=name).first()
        if project is None:
            project = Project.objects.create(organization=org, name=name, platform=platform)
        key = ProjectKey.objects.filter(project=project, is_active=True).order_by("created").first()
        if key is None:
            key = ProjectKey.objects.create(project=project)
        return project.pk, key.public_key_hex

    internal = os.environ.get("GLITCHTIP_INTERNAL_URL", "http://glitchtip:8000").rstrip("/")
    scheme, host = internal.split("://", 1)
    domain = os.environ["SAVOIRE_DOMAIN"].strip()

    web_id, web_key = key_of("web", "javascript-browser")
    api_id, api_key = key_of("api", "dotnet-aspnetcore")
    idx_id, idx_key = key_of("indexer", "node")

    # Courriel a chaque nouvelle erreur : GlitchTip previent les membres des
    # equipes du projet. Une equipe avec l'administrateur et les trois projets.
    from apps.alerts.constants import RecipientType
    from apps.alerts.models import AlertRecipient, ProjectAlert
    from apps.organizations_ext.models import OrganizationUser
    from apps.teams.models import Team

    team, _ = Team.objects.get_or_create(organization=org, slug="savoire")
    team.members.add(OrganizationUser.objects.get(organization=org, user=user))
    for project in Project.objects.filter(organization=org, name__in=["web", "api", "indexer"]):
        team.projects.add(project)
        alert = ProjectAlert.objects.filter(project=project, name="Nouvelle erreur").first()
        if alert is None:
            alert = ProjectAlert.objects.create(project=project, name="Nouvelle erreur", timespan_minutes=1, quantity=1)
        AlertRecipient.objects.get_or_create(alert=alert, recipient_type=RecipientType.EMAIL, url="")

    out = os.environ.get("OUT_DIR", "/out")
    environment = os.environ.get("ERROR_ENVIRONMENT", "production")
    config = {
        "ErrorReporting": {
            # Le serveur parle a GlitchTip par le reseau interne.
            "ApiDsn": f"{scheme}://{api_key}@{host}/{api_id}",
            # L'appli envoie a l'API (tunnel) : l'hote du DSN n'est qu'une etiquette.
            "ClientDsn": f"https://{web_key}@{domain}/{web_id}",
            "Upstream": internal,
            "Environment": environment,
        }
    }
    write(os.path.join(out, "savoire-errors.json"), json.dumps(config, indent=2) + "\n")
    write(os.path.join(out, "indexer-error-dsn"), f"{scheme}://{idx_key}@{host}/{idx_id}\n")
    print(f"GlitchTip pret : projets web {web_id}, api {api_id}, indexer {idx_id}.")


def write(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(text)
    os.chmod(tmp, 0o644)
    os.replace(tmp, path)


try:
    main()
except Exception as err:  # noqa: BLE001 - jamais bloquant
    print(f"glitchtip-bootstrap : suivi des erreurs non prepare ({err}).", file=sys.stderr)
