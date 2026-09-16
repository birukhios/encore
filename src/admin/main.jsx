import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/manrope';
import '../styles.css';
import AdminApp from './AdminApp';
import { setApiBase } from '../shared/api';

setApiBase('/admin/api/');

createRoot(document.getElementById('root')).render(<React.StrictMode><AdminApp /></React.StrictMode>);
