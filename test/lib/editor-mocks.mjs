// The book editor / main picker Worker mock (mockWorker) and its photo list builder (PHOTOS).
// Shared by more than one file in test/suites/; helpers used by a single suite file stay in that file.
import { PIXEL } from './env.mjs';

export const PHOTOS = n => Array.from({ length: n }, (_, i) =>
  ({ id: `20260819/p${i}.jpg`, name: `p${i}.jpg`, size: 9e6, rating: 0 }));

// `image`: serve this instead of the 1x1 PIXEL (with CORS, so the preview
// canvas stays readable) — see BIG_PHOTO.
export function mockWorker(count, extraSettings = {}, image = null) {
  return async page => {
    await page.route('**/imagepicker.hotichen.workers.dev/**', route => {
      const u = new URL(route.request().url());
      if (u.pathname.endsWith('/status'))
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"approved":false}' });
      if (u.pathname.includes('/api/books/'))
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
          name: 'T', clientFolders: ['20260819/'],
          settings: { width: 57, height: 21, dpi: 300, ...extraSettings },
          coverSettings: { width: 20, height: 20, dpi: 300 },
          pages: [{ type: 'inner', layout: '2-up-h', textLayers: [],
            slots: [{ photoId: '20260819/p0.jpg', crop: { x: 0, y: 0, scale: 1 } },
                    { photoId: '20260819/p1.jpg', crop: { x: 0, y: 0, scale: 1 } }] }] }) });
      if (u.searchParams.has('list'))
        return route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ status: 'success', folders: [], data: PHOTOS(count) }) });
      if (image) return route.fulfill({ status: 200, contentType: 'image/png', body: image,
        headers: { 'Access-Control-Allow-Origin': '*' } });
      route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL });
    });
  };
}
