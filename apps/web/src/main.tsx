import { QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_PREFERENCES } from '@bokydo/shared';
import { applyAppearance, cachedAppearance, loadBaseFonts } from './lib/appearance.js';
import { queryClient } from './lib/queries.js';
import { ReauthProvider } from './lib/reauth.js';
import { router } from './router.js';
import { UpdatePrompt } from './components/UpdatePrompt.js';
import './index.css';
import { initI18n, rememberedLanguage, setLanguage } from './i18n.js';
import { stashJoinToken } from './lib/join.js';

// Finish loading the initial bundled face before rendering text. Subsequent changes keep the
// current face visible while the replacement loads, so no system-font flash is shown.
async function start() {
  await Promise.allSettled([
    applyAppearance(cachedAppearance() ?? DEFAULT_PREFERENCES.appearance),
    loadBaseFonts(),
  ]);
  // A /join#token link opened while signed out survives the trip through sign-in.
  stashJoinToken();
  void initI18n();
  void setLanguage(rememberedLanguage());
  const root = document.getElementById('root');
  if (!root) throw new Error('Missing #root element');
  createRoot(root).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <ReauthProvider>
          <RouterProvider router={router} />
          <UpdatePrompt />
        </ReauthProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
void start();
