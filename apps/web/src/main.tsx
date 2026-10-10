import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_PREFERENCES } from '@bokydo/shared';
import { applyAppearance, cachedAppearance } from './lib/appearance.js';
import { queryClient } from './lib/queries.js';
import { ReauthProvider } from './lib/reauth.js';
import { router } from './router.js';
import './index.css';
import { stashJoinToken } from './pages/SharingPages.js';
import { initI18n, rememberedLanguage, setLanguage } from './i18n.js';

// Before sign-in, use this device's last appearance (or the default) so screens don't flash.
applyAppearance(cachedAppearance() ?? DEFAULT_PREFERENCES.appearance);
// A /join#token link opened while signed out survives the trip through sign-in.
stashJoinToken();
// Same for language: this device's remembered choice (or the browser's) for the first paint.
void initI18n();
void setLanguage(rememberedLanguage());

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ReauthProvider>
        <RouterProvider router={router} />
      </ReauthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
