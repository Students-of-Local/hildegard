// SPDX-License-Identifier: AGPL-3.0-only
import { useLocal } from '../lib/hooks.ts';
import { Icon } from './ui.tsx';

/** Where the move is explained: what changes, what stays, and how to switch. */
export const MOVED_URL =
  'https://github.com/baney75/hildegard/blob/main/docs/local-studio.md#moving-from-the-hildegard-app';
export const MOVED_KEY = 'hildegard.movedToLocalStudio';

/**
 * Hildegard is now a plugin in Local Studio. The owner, on the computer Hildegard runs on, sees this until they close
 * it, once per browser. The Studio keeps working; the card only says where new work goes and links to how to switch.
 */
export function MovedNotice() {
  const [seen, setSeen] = useLocal(MOVED_KEY, false);
  if (seen) return null;
  return (
    <aside className="hg-moved" aria-label="Hildegard is now a Local Studio plugin">
      <Icon name="sparkle" size={18} />
      <p>
        <strong>Hildegard is now a Local Studio plugin.</strong> The Studio keeps working, and your projects,
        voices and models stay. New features go into the plugin.{' '}
        <a href={MOVED_URL} target="_blank" rel="noreferrer">
          How to switch
        </a>
      </p>
      <button
        type="button"
        className="hg-btn hg-btn--sm hg-btn--icon hg-btn--ghost"
        aria-label="Close"
        onClick={() => setSeen(true)}
      >
        <Icon name="close" size={16} />
      </button>
    </aside>
  );
}
