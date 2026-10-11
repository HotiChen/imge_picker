-- Product category (platform_products.category, Tim's choice C: a real column).
-- Paste into the D1 Console for imagepicker-db before merging the Worker that
-- reads and writes category. Two statements: run them one by one, in order.
-- Until 1 runs, every catalogue read, the photographer's product pages and the
-- guest shop keep working with category = null; only an operator create or
-- edit that sets a category (a non-empty string) answers 500
-- category_unavailable and writes nothing.
--
-- A short label the operator gives a platform product ('婚紗相本', '無框畫',
-- '桌框' …), at most 20 characters after trim; NULL = no category. Albums and
-- prints alike; operator only, shown to photographers and guests.

-- 1. The column. Not safe to re-run: a second run fails with "duplicate column
--    name: category", which means it already ran and can be ignored.
ALTER TABLE platform_products ADD COLUMN category TEXT;  -- ≤ 20 chars after trim; NULL = none

-- 2. Backfill from the description's header paragraph, e.g.
--    '【相本›婚紗相本】…' → '婚紗相本'. Takes the text after the first '›' up to
--    the first '】' (the description must start with '【' and the '】' must come
--    after the '›'); when it lists several ('婚紗相本、傳記相本') only the part
--    before the first '、'; trimmed. Skipped (stays NULL): no such header, an
--    empty result, more than 20 characters, or a line break / tab in it.
--    Only rows whose category IS NULL are touched, so re-running it is safe and
--    never overwrites a category the operator has set. The description itself
--    is left as it was.
UPDATE platform_products
   SET category = picked.c
  FROM (SELECT id, trim(CASE WHEN instr(t, '、') > 0 THEN substr(t, 1, instr(t, '、') - 1) ELSE t END) AS c
          FROM (SELECT id, substr(description, instr(description, '›') + 1,
                                  instr(description, '】') - instr(description, '›') - 1) AS t
                  FROM platform_products
                 WHERE description LIKE '【%›%】%'
                   AND instr(description, '】') > instr(description, '›'))) AS picked
 WHERE platform_products.id = picked.id
   AND platform_products.category IS NULL
   AND length(picked.c) BETWEEN 1 AND 20
   AND instr(picked.c, char(10)) = 0 AND instr(picked.c, char(13)) = 0 AND instr(picked.c, char(9)) = 0;
