-- 檢查 migration 是否都跑過（自動產生，不要手改）：
--   node worker/tools/gen-migration-check.mjs
-- 用法：整段貼到 Cloudflare D1 Console（imagepicker-db）執行。只讀，不會改任何資料。
-- 結果是空的（0 列）= 全部都跑過了。
-- 每一列是一個缺少的項目；from_file = 要去 D1 Console 逐條執行的 worker/migrations/ 檔案
-- （schema.sql = 基本表，或只寫在 worker/schema.sql 的索引：索引可直接複製 schema.sql 裡那一行
--   CREATE INDEX IF NOT EXISTS … 執行；缺「表」請先問開發者，不要自己建）。
-- 表不存在時只列「表」，不再列它的欄位。
-- 檢查項目：28 張表、41 個 ALTER 欄位、24 個索引。
WITH expected(n, from_file, kind, tbl, name) AS (VALUES
  (1, 'schema.sql', 'table', 'users', NULL),
  (2, 'schema.sql', 'table', 'permissions', NULL),
  (3, 'schema.sql', 'table', 'sessions', NULL),
  (4, 'schema.sql', 'table', 'share_tokens', NULL),
  (5, 'schema.sql', 'index', 'share_tokens', 'idx_share_tokens_book'),
  (6, 'schema.sql', 'index', 'share_tokens', 'idx_share_tokens_user'),
  (7, '2026-09-27-guest-picking.sql', 'table', 'projects', NULL),
  (8, '2026-09-27-guest-picking.sql', 'table', 'pickers', NULL),
  (9, '2026-09-27-guest-picking.sql', 'table', 'selections', NULL),
  (10, '2026-09-27-guest-picking.sql', 'table', 'submissions', NULL),
  (11, '2026-09-27-guest-picking.sql', 'index', 'submissions', 'idx_submissions_project'),
  (12, '2026-09-27-guest-picking.sql', 'table', 'project_members', NULL),
  (13, '2026-09-27-guest-picking.sql', 'column', 'share_tokens', 'project_id'),
  (14, '2026-09-28-dashboard-settings.sql', 'column', 'projects', 'delivered_at'),
  (15, '2026-09-28-dashboard-settings.sql', 'table', 'studio_settings', NULL),
  (16, '2026-09-28-project-archive.sql', 'column', 'projects', 'archived_at'),
  (17, '2026-09-29-products-orders.sql', 'table', 'products', NULL),
  (18, '2026-09-29-products-orders.sql', 'index', 'products', 'idx_products_owner'),
  (19, '2026-09-29-products-orders.sql', 'table', 'product_options', NULL),
  (20, '2026-09-29-products-orders.sql', 'index', 'product_options', 'idx_options_product'),
  (21, '2026-09-29-products-orders.sql', 'table', 'orders', NULL),
  (22, '2026-09-29-products-orders.sql', 'index', 'orders', 'idx_orders_project'),
  (23, '2026-09-29-products-orders.sql', 'index', 'orders', 'idx_orders_owner_paid'),
  (24, '2026-09-29-products-orders.sql', 'table', 'order_items', NULL),
  (25, '2026-09-29-products-orders.sql', 'index', 'order_items', 'idx_items_order'),
  (26, '2026-09-29-products-orders.sql', 'table', 'platform_products', NULL),
  (27, '2026-09-29-products-orders.sql', 'index', 'platform_products', 'idx_platform_products_sort'),
  (28, '2026-09-29-products-orders.sql', 'table', 'platform_product_options', NULL),
  (29, '2026-09-29-products-orders.sql', 'index', 'platform_product_options', 'idx_platform_options_product'),
  (30, '2026-09-30-delivery.sql', 'column', 'projects', 'final_folders'),
  (31, '2026-09-30-delivery.sql', 'column', 'projects', 'allow_proof_download'),
  (32, '2026-09-30-extra-max.sql', 'column', 'projects', 'extra_max'),
  (33, '2026-09-30-extra-max.sql', 'column', 'studio_settings', 'default_extra_max'),
  (34, '2026-09-30-retouch-pins.sql', 'column', 'selections', 'marks'),
  (35, '2026-09-30-retouch-pins.sql', 'column', 'submissions', 'marks'),
  (36, '2026-10-04-client-confirm.sql', 'column', 'projects', 'client_confirmed_at'),
  (37, '2026-10-04-client-confirm.sql', 'column', 'projects', 'client_confirmed_by'),
  (38, '2026-10-04-client-confirm.sql', 'table', 'revision_requests', NULL),
  (39, '2026-10-04-client-confirm.sql', 'index', 'revision_requests', 'idx_revision_requests_project'),
  (40, '2026-10-06-product-max-pages.sql', 'column', 'platform_products', 'max_pages'),
  (41, '2026-10-06-product-min-pages.sql', 'column', 'platform_products', 'min_pages'),
  (42, '2026-10-07-product-bleed.sql', 'column', 'platform_products', 'bleed_mm'),
  (43, '2026-10-07-product-extra-page-price.sql', 'column', 'platform_products', 'extra_page_price'),
  (44, '2026-10-07-project-shoot-date.sql', 'column', 'projects', 'shoot_date'),
  (45, '2026-10-07-project-type.sql', 'column', 'projects', 'project_type'),
  (46, '2026-10-07-revision-pins.sql', 'column', 'revision_requests', 'marks'),
  (47, '2026-10-07-revision-pins.sql', 'column', 'revision_requests', 'finals'),
  (48, '2026-10-07-revision-pins.sql', 'column', 'revision_requests', 'message_auto'),
  (49, '2026-10-07-revision-pins.sql', 'table', 'revision_pins', NULL),
  (50, '2026-10-08-product-interests.sql', 'table', 'product_interests', NULL),
  (51, '2026-10-09-guest-orders.sql', 'column', 'orders', 'request_id'),
  (52, '2026-10-09-guest-orders.sql', 'column', 'orders', 'contact_name'),
  (53, '2026-10-09-guest-orders.sql', 'column', 'orders', 'contact_phone'),
  (54, '2026-10-09-guest-orders.sql', 'column', 'orders', 'contact_line'),
  (55, '2026-10-09-guest-orders.sql', 'column', 'orders', 'delivery_method'),
  (56, '2026-10-09-guest-orders.sql', 'column', 'orders', 'consent_version'),
  (57, '2026-10-09-guest-orders.sql', 'column', 'orders', 'contact_erased_at'),
  (58, '2026-10-09-guest-orders.sql', 'index', 'orders', 'idx_orders_request'),
  (59, '2026-10-09-guest-orders.sql', 'column', 'order_items', 'list_price'),
  (60, '2026-10-09-guest-orders.sql', 'column', 'order_items', 'layout'),
  (61, '2026-10-09-guest-orders.sql', 'column', 'studio_settings', 'transfer_info'),
  (62, '2026-10-10-pick-link-message.sql', 'column', 'studio_settings', 'pick_link_message'),
  (63, '2026-10-11-photographers.sql', 'table', 'photographers', NULL),
  (64, '2026-10-11-photographers.sql', 'table', 'photographer_sessions', NULL),
  (65, '2026-10-11-photographers.sql', 'index', 'photographer_sessions', 'idx_photographer_sessions_owner'),
  (66, '2026-10-11-photographers.sql', 'table', 'photographer_signups', NULL),
  (67, '2026-10-11-photographers.sql', 'index', 'photographer_signups', 'idx_photographer_signups_ip'),
  (68, '2026-10-11-photographers.sql', 'table', 'photographer_login_failures', NULL),
  (69, '2026-10-11-photographers.sql', 'index', 'photographer_login_failures', 'idx_photographer_login_failures_key'),
  (70, '2026-10-12-indexes.sql', 'index', 'pickers', 'idx_pickers_key'),
  (71, '2026-10-12-indexes.sql', 'index', 'share_tokens', 'idx_share_tokens_project'),
  (72, '2026-10-13-co-picking.sql', 'table', 'pick_invites', NULL),
  (73, '2026-10-13-co-picking.sql', 'index', 'pick_invites', 'idx_pick_invites_project'),
  (74, '2026-10-13-co-picking.sql', 'table', 'project_collaborators', NULL),
  (75, '2026-10-13-co-picking.sql', 'index', 'project_collaborators', 'idx_project_collaborators_project'),
  (76, '2026-10-13-co-picking.sql', 'table', 'pick_join_failures', NULL),
  (77, '2026-10-13-co-picking.sql', 'index', 'pick_join_failures', 'idx_pick_join_failures'),
  (78, '2026-10-14-product-category.sql', 'column', 'platform_products', 'category'),
  (79, '2026-10-15-photographer-must-change-password.sql', 'column', 'photographers', 'must_change_password'),
  (80, '2026-10-16-link-messages.sql', 'column', 'studio_settings', 'link_message_submitted'),
  (81, '2026-10-16-link-messages.sql', 'column', 'studio_settings', 'link_message_delivered'),
  (82, '2026-10-16-link-messages.sql', 'column', 'studio_settings', 'link_message_done'),
  (83, '2026-10-17-share-token-owner.sql', 'column', 'share_tokens', 'photographer_id'),
  (84, '2026-10-18-photographer-invites.sql', 'table', 'photographer_invites', NULL),
  (85, '2026-10-18-photographer-invites.sql', 'index', 'photographer_invites', 'idx_photographer_invites_code'),
  (86, '2026-10-18-photographer-invites.sql', 'index', 'photographer_invites', 'idx_photographer_invites_email'),
  (87, '2026-10-18-photographer-invites.sql', 'index', 'photographer_invites', 'idx_photographer_invites_used_by'),
  (88, '2026-10-20-project-events.sql', 'table', 'project_events', NULL),
  (89, '2026-10-20-project-events.sql', 'index', 'project_events', 'idx_project_events_project'),
  (90, '2026-10-21-proof-retention.sql', 'column', 'studio_settings', 'proof_retention_days'),
  (91, '2026-10-21-proof-retention.sql', 'column', 'projects', 'proof_retention_days'),
  (92, '2026-10-21-proof-retention.sql', 'column', 'projects', 'proofs_deleted_at'),
  (93, '2026-10-21-proof-retention.sql', 'column', 'projects', 'proofs_delete_next_at')
)
SELECT e.from_file AS from_file,
       CASE e.kind
         WHEN 'table' THEN '表 ' || e.tbl
         WHEN 'column' THEN '欄位 ' || e.tbl || '.' || e.name
         ELSE '索引 ' || e.name || '（' || e.tbl || '）'
       END AS missing
  FROM expected e
 WHERE CASE e.kind
         WHEN 'table' THEN NOT EXISTS (SELECT 1 FROM sqlite_master m WHERE m.type = 'table' AND m.name = e.tbl COLLATE NOCASE)
         WHEN 'column' THEN EXISTS (SELECT 1 FROM sqlite_master m WHERE m.type = 'table' AND m.name = e.tbl COLLATE NOCASE)
                        AND NOT EXISTS (SELECT 1 FROM pragma_table_info(e.tbl) p WHERE p.name = e.name COLLATE NOCASE)
         ELSE NOT EXISTS (SELECT 1 FROM sqlite_master m WHERE m.type = 'index' AND m.name = e.name COLLATE NOCASE)
       END
 ORDER BY e.n;
