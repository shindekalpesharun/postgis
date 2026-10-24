# Local development and Docker notes

Docker Compose runs the Next.js frontend, Express/Prisma backend, PostgreSQL
with PostGIS, and pgAdmin. Service ports are bound to `127.0.0.1`, so they are
accessible from this machine but not exposed to other machines on the network.

## Requirements

- Docker Desktop (or Docker Engine) with the Compose plugin
- Ports `3000`, `5050`, `5432`, and `8000` available, unless overridden below

Run all commands in this guide from the project root.

## First start

```sh
docker compose up --build -d
```

This builds the frontend and backend images, downloads the PostgreSQL/PostGIS
and pgAdmin images, initializes the database, and starts all services in the
background. The first build and database initialization can take a few minutes.
The initialization script creates the `roads` and `potholes` tables, spatial
indexes, and a small Pune sample dataset when the database volume is empty.
To create the larger Maharashtra demo dataset afterward, see
[Generate dummy roads and potholes](#generate-dummy-roads-and-potholes).

To follow startup logs:

```sh
docker compose logs -f
```

Stop following logs with `Ctrl+C`; this does not stop the services.

## Build and run commands

| Task | Command |
| --- | --- |
| Check Compose configuration | `docker compose config --quiet` |
| Build images without starting services | `docker compose build` |
| Build and start/update all services | `docker compose up --build -d` |
| Start existing images | `docker compose up -d` |
| Rebuild only the backend | `docker compose build backend && docker compose up -d backend` |
| Rebuild only the frontend | `docker compose build frontend && docker compose up -d frontend` |
| Show service status and health | `docker compose ps` |
| Follow logs for one service | `docker compose logs -f backend` |
| Restart one service | `docker compose restart backend` |
| Stop services, keep data | `docker compose down` |

After editing application source, rebuild the corresponding service with
`docker compose up --build -d backend` or `docker compose up --build -d frontend`.
The Docker images run production builds; for source hot reload, use the local
development commands below.

## Service addresses

| Service | Address |
| --- | --- |
| Frontend | http://localhost:3000 |
| Backend health | http://localhost:8000/api/health |
| PostGIS connection test | http://localhost:8000/api/db-test |
| pgAdmin | http://localhost:5050 |

The database itself listens on `localhost:5432`.

## Database access

### Postico 2

Create a PostgreSQL connection with these local development settings:

- Host: `localhost`
- Port: `5432`
- Database: `postgis`
- User: `postgis`
- Password: `postgis_local_dev_password`
- SSL: disabled

### pgAdmin

Open http://localhost:5050 and sign in with:

- Email: `admin@postgis.dev`
- Password: `pgadmin_local_dev_password`

Register a server using host `db`, port `5432`, database `postgis`, user
`postgis`, and password `postgis_local_dev_password`. Use `db` as the host
inside pgAdmin because it connects to PostgreSQL over Docker's private Compose
network. Use `localhost` from desktop database clients such as Postico 2.

## Configuration and environment files

The root Compose file has local-development defaults and can be started without
an env file. To customize credentials or ports, copy the example first:

```sh
cp .env.example .env
```

Edit `.env` in the project root. It is ignored by Git. The root `.env` controls
the values Compose uses for containers. `backend/.env` is read only when
running the backend directly on your Mac; it should use `localhost` as the
database host, while the containerized backend uses the Compose service name
`db`.

To display the interactive Mapbox map, add a public Mapbox token to the root
`.env`:

```dotenv
NEXT_PUBLIC_MAPBOX_TOKEN=pk.your_public_token
```

Then rebuild the frontend with `docker compose up --build -d frontend`. For
local frontend development, set `NEXT_PUBLIC_MAPBOX_TOKEN` in
`frontend/.env.local` and restart the Next.js dev server. Use a public `pk.`
token; do not put a secret `sk.` token in frontend configuration.

Keep `POSTGRES_PASSWORD` URL-safe (letters, numbers, `_`, or `-`) because
Compose inserts it into the backend's `DATABASE_URL`. If you change database
credentials after the database volume has already been initialized, changing
the env file alone does not change the password stored inside PostgreSQL; use
SQL to update the role password or deliberately recreate the database volume.

The default credentials are for local development only. Do not expose these
ports or use these defaults for a public or production database.

If a port is already in use, change the corresponding root `.env` setting:
`FRONTEND_PORT`, `BACKEND_PORT`, `POSTGRES_PORT`, or `PGADMIN_PORT`.

## Local development without a containerized app

To run the frontend/backend on your Mac while keeping PostgreSQL in Docker:

```sh
docker compose up -d db
cd backend && npm run dev
```

In a separate terminal, run:

```sh
cd frontend && npm run dev
```

The backend's `backend/.env` should point to
`postgresql://postgis:postgis_local_dev_password@localhost:5432/postgis?schema=public`.

## Prisma and database initialization

The Prisma client is generated during the backend image build. After adding
or changing models in `backend/prisma/schema.prisma`, apply the schema to the
running local database with:

```sh
docker compose exec backend npx prisma db push
```

For backend development running directly on your Mac:

```sh
cd backend
npm run db:generate
npm run db:push
```

`db:push` applies the Prisma schema but does not create migration history. For
production or a team workflow, use reviewed Prisma migrations instead.

## Generate dummy roads and potholes

The backend includes a script that fills the database to target totals of
10,000 roads and 100,000 potholes across Maharashtra's approximate geographic
extent (longitude `72.6`–`80.9`, latitude `15.6`–`22.1`). This uses a bounding
box, not an exact state-boundary polygon, so some generated points may fall
outside Maharashtra. Roads are generated as short lines. Potholes are placed
near roads and assigned low, medium, or high severity. Potholes are inserted
in batches of 25,000 with progress output to keep large runs manageable.

```sh
docker compose exec backend npm run db:seed:dummy
```

Pass custom road and pothole target totals, in that order:

```sh
docker compose exec backend npm run db:seed:dummy -- 5000 25000
```

If running the backend tools directly on your Mac, run the command from the
backend directory instead:

```sh
cd backend
npm run db:seed:dummy -- 5000 25000
```

The numbers are target totals, not additional rows. Running the command again
does not add more if the targets have already been reached. It never deletes
existing rows by default.

At zoom 6 and below, map tiles use a precomputed grid to avoid aggregating the
full pothole table for every tile request. Zoom levels 7 and above show every
pothole as an individual point. The seeder refreshes the grid after adding
potholes. To create or refresh the grid for an existing database without adding
data, run this once:

```sh
docker compose exec backend npm run db:seed:dummy -- --refresh-map-clusters 0 0
```

This scans existing potholes once; subsequent zoom 6-and-below tile requests use
the indexed grid. Newly inserted rows are included automatically when you run
the seeder again.

To replace data generated by older versions of this script (Pune and
India-wide dummy roads, plus the five sample roads) and regenerate the defaults
across Maharashtra, explicitly pass `--reset-generated`:

```sh
docker compose exec backend npm run db:seed:dummy -- --reset-generated 10000 100000
```

This deletes potholes associated with those generated/sample roads and the
roads themselves before reseeding. When every road and pothole in the database
belongs to the recognized generated/sample data, reset uses `TRUNCATE` for
faster cleanup. Otherwise, it selectively deletes linked generated data and
preserves unrelated roads and unassigned potholes. Review this destructive
option carefully before running it.

## Map tiles

The backend serves PostGIS-generated Mapbox Vector Tiles at
`/api/tiles/{z}/{x}/{y}` and summary counts at `/api/stats`. The frontend
proxies these through same-origin Next.js routes, so the browser does not need
direct database or container-network access. Tiles include pothole point
features for the requested map viewport instead of sending all points to the
browser at once. At zoom 6 and below, the backend aggregates points into
severity-colored grid clusters; individual potholes are returned from zoom 7
through 22. Populated tile responses can be cached for five minutes.

## Data persistence, backup, and reset

PostgreSQL files and pgAdmin settings are stored in the named Docker volumes
`postgres_data` and `pgadmin_data`. Stopping or recreating containers does not
delete these volumes.

Postgres runs files in `docker/postgres/init.sql` only when initializing an
empty data directory. Editing that SQL does not change a database volume that
already exists. If the database is empty after a Docker reset, start the stack
with `docker compose up --build -d` and check initialization with
`docker compose logs db`. Do not use `docker compose down -v` unless you intend
to delete all persisted database and pgAdmin data.

If the database container is already running but the tables are missing, apply
the initialization SQL manually from the project root:

```sh
docker compose exec -T db psql -v ON_ERROR_STOP=1 -U postgis -d postgis < docker/postgres/init.sql
```

This creates the schema and adds five sample roads and ten sample potholes.
To add the larger Maharashtra demo dataset afterward, run
`docker compose exec backend npm run db:seed:dummy`.

To make a database backup on your Mac:

```sh
docker compose exec -T db pg_dump -U postgis -d postgis > postgis-backup.sql
```

Restore a backup into the local database with:

```sh
cat postgis-backup.sql | docker compose exec -T db psql -U postgis -d postgis
```

To remove containers and **all database and pgAdmin data**:

```sh
docker compose down -v
```

This is destructive. Do not use `-v` unless you intend to permanently delete
the local data.

## Troubleshooting

- Check whether all services are running: `docker compose ps`.
- Read an error log: `docker compose logs --tail=100 db` (replace `db` with
  `backend`, `frontend`, or `pgadmin` as appropriate).
- If a port is busy, change its port setting in the root `.env`, then run
  `docker compose up -d`.
- If the backend cannot connect, check that the database is healthy and that
  the backend container uses `db:5432`. A backend running directly on your Mac
  must instead use `localhost:5432`.
- PostGIS is enabled by `docker/postgres/init.sql` when a new database volume
  is initialized. The existing `/api/db-test` endpoint checks both the
  database connection and PostGIS extension.
