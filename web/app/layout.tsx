import type { ReactNode } from 'react';

export const metadata = {
  title: 'Fernhill Supply Co. — HubSpot sync demo',
  description: 'Portfolio demo of a Supabase database and a custom front-end integrated with HubSpot CRM. Fictional company.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: '24px 16px', maxWidth: 720, marginInline: 'auto', lineHeight: 1.5 }}>
        <p role="note" style={{ background: '#fff4d6', padding: '8px 12px', borderRadius: 6 }}>
          <strong>Fictional demo company.</strong> Fernhill Supply Co. does not exist. All data here is synthetic.
        </p>
        {children}
      </body>
    </html>
  );
}
