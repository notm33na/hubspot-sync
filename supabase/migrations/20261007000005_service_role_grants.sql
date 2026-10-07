-- The server (service_role) needs explicit privileges: this project does not grant them by default.
-- anon / authenticated stay locked out (see 20261007000001_core.sql).

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;

-- Triggers and RPCs run as the caller, so the caller needs the private helpers they call.
grant usage on schema private to service_role;
grant execute on all functions in schema private to service_role;
alter default privileges in schema private grant execute on functions to service_role;
