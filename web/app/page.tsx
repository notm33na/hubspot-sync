import { PRODUCTS } from '@/lib/form';
import { DemoForm } from './DemoForm';

export default function Home() {
  const products = Object.entries(PRODUCTS).map(([id, p]) => ({ id, label: `${p.label} ($${p.unitPrice} each)` }));
  return (
    <main>
      <h1>Request a quote</h1>
      <p className="muted">
        Submitting creates (or reuses) a contact and a deal in HubSpot. The contact then syncs to the Supabase
        order database, and its orders appear on the HubSpot contact record.
      </p>
      <DemoForm products={products} />
    </main>
  );
}
