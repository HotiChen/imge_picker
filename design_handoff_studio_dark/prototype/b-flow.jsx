// B · Main flow screens — Grid, Detail, Compare, Slideshow, BatchSelection

// ─── Grid view (interactive) ───────────────────────────────────────────
function BGrid({ density = 'medium' }) {
  const { photos, selectedId, selection } = useStore(s => ({
    photos: s.photos, selectedId: s.selectedId, selection: s.selection,
  }));
  const cols = density === 'dense' ? 6 : density === 'sparse' ? 3 : 4;
  return (
    <div style={base}>
      <StHeader />
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '280px 1fr 360px', overflow: 'hidden' }}>
        <StLeftSidebar />
        <main style={{ overflow: 'auto', padding: '22px 26px', background: T.bg }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
            <div>
              <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.16em' }}>
                FOLDER · 2026 / 08 / 海邊
              </div>
              <h1 style={{
                fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em',
                margin: '4px 0 0',
              }}>
                海邊系列
                <span style={{ fontFamily: T.mono, fontSize: 14, color: T.ink55, fontWeight: 400, marginLeft: 6 }}>
                  247
                </span>
              </h1>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <StPillBtn active>★ 5</StPillBtn>
              <StPillBtn>PICK</StPillBtn>
              <StPillBtn>已標注</StPillBtn>
              <span style={{ width: 1, height: 18, background: T.border, margin: '0 4px' }} />
              <div style={{ display: 'flex', border: `1px solid ${T.border}`, background: T.surface }}>
                {['⊞','▦','▤'].map((t, i) => (
                  <button key={i} style={{
                    width: 28, height: 24, border: 'none',
                    background: i === 1 ? T.accentDim : 'transparent',
                    color: i === 1 ? T.accent : T.ink70,
                    fontSize: 13, cursor: 'pointer',
                  }}>{t}</button>
                ))}
              </div>
            </div>
          </div>

          <div style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gap: density === 'dense' ? 8 : density === 'sparse' ? 16 : 12,
          }}>
            {photos.slice(0, density === 'dense' ? 18 : 12).map(p => (
              <StPhotoCard key={p.id} p={p}
                selected={p.id === selectedId}
                batched={selection.has(p.id)}
                density={density}
                onClick={() => store.selectPhoto(p.id)} />
            ))}
          </div>
        </main>
        <StPreviewPane />
      </div>
    </div>
  );
}

// ─── Grid view with batch selection bar ────────────────────────────────
function BGridBatch({ density = 'medium' }) {
  // pre-populate selection
  React.useEffect(() => {
    if (store.get().selection.size === 0) {
      store.set(s => ({ ...s, selection: new Set(s.photos.slice(0, 12).map(p => p.id)) }));
    }
  }, []);
  const { photos, selectedId, selection } = useStore(s => ({
    photos: s.photos, selectedId: s.selectedId, selection: s.selection,
  }));
  return (
    <div style={base}>
      <StHeader />
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '280px 1fr 360px', overflow: 'hidden' }}>
        <StLeftSidebar />
        <main style={{ overflow: 'auto', padding: '22px 26px', background: T.bg, position: 'relative' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 16 }}>
            <div>
              <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.16em' }}>
                BATCH MODE · 已選 {selection.size} 張
              </div>
              <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', margin: '4px 0 0' }}>
                海邊系列
                <span style={{ fontFamily: T.mono, fontSize: 14, color: T.ink55, fontWeight: 400, marginLeft: 6 }}>
                  247
                </span>
              </h1>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <StPillBtn>取消全選</StPillBtn>
              <StPillBtn active>反選</StPillBtn>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, paddingBottom: 80 }}>
            {photos.slice(0, 12).map(p => (
              <StPhotoCard key={p.id} p={p}
                selected={p.id === selectedId}
                batched={selection.has(p.id)}
                density={density}
                onClick={() => store.toggleSel(p.id)}
                onCheck={(id) => store.toggleSel(id)} />
            ))}
          </div>

          {/* Sticky batch action bar */}
          <div style={{
            position: 'absolute', left: 22, right: 22, bottom: 16,
            background: T.surface, border: `1px solid ${T.accent}`,
            boxShadow: '0 12px 40px rgba(0,0,0,.45)',
            padding: '12px 16px',
            display: 'flex', alignItems: 'center', gap: 14,
          }}>
            <div style={{
              padding: '4px 10px', background: T.accent, color: T.bg,
              fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.1em',
            }}>{selection.size} 已選</div>
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55 }}>批次操作 · BATCH</span>
            <span style={{ flex: 1 }} />

            <BatchBtn label="設定評分">
              <Stars value={0} size={11} on={T.accent} off={T.ink15}
                     onClick={() => {}} />
            </BatchBtn>
            <BatchBtn label="加旗標" hot="P">
              <span style={{ display: 'flex', gap: 3 }}>
                <span style={{ width: 8, height: 8, background: T.pick, borderRadius: '50%' }} />
                <span style={{ width: 8, height: 8, background: T.review, borderRadius: '50%' }} />
                <span style={{ width: 8, height: 8, background: T.reject, borderRadius: '50%' }} />
              </span>
            </BatchBtn>
            <BatchBtn label="加色標">
              <span style={{ display: 'flex', gap: 2 }}>
                {COLOR_LABELS.slice(0, 5).map(c => (
                  <span key={c.key} style={{ width: 7, height: 10, background: c.hex }} />
                ))}
              </span>
            </BatchBtn>
            <BatchBtn label="移到資料夾" hot="M">📁</BatchBtn>
            <BatchBtn label="匯出" hot="⌘E">↗</BatchBtn>
            <BatchBtn label="刪除" danger hot="⌫">×</BatchBtn>
          </div>
        </main>
        <StPreviewPane />
      </div>
    </div>
  );
}
function BatchBtn({ label, children, hot, danger }) {
  return (
    <button style={{
      padding: '8px 12px',
      background: T.card, color: danger ? T.reject : T.ink,
      border: `1px solid ${danger ? T.reject : T.border}`,
      cursor: 'pointer',
      display: 'flex', alignItems: 'center', gap: 8,
      fontSize: 11,
    }}>
      <span style={{ fontSize: 13, opacity: 0.9 }}>{children}</span>
      <span>{label}</span>
      {hot && <span style={{ fontFamily: T.mono, fontSize: 9, color: T.ink55, marginLeft: 2 }}>{hot}</span>}
    </button>
  );
}

// ─── Detail / Annotate ─────────────────────────────────────────────────
function BDetail() {
  const { photos, selectedId } = useStore(s => ({
    photos: s.photos, selectedId: s.selectedId,
  }));
  const p = photos.find(x => x.id === selectedId) || photos[0];
  const idx = photos.findIndex(x => x.id === p.id);

  return (
    <div style={base}>
      <StHeader crumbs={['Family','2026','08 海邊', p.name]} />
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '72px 1fr 320px', overflow: 'hidden' }}>
        {/* Toolbar */}
        <aside style={{
          background: T.surface, borderRight: `1px solid ${T.rule}`,
          padding: '14px 0', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
        }}>
          {[
            { k: 'V', icon: '↖' },
            { k: 'H', icon: '✋' },
            { k: 'B', icon: '○', active: true },
            { k: 'A', icon: '→' },
            { k: 'T', icon: 'T' },
            { k: 'E', icon: '⌫' },
          ].map(t => (
            <button key={t.k} style={{
              width: 44, height: 44, marginBottom: 3,
              background: t.active ? T.accent : 'transparent',
              color: t.active ? T.bg : T.ink70,
              border: 'none', cursor: 'pointer',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 16, position: 'relative',
            }}>
              {t.icon}
              <span style={{
                position: 'absolute', bottom: 4, right: 5,
                fontFamily: T.mono, fontSize: 8, opacity: t.active ? 0.7 : 0.45,
              }}>{t.k}</span>
            </button>
          ))}
          <div style={{ width: 28, height: 1, background: T.border, margin: '10px 0' }} />
          {['#c14b3b','#e5a448','#4a7aa8','#5c8a55','#f1ead8'].map((c, i) => (
            <button key={c} style={{
              width: 24, height: 24, borderRadius: '50%', margin: '2px 0',
              border: i === 1 ? `2px solid ${T.ink}` : '1px solid rgba(255,255,255,.08)',
              background: c, cursor: 'pointer',
            }} />
          ))}
        </aside>

        <main style={{ background: T.bg, display: 'flex', flexDirection: 'column' }}>
          <div style={{
            height: 38, borderBottom: `1px solid ${T.rule}`,
            background: T.surface,
            display: 'flex', alignItems: 'center', gap: 12, padding: '0 14px',
            fontFamily: T.mono, fontSize: 10, color: T.ink70, letterSpacing: '0.06em',
          }}>
            <span>{(idx + 1).toString().padStart(2, '0')} / {photos.length}</span>
            <span style={{ color: T.ink35 }}>·</span>
            <span>{p.annotated ? '4' : '0'} ANNOTATIONS</span>
            <span style={{ color: T.ink35 }}>·</span>
            <span style={{ color: T.pick }}>● SAVED 14:33</span>
            <div style={{ flex: 1 }} />
            <StPillBtn>−</StPillBtn>
            <span>100%</span>
            <StPillBtn>+</StPillBtn>
            <StPillBtn>FIT</StPillBtn>
            <StPillBtn active>F · 幻燈片</StPillBtn>
          </div>

          <div style={{
            flex: 1, position: 'relative', display: 'flex',
            alignItems: 'center', justifyContent: 'center', padding: 28, overflow: 'hidden',
          }}>
            <button onClick={() => store.prev()} style={navArrow('left')}>‹</button>
            <button onClick={() => store.next()} style={navArrow('right')}>›</button>
            <div style={{
              position: 'relative', width: '84%', height: '92%',
              background: `url(${p.src}) center/cover`,
              boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
            }}>
              {p.annotated && (
                <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
                  <ellipse cx="32%" cy="38%" rx="72" ry="48" fill="none" stroke={T.accent} strokeWidth="3" />
                  <ellipse cx="62%" cy="56%" rx="48" ry="36" fill="none" stroke="#9bbd6a" strokeWidth="3" />
                  <line x1="78%" y1="22%" x2="62%" y2="42%" stroke="#c97a6a" strokeWidth="3" markerEnd="url(#arrD)" />
                  <defs>
                    <marker id="arrD" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto">
                      <path d="M0,0 L10,5 L0,10 z" fill="#c97a6a" />
                    </marker>
                  </defs>
                </svg>
              )}
              {p.annotated && (
                <div style={{
                  position: 'absolute', top: '20%', left: '78%',
                  background: T.accent, color: T.bg,
                  padding: '4px 8px', fontFamily: T.mono, fontSize: 10, fontWeight: 600,
                }}>裁切到這邊</div>
              )}
            </div>
          </div>

          {/* Filmstrip */}
          <div style={{
            height: 108, background: T.surface, borderTop: `1px solid ${T.rule}`,
            padding: '12px 14px', display: 'flex', gap: 6, overflow: 'auto',
          }}>
            {photos.map((pp) => (
              <div key={pp.id} onClick={() => store.selectPhoto(pp.id)} style={{
                flex: '0 0 auto', width: 120, height: 84,
                background: `url(${pp.src}) center/cover`,
                outline: pp.id === p.id ? `2px solid ${T.accent}` : '1px solid rgba(255,255,255,0.08)',
                outlineOffset: -1, position: 'relative', cursor: 'pointer',
              }}>
                {pp.flag && (
                  <div style={{
                    position: 'absolute', top: 0, left: 0,
                    padding: '2px 5px', background: flagColor(pp.flag),
                    color: T.bg, fontFamily: T.mono, fontSize: 8, fontWeight: 700,
                  }}>{pp.flag === 'pick' ? 'P' : pp.flag === 'reject' ? 'X' : 'R'}</div>
                )}
                {colorHex(pp.color) && (
                  <div style={{
                    position: 'absolute', top: 4, right: 4,
                    width: 7, height: 7, background: colorHex(pp.color),
                  }} />
                )}
                <div style={{
                  position: 'absolute', bottom: 2, right: 4,
                  fontFamily: T.mono, fontSize: 8, color: T.accent,
                  textShadow: '0 1px 2px rgba(0,0,0,.7)',
                }}>{pp.rating ? '★'.repeat(pp.rating) : ''}</div>
              </div>
            ))}
          </div>
        </main>

        {/* Right info */}
        <aside style={{
          background: T.surface, borderLeft: `1px solid ${T.rule}`,
          padding: 16, overflow: 'auto',
          display: 'flex', flexDirection: 'column', gap: 16,
        }}>
          <div>
            <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '0.18em', color: T.ink55 }}>FRAME</div>
            <div style={{ fontSize: 22, fontWeight: 600, marginTop: 2 }}>{p.name}</div>
          </div>

          <DetailRow k="評分">
            <Stars value={p.rating} on={T.accent} off={T.ink15} size={14}
                   onClick={(r) => store.setRating(p.id, r === p.rating ? 0 : r)} />
          </DetailRow>
          <DetailRow k="旗標">
            {p.flag ? (
              <span style={{
                fontFamily: T.mono, fontSize: 10, padding: '2px 8px',
                background: flagColor(p.flag), color: T.bg, fontWeight: 600,
              }}>{flagLabel(p.flag)}</span>
            ) : <span style={{ color: T.ink35, fontFamily: T.mono, fontSize: 10 }}>—</span>}
          </DetailRow>
          <DetailRow k="色標">
            {colorHex(p.color) ? (
              <span style={{ width: 14, height: 14, background: colorHex(p.color), display: 'inline-block' }} />
            ) : <span style={{ color: T.ink35, fontFamily: T.mono, fontSize: 10 }}>—</span>}
          </DetailRow>
          <DetailRow k="標注">{p.annotated ? '4 個' : <span style={{ color: T.ink35 }}>—</span>}</DetailRow>

          <div style={{ borderTop: `1px solid ${T.rule}`, paddingTop: 12 }}>
            <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '0.18em', color: T.ink55, marginBottom: 6 }}>NOTE</div>
            <textarea
              defaultValue={p.note}
              onChange={(e) => store.setNote(p.id, e.target.value)}
              style={{
                width: '100%', padding: 10, background: T.card, color: T.ink,
                border: `1px solid ${T.border}`, fontSize: 12, fontFamily: T.sans,
                minHeight: 80, resize: 'vertical', outline: 'none',
                boxSizing: 'border-box',
              }} />
            <div style={{ marginTop: 6, fontFamily: T.mono, fontSize: 9, color: T.ink55 }}>
              ● 自動儲存
            </div>
          </div>

          <div style={{ borderTop: `1px solid ${T.rule}`, paddingTop: 12 }}>
            <div style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '0.18em', color: T.ink55, marginBottom: 8 }}>EXIF</div>
            <table style={{ width: '100%', fontFamily: T.mono, fontSize: 11, borderCollapse: 'collapse' }}>
              <tbody>
                {[
                  ['日期',  p.date.split(' ')[0]],
                  ['時間',  p.date.split(' ')[1]],
                  ['機身',  'Sony α7iv'],
                  ['鏡頭',  'FE 24-70 GM'],
                  ['設定',  p.exif.split('·').slice(1).join('·').trim()],
                  ['尺寸',  '6048 × 4032'],
                ].map(([k, v]) => (
                  <tr key={k} style={{ borderBottom: `1px solid ${T.rule}` }}>
                    <td style={{ color: T.ink55, padding: '4px 0', width: '36%' }}>{k}</td>
                    <td style={{ color: T.ink }}>{v}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </aside>
      </div>
    </div>
  );
}
function DetailRow({ k, children }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '4px 0', fontSize: 12,
    }}>
      <span style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.1em' }}>{k}</span>
      {children}
    </div>
  );
}
function navArrow(side) {
  return {
    position: 'absolute', top: '50%', [side]: 12, transform: 'translateY(-50%)',
    width: 36, height: 36, zIndex: 2,
    background: 'rgba(0,0,0,.4)', border: `1px solid ${T.border}`,
    color: T.ink, fontSize: 20, cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
}

// ─── Compare mode ──────────────────────────────────────────────────────
function BCompare() {
  // pick 3 photos for compare
  const photos = useStore(s => s.photos);
  const candidates = [photos[0], photos[1], photos[2]];
  const [winner, setWinner] = React.useState(candidates[0].id);

  return (
    <div style={base}>
      <StHeader crumbs={['Family','2026','08 海邊','比較模式']} showSync={false} />
      <div style={{
        flex: 1, background: T.bgDeep,
        padding: '20px 24px', overflow: 'hidden',
        display: 'flex', flexDirection: 'column', gap: 16,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <div>
            <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.18em' }}>
              COMPARE · 比較模式 · 選出最佳 1 張
            </div>
            <h1 style={{ fontSize: 24, fontWeight: 600, margin: '4px 0 0', letterSpacing: '-0.02em' }}>
              海邊系列 · 3 張相似照片
            </h1>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <StPillBtn>+ 加入比較</StPillBtn>
            <StPillBtn>退出 (Esc)</StPillBtn>
          </div>
        </div>

        <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, minHeight: 0 }}>
          {candidates.map(p => {
            const isWin = winner === p.id;
            return (
              <div key={p.id} style={{
                display: 'flex', flexDirection: 'column',
                background: T.surface,
                border: `2px solid ${isWin ? T.accent : T.border}`,
                position: 'relative',
                minHeight: 0,
              }}>
                {isWin && (
                  <div style={{
                    position: 'absolute', top: 0, left: 0,
                    background: T.accent, color: T.bg,
                    padding: '4px 10px',
                    fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                    zIndex: 2,
                  }}>★ 已選為最佳</div>
                )}
                <div style={{
                  flex: 1, background: `url(${p.src}) center/cover`, minHeight: 0,
                }} />
                <div style={{ padding: 14, borderTop: `1px solid ${T.rule}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 15, fontWeight: 600 }}>{p.name}</div>
                    <Stars value={p.rating} on={T.accent} off={T.ink15} size={14}
                           onClick={(r) => store.setRating(p.id, r === p.rating ? 0 : r)} />
                  </div>
                  <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, marginTop: 2 }}>
                    {p.date.split(' ')[1]} · {p.exif}
                  </div>
                  <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
                    <button onClick={() => setWinner(p.id)} style={{
                      flex: 1, padding: '8px 0', cursor: 'pointer',
                      background: isWin ? T.accent : T.card,
                      color: isWin ? T.bg : T.ink,
                      border: `1px solid ${isWin ? T.accent : T.border}`,
                      fontFamily: T.mono, fontSize: 10, fontWeight: 600, letterSpacing: '0.1em',
                    }}>{isWin ? '★ 最佳' : '選為最佳'}</button>
                    <button style={{
                      padding: '8px 12px', cursor: 'pointer',
                      background: T.card, color: T.reject,
                      border: `1px solid ${T.reject}`,
                      fontFamily: T.mono, fontSize: 10, fontWeight: 600,
                    }}>X · 捨棄</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Hint bar */}
        <div style={{
          height: 40, background: T.surface, border: `1px solid ${T.border}`,
          display: 'flex', alignItems: 'center', padding: '0 14px', gap: 18,
          fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.06em',
        }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <StKbd>1</StKbd><StKbd>2</StKbd><StKbd>3</StKbd> 選最佳
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <StKbd>X</StKbd> 捨棄
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <StKbd>Z</StKbd> 1:1 對齊放大
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <StKbd>Esc</StKbd> 離開
          </span>
          <span style={{ flex: 1 }} />
          <span>AI 建議 · 第 1 張構圖最佳，第 2 張可能輕微失焦</span>
        </div>
      </div>
    </div>
  );
}

// ─── Slideshow ────────────────────────────────────────────────────────
function BSlideshow() {
  const { photos, selectedId } = useStore(s => ({
    photos: s.photos, selectedId: s.selectedId,
  }));
  const p = photos.find(x => x.id === selectedId) || photos[0];
  const idx = photos.findIndex(x => x.id === p.id);

  return (
    <div style={{ ...base, background: '#0a0907' }}>
      <div style={{
        height: 48, padding: '0 24px',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', background: T.accent,
            boxShadow: `0 0 8px ${T.accent}`,
          }} />
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.2em' }}>
            SLIDESHOW · PRESS ESC TO EXIT
          </span>
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.ink70 }}>
            <span style={{ color: T.accent, fontWeight: 600 }}>
              {(idx + 1).toString().padStart(2, '0')}
            </span>
            <span style={{ color: T.ink35 }}> / </span>
            {photos.length}
          </span>
          <button style={{
            background: 'transparent', border: `1px solid ${T.border}`,
            color: T.ink, padding: '5px 12px', fontFamily: T.mono, fontSize: 10,
            cursor: 'pointer', letterSpacing: '0.1em',
          }}>⏸ AUTO · 5s</button>
        </div>
      </div>

      <div style={{
        flex: 1, position: 'relative', display: 'flex',
        alignItems: 'center', justifyContent: 'center', padding: '0 80px',
      }}>
        <button onClick={() => store.prev()} style={navArrow('left')}>‹</button>
        <button onClick={() => store.next()} style={navArrow('right')}>›</button>

        <div style={{
          width: '78%', height: '80%',
          background: `url(${p.src}) center/cover`,
          boxShadow: '0 40px 100px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.05)',
        }} />

        <div style={{
          position: 'absolute', bottom: 28, left: 80, right: 80,
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
        }}>
          <div>
            <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.2em' }}>
              FRAME {(idx + 1).toString().padStart(2, '0')} · {p.date.split(' ')[0]}
            </div>
            <div style={{ fontSize: 26, fontWeight: 600, marginTop: 4, letterSpacing: '-0.015em' }}>
              {p.name}
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, marginTop: 4 }}>{p.exif}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <Stars value={p.rating} on={T.accent} off="rgba(255,255,255,.1)" size={20}
                   onClick={(r) => store.setRating(p.id, r === p.rating ? 0 : r)} />
            <div style={{ marginTop: 10, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
              {[
                { k: '1–5', l: '評分' },
                { k: 'P',   l: '精選' },
                { k: 'X',   l: '捨棄' },
                { k: '→',   l: '下一張' },
              ].map(h => (
                <span key={h.k} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <StKbd>{h.k}</StKbd>
                  <span style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.06em' }}>{h.l}</span>
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div style={{
        height: 76, padding: '12px 24px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        display: 'flex', gap: 4, justifyContent: 'center', alignItems: 'center',
        overflow: 'hidden',
      }}>
        {photos.slice(0, 14).map(pp => (
          <div key={pp.id} onClick={() => store.selectPhoto(pp.id)} style={{
            width: 64, height: 48,
            background: `url(${pp.src}) center/cover`,
            opacity: pp.id === p.id ? 1 : 0.35,
            outline: pp.id === p.id ? `2px solid ${T.accent}` : 'none',
            outlineOffset: -1, cursor: 'pointer',
          }} />
        ))}
      </div>
    </div>
  );
}

Object.assign(window, { BGrid, BGridBatch, BDetail, BCompare, BSlideshow });
