// The two public pages: same content as before, and nothing from the database is rendered unescaped.
import { describe, expect, it } from 'vitest';
import { activityPage, escapeHtml, homePage } from './pages';

describe('pages', () => {
  it('escapes HTML', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('renders the quote form with every field, the four products and the honeypot', () => {
    const html = homePage();
    for (const name of ['firstName', 'lastName', 'email', 'product', 'quantity', 'message', 'website']) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html.match(/<option value="[a-z-]+">/g)).toHaveLength(4);
    expect(html).toContain('Oak shelving kit ($189 each)');
    expect(html).toContain('<div class="hp" aria-hidden="true">');
    expect(html).toContain("fetch('/api/form'");
  });

  it('renders activity rows escaped, with the parked-job count', () => {
    const html = activityPage({
      dead: 2,
      rows: [{ at: '2026-10-22T06:03:24.123Z', direction: 'system', action: 'daily', outcome: '<script>x</script>', object_id: null }],
    });
    expect(html).toContain('Parked jobs needing attention: <strong>2</strong>');
    expect(html).toContain('<td>2026-10-22 06:03:24</td><td>system</td><td>daily</td><td>&lt;script&gt;x&lt;/script&gt;</td><td>—</td>');
    expect(html).not.toContain('<script>x</script>');
  });

  it('shows the empty state and the unavailable state', () => {
    expect(activityPage({ dead: 0, rows: [] })).toContain('No sync activity yet.');
    expect(activityPage(null)).toContain('The activity log is unavailable right now.');
  });
});
