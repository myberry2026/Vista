import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

// Global error logging for better debuggability of white screen issues
window.onerror = (message, source, lineno, colno, error) => {
  console.error('[TourGuide] Global Error:', message, 'at', source, lineno, ':', colno, error);
};

window.onunhandledrejection = (event) => {
  console.error('[TourGuide] Unhandled Promise Rejection:', event.reason);
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
