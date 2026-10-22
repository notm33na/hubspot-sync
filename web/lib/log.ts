// One JSON line per call (Workers Logs). Callers log once per request or per job, so a request's
// story stays in one line. Never pass names, emails, tokens or query strings.
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}
