# Docker

This repository includes a local Docker setup for the Express API plus Postgres.
Supabase Auth and Storage are expected to come from Supabase Cloud and are configured through the API `.env` file.

- Express API: http://localhost:3000
- Postgres: localhost:5432

Start everything:

```sh
docker compose up --build
```

Start the development API image with watch mode:

```sh
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

The development API bind-mounts this project into the container and runs `npm install` before `npm run dev`, so `node_modules` is populated on your local filesystem as well as inside the container.

Stop everything:

```sh
docker compose down
```

Remove local database data:

```sh
docker compose down -v
```

The Compose file uses a development Postgres password from `.env.db`. Replace it before using this outside local development.
Supabase Cloud should already have any buckets used by the API, such as `avatars` and `documents`.

Service environment is split by container:

- API: `.env`
- Postgres: `.env.db`

Each service env file has a matching `.example` file describing its values.

The API continues to use the existing `.env` file. For the API container to talk to local Postgres and Cloudflare R2, use values like:

```sh
DATABASE_URL=postgresql://postgres:password123@db:5432/postgres
PROD_DATABASE_URL=postgresql://postgres:password123@db:5432/postgres
R2_ACCOUNT_ID=<cloudflare-account-id>
R2_ACCESS_KEY_ID=<r2-access-key-id>
R2_SECRET_ACCESS_KEY=<r2-secret-access-key>
R2_BUCKET=<r2-bucket-name>
```
