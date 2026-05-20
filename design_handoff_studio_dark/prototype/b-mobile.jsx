// B · Mobile / RWD screens — iPhone 14 Pro 390×844

function PhoneShell({ children, statusTime = '14:32', dark = true }) {
  return (
    <div style={{
      width: '100%', height: '100%',
      background: dark ? T.bg : T.surface,
      display: 'flex', flexDirection: 'column',
      fontFamily: T.sans, color: T.ink,
      position: 'relative', overflow: 'hidden',
    }}>
      {/* Status bar */}
      <div style={{
        flex: '0 0 auto', height: 44,
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '0 22px',
        fontFamily: T.mono, fontSize: 14, fontWeight: 600, color: T.ink,
      }}>
        <span>{statusTime}</span>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <span>●●●</span>
          <span style={{ fontSize: 11 }}>5G</span>
          <span style={{
            display: 'inline-block', width: 22, height: 11,
            border: `1px solid ${T.ink}`, borderRadius: 2, position: 'relative',
          }}>
            <span style={{
              position: 'absolute', inset: 1, right: 4, background: T.ink,
            }} />
          </span>
        </span>
      </div>
      {children}
      {/* Home indicator */}
      <div style={{
        flex: '0 0 auto', height: 24,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{ width: 134, height: 5, borderRadius: 3, background: T.ink55 }} />
      </div>
    </div>
  );
}

// ─── Mobile Grid ───────────────────────────────────────────────────────
function BMobileGrid() {
  const { photos, selectedId } = useStore(s => ({
    photos: s.photos, selectedId: s.selectedId,
  }));
  return (
    <PhoneShell>
      {/* Top bar */}
      <div style={{
        flex: '0 0 auto', padding: '6px 16px 10px',
        borderBottom: `1px solid ${T.rule}`,
      }}>
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8,
        }}>
          <span style={{ fontFamily: T.mono, fontSize: 9, color: T.ink55, letterSpacing: '0.16em' }}>
            FAMILY · 2026 · 08
          </span>
          <span style={{
            display: 'inline-flex', gap: 10, alignItems: 'center',
            fontSize: 17, color: T.ink,
          }}>
            <span>⌕</span>
            <span>↗</span>
            <span>⋯</span>
          </span>
        </div>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0, letterSpacing: '-0.02em' }}>
          海邊系列
          <span style={{ fontFamily: T.mono, fontSize: 12, color: T.ink55, fontWeight: 400, marginLeft: 6 }}>
            247
          </span>
        </h1>
        <div style={{
          marginTop: 10, display: 'flex', gap: 6, overflow: 'auto',
        }}>
          {[
            { l: '全部',   active: true },
            { l: '★ 5',   active: false },
            { l: 'PICK',  active: false },
            { l: '已標注', active: false },
            { l: '色標',  active: false },
          ].map(c => (
            <span key={c.l} style={{
              flex: '0 0 auto',
              padding: '5px 11px', borderRadius: 999,
              fontSize: 11, fontWeight: c.active ? 600 : 400,
              background: c.active ? T.accent : T.card,
              color: c.active ? T.bg : T.ink70,
              border: `1px solid ${c.active ? T.accent : T.border}`,
            }}>{c.l}</span>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div style={{
        flex: 1, overflow: 'auto', padding: '10px 14px 90px',
        display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8,
        alignContent: 'start',
      }}>
        {photos.slice(0, 12).map(p => {
          const fc = flagColor(p.flag);
          const cx = colorHex(p.color);
          return (
            <div key={p.id} onClick={() => store.selectPhoto(p.id)} style={{
              background: T.card,
              border: `1px solid ${p.id === selectedId ? T.accent : T.border}`,
              padding: 4, position: 'relative',
            }}>
              <div style={{
                width: '100%', aspectRatio: '1/1',
                background: `url(${p.src}) center/cover`,
                position: 'relative',
              }}>
                {fc && (
                  <div style={{
                    position: 'absolute', top: 5, left: 5,
                    padding: '2px 5px', background: fc, color: T.bg,
                    fontFamily: T.mono, fontSize: 8, fontWeight: 700, letterSpacing: '0.06em',
                  }}>{flagLabel(p.flag)}</div>
                )}
                {cx && (
                  <div style={{
                    position: 'absolute', top: 5, right: 5,
                    width: 8, height: 8, background: cx,
                  }} />
                )}
                {p.annotated && (
                  <div style={{
                    position: 'absolute', bottom: 5, right: 5,
                    width: 18, height: 18, background: T.bg, color: T.accent,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontSize: 11, fontWeight: 700,
                  }}>✎</div>
                )}
              </div>
              <div style={{
                padding: '5px 4px 2px', display: 'flex',
                justifyContent: 'space-between', alignItems: 'center',
              }}>
                <Stars value={p.rating} on={T.accent} off={T.ink15} size={9} />
                <span style={{ fontFamily: T.mono, fontSize: 9, color: T.ink55 }}>
                  {p.name.split('_')[1]?.replace('.jpg','')}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Floating filter pill */}
      <div style={{
        position: 'absolute', bottom: 88, left: '50%', transform: 'translateX(-50%)',
        padding: '10px 18px', background: T.accent, color: T.bg,
        borderRadius: 999, fontFamily: T.mono, fontSize: 11, fontWeight: 700,
        letterSpacing: '0.1em', display: 'flex', alignItems: 'center', gap: 8,
        boxShadow: '0 8px 30px rgba(229,164,72,.4)',
      }}>
        <span>⫶</span>
        篩選 · FILTER
      </div>

      {/* Bottom tab */}
      <div style={{
        position: 'absolute', bottom: 24, left: 0, right: 0,
        padding: '8px 4px 0',
        background: T.surface, borderTop: `1px solid ${T.rule}`,
        display: 'flex', justifyContent: 'space-around',
      }}>
        {[
          { i: '▦', l: '網格',   active: true },
          { i: '▥', l: '幻燈片', active: false },
          { i: '⊟', l: '比較',   active: false },
          { i: '⌃', l: '匯出',   active: false },
          { i: '☰', l: '更多',   active: false },
        ].map((t, i) => (
          <div key={i} style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            padding: '4px 12px',
            color: t.active ? T.accent : T.ink55,
          }}>
            <span style={{ fontSize: 18, lineHeight: 1 }}>{t.i}</span>
            <span style={{ fontFamily: T.mono, fontSize: 9, letterSpacing: '0.04em' }}>{t.l}</span>
          </div>
        ))}
      </div>
    </PhoneShell>
  );
}

// ─── Mobile Detail ─────────────────────────────────────────────────────
function BMobileDetail() {
  const { photos, selectedId } = useStore(s => ({
    photos: s.photos, selectedId: s.selectedId,
  }));
  const p = photos.find(x => x.id === selectedId) || photos[0];
  const idx = photos.findIndex(x => x.id === p.id);

  return (
    <PhoneShell>
      {/* Top bar */}
      <div style={{
        flex: '0 0 auto', padding: '6px 16px 10px',
        display: 'flex', alignItems: 'center', gap: 12,
      }}>
        <span style={{ fontSize: 18, color: T.ink }}>‹</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{p.name}</div>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55 }}>
            {(idx + 1).toString().padStart(2, '0')} / {photos.length} · {p.date.split(' ')[0]}
          </div>
        </div>
        <span style={{
          padding: '4px 8px', background: T.card, border: `1px solid ${T.border}`,
          fontFamily: T.mono, fontSize: 10, color: T.ink70,
        }}>✎ 標注</span>
      </div>

      {/* Photo */}
      <div style={{
        flex: '0 0 auto', height: 320, position: 'relative',
        background: `url(${p.src}) center/cover #000`,
        margin: '0 14px', border: `1px solid ${T.border}`,
      }}>
        {p.annotated && (
          <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
            <ellipse cx="32%" cy="38%" rx="56" ry="38" fill="none" stroke={T.accent} strokeWidth="2.5" />
            <ellipse cx="62%" cy="56%" rx="38" ry="28" fill="none" stroke="#9bbd6a" strokeWidth="2.5" />
          </svg>
        )}
        <button onClick={() => store.prev()} style={{
          position: 'absolute', top: '50%', left: 8, transform: 'translateY(-50%)',
          width: 32, height: 32, background: 'rgba(0,0,0,.5)', border: 'none',
          color: T.ink, fontSize: 18, borderRadius: '50%',
        }}>‹</button>
        <button onClick={() => store.next()} style={{
          position: 'absolute', top: '50%', right: 8, transform: 'translateY(-50%)',
          width: 32, height: 32, background: 'rgba(0,0,0,.5)', border: 'none',
          color: T.ink, fontSize: 18, borderRadius: '50%',
        }}>›</button>
      </div>

      {/* Action sheet */}
      <div style={{
        flex: 1, overflow: 'auto', padding: '14px 16px 24px',
        display: 'flex', flexDirection: 'column', gap: 14,
      }}>
        {/* Rating */}
        <div style={{
          padding: '12px 14px', background: T.card, border: `1px solid ${T.border}`,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.14em' }}>
              RATING
            </span>
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55 }}>{p.rating}/5</span>
          </div>
          <div style={{ marginTop: 8 }}>
            <Stars value={p.rating} on={T.accent} off={T.ink15} size={26}
                   onClick={(r) => store.setRating(p.id, r === p.rating ? 0 : r)} />
          </div>
        </div>

        {/* Flag */}
        <div style={{ display: 'flex', gap: 6 }}>
          {[
            { k: 'pick',   label: '精選', bg: T.pick },
            { k: 'review', label: '覆審', bg: T.review },
            { k: 'reject', label: '捨棄', bg: T.reject },
          ].map(b => {
            const active = p.flag === b.k;
            return (
              <button key={b.k} onClick={() => store.setFlag(p.id, b.k)} style={{
                flex: 1, padding: '12px 0', cursor: 'pointer',
                border: `1px solid ${active ? b.bg : T.border}`,
                background: active ? b.bg : T.card,
                color: active ? T.bg : T.ink70,
                fontSize: 13, fontWeight: 600,
              }}>{b.label}</button>
            );
          })}
        </div>

        {/* Color */}
        <div style={{
          padding: '10px 14px', background: T.card, border: `1px solid ${T.border}`,
        }}>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.14em', marginBottom: 8 }}>
            COLOR LABEL
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {COLOR_LABELS.map(c => {
              const active = p.color === c.key;
              return (
                <button key={c.key} onClick={() => store.setColor(p.id, c.key)} style={{
                  flex: 1, height: 30, padding: 0, cursor: 'pointer',
                  border: active ? `2px solid ${T.ink}` : `1px solid ${T.border}`,
                  background: c.hex,
                }} />
              );
            })}
          </div>
        </div>

        {/* Note */}
        <div style={{
          padding: '10px 14px', background: T.card, border: `1px solid ${T.border}`,
        }}>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.14em' }}>
            NOTE
          </div>
          <div style={{ fontSize: 13, color: T.ink, marginTop: 6, lineHeight: 1.6 }}>
            {p.note || <span style={{ color: T.ink35 }}>輕點加上備註...</span>}
          </div>
        </div>
      </div>
    </PhoneShell>
  );
}

// ─── Mobile Filter Drawer ──────────────────────────────────────────────
function BMobileFilters() {
  return (
    <PhoneShell>
      {/* Dimmed grid behind */}
      <div style={{ position: 'absolute', inset: 0, top: 44, bottom: 24, background: T.bgDeep, opacity: 0.85 }}>
        <div style={{
          padding: 14, display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, opacity: 0.3,
        }}>
          {PHOTOS.slice(0, 6).map(p => (
            <div key={p.id} style={{
              aspectRatio: '1/1', background: `url(${p.src}) center/cover`,
            }} />
          ))}
        </div>
      </div>

      {/* Bottom sheet */}
      <div style={{
        position: 'absolute', left: 0, right: 0, bottom: 24,
        background: T.surface, borderTop: `1px solid ${T.border}`,
        padding: '8px 16px 18px',
        maxHeight: '78%', display: 'flex', flexDirection: 'column', gap: 14,
        boxShadow: '0 -16px 40px rgba(0,0,0,.5)',
      }}>
        {/* drag handle */}
        <div style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, background: T.border }} />

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>篩選</h2>
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent }}>清除全部</span>
        </div>

        {/* Star rating */}
        <div>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.14em', marginBottom: 8 }}>
            星級
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {['全部','5★','4★','3★','2★','1★','未評分'].map((l, i) => (
              <span key={l} style={{
                padding: '7px 13px', borderRadius: 999,
                fontSize: 12, fontWeight: i === 1 ? 600 : 400,
                background: i === 1 ? T.accent : T.card,
                color: i === 1 ? T.bg : T.ink70,
                border: `1px solid ${i === 1 ? T.accent : T.border}`,
              }}>{l}</span>
            ))}
          </div>
        </div>

        {/* Flag */}
        <div>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.14em', marginBottom: 8 }}>
            旗標
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[
              { l: 'PICK',   bg: T.pick,   active: true,  n: 38 },
              { l: 'REVIEW', bg: T.review, n: 11 },
              { l: 'REJECT', bg: T.reject, n: 9 },
            ].map(b => (
              <div key={b.l} style={{
                flex: 1, padding: '10px 0', textAlign: 'center',
                background: b.active ? T.cardHi : T.card,
                border: `1px solid ${b.active ? b.bg : T.border}`,
                borderTop: `2px solid ${b.bg}`,
              }}>
                <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.1em' }}>{b.l}</div>
                <div style={{ fontFamily: T.mono, fontSize: 16, fontWeight: 600 }}>{b.n}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Color */}
        <div>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.14em', marginBottom: 8 }}>
            色標
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {COLOR_LABELS.map((c, i) => (
              <button key={c.key} style={{
                flex: 1, height: 36, padding: 0,
                border: i === 0 ? `2px solid ${T.ink}` : `1px solid ${T.border}`,
                background: c.hex,
              }} />
            ))}
          </div>
        </div>

        {/* AI */}
        <div>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.14em', marginBottom: 8 }}>
            AI 智慧
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {AI_GROUPS.slice(0, 3).map(g => (
              <div key={g.id} style={{
                padding: '10px 12px', background: T.card, border: `1px solid ${T.border}`,
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <span style={{
                  width: 22, height: 22, background: T.accentDim,
                  color: T.accent, fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}>{g.count}</span>
                <span style={{ fontSize: 13, flex: 1 }}>{g.label}</span>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.ink55 }}>›</span>
              </div>
            ))}
          </div>
        </div>

        <button style={{
          padding: '14px 0', background: T.accent, color: T.bg, border: 'none',
          fontFamily: T.mono, fontSize: 12, fontWeight: 700, letterSpacing: '0.14em',
        }}>套用 · 顯示 38 張</button>
      </div>
    </PhoneShell>
  );
}

Object.assign(window, { BMobileGrid, BMobileDetail, BMobileFilters });
