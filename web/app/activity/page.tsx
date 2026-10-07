// Public, read-only sync activity (R11): IDs and outcomes only, never names or emails.
import { db, type SyncLogRow } from '@/lib/db';
import { log } from '@/lib/log';

export const dynamic = 'force-dynamic';

export default async function Activity() {
  const store = db();
  let rows: SyncLogRow[];
  let dead: number;
  try {
    [rows, dead] = await Promise.all([store.recentLog(50), store.rpc<number>('dead_job_count')]);
  } catch (err) {
    log('activity_failed', { error: (err as Error).message });
    return (
      <main>
        <h1>Sync activity</h1>
        <p role="alert">The activity log is unavailable right now. Try again in a minute.</p>
      </main>
    );
  }

  return (
    <main>
      <h1>Sync activity</h1>
      <p className="muted">
        The last 50 sync events between HubSpot and the Supabase database. &ldquo;Own write (echo)&rdquo; marks
        webhooks caused by the integration itself, which are deliberately ignored to prevent loops.
      </p>
      <p>
        Parked jobs needing attention: <strong>{dead}</strong>
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Time (UTC)</th>
              <th scope="col">Direction</th>
              <th scope="col">Action</th>
              <th scope="col">Outcome</th>
              <th scope="col">Object ID</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{r.at.slice(0, 19).replace('T', ' ')}</td>
                <td>{r.direction}</td>
                <td>{r.action}</td>
                <td>{r.outcome}</td>
                <td>{r.object_id ?? '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={5}>No sync activity yet.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
