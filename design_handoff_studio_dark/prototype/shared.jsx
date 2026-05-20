// Shared sample data + helpers.

const PHOTOS = [
  { id: 'p01', src: 'https://picsum.photos/seed/family-beach-1/800/600',  name: '海邊_0823.jpg',  rating: 5, flag: 'pick',    annotated: true,  color: 'red',    note: '主視覺候選 — 光線很乾淨，海平線稍微歪。',  date: '2026/08/23 14:32', exif: 'α7iv · 52mm · f/2.8 · 1/640 · ISO 160' },
  { id: 'p02', src: 'https://picsum.photos/seed/family-beach-2/800/600',  name: '海邊_0824.jpg',  rating: 4, flag: 'pick',    annotated: false, color: 'amber',  note: '', date: '2026/08/23 14:33', exif: 'α7iv · 52mm · f/2.8 · 1/640 · ISO 160' },
  { id: 'p03', src: 'https://picsum.photos/seed/family-beach-3/800/600',  name: '海邊_0825.jpg',  rating: 3, flag: null,      annotated: false, color: null,     note: '', date: '2026/08/23 14:34', exif: 'α7iv · 52mm · f/2.8 · 1/640 · ISO 160' },
  { id: 'p04', src: 'https://picsum.photos/seed/family-dinner/800/600',   name: '晚餐_1102.jpg',  rating: 5, flag: 'pick',    annotated: true,  color: 'green',  note: '阿嬤的笑容 — 印出來給她。', date: '2026/11/02 19:14', exif: 'α7iv · 35mm · f/2.0 · 1/120 · ISO 400' },
  { id: 'p05', src: 'https://picsum.photos/seed/family-dinner-2/800/600', name: '晚餐_1103.jpg',  rating: 2, flag: 'reject',  annotated: false, color: null,     note: '失焦', date: '2026/11/02 19:15', exif: 'α7iv · 35mm · f/2.0 · 1/120 · ISO 400' },
  { id: 'p06', src: 'https://picsum.photos/seed/family-park/800/600',     name: '公園_0411.jpg',  rating: 4, flag: null,      annotated: true,  color: 'blue',   note: '', date: '2026/04/11 16:48', exif: 'α7iv · 85mm · f/1.8 · 1/500 · ISO 200' },
  { id: 'p07', src: 'https://picsum.photos/seed/family-cake/800/600',     name: '蛋糕_0612.jpg',  rating: 5, flag: 'pick',    annotated: false, color: 'red',    note: '', date: '2026/06/12 19:08', exif: 'α7iv · 50mm · f/1.4 · 1/80 · ISO 1600' },
  { id: 'p08', src: 'https://picsum.photos/seed/family-pet/800/600',      name: '阿橘_0517.jpg',  rating: 3, flag: 'review',  annotated: false, color: 'amber',  note: '', date: '2026/05/17 11:22', exif: 'α7iv · 85mm · f/1.8 · 1/250 · ISO 400' },
  { id: 'p09', src: 'https://picsum.photos/seed/family-pet-2/800/600',    name: '阿橘_0518.jpg',  rating: 1, flag: 'reject',  annotated: false, color: null,     note: '失焦', date: '2026/05/18 11:30', exif: 'α7iv · 85mm · f/1.8 · 1/250 · ISO 400' },
  { id: 'p10', src: 'https://picsum.photos/seed/family-mountain/800/600', name: '山行_0903.jpg',  rating: 4, flag: 'pick',    annotated: false, color: 'green',  note: '', date: '2026/09/03 07:14', exif: 'α7iv · 24mm · f/8 · 1/200 · ISO 100' },
  { id: 'p11', src: 'https://picsum.photos/seed/family-mountain-2/800/600', name: '山行_0904.jpg', rating: 3, flag: null,      annotated: false, color: null,     note: '', date: '2026/09/03 07:16', exif: 'α7iv · 24mm · f/8 · 1/200 · ISO 100' },
  { id: 'p12', src: 'https://picsum.photos/seed/family-night/800/600',    name: '夜景_1224.jpg',  rating: 4, flag: 'review',  annotated: true,  color: 'purple', note: '聖誕夜', date: '2026/12/24 22:08', exif: 'α7iv · 24mm · f/2.8 · 0.5s · ISO 800' },
  { id: 'p13', src: 'https://picsum.photos/seed/family-portrait/800/600', name: '人像_0307.jpg',  rating: 5, flag: 'pick',    annotated: true,  color: 'red',    note: '客戶要求', date: '2026/03/07 15:00', exif: 'α7iv · 85mm · f/1.4 · 1/500 · ISO 200' },
  { id: 'p14', src: 'https://picsum.photos/seed/family-portrait-2/800/600',name: '人像_0308.jpg', rating: 2, flag: null,      annotated: false, color: null,     note: '', date: '2026/03/07 15:02', exif: 'α7iv · 85mm · f/1.4 · 1/500 · ISO 200' },
  { id: 'p15', src: 'https://picsum.photos/seed/family-kids/800/600',     name: '孩子_0729.jpg',  rating: 4, flag: 'pick',    annotated: false, color: 'blue',   note: '', date: '2026/07/29 17:32', exif: 'α7iv · 50mm · f/1.8 · 1/1000 · ISO 200' },
  { id: 'p16', src: 'https://picsum.photos/seed/family-kids-2/800/600',   name: '孩子_0730.jpg',  rating: 3, flag: null,      annotated: false, color: null,     note: '', date: '2026/07/29 17:34', exif: 'α7iv · 50mm · f/1.8 · 1/1000 · ISO 200' },
  { id: 'p17', src: 'https://picsum.photos/seed/family-walk/800/600',     name: '散步_0421.jpg',  rating: 5, flag: 'pick',    annotated: true,  color: 'green',  note: '光線剛好', date: '2026/04/21 17:48', exif: 'α7iv · 35mm · f/2.8 · 1/800 · ISO 200' },
  { id: 'p18', src: 'https://picsum.photos/seed/family-walk-2/800/600',   name: '散步_0422.jpg',  rating: 4, flag: null,      annotated: false, color: null,     note: '', date: '2026/04/21 17:50', exif: 'α7iv · 35mm · f/2.8 · 1/800 · ISO 200' },
  { id: 'p19', src: 'https://picsum.photos/seed/family-tea/800/600',      name: '下午茶_1015.jpg',rating: 3, flag: null,      annotated: false, color: null,     note: '', date: '2026/10/15 15:20', exif: 'α7iv · 50mm · f/2.0 · 1/200 · ISO 800' },
  { id: 'p20', src: 'https://picsum.photos/seed/family-tea-2/800/600',    name: '下午茶_1016.jpg',rating: 0, flag: null,      annotated: false, color: null,     note: '', date: '2026/10/15 15:21', exif: 'α7iv · 50mm · f/2.0 · 1/200 · ISO 800' },
  { id: 'p21', src: 'https://picsum.photos/seed/family-flower/800/600',   name: '花_0501.jpg',    rating: 4, flag: 'pick',    annotated: false, color: 'purple', note: '', date: '2026/05/01 09:48', exif: 'α7iv · 90mm · f/4 · 1/320 · ISO 200' },
  { id: 'p22', src: 'https://picsum.photos/seed/family-flower-2/800/600', name: '花_0502.jpg',    rating: 3, flag: null,      annotated: false, color: null,     note: '', date: '2026/05/01 09:50', exif: 'α7iv · 90mm · f/4 · 1/320 · ISO 200' },
  { id: 'p23', src: 'https://picsum.photos/seed/family-flower-3/800/600', name: '花_0503.jpg',    rating: 2, flag: 'reject',  annotated: false, color: null,     note: '太暗', date: '2026/05/01 09:52', exif: 'α7iv · 90mm · f/4 · 1/320 · ISO 200' },
  { id: 'p24', src: 'https://picsum.photos/seed/family-bike/800/600',     name: '單車_0808.jpg',  rating: 5, flag: 'pick',    annotated: true,  color: 'red',    note: '', date: '2026/08/08 16:24', exif: 'α7iv · 24mm · f/4 · 1/500 · ISO 200' },
];

const AI_GROUPS = [
  { id: 'g1', label: '相似組 · 海邊',     count: 3, suggest: '海邊_0823.jpg', kind: 'similar' },
  { id: 'g2', label: '相似組 · 阿橘',     count: 2, suggest: '阿橘_0517.jpg', kind: 'similar' },
  { id: 'g3', label: '可能失焦',           count: 2, suggest: '—',           kind: 'blur'    },
  { id: 'g4', label: '構圖最佳建議',       count: 6, suggest: '人像_0307.jpg', kind: 'best'    },
];

const SHORTCUTS = [
  {
    title: '評分與標記',
    items: [
      { keys: ['1','2','3','4','5'], desc: '設定 1–5 星評分' },
      { keys: ['0'],                  desc: '清除評分' },
      { keys: ['P'],                  desc: '標記為「精選」' },
      { keys: ['X'],                  desc: '標記為「捨棄」' },
      { keys: ['R'],                  desc: '標記為「待覆審」' },
      { keys: ['G'],                  desc: '加上色標（紅／橘／綠／藍／紫）' },
    ],
  },
  {
    title: '瀏覽與導覽',
    items: [
      { keys: ['←','→'],              desc: '上一張 / 下一張' },
      { keys: ['↑','↓'],              desc: '上一列 / 下一列' },
      { keys: ['F'],                  desc: '進入幻燈片模式' },
      { keys: ['Esc'],                desc: '退出 / 關閉視窗' },
      { keys: ['Space'],              desc: '快速預覽' },
      { keys: ['C'],                  desc: '比較模式（選 2–4 張）' },
    ],
  },
  {
    title: '標注與工具',
    items: [
      { keys: ['B'],                  desc: '畫圈標注' },
      { keys: ['T'],                  desc: '加文字標注' },
      { keys: ['E'],                  desc: '橡皮擦' },
      { keys: ['Z'],                  desc: '縮放工具' },
      { keys: ['⌘','S'],              desc: '儲存標注' },
      { keys: ['⌘','Z'],              desc: '復原' },
    ],
  },
  {
    title: '檔案與同步',
    items: [
      { keys: ['⌘','O'],              desc: '載入 Drive 資料夾' },
      { keys: ['⌘','E'],              desc: '匯出 JSON' },
      { keys: ['⌘','⇧','S'],          desc: '同步到 Google Sheets' },
      { keys: ['?'],                  desc: '顯示／關閉這個面板' },
    ],
  },
];

const COLOR_LABELS = [
  { key: 'red',    name: '紅 · 重點',   hex: '#c14b3b' },
  { key: 'amber',  name: '橘 · 候選',   hex: '#d99245' },
  { key: 'green',  name: '綠 · 已通過', hex: '#5c8a55' },
  { key: 'blue',   name: '藍 · 待客戶', hex: '#4a7aa8' },
  { key: 'purple', name: '紫 · 後製',   hex: '#7c5fa3' },
];

const FOLDERS = [
  { id: 'f1', name: '2026 海邊系列',   n: 247, sub: '08 月 · α7iv',     active: true },
  { id: 'f2', name: '2026 阿橘',       n: 184, sub: '05 月 · α7iv' },
  { id: 'f3', name: '2026 山行',       n: 96,  sub: '09 月 · α7iv' },
  { id: 'f4', name: '2026 花',         n: 64,  sub: '04–05 月 · α7iv' },
  { id: 'f5', name: '2026 聖誕',       n: 42,  sub: '12 月 · α7iv' },
  { id: 'f6', name: '2025 全部',       n: 1822,sub: '12 個月' },
];

function Stars({ value, max = 5, size = 12, on = '#e5a448', off = 'rgba(241,234,216,.12)', onClick }) {
  return (
    <span style={{ display: 'inline-flex', gap: 1, lineHeight: 1 }}>
      {Array.from({ length: max }).map((_, i) => (
        <button
          key={i}
          onClick={onClick ? (e) => { e.stopPropagation(); onClick(i + 1); } : undefined}
          style={{
            display: 'inline-flex', alignItems: 'center', padding: 0,
            background: 'transparent', border: 'none',
            cursor: onClick ? 'pointer' : 'default',
          }}
          aria-label={`${i + 1} star`}
        >
          <svg width={size} height={size} viewBox="0 0 24 24" fill={i < value ? on : off}>
            <path d="M12 2.5l2.9 6.5 7.1.7-5.4 4.8 1.6 7L12 18l-6.2 3.5 1.6-7L2 9.7l7.1-.7z" />
          </svg>
        </button>
      ))}
    </span>
  );
}

function flagColor(flag) {
  return ({ pick: '#9bbd6a', reject: '#c97a6a', review: '#d9a85a' })[flag] || null;
}
function flagLabel(flag) {
  return ({ pick: 'PICK', reject: 'REJECT', review: 'REVIEW' })[flag] || '';
}
function colorHex(c) {
  return (COLOR_LABELS.find(x => x.key === c) || {}).hex || null;
}

Object.assign(window, {
  PHOTOS, AI_GROUPS, SHORTCUTS, COLOR_LABELS, FOLDERS,
  Stars, flagColor, flagLabel, colorHex,
});
