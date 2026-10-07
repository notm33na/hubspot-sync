'use client';

import { useState, type FormEvent } from 'react';

type Result = { kind: 'ok' | 'err'; text: string } | null;

export function DemoForm({ products }: { products: { id: string; label: string }[] }) {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Result>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setResult(null);
    const body = Object.fromEntries(new FormData(e.currentTarget).entries());
    try {
      const res = await fetch('/api/form', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { errors?: Record<string, string>; error?: string; replayed?: boolean };
      if (res.ok) {
        setResult({
          kind: 'ok',
          text: data.replayed
            ? 'Already received: this exact request was submitted earlier, so nothing new was created.'
            : 'Thanks! A contact and a deal were created in the demo HubSpot account.',
        });
      } else if (data.errors) {
        setErrors(data.errors);
      } else {
        setResult({ kind: 'err', text: data.error ?? 'Something went wrong. Submitting again is safe.' });
      }
    } catch {
      setResult({ kind: 'err', text: 'Network error. Submitting again is safe.' });
    } finally {
      setBusy(false);
    }
  }

  const err = (name: string) =>
    errors[name] ? <span className="field-error" id={`${name}-error`}>{errors[name]}</span> : null;
  const describedBy = (name: string) => (errors[name] ? `${name}-error` : undefined);

  return (
    <form onSubmit={onSubmit} noValidate>
      <div className="row">
        <label>
          First name
          <input name="firstName" autoComplete="off" required aria-invalid={!!errors.firstName} aria-describedby={describedBy('firstName')} />
          {err('firstName')}
        </label>
        <label>
          Last name
          <input name="lastName" autoComplete="off" required aria-invalid={!!errors.lastName} aria-describedby={describedBy('lastName')} />
          {err('lastName')}
        </label>
      </div>
      <label>
        Email (must end in @example.com)
        <input name="email" type="email" placeholder="jordan@example.com" autoComplete="off" required
          aria-invalid={!!errors.email} aria-describedby={describedBy('email')} />
        {err('email')}
      </label>
      <div className="row">
        <label>
          Product
          <select name="product" defaultValue="" required aria-invalid={!!errors.product} aria-describedby={describedBy('product')}>
            <option value="" disabled>Choose…</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
          {err('product')}
        </label>
        <label>
          Quantity
          <input name="quantity" type="number" min={1} max={100} defaultValue={1} required
            aria-invalid={!!errors.quantity} aria-describedby={describedBy('quantity')} />
          {err('quantity')}
        </label>
      </div>
      <label>
        Message (optional)
        <textarea name="message" rows={3} maxLength={500} />
      </label>
      {/* Honeypot: hidden from people and assistive tech; bots tend to fill it. */}
      <div className="hp" aria-hidden="true">
        <label>
          Website
          <input name="website" tabIndex={-1} autoComplete="off" />
        </label>
      </div>
      <button type="submit" disabled={busy}>{busy ? 'Sending…' : 'Request quote'}</button>
      {result && (
        <p role="status" className={`result ${result.kind}`}>{result.text}</p>
      )}
    </form>
  );
}
