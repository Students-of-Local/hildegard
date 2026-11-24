// SPDX-License-Identifier: AGPL-3.0-only
import { expect, test } from '@playwright/test';
import { expectAccessible, expectCurlyQuotes, watchErrors } from './helpers.ts';

// The config closes the notice for every other test; this one starts as someone opening the Studio fresh.
test.use({ storageState: { cookies: [], origins: [] } });

test('the owner sees that Hildegard moved to Local Studio, once', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  const notice = page.getByRole('complementary', { name: 'Hildegard is now a Local Studio plugin' });
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('Hildegard is now a Local Studio plugin.');
  await expect(notice.getByRole('link', { name: 'How to switch' })).toHaveAttribute(
    'href',
    /docs\/local-studio\.md#moving-from-the-hildegard-app$/,
  );
  await expectAccessible(page, 'move notice');
  await expectCurlyQuotes(page, 'move notice');

  await notice.getByRole('button', { name: 'Close' }).click();
  await expect(notice).toHaveCount(0);
  await page.reload();
  await expect(page.locator('.hg-app')).toBeVisible();
  await expect(notice).toHaveCount(0);
  expect(errors).toEqual([]);
});
