# Shared helper for bash scripts: read one value from .env.local (parsed, never executed as shell).
# Usage (after `ROOT=` is set):  . "$ROOT/scripts/lib/read-env.sh";  VALUE="$(read_env NAME)"

# Git Bash paths (/d/...) mean nothing to Node on Windows; convert when cygpath exists.
NODE_ROOT="$(cygpath -m "$ROOT" 2>/dev/null || echo "$ROOT")"

read_env() {
  node --input-type=module -e "
    const { pathToFileURL } = await import('node:url');
    const { readEnvFile } = await import(pathToFileURL(process.argv[1]).href);
    const v = readEnvFile(process.argv[2])[process.argv[3]];
    if (!v) { console.error(process.argv[3] + ' missing from .env.local'); process.exit(1); }
    process.stdout.write(v);" "$NODE_ROOT/scripts/lib/env-file.mjs" "$NODE_ROOT/.env.local" "$1"
}
