import { useMemo } from 'react';
import { RouterProvider } from 'react-router-dom';
import { useTheme } from '@/hooks/useTheme';
import { useAccentColor } from '@/hooks/useAccentColor';
import { createRouter } from './router';

export function App() {
  // Shared appearance hooks: theme class and accent colour
  useTheme();
  useAccentColor();
  const router = useMemo(() => createRouter(), []);
  return <RouterProvider router={router} />;
}
