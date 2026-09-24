'use client';

import dynamic from 'next/dynamic';

const GuestApp = dynamic(() => import('@encore/guest/GuestApp'), { ssr: false });
const OfflineBar = dynamic(() => import('@encore/shared/ui').then(m => m.OfflineBar), { ssr: false });

export default function GuestClient() { return <><GuestApp /><OfflineBar /></>; }
