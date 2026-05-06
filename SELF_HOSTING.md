# Self-hosting Savoire

## Requirements

- Docker and Docker Compose
- A server with at least 1 GB RAM (2 GB recommended)
- Ports 5000 (API) and 8082 (web) open

## Quick start

```bash
git clone https://github.com/JleloupDev/Savoire.git
cd Savoire

# Copy and edit the environment file
cp .env.example .env
$EDITOR .env

# Start
docker compose up -d
```

The web interface is available at `http://<your-server>:8082`.

## Environment variables

Copy `.env.example` to `.env` and fill in the values:

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | Yes | Secret key for signing JWT tokens. Generate with `openssl rand -base64 48` |
| `JWT_ISSUER` | No | JWT issuer claim (default: `savoire-server`) |
| `JWT_AUDIENCE` | No | JWT audience claim (default: `savoire-client`) |
| `ALLOWED_ORIGIN_1` | No | Extra CORS origin to allow (e.g. `http://your-server:8082`) |

Generate a secure JWT secret:

```bash
openssl rand -base64 48
```

## Users

Users are declared in `docker-compose.yml` under the `api` service environment:

```yaml
- Users__0__Id=alice
- Users__0__DisplayName=Alice
- Users__0__DefaultVaultPath=/data/alice
- Users__0__PasswordHash=<bcrypt hash>
```

> There is no user management UI yet. Add users by editing `docker-compose.yml` and restarting the API container.

## Data

Vault data is stored in `.local/data/` on the host, mounted into the container at `/data`. Back up this directory to preserve your notes.

## Updating

```bash
git pull
docker compose build
docker compose up -d
```

## Swap

On servers with less than 4 GB RAM, add a swap file before building to avoid OOM kills during the frontend build:

```bash
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```
