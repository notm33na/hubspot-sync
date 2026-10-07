import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Fernhill Supply Co. — HubSpot sync demo',
  description: 'Portfolio demo of a Supabase database and a custom front-end integrated with HubSpot CRM. Fictional company.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="page">
          <p role="note" className="note">
            <strong>Fictional demo company.</strong> Fernhill Supply Co. does not exist. All data here is synthetic.
          </p>
          <nav aria-label="Main">
            <a href="/">Request a quote</a>
            <a href="/activity">Sync activity</a>
          </nav>
          {children}
        </div>
      </body>
    </html>
  );
}
