export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const params = url.searchParams;
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, PUT, PATCH, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

    // ─── 相本書 API (/api/books/...) ─────────────────────────────
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts[0] === 'api' && pathParts[1] === 'books' && pathParts[2]) {
      const bookId = pathParts[2];

      // GET /api/books/:id — 讀取相本 JSON
      if (request.method === 'GET' && !pathParts[3]) {
        const obj = await env.imagepicker.get(`_books/${bookId}.json`);
        if (!obj) return new Response('Not found', { status: 404, headers: corsHeaders });
        return new Response(await obj.text(), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // PUT /api/books/:id — 完整儲存（需攝影師 token）
      if (request.method === 'PUT' && !pathParts[3]) {
        if (env.PHOTOGRAPHER_TOKEN) {
          const auth = request.headers.get('Authorization') || '';
          const token = auth.replace(/^Bearer\s+/i, '').trim();
          if (token !== env.PHOTOGRAPHER_TOKEN) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), {
              status: 401,
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            });
          }
        }
        await env.imagepicker.put(`_books/${bookId}.json`, await request.text(), {
          httpMetadata: { contentType: 'application/json' }
        });
        return new Response(JSON.stringify({ ok: true, id: bookId }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // PATCH /api/books/:id — 客人換照片（僅限未鎖定頁、開放資料夾）
      if (request.method === 'PATCH' && !pathParts[3]) {
        // 讀取書本
        const obj = await env.imagepicker.get(`_books/${bookId}.json`);
        if (!obj) return new Response('Not found', { status: 404, headers: corsHeaders });
        let book;
        try { book = JSON.parse(await obj.text()); }
        catch { return new Response('Invalid book data', { status: 500, headers: corsHeaders }); }

        let body;
        try { body = await request.json(); }
        catch { return new Response('Invalid request body', { status: 400, headers: corsHeaders }); }

        const { pageIndex, slots } = body;

        // 驗證頁碼
        if (typeof pageIndex !== 'number' || !book.pages?.[pageIndex]) {
          return new Response(JSON.stringify({ error: '無效的頁碼' }), {
            status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // 驗證未鎖定
        const page = book.pages[pageIndex];
        if (page.locked) {
          return new Response(JSON.stringify({ error: '此頁已鎖定，無法修改' }), {
            status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }

        // 驗證 photoId 在開放資料夾內
        const clientFolders = book.clientFolders || [];
        if (clientFolders.length > 0 && Array.isArray(slots)) {
          for (const slot of slots) {
            if (slot.photoId) {
              const allowed = clientFolders.some(f => slot.photoId.startsWith(f));
              if (!allowed) {
                return new Response(JSON.stringify({ error: `照片不在開放資料夾內` }), {
                  status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
                });
              }
            }
          }
        }

        // 只更新 photoId + crop，其他欄位不動
        if (Array.isArray(slots)) {
          slots.forEach((newSlot, idx) => {
            if (!page.slots[idx] || !newSlot) return;
            if (newSlot.photoId !== undefined) page.slots[idx].photoId = newSlot.photoId;
            if (newSlot.crop !== undefined) page.slots[idx].crop = newSlot.crop;
          });
        }

        // 存回 R2
        await env.imagepicker.put(`_books/${bookId}.json`, JSON.stringify(book), {
          httpMetadata: { contentType: 'application/json' }
        });

        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // GET /api/books/:id/status — 讀取批准狀態
      if (request.method === 'GET' && pathParts[3] === 'status') {
        const obj = await env.imagepicker.get(`_books/${bookId}_status.json`);
        const data = obj ? await obj.text() : JSON.stringify({ approved: false });
        return new Response(data, {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // POST /api/books/:id/approve — 客戶批准
      if (request.method === 'POST' && pathParts[3] === 'approve') {
        const status = { approved: true, timestamp: new Date().toISOString() };
        await env.imagepicker.put(`_books/${bookId}_status.json`, JSON.stringify(status), {
          httpMetadata: { contentType: 'application/json' }
        });

        // Webhook 通知攝影師
        const bookObj = await env.imagepicker.get(`_books/${bookId}.json`);
        if (bookObj) {
          try {
            const book = JSON.parse(await bookObj.text());
            if (book.notifyUrl) {
              await fetch(book.notifyUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  event: 'book_approved',
                  bookId,
                  bookName: book.name || '相本',
                  timestamp: status.timestamp,
                  message: `📸 客人已批准相本「${book.name || '相本'}」！`
                })
              });
            }
          } catch (e) { /* webhook 失敗不影響批准流程 */ }
        }

        return new Response(JSON.stringify({ ok: true }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      return new Response('Not found', { status: 404, headers: corsHeaders });
    }

    // ─── 圖片上傳 (PUT /:key, 需 Bearer Token) ───────────────────
    if (request.method === 'PUT') {
      if (env.PHOTOGRAPHER_TOKEN) {
        const auth = request.headers.get('Authorization') || '';
        const token = auth.replace(/^Bearer\s+/i, '').trim();
        if (token !== env.PHOTOGRAPHER_TOKEN) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          });
        }
      }
      // Support both /_assets/path (legacy) and /path directly
      let key = decodeURIComponent(url.pathname.slice(1));
      if (key.startsWith('_assets/')) key = key.slice('_assets/'.length);
      const contentType = request.headers.get('Content-Type') || 'image/jpeg';
      await env.imagepicker.put(key, request.body, { httpMetadata: { contentType } });
      return new Response(JSON.stringify({ ok: true, key }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ─── 列出檔案清單 (?list=路徑) ───────────────────────────────
    const listPrefix = params.get("list");
    if (listPrefix !== null) {
      try {
        const listed = await env.imagepicker.list({ prefix: listPrefix, delimiter: "/" });
        const files = listed.objects
          .filter(obj => /\.(jpg|jpeg|png|webp|avif)$/i.test(obj.key))
          .map(obj => ({
            id: obj.key,
            name: obj.key.split('/').pop(),
            size: obj.size,
            uploaded: obj.uploaded
          }));
        const folders = listed.delimitedPrefixes || [];
        return new Response(JSON.stringify({ status: "success", data: files, folders }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ status: "error", message: e.message }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // ─── 取得單張照片內容 (GET /:key) ────────────────────────────
    const key = decodeURIComponent(url.pathname.slice(1));
    if (key) {
      const object = await env.imagepicker.get(key);
      if (!object) return new Response("Object Not Found", { status: 404, headers: corsHeaders });
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      headers.set("Access-Control-Allow-Origin", "*");
      headers.set("Cache-Control", "public, max-age=31536000");
      return new Response(object.body, { headers });
    }

    return new Response("Invalid Request", { status: 400, headers: corsHeaders });
  }
};
