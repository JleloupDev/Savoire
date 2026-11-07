# Installer Savoire sur un VPS

Sur une machine neuve (Debian 12 ou 13, Ubuntu 22.04 ou 24.04), en root :

```bash
curl -fsSL https://raw.githubusercontent.com/JleloupDev/Savoire/master/deploy/vps/install.sh -o install.sh
sudo bash install.sh
```

Tout est expliqué dans [SELF_HOSTING.md](../../SELF_HOSTING.md) : ce que fait
chaque script, Brevo, la copie hors machine, Grafana, GlitchTip, les alertes.
Les choix sont dans `docs/Architecture/ADR/ADR-029-exploitation.md`.
