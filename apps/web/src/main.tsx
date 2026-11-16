import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import './styles.css';
import { ToastProvider } from './lib/ui';
import CrmApp from './crm/App';
import PlatformApp from './platform/App';
import PartnerApp from './partner/Portal';
import { setBaseDomain } from './lib/api';

// In production the console lives at admin.hxgconnect.com and clients at
// {workspace}.hxgconnect.com; both are served by this one bundle.
const isAdminHost = location.hostname.startsWith('admin.');

document.documentElement.dataset.theme =
  localStorage.getItem('hxg.theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

async function boot() {
  try {
    const r = await fetch('/api/public/config');
    if (r.ok) setBaseDomain((await r.json()).base_domain ?? null);
  } catch { /* offline: run without a domain */ }

  createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <ToastProvider>
        <Routes>
          {isAdminHost
            ? (
              <>
                <Route path="/platform/*" element={<PlatformApp />} />
                <Route path="/*" element={<PlatformApp />} />
              </>
            )
            : (
              <>
                <Route path="/platform/*" element={<PlatformApp />} />
                <Route path="/partner/*" element={<PartnerApp />} />
                <Route path="/*" element={<CrmApp />} />
              </>
            )}
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  </StrictMode>,
  );
}
boot();
