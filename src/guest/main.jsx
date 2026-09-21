import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/manrope';
import '../styles.css';
import GuestApp from './GuestApp';
import { ErrorBoundary, OfflineBar } from '../shared/ui';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary homeHref="/">
      <GuestApp />
      <OfflineBar />
    </ErrorBoundary>
  </React.StrictMode>,
);
