import React, { Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/manrope';
import '../styles.css';
import AdminApp from './AdminApp';
import { setApiBase } from '../shared/api';
import { Spinner } from '../shared/ui';

setApiBase('/admin/api/');

// Encore's own operators use a separate console at /admin/platform with its own sign-in.
const PlatformApp = lazy(() => import('./PlatformApp'));
const platform = location.pathname === '/admin/platform' || location.pathname.startsWith('/admin/platform/');

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {platform
      ? <Suspense fallback={<div className="loading"><Spinner />Opening Encore Platform…</div>}><PlatformApp /></Suspense>
      : <AdminApp />}
  </React.StrictMode>,
);
