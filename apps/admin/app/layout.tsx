import type { Metadata } from 'next';
import '@fontsource-variable/manrope';
import '../../../src/styles.css';
import './tailwind.css';
import { Badge } from '../components/ui/badge';

export const metadata: Metadata = { title: 'Encore — Organizer Admin', robots: 'noindex' };

export default function Layout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}<footer className="powered-by-afropay"><Badge>Powered by Afropay</Badge></footer></body></html>;
}
