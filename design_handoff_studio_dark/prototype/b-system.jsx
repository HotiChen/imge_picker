// B · Studio Dark — design system + global store + common components.

// ─── design tokens ─────────────────────────────────────────────────────
const T = {
  bg:        '#15120d',
  bgSoft:    '#1c1a14',
  bgDeep:    '#0e0c08',
  surface:   '#1f1c16',
  card:      '#26221b',
  cardHi:    '#2e2922',
  ink:       '#f1ead8',
  ink70:     'rgba(241,234,216,.72)',
  ink55:     'rgba(241,234,216,.55)',
  ink35:     'rgba(241,234,216,.32)',
  ink15:     'rgba(241,234,216,.12)',
  border:    '#332e25',
  rule:      '#2a261f',
  accent:    '#e5a448',
  accentDim: 'rgba(229,164,72,.18)',
  pick:      '#9bbd6a',
  reject:    '#c97a6a',
  review:    '#d9a85a',
  sans:      "'IBM Plex Sans', -apple-system, sans-serif",
  mono:      "'IBM Plex Mono', ui-monospace, monospace",
};

const base = {
  fontFamily: T.sans, color: T.ink, background: T.bg,
  width: '100%', height: '100%',
  display: 'flex', flexDirection: 'column',
  fontSize: 13, lineHeight: 1.45,
};

// ─── global store (singleton, shared across all artboards) ─────────────
const makeStore = () => {
  let state = {
    photos: PHOTOS.map(p => ({ ...p })),
    selectedId: 'p01',
    selection: new Set(),
    filter: { rating: 'all', flag: 'all', annotated: 'all', color: 'all' },
    sort: 'rating',
    showShortcuts: false,
    folderId: 'f1',
  };
  const listeners = new Set();
  const emit = () => listeners.forEach(l => l());
  const set = (u) => { state = typeof u === 'function' ? u(state) : { ...state, ...u }; emit(); };
  const get = () => state;
  const subscribe = (cb) => { listeners.add(cb); return () => listeners.delete(cb); };

  const updatePhoto = (id, patch) => set(s => ({
    ...s, photos: s.photos.map(p => p.id === id ? { ...p, ...patch } : p),
  }));

  const actions = {
    setRating:  (id, r)   => updatePhoto(id, { rating: r }),
    setFlag:    (id, f)   => updatePhoto(id, { flag: state.photos.find(p => p.id === id)?.flag === f ? null : f }),
    setColor:   (id, c)   => updatePhoto(id, { color: state.photos.find(p => p.id === id)?.color === c ? null : c }),
    setNote:    (id, n)   => updatePhoto(id, { note: n }),
    selectPhoto:(id)      => set({ selectedId: id }),
    toggleSel:  (id)      => set(s => {
      const next = new Set(s.selection);
      next.has(id) ? next.delete(id) : next.add(id);
      return { ...s, selection: next };
    }),
    selectAll:  ()        => set(s => ({ ...s, selection: new Set(s.photos.slice(0, 12).map(p => p.id)) })),
    clearSel:   ()        => set({ selection: new Set() }),
    next:       ()        => set(s => {
      const list = s.photos;
      const i = list.findIndex(p => p.id === s.selectedId);
      return { ...s, selectedId: list[Math.min(i + 1, list.length - 1)].id };
    }),
    prev:       ()        => set(s => {
      const list = s.photos;
      const i = list.findIndex(p => p.id === s.selectedId);
      return { ...s, selectedId: list[Math.max(i - 1, 0)].id };
    }),
    setFilter:  (k, v)    => set(s => ({ ...s, filter: { ...s.filter, [k]: v } })),
    setSort:    (s2)      => set({ sort: s2 }),
    toggleShortcuts: ()   => set(s => ({ ...s, showShortcuts: !s.showShortcuts })),
    setFolder:  (id)      => set({ folderId: id }),
  };

  return { get, set, subscribe, ...actions };
};

const store = makeStore();

function useStore(selector = s => s) {
  const sel = React.useRef(selector); sel.current = selector;
  const [snap, setSnap] = React.useState(() => sel.current(store.get()));
  React.useEffect(() => store.subscribe(() => setSnap(sel.current(store.get()))), []);
  return snap;
}

// ─── global keyboard handler — install once ────────────────────────────
(function installKeys() {
  if (window.__bKeysInstalled) return;
  window.__bKeysInstalled = true;
  window.addEventListener('keydown', (e) => {
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
    const s = store.get();
    const id = s.selectedId;
    if (e.key >= '0' && e.key <= '5') { store.setRating(id, +e.key); e.preventDefault(); return; }
    const k = e.key.toLowerCase();
    if (k === 'p') store.setFlag(id, 'pick');
    else if (k === 'x') store.setFlag(id, 'reject');
    else if (k === 'r') store.setFlag(id, 'review');
    else if (e.key === 'ArrowRight') store.next();
    else if (e.key === 'ArrowLeft')  store.prev();
    else if (e.key === '?')          store.toggleShortcuts();
  });
})();

// ─── common UI atoms ────────────────────────────────────────────────────
function StPillBtn({ active, children, ...rest }) {
  return (
    <button {...rest} style={{
      border: `1px solid ${active ? T.accent : T.border}`,
      background: active ? T.accentDim : 'transparent',
      color: active ? T.accent : T.ink70,
      padding: '5px 10px', fontFamily: T.mono, fontSize: 10,
      cursor: 'pointer', letterSpacing: '0.04em',
      ...(rest.style || {}),
    }}>{children}</button>
  );
}

function StSideTitle({ label }) {
  return (
    <div style={{
      fontFamily: T.mono, fontSize: 9, letterSpacing: '0.2em',
      color: T.ink55, textTransform: 'uppercase',
      padding: '0 0 6px', borderBottom: `1px solid ${T.rule}`,
    }}>{label}</div>
  );
}

function StKbd({ children, big }) {
  return (
    <kbd style={{
      fontFamily: T.mono, fontSize: big ? 12 : 10,
      padding: big ? '4px 10px' : '2px 7px', minWidth: 18, textAlign: 'center',
      background: T.card, border: `1px solid ${T.border}`,
      borderBottomWidth: 2, color: T.ink, fontWeight: 600,
      display: 'inline-block',
    }}>{children}</kbd>
  );
}

function StHeader({ crumbs = ['Family','2026','08 海邊'], showSync = true }) {
  return (
    <header style={{
      flex: '0 0 auto', height: 56,
      borderBottom: `1px solid ${T.rule}`,
      background: T.surface,
      display: 'grid', gridTemplateColumns: '280px 1fr 320px',
      alignItems: 'center',
    }}>
      <div style={{ padding: '0 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 22, height: 22, background: T.accent, color: T.bg,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: T.mono, fontSize: 12, fontWeight: 700,
        }}>選</div>
        <span style={{ fontSize: 14, fontWeight: 600 }}>選圖工作室</span>
        <span style={{ fontFamily: T.mono, fontSize: 9, color: T.ink55, letterSpacing: '0.12em' }}>STUDIO</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center' }}>
        <div style={{ fontFamily: T.mono, fontSize: 11, color: T.ink55, display: 'flex', gap: 6, alignItems: 'center' }}>
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              <span style={{ color: i === crumbs.length - 1 ? T.ink : T.ink55 }}>{c}</span>
              {i < crumbs.length - 1 && <span style={{ color: T.ink35 }}>›</span>}
            </React.Fragment>
          ))}
        </div>
        <span style={{ width: 1, height: 16, background: T.border }} />
        <StPillBtn>排序 · 評分 ↓</StPillBtn>
        <StPillBtn>網格</StPillBtn>
      </div>
      <div style={{ padding: '0 18px', display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end' }}>
        {showSync && (
          <button style={{
            padding: '7px 12px', background: T.accent, color: T.bg, border: 'none',
            fontFamily: T.mono, fontSize: 10, letterSpacing: '0.12em',
            textTransform: 'uppercase', cursor: 'pointer', fontWeight: 600,
          }}>同步 SHEETS</button>
        )}
        <div style={{
          width: 30, height: 30, borderRadius: '50%',
          background: 'linear-gradient(135deg,#c8a878,#8a6a44)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: T.bg, fontWeight: 700, fontSize: 12,
        }}>HC</div>
      </div>
    </header>
  );
}

// ─── photo card ─────────────────────────────────────────────────────────
function StPhotoCard({ p, selected, batched, density = 'medium', onClick, onCheck }) {
  const fc = flagColor(p.flag);
  const cx = colorHex(p.color);
  const h = density === 'dense' ? 96 : density === 'sparse' ? 200 : 150;
  return (
    <div onClick={onClick} style={{
      background: T.card,
      padding: density === 'dense' ? 4 : 6,
      paddingBottom: density === 'dense' ? 6 : 8,
      border: `1px solid ${selected ? T.accent : (batched ? T.ink55 : T.border)}`,
      position: 'relative', cursor: 'pointer',
      transition: 'border-color .12s',
    }}>
      <div className="ph" style={{
        width: '100%', height: h,
        backgroundImage: `url(${p.src})`,
        position: 'relative',
      }}>
        {fc && (
          <div style={{
            position: 'absolute', top: 6, left: 6,
            padding: '2px 6px', background: fc, color: T.bg,
            fontFamily: T.mono, fontSize: 8, fontWeight: 700, letterSpacing: '0.08em',
          }}>{flagLabel(p.flag)}</div>
        )}
        {cx && (
          <div style={{
            position: 'absolute', top: 6, right: p.annotated ? 30 : 6,
            width: 10, height: 10, background: cx,
            boxShadow: '0 0 0 1px rgba(0,0,0,.3)',
          }} />
        )}
        {p.annotated && (
          <div style={{
            position: 'absolute', top: 4, right: 4,
            width: 18, height: 18, background: T.bg, color: T.accent,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 10, fontWeight: 700,
          }}>✎</div>
        )}
        {onCheck && (
          <button onClick={(e) => { e.stopPropagation(); onCheck(p.id); }} style={{
            position: 'absolute', bottom: 6, left: 6,
            width: 22, height: 22, padding: 0, cursor: 'pointer',
            background: batched ? T.accent : 'rgba(15,12,8,.7)',
            color: batched ? T.bg : T.ink, fontWeight: 700, fontSize: 12,
            border: batched ? 'none' : '1px solid rgba(255,255,255,.3)',
          }}>{batched ? '✓' : ''}</button>
        )}
      </div>
      {density !== 'dense' && (
        <div style={{ paddingTop: 7, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.ink70 }}>{p.name}</span>
          <Stars value={p.rating} on={T.accent} off={T.ink15} size={10}
                 onClick={(r) => store.setRating(p.id, r === p.rating ? 0 : r)} />
        </div>
      )}
    </div>
  );
}

// ─── left sidebar (filters) ─────────────────────────────────────────────
function StLeftSidebar({ folder = '2026 海邊系列', folderMeta = '247 frames · 1.8 GB' }) {
  const filter = useStore(s => s.filter);
  return (
    <aside style={{
      background: T.surface, borderRight: `1px solid ${T.rule}`,
      padding: '18px 16px', overflow: 'auto',
      display: 'flex', flexDirection: 'column', gap: 22,
    }}>
      <div>
        <StSideTitle label="01 / SOURCE" />
        <div style={{
          marginTop: 10, padding: 12,
          background: T.card, border: `1px solid ${T.border}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: T.pick }} />
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55 }}>已連線 · DRIVE</span>
          </div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{folder}</div>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, marginTop: 2 }}>{folderMeta}</div>
        </div>
      </div>

      <div>
        <StSideTitle label="02 / RATING" />
        <div style={{ marginTop: 8 }}>
          {[
            { k: 'all', label: '全部',  n: 247 },
            { k: '5', label: '5 ★ 精選', n: 18 },
            { k: '4', label: '4 ★',      n: 42 },
            { k: '3', label: '3 ★',      n: 67 },
            { k: '2', label: '2 ★',      n: 31 },
            { k: '1', label: '1 ★',      n: 12 },
            { k: '0', label: '未評分',   n: 77 },
          ].map(r => {
            const active = String(filter.rating) === r.k;
            return (
              <div key={r.k} onClick={() => store.setFilter('rating', r.k)} style={{
                display: 'flex', justifyContent: 'space-between',
                padding: '6px 8px', marginBottom: 2, cursor: 'pointer',
                background: active ? T.cardHi : 'transparent',
                borderLeft: `2px solid ${active ? T.accent : 'transparent'}`,
                fontSize: 12,
                color: active ? T.ink : T.ink70,
              }}>
                <span>{r.label}</span>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: active ? T.accent : T.ink55 }}>
                  {r.n}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <StSideTitle label="03 / FLAGS" />
        <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 6 }}>
          {[
            { k: 'pick',   label: 'PICK',   n: 38, bg: T.pick },
            { k: 'review', label: 'REVIEW', n: 11, bg: T.review },
            { k: 'reject', label: 'REJECT', n: 9,  bg: T.reject },
          ].map(b => {
            const active = filter.flag === b.k;
            return (
              <div key={b.label} onClick={() => store.setFilter('flag', active ? 'all' : b.k)}
                style={{
                  padding: '8px 6px', textAlign: 'center', cursor: 'pointer',
                  background: active ? T.cardHi : T.card,
                  border: `1px solid ${active ? b.bg : T.border}`,
                  borderTop: `2px solid ${b.bg}`,
                }}>
                <div style={{ fontFamily: T.mono, fontSize: 9, color: T.ink55, letterSpacing: '0.12em' }}>{b.label}</div>
                <div style={{ fontFamily: T.mono, fontSize: 18, fontWeight: 600, marginTop: 2 }}>{b.n}</div>
              </div>
            );
          })}
        </div>
      </div>

      <div>
        <StSideTitle label="04 / COLOR" />
        <div style={{ marginTop: 8 }}>
          {COLOR_LABELS.map((c, i) => (
            <div key={c.key} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '6px 4px', fontSize: 12, cursor: 'pointer',
            }}>
              <span style={{ width: 12, height: 12, background: c.hex, border: '1px solid rgba(255,255,255,.08)' }} />
              <span style={{ flex: 1, color: T.ink70 }}>{c.name}</span>
              <span style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55 }}>
                {[12,8,21,5,3][i]}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div>
        <StSideTitle label="05 / AI ASSIST" />
        <div style={{ marginTop: 8 }}>
          {AI_GROUPS.map(g => (
            <div key={g.id} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 10px', background: T.card,
              border: `1px solid ${T.border}`, marginBottom: 5,
            }}>
              <div>
                <div style={{ fontSize: 12, color: T.ink }}>{g.label}</div>
                <div style={{ fontFamily: T.mono, fontSize: 9, color: T.ink55, marginTop: 1 }}>
                  {g.kind === 'similar' ? '保留 1 張' : g.kind === 'blur' ? '建議捨棄' : '構圖最佳'}
                </div>
              </div>
              <span style={{
                fontFamily: T.mono, fontSize: 10, color: T.accent,
                padding: '3px 8px', border: `1px solid ${T.accent}`,
              }}>{g.count}</span>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

// ─── right preview pane ─────────────────────────────────────────────────
function StPreviewPane({ openDetail = '進入詳細 ↗' }) {
  const { sel } = useStore(s => ({ sel: s.photos.find(p => p.id === s.selectedId) }));
  if (!sel) return null;
  return (
    <aside style={{
      background: T.surface, borderLeft: `1px solid ${T.rule}`,
      padding: 18, overflow: 'auto',
      display: 'flex', flexDirection: 'column', gap: 14,
    }}>
      <StSideTitle label="PREVIEW" />
      <div style={{
        aspectRatio: '4/3',
        background: `url(${sel.src}) center/cover`,
        border: `1px solid ${T.border}`,
      }} />

      <div>
        <div style={{ fontSize: 16, fontWeight: 600 }}>{sel.name}</div>
        <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, marginTop: 4 }}>
          {sel.date} · {sel.exif}
        </div>
      </div>

      <div>
        <div style={{ fontFamily: T.mono, fontSize: 9, color: T.ink55, letterSpacing: '0.16em', marginBottom: 6 }}>RATING</div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Stars value={sel.rating} on={T.accent} off={T.ink15} size={20}
                 onClick={(r) => store.setRating(sel.id, r === sel.rating ? 0 : r)} />
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55 }}>按 1–5</span>
        </div>
      </div>

      <div>
        <div style={{ fontFamily: T.mono, fontSize: 9, color: T.ink55, letterSpacing: '0.16em', marginBottom: 6 }}>FLAG</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[
            { k: 'pick',   label: 'PICK',   bg: T.pick,   h: 'P' },
            { k: 'review', label: 'REVIEW', bg: T.review, h: 'R' },
            { k: 'reject', label: 'REJECT', bg: T.reject, h: 'X' },
          ].map(b => {
            const active = sel.flag === b.k;
            return (
              <button key={b.k} onClick={() => store.setFlag(sel.id, b.k)} style={{
                flex: 1, padding: '8px 0', cursor: 'pointer',
                border: `1px solid ${active ? b.bg : T.border}`,
                background: active ? b.bg : 'transparent',
                color: active ? T.bg : T.ink70,
                fontFamily: T.mono, fontSize: 10, fontWeight: 600, letterSpacing: '0.08em',
                position: 'relative',
              }}>
                {b.label}
                <span style={{
                  position: 'absolute', top: 2, right: 4,
                  fontSize: 8, opacity: 0.6,
                }}>{b.h}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div style={{ fontFamily: T.mono, fontSize: 9, color: T.ink55, letterSpacing: '0.16em', marginBottom: 6 }}>COLOR</div>
        <div style={{ display: 'flex', gap: 6 }}>
          {COLOR_LABELS.map((c) => {
            const active = sel.color === c.key;
            return (
              <button key={c.key} onClick={() => store.setColor(sel.id, c.key)} style={{
                width: 30, height: 30, padding: 0, cursor: 'pointer',
                border: active ? `2px solid ${T.ink}` : `1px solid ${T.border}`,
                background: c.hex,
              }} />
            );
          })}
        </div>
      </div>

      <div>
        <div style={{ fontFamily: T.mono, fontSize: 9, color: T.ink55, letterSpacing: '0.16em', marginBottom: 6 }}>NOTE</div>
        <div style={{
          padding: 10, background: T.card, border: `1px solid ${T.border}`,
          fontSize: 12, color: T.ink70, minHeight: 56,
        }}>
          {sel.note || <span style={{ color: T.ink35 }}>— 還沒有備註 —</span>}
        </div>
      </div>

      <button style={{
        marginTop: 'auto', padding: '10px 0', cursor: 'pointer',
        background: T.accent, color: T.bg, border: 'none',
        fontFamily: T.mono, fontSize: 11, letterSpacing: '0.12em', fontWeight: 600,
      }}>{openDetail}</button>
    </aside>
  );
}

Object.assign(window, {
  T, base, store, useStore,
  StPillBtn, StSideTitle, StKbd, StHeader, StPhotoCard,
  StLeftSidebar, StPreviewPane,
});
