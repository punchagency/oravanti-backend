# Docker

This repository includes a local Docker setup for the Express API plus Supabase Auth and Storage:

- Express API: http://localhost:3000
- Supabase Auth gateway: http://localhost:54321/auth/v1
- Supabase Storage gateway: http://localhost:54321/storage/v1
- Postgres: localhost:54322

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

Remove local database and storage data:

```sh
docker compose down -v
```

The Compose file uses development-only Supabase JWT keys and a development Postgres password. Replace those values before using this outside local development.

The local Storage setup creates the `avatars` and `documents` buckets used by the API.

Service environment is split by container:

- API: `.env`
- Auth: `.env.auth`
- PostgREST: `.env.rest`
- Storage: `.env.storage`
- Storage bucket bootstrap: `.env.create-storage-buckets`
- Kong: `.env.kong`
- Postgres: `.env.db`
- Database bootstrap: `.env.db-bootstrap`

Each service env file has a matching `.example` file describing its values.

The API continues to use the existing `.env` file. For the API to talk to this local Docker stack, its database and Supabase values should point at container hostnames, for example:

```sh
DATABASE_URL=postgresql://postgres:postgres@db:5432/postgres
PROD_DATABASE_URL=postgresql://postgres:postgres@db:5432/postgres
SUPABASE_URL=http://kong:8000
SUPABASE_ANON_KEY=<same value as ANON_KEY in .env.storage>
SUPABASE_SERVICE_ROLE_KEY=<same value as SERVICE_KEY in .env.storage>
```
