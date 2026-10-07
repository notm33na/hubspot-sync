// One JSON line per call: Vercel's log stream can drop later lines of a request, so callers
// log once per request or per job. Never pass names, emails, tokens or query strings.
export function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, ...fields }));
}
