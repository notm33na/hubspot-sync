import { useEffect, useState } from 'react';
import {
  Button,
  CrmContext,
  EmptyState,
  ErrorState,
  Flex,
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

const API_BASE = 'https://fernhill-order-sync.vercel.app';

interface Order {
  orderNumber: string;
  date: string;
  total: number;
  currency: string;
  status: string;
}

interface OrdersPage {
  orders: Order[];
  nextPage: number | null;
}

hubspot.extend<'crm.record.tab'>(({ context }) => <OrdersCard context={context} />);

const OrdersCard = ({ context }: { context: CrmContext }) => {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<OrdersPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setData(null);
    setError(null);
    hubspot
      .fetch(`${API_BASE}/api/card/orders?contactId=${context.crm.objectId}&page=${page}`, { method: 'GET' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`The order service answered ${res.status}.`);
        setData((await res.json()) as OrdersPage);
      })
      .catch((e: Error) => setError(e.message));
  }, [context.crm.objectId, page]);

  if (error) {
    return (
      <ErrorState title="Couldn't load orders">
        <Text>{error} Try again in a minute.</Text>
      </ErrorState>
    );
  }
  if (!data) return <LoadingSpinner label="Loading orders…" />;

  if (data.orders.length === 0 && page === 0) {
    return (
      <EmptyState title="No orders yet" layout="vertical">
        <Text>This contact has no orders in the Fernhill demo database.</Text>
      </EmptyState>
    );
  }

  const money = (o: Order) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: o.currency }).format(o.total);

  return (
    <Flex direction="column" gap="sm">
      <Text variant="microcopy">Fictional demo data from the Fernhill Supply Co. database (Supabase).</Text>
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
          {data.orders.map((o) => (
            <TableRow key={o.orderNumber}>
              <TableCell>{o.orderNumber}</TableCell>
              <TableCell>{o.date}</TableCell>
              <TableCell>{money(o)}</TableCell>
              <TableCell>{o.status}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Flex direction="row" gap="sm">
        <Button disabled={page === 0} onClick={() => setPage(page - 1)}>Newer</Button>
        <Button disabled={data.nextPage === null} onClick={() => setPage(page + 1)}>Older</Button>
      </Flex>
    </Flex>
  );
};
