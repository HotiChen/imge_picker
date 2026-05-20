// B · Album Designer — 相簿排版工具 (R2 Designer)
// Canvas-based layout tool with library / background / layout / AI tabs.

function DesignerShell({ activeTab = 'bg', children, rightPanel }) {
  const tabs = [
    { k: 'bg',     label: '背景',    hot: 'B' },
    { k: 'layout', label: '版面',    hot: 'L' },
    { k: 'text',   label: '文字',    hot: 'T' },
    { k: 'ai',     label: 'AI 創生', hot: 'A' },
  ];
  return (
    <div style={base}>
      {/* Top toolbar */}
      <header style={{
        flex: '0 0 auto', height: 56,
        borderBottom: `1px solid ${T.rule}`,
        background: T.surface,
        display: 'grid', gridTemplateColumns: '260px 1fr 360px',
        alignItems: 'center',
      }}>
        <div style={{ padding: '0 18px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{
            width: 22, height: 22, background: T.accent, color: T.bg,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontFamily: T.mono, fontSize: 12, fontWeight: 700,
          }}>排</div>
          <span style={{ fontSize: 14, fontWeight: 600 }}>相簿排版</span>
          <span style={{ fontFamily: T.mono, fontSize: 9, color: T.ink55, letterSpacing: '0.12em' }}>DESIGNER</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, justifyContent: 'center' }}>
          <div style={{ fontFamily: T.mono, fontSize: 11, color: T.ink55, display: 'flex', gap: 6, alignItems: 'center' }}>
            <span>Family</span><span style={{ color: T.ink35 }}>›</span>
            <span>2026 海邊系列</span><span style={{ color: T.ink35 }}>›</span>
            <span style={{ color: T.ink }}>跨頁 03 / 08</span>
          </div>
          <span style={{ width: 1, height: 16, background: T.border }} />
          <StPillBtn>↺ 復原</StPillBtn>
          <StPillBtn>↻ 重做</StPillBtn>
          <StPillBtn>清空</StPillBtn>
        </div>
        <div style={{ padding: '0 18px', display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'flex-end' }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontFamily: T.mono, fontSize: 10, color: T.pick,
          }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: T.pick }} />
            已儲存
          </span>
          <button style={{
            padding: '7px 14px', background: T.accent, color: T.bg, border: 'none',
            fontFamily: T.mono, fontSize: 10, letterSpacing: '0.12em',
            textTransform: 'uppercase', cursor: 'pointer', fontWeight: 600,
          }}>匯出成品 ↗</button>
        </div>
      </header>

      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '260px 1fr 320px', overflow: 'hidden' }}>
        {/* Library sidebar */}
        <aside style={{
          background: T.surface, borderRight: `1px solid ${T.rule}`,
          padding: 16, overflow: 'auto',
          display: 'flex', flexDirection: 'column', gap: 14,
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <StSideTitle label="素材庫 / LIBRARY" />
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, cursor: 'pointer' }}>⟳</span>
          </div>

          <div style={{
            display: 'flex', gap: 4, padding: 2,
            background: T.card, border: `1px solid ${T.border}`,
          }}>
            {['全部','PICK','★5'].map((t, i) => (
              <button key={t} style={{
                flex: 1, padding: '5px 0', border: 'none',
                background: i === 1 ? T.accentDim : 'transparent',
                color: i === 1 ? T.accent : T.ink70,
                fontFamily: T.mono, fontSize: 10, fontWeight: 600,
                cursor: 'pointer', letterSpacing: '0.06em',
              }}>{t}</button>
            ))}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
            {PHOTOS.filter(p => p.flag === 'pick').slice(0, 14).map((p, i) => (
              <div key={p.id} style={{
                position: 'relative', aspectRatio: '4/3',
                background: `url(${p.src}) center/cover`,
                border: i === 0 ? `2px solid ${T.accent}` : '1px solid rgba(255,255,255,.08)',
                cursor: 'grab',
              }}>
                <Stars value={p.rating} size={8} on={T.accent} off="rgba(0,0,0,0.3)" />
                {i === 0 && (
                  <div style={{
                    position: 'absolute', bottom: 2, right: 3,
                    fontFamily: T.mono, fontSize: 8, color: T.accent,
                    background: 'rgba(0,0,0,0.6)', padding: '1px 4px',
                  }}>已用</div>
                )}
              </div>
            ))}
          </div>

          <div style={{ marginTop: 4, paddingTop: 12, borderTop: `1px solid ${T.rule}` }}>
            <div style={{
              fontFamily: T.mono, fontSize: 10, color: T.ink55,
              letterSpacing: '0.16em', marginBottom: 6,
            }}>使用提示</div>
            <div style={{ fontSize: 11, color: T.ink70, lineHeight: 1.6 }}>
              拖照片到畫布裡 · 雙擊套用為背景 · 右鍵清除
            </div>
          </div>
        </aside>

        {/* Canvas workspace */}
        {children}

        {/* Right panel */}
        <aside style={{
          background: T.surface, borderLeft: `1px solid ${T.rule}`,
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}>
          <div style={{
            display: 'flex', borderBottom: `1px solid ${T.rule}`,
          }}>
            {tabs.map(t => (
              <button key={t.k} style={{
                flex: 1, padding: '13px 0', border: 'none',
                background: activeTab === t.k ? T.bg : 'transparent',
                color: activeTab === t.k ? T.accent : T.ink70,
                cursor: 'pointer', position: 'relative',
                fontFamily: T.sans, fontSize: 12, fontWeight: activeTab === t.k ? 600 : 400,
                borderBottom: activeTab === t.k ? `2px solid ${T.accent}` : '2px solid transparent',
                marginBottom: -1,
              }}>
                {t.label}
                <span style={{
                  position: 'absolute', top: 2, right: 6,
                  fontFamily: T.mono, fontSize: 8, color: T.ink35,
                }}>{t.hot}</span>
              </button>
            ))}
          </div>
          <div style={{ flex: 1, padding: 16, overflow: 'auto' }}>
            {rightPanel}
          </div>
        </aside>
      </div>
    </div>
  );
}

function CanvasBezel({ children, info }) {
  return (
    <main style={{
      background: T.bgDeep, padding: 24, overflow: 'hidden',
      display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        position: 'relative',
        width: 760, height: 520,
        background: '#ffffff',
        boxShadow: '0 30px 80px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.05)',
      }}>
        {/* ruler corners */}
        {[
          { top: -10, left: -10 },
          { top: -10, right: -10 },
          { bottom: -10, left: -10 },
          { bottom: -10, right: -10 },
        ].map((pos, i) => (
          <div key={i} style={{
            position: 'absolute', ...pos,
            width: 12, height: 12,
            borderTop:    pos.top !== undefined    ? `1px solid ${T.accent}` : 'none',
            borderBottom: pos.bottom !== undefined ? `1px solid ${T.accent}` : 'none',
            borderLeft:   pos.left !== undefined   ? `1px solid ${T.accent}` : 'none',
            borderRight:  pos.right !== undefined  ? `1px solid ${T.accent}` : 'none',
          }} />
        ))}
        {children}
      </div>

      {/* Info bar */}
      <div style={{
        display: 'flex', gap: 14, alignItems: 'center',
        background: T.surface, border: `1px solid ${T.border}`,
        padding: '7px 14px',
        fontFamily: T.mono, fontSize: 10, color: T.ink70, letterSpacing: '0.06em',
      }}>
        <span>{info.size}</span>
        <span style={{ color: T.ink35 }}>·</span>
        <span>{info.zoom}</span>
        <span style={{ color: T.ink35 }}>·</span>
        <span>{info.objects}</span>
        {info.selected && (<>
          <span style={{ color: T.ink35 }}>·</span>
          <span style={{ color: T.accent }}>● {info.selected}</span>
        </>)}
      </div>
    </main>
  );
}

// ─── Screen 1 — Empty canvas / Background tab ──────────────────────────
function BDesignerEmpty() {
  return (
    <DesignerShell activeTab="bg" rightPanel={
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <div style={{
            fontFamily: T.mono, fontSize: 10, letterSpacing: '0.16em',
            color: T.ink55, marginBottom: 8,
          }}>背景顏色</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
            {['#ffffff','#000000','#fbf0e4','#1c1a14','#c8a878','#5c8a55','#c14b3b','#4a7aa8','#d9d3c5','#7c5fa3','#e5a448','#26221b'].map((c, i) => (
              <div key={c} style={{
                aspectRatio: '1/1', background: c,
                border: i === 0 ? `2px solid ${T.accent}` : '1px solid rgba(255,255,255,0.08)',
                cursor: 'pointer',
              }} />
            ))}
          </div>
        </div>

        <div>
          <div style={{
            fontFamily: T.mono, fontSize: 10, letterSpacing: '0.16em',
            color: T.ink55, marginBottom: 8,
          }}>自訂顏色</div>
          <div style={{
            padding: 10, background: T.card, border: `1px solid ${T.border}`,
            display: 'flex', alignItems: 'center', gap: 10,
          }}>
            <span style={{ width: 28, height: 28, background: '#ffffff', border: `1px solid ${T.border}` }} />
            <input defaultValue="#FFFFFF" style={{
              flex: 1, background: 'transparent', border: 'none',
              fontFamily: T.mono, fontSize: 13, color: T.ink, outline: 'none',
            }} />
          </div>
        </div>

        <div>
          <div style={{
            fontFamily: T.mono, fontSize: 10, letterSpacing: '0.16em',
            color: T.ink55, marginBottom: 8,
          }}>背景圖片</div>
          <div style={{
            padding: '28px 12px', textAlign: 'center',
            background: T.card, border: `1.5px dashed ${T.border}`,
            cursor: 'pointer',
          }}>
            <div style={{ fontSize: 22, color: T.ink35 }}>↑</div>
            <div style={{ fontSize: 12, color: T.ink70, marginTop: 4 }}>
              點擊或拖放圖片
            </div>
            <div style={{ fontFamily: T.mono, fontSize: 9, color: T.ink35, marginTop: 4 }}>
              PNG / JPG / WebP · 最大 10 MB
            </div>
          </div>
        </div>

        <div>
          <div style={{
            fontFamily: T.mono, fontSize: 10, letterSpacing: '0.16em',
            color: T.ink55, marginBottom: 8,
          }}>畫布尺寸</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[
              { l: '4:3', s: '800×600', active: true },
              { l: '16:9', s: '960×540' },
              { l: 'A4', s: '595×842' },
              { l: '正方', s: '700×700' },
            ].map(d => (
              <div key={d.l} style={{
                flex: 1, padding: '8px 0', textAlign: 'center', cursor: 'pointer',
                background: d.active ? T.cardHi : T.card,
                border: `1px solid ${d.active ? T.accent : T.border}`,
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: d.active ? T.accent : T.ink }}>
                  {d.l}
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 9, color: T.ink55, marginTop: 1 }}>
                  {d.s}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    }>
      <CanvasBezel info={{ size: '800 × 600', zoom: '100%', objects: '0 個物件' }}>
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          color: '#9a9080',
        }}>
          <div style={{
            width: 64, height: 64, border: `1.5px dashed #b8ad9a`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 26, color: '#b8ad9a',
          }}>↘</div>
          <div style={{ fontSize: 14, color: '#7a7060', marginTop: 14 }}>
            從左側拖一張照片開始
          </div>
          <div style={{
            fontFamily: T.mono, fontSize: 10, color: '#b8ad9a',
            marginTop: 4, letterSpacing: '0.06em',
          }}>或選一個自動排版模板 ⌘ 1 / 2 / 4</div>
        </div>
      </CanvasBezel>
    </DesignerShell>
  );
}

// ─── Screen 2 — Layout tab + photos placed ─────────────────────────────
function BDesignerLayout() {
  return (
    <DesignerShell activeTab="layout" rightPanel={
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div>
          <div style={{
            fontFamily: T.mono, fontSize: 10, letterSpacing: '0.16em',
            color: T.ink55, marginBottom: 8,
          }}>自動排版模板</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>
            {[
              { id: '1', n: 1, layout: 'one' },
              { id: '2-h', n: 2, layout: 'two-h' },
              { id: '2-v', n: 2, layout: 'two-v' },
              { id: '3', n: 3, layout: 'three' },
              { id: '4', n: 4, layout: 'four', active: true },
              { id: '4l', n: 4, layout: 'four-large' },
              { id: '6', n: 6, layout: 'six' },
              { id: '9', n: 9, layout: 'nine' },
            ].map(t => (
              <div key={t.id} style={{
                aspectRatio: '4/3', padding: 6,
                background: t.active ? T.cardHi : T.card,
                border: `1px solid ${t.active ? T.accent : T.border}`,
                cursor: 'pointer', position: 'relative',
              }}>
                <LayoutThumb layout={t.layout} />
                <span style={{
                  position: 'absolute', bottom: 3, right: 5,
                  fontFamily: T.mono, fontSize: 9, color: t.active ? T.accent : T.ink55,
                }}>{t.n}</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <div style={{
            fontFamily: T.mono, fontSize: 10, letterSpacing: '0.16em',
            color: T.ink55, marginBottom: 8,
          }}>間距 · GAP</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input type="range" min="0" max="40" defaultValue="12" style={{ flex: 1 }} />
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, minWidth: 32 }}>12 px</span>
          </div>
        </div>

        <div>
          <div style={{
            fontFamily: T.mono, fontSize: 10, letterSpacing: '0.16em',
            color: T.ink55, marginBottom: 8,
          }}>選中物件 · 海邊_0823.jpg</div>
          <div style={{
            padding: 10, background: T.card, border: `1px solid ${T.border}`,
            display: 'flex', flexDirection: 'column', gap: 8,
          }}>
            <DesProp k="X" v="124" />
            <DesProp k="Y" v="86" />
            <DesProp k="寬" v="332" />
            <DesProp k="高" v="218" />
            <DesProp k="旋轉" v="0°" />
            <DesProp k="圓角" v="0 px" />
            <DesProp k="陰影" v="關閉" />
          </div>
        </div>

        <div>
          <div style={{
            fontFamily: T.mono, fontSize: 10, letterSpacing: '0.16em',
            color: T.ink55, marginBottom: 8,
          }}>圖層 · LAYERS</div>
          <div style={{ background: T.card, border: `1px solid ${T.border}` }}>
            {[
              { l: '海邊_0823.jpg', active: true },
              { l: '海邊_0824.jpg' },
              { l: '海邊_0825.jpg' },
              { l: '夜景_1224.jpg' },
              { l: '背景 · 米白', meta: true },
            ].map((l, i) => (
              <div key={i} style={{
                padding: '7px 10px', fontSize: 11,
                background: l.active ? T.cardHi : 'transparent',
                color: l.meta ? T.ink55 : T.ink,
                borderBottom: i < 4 ? `1px solid ${T.rule}` : 'none',
                borderLeft: `2px solid ${l.active ? T.accent : 'transparent'}`,
                display: 'flex', alignItems: 'center', gap: 8,
                fontFamily: l.meta ? T.mono : T.sans,
              }}>
                <span style={{ color: T.ink55, fontSize: 12 }}>{l.meta ? '▢' : '▤'}</span>
                <span style={{ flex: 1 }}>{l.l}</span>
                <span style={{ color: T.ink55, fontSize: 10 }}>👁</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    }>
      <CanvasBezel info={{ size: '800 × 600', zoom: '100%', objects: '4 個物件', selected: '海邊_0823.jpg · 4-grid' }}>
        <div style={{
          position: 'absolute', inset: 0, background: '#fbf0e4', padding: 24,
        }}>
          <div style={{
            width: '100%', height: '100%', display: 'grid',
            gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 12,
          }}>
            {[PHOTOS[0], PHOTOS[1], PHOTOS[16], PHOTOS[11]].map((p, i) => (
              <div key={p.id} style={{
                position: 'relative',
                background: `url(${p.src}) center/cover`,
                outline: i === 0 ? `2px solid ${T.accent}` : 'none',
                outlineOffset: 4,
                boxShadow: '0 1px 4px rgba(0,0,0,.08)',
              }}>
                {i === 0 && (
                  <>
                    {/* Resize handles */}
                    {[
                      { top: -5, left: -5 },
                      { top: -5, right: -5 },
                      { bottom: -5, left: -5 },
                      { bottom: -5, right: -5 },
                    ].map((pos, j) => (
                      <div key={j} style={{
                        position: 'absolute', ...pos,
                        width: 10, height: 10, background: T.accent,
                        border: '2px solid #fff',
                      }} />
                    ))}
                    <div style={{
                      position: 'absolute', top: -28, left: 0,
                      padding: '3px 8px',
                      background: T.accent, color: T.bg,
                      fontFamily: T.mono, fontSize: 10, fontWeight: 600,
                      letterSpacing: '0.06em',
                    }}>海邊_0823.jpg · 332 × 218</div>
                  </>
                )}
              </div>
            ))}
          </div>
          {/* Spread label */}
          <div style={{
            position: 'absolute', top: 8, left: 12,
            fontFamily: T.mono, fontSize: 10, color: '#9a9080', letterSpacing: '0.1em',
          }}>跨頁 03 / 08 · 海邊</div>
        </div>
      </CanvasBezel>
    </DesignerShell>
  );
}

function LayoutThumb({ layout }) {
  const cell = { background: '#999', flex: 1, borderRadius: 1 };
  const wrap = { width: '100%', height: '100%', display: 'flex', gap: 2 };
  switch (layout) {
    case 'one':    return <div style={wrap}><div style={cell} /></div>;
    case 'two-h':  return <div style={wrap}><div style={cell} /><div style={cell} /></div>;
    case 'two-v':  return <div style={{ ...wrap, flexDirection: 'column' }}><div style={cell} /><div style={cell} /></div>;
    case 'three':  return <div style={wrap}><div style={cell} /><div style={{ ...wrap, flexDirection: 'column', flex: 1 }}><div style={cell} /><div style={cell} /></div></div>;
    case 'four':   return <div style={{ ...wrap, flexWrap: 'wrap' }}>{[0,1,2,3].map(i => <div key={i} style={{ ...cell, flexBasis: 'calc(50% - 1px)' }} />)}</div>;
    case 'four-large': return <div style={wrap}><div style={{ ...cell, flex: 2 }} /><div style={{ ...wrap, flexDirection: 'column', flex: 1 }}><div style={cell} /><div style={cell} /><div style={cell} /></div></div>;
    case 'six':    return <div style={{ ...wrap, flexWrap: 'wrap' }}>{[0,1,2,3,4,5].map(i => <div key={i} style={{ ...cell, flexBasis: 'calc(33.3% - 2px)', flex: 'none', height: 'calc(50% - 1px)' }} />)}</div>;
    case 'nine':   return <div style={{ ...wrap, flexWrap: 'wrap' }}>{[...Array(9)].map((_, i) => <div key={i} style={{ ...cell, flexBasis: 'calc(33.3% - 2px)', flex: 'none', height: 'calc(33.3% - 2px)' }} />)}</div>;
    default: return null;
  }
}

function DesProp({ k, v }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      fontSize: 11, fontFamily: T.mono,
    }}>
      <span style={{ color: T.ink55 }}>{k}</span>
      <span style={{ color: T.ink }}>{v}</span>
    </div>
  );
}

// ─── Screen 3 — AI background generation ──────────────────────────────
function BDesignerAI() {
  return (
    <DesignerShell activeTab="ai" rightPanel={
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div style={{
          padding: '8px 12px', background: T.accentDim,
          borderLeft: `3px solid ${T.accent}`,
        }}>
          <div style={{
            fontFamily: T.mono, fontSize: 10, color: T.accent,
            letterSpacing: '0.16em', marginBottom: 4,
          }}>✨ AI 背景生成</div>
          <div style={{ fontSize: 11, color: T.ink70, lineHeight: 1.5 }}>
            描述你想要的氛圍，AI 會生成 4 個背景供你選用
          </div>
        </div>

        <div>
          <div style={{
            fontFamily: T.mono, fontSize: 10, letterSpacing: '0.16em',
            color: T.ink55, marginBottom: 6,
          }}>提示詞 · PROMPT</div>
          <textarea
            defaultValue="夢幻黃昏海岸線，溫暖橘色光線，極簡棚拍，淺景深"
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: 10, minHeight: 80, resize: 'vertical',
              background: T.card, color: T.ink,
              border: `1px solid ${T.border}`,
              fontFamily: T.sans, fontSize: 12, outline: 'none',
            }} />
        </div>

        <div>
          <div style={{
            fontFamily: T.mono, fontSize: 10, letterSpacing: '0.16em',
            color: T.ink55, marginBottom: 8,
          }}>快速風格</div>
          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {[
              '夢幻森林','韓式簡約','復古莫蘭迪','日系底片','棚拍純白','油畫油彩','膠片質感','水彩',
            ].map((t, i) => (
              <span key={t} style={{
                padding: '4px 10px', borderRadius: 999,
                fontFamily: T.mono, fontSize: 10,
                background: i === 0 ? T.accentDim : T.card,
                color: i === 0 ? T.accent : T.ink70,
                border: `1px solid ${i === 0 ? T.accent : T.border}`,
                cursor: 'pointer',
              }}>{t}</span>
            ))}
          </div>
        </div>

        <button style={{
          padding: '12px 0', cursor: 'pointer',
          background: T.accent, color: T.bg, border: 'none',
          fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.14em',
        }}>✨ 開始生成 · GENERATE</button>

        <div style={{
          fontFamily: T.mono, fontSize: 10, color: T.ink55,
          letterSpacing: '0.04em', textAlign: 'center',
        }}>每次生成 4 張 · 約需 12 秒 · 不會儲存提示詞</div>

        <div style={{
          marginTop: 6, padding: '10px 12px',
          background: T.card, border: `1px solid ${T.border}`,
        }}>
          <div style={{
            fontFamily: T.mono, fontSize: 10, color: T.ink55,
            letterSpacing: '0.12em', marginBottom: 4,
          }}>歷史紀錄</div>
          {[
            '夢幻黃昏海岸線',
            '韓式簡約棚拍 · 米白',
            '復古莫蘭迪 · 灰調',
          ].map(h => (
            <div key={h} style={{
              padding: '4px 0', fontSize: 11, color: T.ink70,
              borderBottom: `1px solid ${T.rule}`,
              display: 'flex', justifyContent: 'space-between', cursor: 'pointer',
            }}>
              <span style={{ flex: 1, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{h}</span>
              <span style={{ color: T.accent, fontFamily: T.mono, fontSize: 9 }}>↺</span>
            </div>
          ))}
        </div>
      </div>
    }>
      <CanvasBezel info={{ size: '800 × 600', zoom: '100%', objects: '4 個物件', selected: 'AI 生成預覽中' }}>
        <div style={{
          position: 'absolute', inset: 0,
          background: 'linear-gradient(135deg, #f4d8a8 0%, #e6a87c 35%, #c97a6a 70%, #6b4a4f 100%)',
          padding: 24,
        }}>
          <div style={{
            width: '100%', height: '100%', display: 'grid',
            gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 12,
          }}>
            {[PHOTOS[0], PHOTOS[1], PHOTOS[16], PHOTOS[3]].map((p, i) => (
              <div key={p.id} style={{
                background: `url(${p.src}) center/cover`,
                boxShadow: '0 6px 18px rgba(0,0,0,.3)',
                borderRadius: 4,
              }} />
            ))}
          </div>

          {/* AI Generation overlay - candidate strip */}
          <div style={{
            position: 'absolute', bottom: -82, left: 0, right: 0,
            display: 'flex', justifyContent: 'center', gap: 8,
          }}>
            {[
              { active: true,  bg: 'linear-gradient(135deg,#f4d8a8,#e6a87c,#c97a6a,#6b4a4f)' },
              { bg: 'linear-gradient(135deg,#cfe2c0,#9ec99c,#6b9d7c,#3a5f4a)' },
              { bg: 'linear-gradient(135deg,#f0e8d8,#d8cab0,#a89878,#5a4a30)' },
              { bg: 'linear-gradient(135deg,#dce4f0,#a8b8d0,#7080a0,#404a60)' },
            ].map((c, i) => (
              <div key={i} style={{
                width: 90, height: 64,
                background: c.bg,
                border: `2px solid ${c.active ? T.accent : T.border}`,
                cursor: 'pointer', position: 'relative',
              }}>
                <span style={{
                  position: 'absolute', top: 2, left: 4,
                  fontFamily: T.mono, fontSize: 9, color: '#fff',
                  textShadow: '0 1px 2px rgba(0,0,0,.5)', fontWeight: 600,
                }}>{['01','02','03','04'][i]}</span>
                {c.active && (
                  <div style={{
                    position: 'absolute', top: -10, right: -10,
                    width: 18, height: 18, borderRadius: '50%',
                    background: T.accent, color: T.bg,
                    fontFamily: T.mono, fontSize: 10, fontWeight: 700,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>✓</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </CanvasBezel>
    </DesignerShell>
  );
}

// ─── Screen 4 — Export modal ───────────────────────────────────────────
function BDesignerExport() {
  return (
    <ModalShell width={920} title="匯出相簿" sub="ALBUM EXPORT" badge="⌘E">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 22 }}>
        {/* Preview */}
        <div>
          <div style={{
            fontFamily: T.mono, fontSize: 10, letterSpacing: '0.16em',
            color: T.ink55, marginBottom: 8,
          }}>預覽</div>
          <div style={{
            aspectRatio: '4/3', background: '#fbf0e4', padding: 12,
            border: `1px solid ${T.border}`,
            position: 'relative',
          }}>
            <div style={{
              width: '100%', height: '100%', display: 'grid',
              gridTemplateColumns: '1fr 1fr', gridTemplateRows: '1fr 1fr', gap: 6,
            }}>
              {[PHOTOS[0], PHOTOS[1], PHOTOS[16], PHOTOS[11]].map(p => (
                <div key={p.id} style={{
                  background: `url(${p.src}) center/cover`,
                }} />
              ))}
            </div>
            <div style={{
              position: 'absolute', top: 16, left: 20,
              fontFamily: T.mono, fontSize: 9, color: '#7a7060', letterSpacing: '0.1em',
            }}>跨頁 03 / 08</div>
          </div>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            fontFamily: T.mono, fontSize: 10, color: T.ink55, marginTop: 6,
          }}>
            <span>800 × 600 · 4 個物件</span>
            <span>未壓縮 · 預估 1.4 MB</span>
          </div>
        </div>

        <div>
          <div style={{
            fontFamily: T.mono, fontSize: 10, letterSpacing: '0.16em',
            color: T.ink55, marginBottom: 8,
          }}>01 / 格式</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
            {[
              { l: 'PNG',  meta: '無壓縮 · 透明背景', active: true },
              { l: 'JPG',  meta: '檔案小 · 適合分享' },
              { l: 'PDF',  meta: '可印刷 · CMYK' },
            ].map(f => (
              <div key={f.l} style={{
                flex: 1, padding: 12, cursor: 'pointer',
                background: f.active ? T.cardHi : T.card,
                border: `1px solid ${f.active ? T.accent : T.border}`,
              }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: f.active ? T.accent : T.ink }}>
                  {f.l}
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 9, color: T.ink55, marginTop: 4 }}>
                  {f.meta}
                </div>
              </div>
            ))}
          </div>

          <div style={{
            fontFamily: T.mono, fontSize: 10, letterSpacing: '0.16em',
            color: T.ink55, marginBottom: 8,
          }}>02 / 解析度</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
            {[
              { l: '網頁',  s: '72 dpi' },
              { l: '印刷',  s: '300 dpi', active: true },
              { l: '高解析',s: '600 dpi' },
            ].map(r => (
              <div key={r.l} style={{
                flex: 1, padding: '8px 0', textAlign: 'center', cursor: 'pointer',
                background: r.active ? T.cardHi : T.card,
                border: `1px solid ${r.active ? T.accent : T.border}`,
              }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: r.active ? T.accent : T.ink }}>
                  {r.l}
                </div>
                <div style={{ fontFamily: T.mono, fontSize: 9, color: T.ink55, marginTop: 1 }}>
                  {r.s}
                </div>
              </div>
            ))}
          </div>

          <div style={{
            fontFamily: T.mono, fontSize: 10, letterSpacing: '0.16em',
            color: T.ink55, marginBottom: 8,
          }}>03 / 整本相簿</div>
          <div style={{
            padding: 12, background: T.card, border: `1px solid ${T.border}`,
            display: 'flex', alignItems: 'center', gap: 12,
          }}>
            <button style={{
              width: 22, height: 22, padding: 0,
              background: T.accent, color: T.bg, border: 'none',
              fontSize: 12, fontWeight: 700, cursor: 'pointer',
            }}>✓</button>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 12, color: T.ink }}>匯出全部 8 個跨頁為 ZIP</div>
              <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, marginTop: 2 }}>
                每個跨頁一張圖 · 預估 11.2 MB
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={{
        padding: '12px 16px', background: T.bg, border: `1px solid ${T.border}`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.1em' }}>
            檔案命名
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 13, color: T.ink, marginTop: 2 }}>
            Album_海邊系列_2026-05-19.png
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <StPillBtn>取消</StPillBtn>
          <button style={{
            padding: '10px 22px', background: T.accent, color: T.bg, border: 'none',
            fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.12em',
            cursor: 'pointer',
          }}>下載 PNG ↗</button>
        </div>
      </div>
    </ModalShell>
  );
}

Object.assign(window, {
  BDesignerEmpty, BDesignerLayout, BDesignerAI, BDesignerExport,
});
