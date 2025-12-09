import { useState, useEffect, useRef } from 'react';

/**
 * Returns a throttled version of the value that updates at most once per interval
 * @param value - The value to throttle
 * @param interval - Minimum ms between updates (default: 100ms)
 */
export function useThrottledValue<T>(value: T, interval: number = 100): T {
  const [throttledValue, setThrottledValue] = useState<T>(value);
  const lastUpdateRef = useRef<number>(Date.now());
  const pendingUpdateRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const now = Date.now();
    const timeSinceLastUpdate = now - lastUpdateRef.current;

    if (timeSinceLastUpdate >= interval) {
      // Update immediately if enough time has passed
      setThrottledValue(value);
      lastUpdateRef.current = now;
    } else {
      // Schedule update for later
      if (pendingUpdateRef.current) {
        clearTimeout(pendingUpdateRef.current);
      }

      pendingUpdateRef.current = setTimeout(() => {
        setThrottledValue(value);
        lastUpdateRef.current = Date.now();
        pendingUpdateRef.current = null;
      }, interval - timeSinceLastUpdate);
    }

    // Cleanup on unmount
    return () => {
      if (pendingUpdateRef.current) {
        clearTimeout(pendingUpdateRef.current);
      }
    };
  }, [value, interval]);

  // Always update to final value immediately when value stops changing
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setThrottledValue(value);
    }, interval);

    return () => clearTimeout(timeoutId);
  }, [value, interval]);

  return throttledValue;
}
