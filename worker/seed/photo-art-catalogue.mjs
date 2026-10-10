// Platform catalogue seed: the printable products of the print lab's shop
// (印像網 / 大千精品影像, https://www.photo-art-1.com), read on 2026-10-10.
// Albums (相本) and frames (相框, 無框畫 and desk/wall frames) only; the shop's
// 謝卡 (9) and 婚用周邊 (15) are not seeded (see docs/catalogue-seed-photo-art-1.md).
//
// What this is and is not:
//   - Prices are the shop's 暖心價 (what a customer pays the shop). They are
//     used as BOTH vendor_cost and platform_price; Tim's real lab price may be
//     lower, so review before applying (the operator page edits both).
//   - The shop lists ONE price per product page. For the multi-size albums the
//     detail page shows the price of its first (largest) size and the category
//     list shows the smaller one; an option marked how:'inferred' is a price
//     paired from those two pages or from the size ladder of the 光遇 series
//     (6×8 $1380, 8×8 $1730, 8×11 $2350, 12×12 $3300). Such a product says
//     「價格待確認」 in its description.
//   - The shop publishes NO bleed and NO file resolution, so bleed_mm is not
//     set anywhere. Its two add-page prices (規格表 per size vs 加購區 per
//     page) disagree, so extra_page_price is not set either; both numbers sit
//     in the description. The shop's 「加頁上限 25P」 is ambiguous (total or
//     extra), so max_pages is not set. min_pages is the shop's 基本頁數 15P.
//   - The catalogue has no category column (kind is only print|album): the
//     category is the first thing in the description, and `sort` follows it.
//
// Every product is validated against the real operator route by
// worker/test/seed-photo-art-catalogue.test.mjs.

// subcategory (the shop's own names) → top category. Key order = sort order.
export const CATEGORIES = {
  '婚紗相本': '相本',
  '寶寶.成長相本': '相本',
  '旅遊.全家福相本': '相本',
  '傳記相本': '相本',
  '無框畫': '相框',
  '放大框': '相框',
  '桌框': '相框',
};

const W = '婚紗相本', BABY = '寶寶.成長相本', TRIP = '旅遊.全家福相本', BIO = '傳記相本';
const FRAME = '無框畫', BIG = '放大框', DESK = '桌框';

// o(size, price, dim, how): one sellable size. dim: an album's inside spread
// (cm) or a print's size; how: 'site' (the price the shop shows for it) or
// 'inferred' (paired from other shop pages, to be confirmed).
const o = (size, price, dim = '', how = 'site') => ({ size, price, dim, how });
const album = a => ({ kind: 'album', ...a });
const print = a => ({ kind: 'print', ...a });

export const PRODUCTS = [
  // ── 相本 › 婚紗相本 ───────────────────────────────────────────────────────
  print({ src: [562], subs: [W], name: '《獨家 換照框盒》12×12吋',
    opts: [o('12×12吋框盒', 1125)], mat: '藝術噴繪相紙／訂製黑卡',
    add: '相本加頁 $320/頁（加購可換照 8 折 $256）',
    note: '框盒可放 1 本 15P 相本＋可換照 6 張(12 面)，附贈 2 張；網站尺寸標 610×305mm 與 12×12 吋不符，待確認' }),
  album({ src: [578], subs: [W], name: '《透影》12×12吋 晶瑩透亮大封面',
    opts: [o('12×12吋', 3300, '61×30.5')], mat: '透影晶瑩大封面', colors: '白', cover: '未標示',
    add: '規格表 $160／加購區 $320', note: '贈框盒含可換照 2P' }),
  album({ src: [482], subs: [W], name: '《光遇》8×11吋',
    opts: [o('8×11吋', 2350, '39.8×28.4')], mat: '水晶封面、柯達原廠相紙、內頁PVC', colors: '白、黑', cover: '10.1×16cm',
    add: '規格表 $140／加購區 $280', note: '11×16吋已絕版完售' }),
  album({ src: [479], subs: [W], name: '《光遇》12×12吋',
    opts: [o('12×12吋', 3300, '61×30.5')], mat: '水晶封面、白金珠光相紙、內頁PVC', colors: '白', cover: '17.8×17.8cm',
    add: '規格表 $160／加購區 $320', note: '贈框盒含可換照 2P' }),
  album({ src: [477], subs: [W], name: '《愫》12×12吋',
    opts: [o('12×12吋', 3300, '61×30.5')], mat: '柯達原廠相紙、內頁PVC、10色微噴', colors: '白、灰、黑', cover: '13.5×13.5cm',
    add: '規格表 $160／加購區 $320' }),
  album({ src: [483], subs: [W], name: '《拾景》相本',
    opts: [o('8×11吋', 2350, '39.8×28.4'), o('12×12吋', 3300, '61×30.5', 'inferred')],
    mat: '水晶封面(裸空)、白金珠光相紙、內頁PVC', colors: '白、黑', cover: '請洽客服',
    add: '12×12 規格表 $160／8×11 $140／加購區 $280', note: '12×12 贈框盒含可換照 2P' }),
  album({ src: [57], subs: [W], name: '《水晶相本》多尺寸',
    opts: [o('6×8吋', 1380, '30.5×20.3'), o('8×8吋', 1730, '40.6×15.2', 'inferred'),
      o('8×11吋', 2350, '39.8×28.4'), o('12×12吋', 3300, '61×30.5', 'inferred')],
    mat: '水晶、原廠相片紙、內頁PVC', colors: '白、黑',
    cover: '6×8 15.3×20.7／8×8 20.3×20.7／8×11 19.6×28.4／12×12 30.5×31',
    add: '規格表 6×8 $80／8×8 $100／8×11 $140／12×12 $160／加購區 $280',
    other: '10×10吋(內頁 48.6×24.3cm，價格未知，未建立)；12×18、4×6 已停產' }),
  album({ src: [472], subs: [W], name: 'Memory《歡妍》相本 11×8吋 橫式',
    opts: [o('11×8吋 橫', 2350, '57.4×19.6')], mat: '水晶、柯達原廠相紙、內頁PVC', colors: '白、黑', cover: '28.2×19.4cm',
    add: '規格表 $140／加購區 $280' }),
  album({ src: [566], subs: [W], name: '《微恩》雙封面 8×11吋',
    opts: [o('8×11吋', 2350, '39.8×28.4')], colors: '白', cover: '12×22cm(請洽客服套版)',
    add: '$280/頁' }),
  album({ src: [564], subs: [W], name: '《浪漫時光》8×11吋',
    opts: [o('8×11吋', 2350, '39.8×28.4')], colors: '白', cover: '19.2×16.1cm',
    add: '規格表 $140／加購區 $280' }),
  album({ src: [527], subs: [W], name: '《喬樂絲》8×10吋',
    opts: [o('8×10吋', 2350, '40.6×25.8')], mat: '水晶布料、內頁PVC', cover: '6.2×10.4吋',
    add: '規格表 $140／加購區 $280', note: '網站尺寸欄標 8×11(398×284mm)與 8×10 不符' }),
  album({ src: [180], subs: [W], name: '《Memory》皮革烙印相本 12×12吋',
    opts: [o('12×12吋', 3300, '61×30.5')], mat: '皮革、內頁PVC', colors: '白、紅咖、橘棕', cover: '未標示',
    add: '規格表 $160／加購區 $320' }),
  album({ src: [49], subs: [W], name: '《婚攝本》Wedding Record 皮革相本 11×8吋',
    opts: [o('11×8吋 橫', 2350, '57.4×19.6')], mat: '皮面', colors: '紅咖、黑', cover: '無封面(皮面)',
    add: '規格表 $140／加購區 $280', note: '公版' }),
  album({ src: [353, 354], subs: [W, BIO], name: '《連心》皮革質感款相本 12×12吋',
    opts: [o('12×12吋', 3300, '61×30.5')], mat: '皮革、封面安格紙', colors: '橘棕、黑、磚色、駝色', cover: '6.8×10.8cm',
    add: '規格表 $160／加購區 $320', note: '網站重複上架(婚紗相本與傳記相本)，已合併' }),
  album({ src: [121, 123, 181], subs: [W, BABY, TRIP], name: '《布料水晶相本》8×8吋',
    opts: [o('8×8吋', 1730, '40.6×20.3')], mat: '水晶＋布面', colors: '灰、紫棕、米黃', cover: '5.8×5.8cm',
    add: '規格表 $100／加購區 $240', note: '網站以婚紗/寶寶成長/旅遊三個名稱重複上架，已合併' }),
  album({ src: [572], subs: [W], name: '《Memory》布料烙印相本 12×12吋',
    opts: [o('12×12吋', 3300, '61×30.5')], mat: '布料烙印', cover: '未標示',
    add: '規格表 $160／加購區 $320' }),
  album({ src: [46], subs: [W], name: '《柔然》三合一框盒組 12×12吋',
    opts: [o('12×12吋', 3300, '61×30.5')], mat: '布面桌框盒、內頁PVC', colors: '灰', cover: '盒封 21.6×20.8cm',
    add: '規格表 $160／加購區 $320' }),
  album({ src: [62], subs: [W], name: '《魔禾》三合一框盒組 12×12吋',
    opts: [o('12×12吋', 3300, '61×30.5')], mat: '布面桌框盒', colors: '褐', cover: '盒封 21.6×20.8cm',
    add: '規格表 $160／加購區 $320' }),
  album({ src: [169], subs: [W], name: '《木匣子》原木婚紗相本 12吋',
    opts: [o('12×12吋', 3300, '61×30.5')], mat: '原木', cover: '未標示',
    add: '規格表 $160／加購區 $320' }),
  album({ src: [499], subs: [W], name: '《書式木盒》12×12吋 套組',
    opts: [o('12×12吋', 3300, '61×30.5')], mat: '水晶', colors: '橘棕', cover: '17.3×13.2cm',
    add: '規格表 $160／加購區 $320' }),
  album({ src: [33], subs: [W], name: '《香格里拉2》水鑽閃耀婚紗相本 粉花',
    opts: [o('12×18吋', 3600, '60.4×43'), o('8×11吋', 2350, '39.8×28.4', 'inferred')],
    mat: '水晶、內頁PVC', colors: '粉花', cover: '12×18 6.6×6.6吋／8×11 4.5×4.5吋',
    add: '規格表 12×18 $200／8×11 $140／加購區 $320' }),
  album({ src: [558], subs: [W], name: '《塞維莉亞》三種尺寸',
    opts: [o('12×18吋', 3600, '60.4×43'), o('12×12吋', 3300, '61×30.5', 'inferred'), o('8×11吋', 2350, '39.8×28.4', 'inferred')],
    cover: '12×18 9×15cm／8×11 6.5×11.5cm／12×12 實際影像 3×4.5吋',
    add: '規格表 12×18 $200／12×12 $160／8×11 $140／加購區 $320' }),
  album({ src: [108], subs: [W], name: '《心蜜1》粉色系層次花紋',
    opts: [o('12×15吋', 3000, '61×38.7'), o('8×10吋', 1800, '40.6×25.8', 'inferred')],
    mat: '水晶(最高等級藝術噴繪)、內頁PVC', colors: '櫻花粉', cover: '12×15 6.4×6.4吋／8×10 4.4×4.4吋',
    add: '規格表 12×15 $200／8×10 $140／加購區 $320',
    note: '網站下拉選單仍寫 12×18/8×11，標題為 12×15/8×10' }),
  album({ src: [545], subs: [W], name: '《黛菈》18吋 閃耀白', retire: true,
    opts: [o('12×18吋', 3000, '60.4×43')], colors: '白', cover: '16.2×16.2cm',
    add: '規格表 $200／加購區 $320', note: '絕版出清' }),
  album({ src: [559], subs: [W], name: '《許願精靈》立體美雕花相本',
    opts: [o('12×18吋', 3000, '60.4×43'), o('8×11吋', 1800, '39.8×28.4', 'inferred')],
    cover: '12×18 14.5×14.5cm／8×11 10.3×10.3cm',
    add: '規格表 12×18 $200／8×11 $140／加購區 $320', note: '網站 12×18 內頁寫 60.4×30.5cm，疑為 60.4×43 筆誤' }),
  album({ src: [552], subs: [W], name: '特殊玫色皮料浪漫相本 11吋',
    opts: [o('8×11吋', 1800, '39.8×28.4')], mat: '皮料', colors: '粉', cover: '3.8×3.8吋',
    add: '規格表 $140／加購區 $280' }),
  album({ src: [551], subs: [W], name: '《白水木》11吋 特殊木材質雕刻',
    opts: [o('8×11吋', 1800, '39.8×28.4')], mat: '特殊木材質雕刻', colors: '木紋', cover: '畫面 9.8×7.5cm(出照 12×10cm)',
    add: '規格表 $140／加購區 $280' }),
  album({ src: [549], subs: [W], name: '《光燦之星》11吋 雙紙質',
    opts: [o('8×11吋', 1800, '39.8×28.4')], mat: '雙紙質', colors: '白(星幻)', cover: '11×15cm(實際 8×12cm)',
    add: '規格表 $140／加購區 $280' }),
  album({ src: [548], subs: [W], name: '《晶瑩》11吋 粉亮鑽',
    opts: [o('8×11吋', 1800, '39.8×28.4')], colors: '粉', cover: '3.7×5.2吋',
    add: '規格表 $140／加購區 $280' }),
  album({ src: [546], subs: [W], name: '《蜜斯朵》11吋 立體浪漫雕花',
    opts: [o('8×11吋', 2500, '39.8×28.4')], colors: '米黃', cover: '8.4×11.4cm',
    add: '$280/頁' }),
  album({ src: [544], subs: [W], name: '《雅漾》18吋(老規尺寸) 粉嫩色系', retire: true,
    opts: [o('12×18吋', 3500, '62.2×44.8')], colors: '粉', cover: '23.2×11.3cm',
    add: '$320/頁', note: '絕版出清；內頁尺寸與其他 18 吋款(60.4×43)不同' }),
  album({ src: [542], subs: [W], name: '《薰衣草》11吋 寧靜黑',
    opts: [o('12×18吋', 3500, '60.4×43'), o('8×11吋', 2500, '39.8×28.4', 'inferred')],
    colors: '黑', cover: '12×18 7×6.5吋／8×11 5×4.5吋', add: '$320/頁',
    note: '網站內頁尺寸列兩組數字(18吋 62.2×44.8 或 60.4×43；11吋 42×29.5 或 39.8×28.4)，待確認' }),
  album({ src: [540], subs: [W], name: '《寵愛》咖色 促銷款', retire: true,
    opts: [o('12×18吋', 3000, '62.2×44.8')], colors: '網站標示紫(名稱為咖色)', cover: '8.5×5吋',
    add: '規格表 $200／加購區 $320', note: '售完即絕版' }),
  album({ src: [537], subs: [W], name: '《奧莉芙》11吋 光澤緞面花鑽',
    opts: [o('8×11吋', 1800, '39.8×28.4')], mat: '特殊光澤緞面＋閃耀花鑽', colors: '香檳色', cover: '畫面 8.5×10cm(出照 10.5×12cm)',
    add: '規格表 $140／加購區 $280' }),
  album({ src: [358], subs: [W], name: '《柔曼》藕色素雅水鑽相本',
    opts: [o('12×18吋', 2100, '60.4×43'), o('8×11吋', 1800, '39.8×28.4', 'inferred')],
    mat: '水晶壓克力、內頁PVC', colors: '藕色',
    add: '規格表 12×18 $200／8×11 $140／加購區 $320', note: '網站下拉標 8×10；12×18 價 $2100 比其他 18 吋款低，待確認' }),
  album({ src: [504], subs: [W], name: '《莫內花園》米亞色蕾絲',
    opts: [o('12×18吋', 3000, '60.4×43'), o('8×11吋', 1800, '39.8×28.4', 'inferred')],
    mat: '布料', colors: '米黃', add: '規格表 12×18 $200／8×11 $140／加購區 $320' }),
  album({ src: [312], subs: [W], name: '《米婭公主》婚紗相本',
    opts: [o('12×18吋', 2300, '60.4×43'), o('8×11吋', 1800, '39.8×28.4', 'inferred')],
    mat: '水晶壓克力封面、內頁PVC', colors: '藍', add: '$320/頁' }),
  album({ src: [280], subs: [W], name: '《圓舞曲》氣質雕花款',
    opts: [o('12×18吋', 3000, '60.4×43'), o('8×11吋', 1800, '39.8×28.4', 'inferred')],
    mat: '水晶', colors: '白', cover: '12×18 165×94mm／8×11 116×69mm',
    add: '規格表 12×18 $200／8×11 $140／加購區 $320' }),
  album({ src: [516], subs: [W], name: '《馨語》裸色 立體水鑽封面',
    opts: [o('8×11吋', 1800, '39.8×28.4')], mat: '鋼琴烤漆面版', colors: '裸色', cover: '11×9cm',
    add: '規格表 $140／加購區 $280' }),
  album({ src: [130], subs: [W], name: '《舒莉》鋼琴烤漆相本',
    opts: [o('12×18吋', 3000, '60.4×43'), o('8×11吋', 1800, '39.8×28.4', 'inferred')],
    mat: '鋼琴烤漆', cover: '12×18 5.9×6.2吋／8×11 3.9×4.5吋',
    add: '規格表 12×18 $200／8×11 $140／加購區 $320', note: '買 18 吋送桌框(限量)' }),
  album({ src: [543], subs: [W], name: '《凱特》18吋／8×10吋',
    opts: [o('12×18吋', 3000, '60.4×43'), o('8×10吋', 1800, '40.6×25.8', 'inferred')],
    colors: '咖啡', cover: '18吋 10.5×16.2cm／8×10 7.5×11.5cm', add: '$320/頁', note: '少量出清' }),
  album({ src: [535], subs: [W], name: '《金莎》深咖啡閃耀金 11吋',
    opts: [o('8×11吋', 1800, '39.8×28.4')], colors: '咖啡', cover: '10.1×10.1cm',
    add: '規格表 $140／加購區 $280' }),
  album({ src: [530], subs: [W], name: '《馬卡》8×10吋 浪漫編織封面',
    opts: [o('8×10吋', 1700, '40.6×25.8')], mat: '編織封面', colors: '微金屬藍', cover: '11×8cm',
    add: '$280/頁', note: '網站尺寸欄標 8×11(398×284mm)' }),

  // ── 相本 › 寶寶.成長相本 ──────────────────────────────────────────────────
  album({ src: [573], subs: [BABY], name: 'Mini 小尺寸相本＋彌月卡 框合組',
    opts: [o('4×6吋', 2000, '20.3×14.5')], mat: '雙水晶相本', cover: '10.5×15cm', add: '$240/頁',
    note: '含 8×8 可換照框盒＋彌月卡 30 張＋4×6 相本；網站尺寸欄暫用 8×8，實際為 4×6' }),
  album({ src: [478], subs: [BABY], name: '《光遇》8×8吋',
    opts: [o('8×8吋', 1730, '40.6×20.3')], mat: '水晶、白金珠光相紙、內頁PVC', colors: '白', cover: '10×10cm',
    add: '規格表 $100／加購區 $240' }),
  album({ src: [480], subs: [BABY], name: '《光遇》6×8吋',
    opts: [o('6×8吋', 1380, '30.5×20.3')], mat: '水晶封面(中間裸空)、柯達相紙、內頁PVC', colors: '白', cover: '10×10cm',
    add: '規格表 $80／加購區 $240' }),

  // ── 相框 › 無框畫 ─────────────────────────────────────────────────────────
  print({ src: [42], subs: [FRAME], name: '《無框畫》直／橫皆可製作',
    opts: [o('16×24吋 直/橫', 950, '41×61cm')], mat: '10色藝術微噴相紙、貼膜、全背板不透光',
    other: '20×30吋(51×76cm)、24×35吋(60×90cm) 直/橫，網站 3 種尺寸共用單一標價，其餘價格待確認',
    note: '代客排版；手工製品誤差±2cm' }),
  print({ src: [351], subs: [FRAME], name: '《白金珠光油畫布無框畫》直／橫皆可',
    opts: [o('16×24吋 直/橫', 1000, '41×61cm')], mat: '白金珠光油畫布、EPSON 油性防水噴圖、全背板不透光',
    other: '20×30吋(51×76cm)、24×35吋(60×90cm) 直/橫，網站 3 種尺寸共用單一標價，其餘價格待確認',
    note: '代客排版；採 CMYK 印製略有色差；誤差±2cm' }),
  print({ src: [97], subs: [FRAME], name: '《相片無框畫》12×12吋',
    opts: [o('12×12吋', 750, '約30×30cm')], mat: '10色藝術微噴相紙、貼膜、全背板不透光',
    note: '小畫架另購；代客排版無校稿；網站尺寸下拉誤標 A4 直' }),
  print({ src: [187], subs: [FRAME], name: '《A4相片無框畫》',
    opts: [o('A4 直', 650, '21×29.7cm'), o('A4 橫', 650, '29.7×21cm')], mat: '10色藝術微噴',
    note: '代客排版無校稿' }),
  print({ src: [532], subs: [FRAME], name: '【微瑕疵出清】水晶婚禮面板 浪漫裸色', retire: true,
    opts: [o('整組(約29×20cm)', 180)], mat: '水晶面板', colors: '粉',
    note: '出清售出不退；含照片(10×12cm)、設計框、小畫架；網站尺寸欄 A4 直(21×29.7cm)與說明 29×20cm 不一致' }),

  // ── 相框 › 放大框 ─────────────────────────────────────────────────────────
  print({ src: [561], subs: [BIG], name: '《獨家 換照框》一框 6 張 12 面',
    opts: [o('12×12吋', 1380, '305×305mm')], mat: '亞柏、沐雪款',
    other: '10×14吋(網站標 49.8×35.6cm，與吋數不符，價格未標示)',
    note: '一框放 6 張共 12 面畫面，可換照' }),
  print({ src: [348], subs: [BIG], name: '《亞柏》壁相框',
    opts: [o('35×25吋 壁框', 3500, '約90×64cm')], mat: '原木淺色系、含相片紙與背板',
    note: '新品促銷；照片 24×30吋' }),
  print({ src: [526], subs: [BIG], name: '《松露》8.6×16.6吋 韓風壁相框',
    opts: [o('8.6×16.6吋', 1280, '約21.8×42.2cm')], mat: '霧面細膩質感', colors: '純色黑',
    note: '3 張合併輸出為 1 張(46×22cm)，亦可單張' }),
  print({ src: [118], subs: [BIG], name: '《仿古》掛框 出清款',
    opts: [o('大', 675, '57.3×47.4cm'), o('中', 450, '27.5×47.4cm', 'inferred')], mat: '木頭上漆做舊、含相片紙與背板',
    note: '出清款恕不退換；照片尺寸 6×8吋/8×16吋/20×16吋，對應框型待確認' }),

  // ── 相框 › 桌框 ───────────────────────────────────────────────────────────
  print({ src: [575], subs: [DESK], name: '《影像存錢筒》5×7吋',
    opts: [o('5×7吋', 500, '127×178mm')], other: '6×8吋(網站列有此選項，價格未標示)',
    note: '照片/文字/來圖皆可製作，含去背' }),
  print({ src: [438], subs: [DESK], name: '《Love you》閃亮桌框 25.8×20.6cm',
    opts: [o('25.8×20.6cm', 488)], mat: '相片紙、閃點膜、含背板' }),
  print({ src: [54], subs: [DESK], name: '《Love you》桌框 32×19.5cm',
    opts: [o('32×19.5cm', 588)], mat: '相片紙、閃點膜、含背板', note: '1 張橫式；成品約 31×18.5cm' }),
  print({ src: [569], subs: [DESK], name: '《時光寶盒》萬用相框蒐藏本',
    opts: [o('17.9×17.9×2.5cm', 450)], note: '內頁 6 張(4+2)＋封面 1 張' }),
  print({ src: [171], subs: [DESK], name: '《木匣子》6×7吋 原木桌框',
    opts: [o('6×7吋', 470, '框 22.5×28.5cm')], mat: '原木、含背板' }),
  print({ src: [521], subs: [DESK], name: '【宜家】8×10吋 原木雙色桌框',
    opts: [o('8×10吋', 380, '框 32.8×28cm')], mat: '原木雙色', note: '下殺出清' }),
  print({ src: [524], subs: [DESK], name: '《沐雪》8×10吋 原木設計感桌框',
    opts: [o('8×10吋', 588, '約20.3×25.4cm')], mat: '原木', colors: '樸實原木色' }),
  print({ src: [205], subs: [DESK], name: '《品木》南法鄉村風桌相框',
    opts: [o('12×12吋框', 710, '約30.5×30.5cm')], mat: '原木、相紙', note: '照片 7×7吋' }),
  print({ src: [501], subs: [DESK], name: '《小松露》小壁框',
    opts: [o('框 22.5×28.5cm', 580)], colors: '黑', note: '照片 7.2×5吋；較大尺寸請選放大框' }),
  print({ src: [522], subs: [DESK], name: '《藍調》8×10吋 清新質感桌框',
    opts: [o('8×10吋', 380)], mat: '雙色木質調', note: '下殺出清；直/橫皆可' }),
  print({ src: [520], subs: [DESK], name: '《帕斯妮(輕裸)》玻璃桌相框 8×10吋',
    opts: [o('8×10吋', 440, '外框 34×29cm')], mat: '鏡面玻璃、原廠相片紙' }),
  print({ src: [79], subs: [DESK], name: '《圓舞曲》玻璃桌相框 8×10吋',
    opts: [o('8×10吋', 440, '外框 34×29cm')], mat: '玻璃、原廠相片紙' }),
  print({ src: [519], subs: [DESK], name: '《謬思(藍咖)》玻璃桌相框 8×10吋',
    opts: [o('8×10吋', 440, '外框 34×29cm')], mat: '鏡面玻璃、原廠相片紙' }),
  print({ src: [77], subs: [DESK], name: '《享婚二》玻璃桌相框 8×10吋',
    opts: [o('8×10吋', 440, '外框 34×29cm')], mat: '玻璃、含背板、FUJI 原廠相片紙', note: '可客製個人封面' }),
  print({ src: [533], subs: [DESK], name: '《八邊美框》古銅玫金桌框',
    opts: [o('20×25cm', 350)], colors: '古銅玫金', note: '八邊形；相片材質(原油畫布已斷貨)' }),
  print({ src: [117], subs: [DESK], name: '《古菱閣》桌相框',
    opts: [o('框 22×27cm', 225)], mat: '皮革、含背板與相片紙', colors: '咖啡、米白', note: '照片 5×7吋' }),
  print({ src: [536], subs: [DESK], name: '【精緻復古】Mini 復刻版桌上小相框(4款)',
    opts: [o('Mini 4 款任選', 100)], note: '附贈照片 6~10cm；愛心款有 2 色，需另告知款式' }),
  print({ src: [555], subs: [DESK], name: '《許願精靈》6×8立體雕花桌框',
    opts: [o('照片 8×10吋', 470)], colors: '藍', note: '標題寫 6×8、照片規格寫 8×10，待確認；直放橫放皆可' }),
];

// every shop product id the seed covers (merged duplicates included)
export const sourceIds = () => PRODUCTS.flatMap(p => p.src);

const label = (p, x) => {
  if (!x.dim) return x.size;
  return p.kind === 'album' ? `${x.size}｜內頁跨頁${x.dim}cm` : `${x.size}（${x.dim}）`;
};

export function describe(p) {
  const top = CATEGORIES[p.subs[0]];
  const inferred = p.opts.filter(x => x.how === 'inferred').map(x => x.size);
  const parts = [
    `【${top}›${p.subs.join('、')}】`,
    p.mat && `材質：${p.mat}`,
    p.colors && `顏色：${p.colors}`,
    p.cover && `封面：${p.cover}`,
    p.kind === 'album' && '基本 15P(跨頁)',
    p.add && `加頁(網站數字不一致，待確認)：${p.add}`,
    p.other && `其他尺寸(未建立)：${p.other}`,
    p.note && `備註：${p.note}`,
    inferred.length && `價格待確認：${inferred.join('、')}(由網站列表價/同系列推算)`,
    `來源：印像網 #${p.src.join('/')}`,
  ].filter(Boolean);
  return parts.join('｜');
}

// the body of POST /api/operator/products for seed product p at position i
export function toPayload(p, i) {
  const body = {
    kind: p.kind,
    name: p.name,
    description: describe(p),
    sort: i * 10,
    options: p.opts.map(x => ({ label: label(p, x), vendor_cost: x.price, platform_price: x.price })),
  };
  if (p.kind === 'album') body.min_pages = 15;
  return body;
}
