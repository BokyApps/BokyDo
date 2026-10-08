import {
  instanceStatusSchema,
  sessionInfoSchema,
  type AiFeature,
  type InstanceStatus,
  type PublicSettings,
  type SessionInfo,
  type SetupStatus,
} from '@bokydo/shared';
import { QueryClient, queryOptions } from '@tanstack/react-query';
import { api, ApiError } from './api.js';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

export const instanceQuery = queryOptions({
  queryKey: ['instance'],
  queryFn: async (): Promise<InstanceStatus> =>
    instanceStatusSchema.parse(await api('GET', '/api/v1/instance')),
});

/** The current session, or null when signed out. */
export const sessionQuery = queryOptions({
  queryKey: ['session'],
  queryFn: async (): Promise<SessionInfo | null> => {
    try {
      return sessionInfoSchema.parse(await api('GET', '/api/v1/auth/session'));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return null;
      throw err;
    }
  },
});

export const setupQuery = queryOptions({
  queryKey: ['setup'],
  queryFn: () => api<SetupStatus>('GET', '/api/v1/setup'),
});

export const adminSettingsQuery = queryOptions({
  queryKey: ['admin', 'settings'],
  queryFn: () => api<PublicSettings>('GET', '/api/v1/admin/settings'),
});

/** The AI features this user can use right now. AI settings invalidate the same key after edits. */
export interface AiCatalog {
  policy: { userKeys: boolean; signIn: boolean; instance: boolean };
  available: AiFeature[];
}

export const aiCatalogQuery = queryOptions({
  queryKey: ['ai-catalog'],
  queryFn: () => api<AiCatalog>('GET', '/api/v1/ai/catalog'),
});
