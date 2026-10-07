import { useEffect } from 'react';

// Shared across hook instances: overlapping locks (a modal opening while
// another one is still leaving) must restore the body only on the last release.
let activeLocks = 0;
let unlockedStyle = { overflow: '', touchAction: '' };

/**
 * Hook to lock the body scroll whenever a component is mounted or
 * whenever isLocked is set to true.
 *
 * You can pass in true always to cause a lock on mount/dismount of the component
 * using this hook.
 *
 * @param isLocked Toggle the scroll lock
 * @param disabled Disables the entire hook (allows conditional skipping of the lock)
 */
export const useLockBodyScroll = (
  isLocked: boolean,
  disabled?: boolean
): void => {
  useEffect(() => {
    if (!isLocked || disabled) return;
    if (activeLocks++ === 0) {
      unlockedStyle = {
        overflow: document.body.style.overflow,
        touchAction: document.body.style.touchAction,
      };
      document.body.style.overflow = 'hidden';
      document.body.style.touchAction = 'none';
    }
    return () => {
      if (--activeLocks === 0) {
        document.body.style.overflow = unlockedStyle.overflow;
        document.body.style.touchAction = unlockedStyle.touchAction;
      }
    };
  }, [isLocked, disabled]);
};
