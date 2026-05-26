create extension if not exists pgcrypto;
create extension if not exists "uuid-ossp";

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login password 'postgres';
  end if;

  if not exists (select 1 from pg_roles where rolname = 'supabase_storage_admin') then
    create role supabase_storage_admin login password 'postgres';
  end if;
end
$$;

alter role supabase_storage_admin with login password 'postgres' bypassrls;

grant anon, authenticated, service_role to authenticator;
create schema if not exists auth;
create schema if not exists storage;

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant usage on schema storage to anon, authenticated, service_role;
grant all privileges on schema public to service_role;
grant all privileges on schema auth to service_role;
grant all privileges on schema storage to service_role;
grant all privileges on schema storage to supabase_storage_admin;

grant all privileges on all tables in schema public to service_role;
grant all privileges on all tables in schema auth to service_role;
grant all privileges on all tables in schema storage to service_role;
grant all privileges on all tables in schema storage to supabase_storage_admin;
grant all privileges on all sequences in schema public to service_role;
grant all privileges on all sequences in schema auth to service_role;
grant all privileges on all sequences in schema storage to service_role;
grant all privileges on all sequences in schema storage to supabase_storage_admin;
grant all privileges on all functions in schema public to service_role;
grant all privileges on all functions in schema auth to service_role;
grant all privileges on all functions in schema storage to service_role;
grant all privileges on all functions in schema storage to supabase_storage_admin;

alter default privileges in schema public grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema auth grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema storage grant select, insert, update, delete on tables to anon, authenticated, service_role;
alter default privileges in schema storage grant all on tables to supabase_storage_admin;
alter default privileges in schema public grant usage, select on sequences to anon, authenticated, service_role;
alter default privileges in schema auth grant usage, select on sequences to anon, authenticated, service_role;
alter default privileges in schema storage grant usage, select on sequences to anon, authenticated, service_role;
alter default privileges in schema storage grant all on sequences to supabase_storage_admin;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema auth grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema storage grant execute on functions to anon, authenticated, service_role;
alter default privileges in schema storage grant all on functions to supabase_storage_admin;
