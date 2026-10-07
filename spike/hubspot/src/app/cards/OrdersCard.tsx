import { useEffect, useState } from 'react';
import {
  CrmContext,
  ErrorState,
  LoadingSpinner,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Text,
  hubspot,
} from '@hubspot/ui-extensions';

const API_BASE = 'https://ms-sync-spike.vercel.app';

interface Order {
  id: string;
  date: string;
  total: number;
  status: string;
}

hubspot.extend<'crm.record.tab'>(({ context }) => <OrdersCard context={context} />);

const OrdersCard = ({ context }: { context: CrmContext }) => {
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const url = `${API_BASE}/api/orders?contactId=${context.crm.objectId}`;
    hubspot
      .fetch(url, { method: 'GET' })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(`${res.status}: ${body.reason ?? 'request failed'}`);
        setOrders(body.orders);
      })
      .catch((e: Error) => setError(e.message));
  }, [context.crm.objectId]);

  if (error) {
    return (
      <ErrorState title="Could not load orders">
        <Text>{error}</Text>
      </ErrorState>
    );
  }
  if (!orders) return <LoadingSpinner label="Loading orders…" />;

  return (
    <>
      <Text variant="microcopy">Fictional demo data from the spike endpoint (signature verified).</Text>
      <Table bordered>
        <TableHead>
          <TableRow>
            <TableHeader>Order</TableHeader>
            <TableHeader>Date</TableHeader>
            <TableHeader>Total</TableHeader>
            <TableHeader>Status</TableHeader>
          </TableRow>
        </TableHead>
        <TableBody>
          {orders.map((o) => (
            <TableRow key={o.id}>
              <TableCell>{o.id}</TableCell>
              <TableCell>{o.date}</TableCell>
              <TableCell>${o.total.toFixed(2)}</TableCell>
              <TableCell>{o.status}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </>
  );
};
