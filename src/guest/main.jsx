import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/manrope';
import '../styles.css';
import GuestApp from './GuestApp';

createRoot(document.getElementById('root')).render(<React.StrictMode><GuestApp /></React.StrictMode>);
