'use client';

import dynamic from 'next/dynamic';
import { setApiBase } from '@encore/shared/api';

setApiBase('/admin/api/');
const AdminApp = dynamic(() => import('@encore/admin/AdminApp'), { ssr: false });
const PlatformApp = dynamic(() => import('@encore/admin/PlatformApp'), { ssr: false });
const OfflineBar = dynamic(() => import('@encore/shared/ui').then(m => m.OfflineBar), { ssr: false });

export default function AdminClient() {
  const platform = typeof location !== 'undefined' && location.pathname.startsWith('/admin/platform');
  return <>{platform ? <PlatformApp /> : <AdminApp />}<OfflineBar /></>;
}
