// B · Empty / Loading states

// Reusable centered empty-state layout
function EmptyShell({ icon, title, sub, primary, secondary, children }) {
  return (
    <div style={{
      flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: T.bg, padding: 40,
    }}>
      <div style={{
        maxWidth: 480, textAlign: 'center',
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 18,
      }}>
        <div style={{
          width: 88, height: 88, border: `1.5px solid ${T.border}`,
          background: T.surface,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 38, color: T.ink55,
        }}>{icon}</div>
        <div>
          <h1 style={{
            fontSize: 22, fontWeight: 600, letterSpacing: '-0.015em',
            margin: 0, color: T.ink,
          }}>{title}</h1>
          <p style={{
            fontSize: 13, color: T.ink70, margin: '8px 0 0', lineHeight: 1.65,
          }}>{sub}</p>
        </div>
        {children}
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          {primary && (
            <button style={{
              padding: '10px 22px', background: T.accent, color: T.bg, border: 'none',
              fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.12em',
              cursor: 'pointer',
            }}>{primary}</button>
          )}
          {secondary && (
            <StPillBtn>{secondary}</StPillBtn>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Not signed in ─────────────────────────────────────────────────────
function BEmptySignIn() {
  return (
    <div style={base}>
      <header style={{
        flex: '0 0 auto', height: 56,
        borderBottom: `1px solid ${T.rule}`, background: T.surface,
        display: 'flex', alignItems: 'center', padding: '0 18px', gap: 10,
      }}>
        <div style={{
          width: 22, height: 22, background: T.accent, color: T.bg,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontFamily: T.mono, fontSize: 12, fontWeight: 700,
        }}>選</div>
        <span style={{ fontSize: 14, fontWeight: 600 }}>選圖工作室</span>
        <span style={{ fontFamily: T.mono, fontSize: 9, color: T.ink55, letterSpacing: '0.12em' }}>STUDIO</span>
      </header>

      <EmptyShell
        icon="◌"
        title="先登入你的 Google 帳號"
        sub="選圖工作室會從你的 Drive 載入照片。我們不會上傳任何檔案，所有資料只儲存在你的瀏覽器跟你授權的 Sheets 裡。"
        primary="使用 Google 登入"
        secondary="先看教學"
      >
        <div style={{
          display: 'flex', gap: 12, fontFamily: T.mono, fontSize: 10, color: T.ink55,
          marginTop: 4,
        }}>
          {[
            { icon: '✓', label: '只讀取，不修改' },
            { icon: '✓', label: '可隨時撤銷' },
            { icon: '✓', label: '本機儲存' },
          ].map(f => (
            <span key={f.label} style={{
              padding: '6px 10px', background: T.card, border: `1px solid ${T.border}`,
              display: 'inline-flex', alignItems: 'center', gap: 6,
            }}>
              <span style={{ color: T.pick }}>{f.icon}</span>
              {f.label}
            </span>
          ))}
        </div>
      </EmptyShell>
    </div>
  );
}

// ─── Signed in, no folder loaded ───────────────────────────────────────
function BEmptyNoFolder() {
  return (
    <div style={base}>
      <StHeader crumbs={['Family','—']} showSync={false} />
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '280px 1fr', overflow: 'hidden' }}>
        <aside style={{
          background: T.surface, borderRight: `1px solid ${T.rule}`,
          padding: '18px 16px',
        }}>
          <StSideTitle label="01 / SOURCE" />
          <div style={{
            marginTop: 10, padding: 14,
            background: T.card, border: `1px dashed ${T.border}`,
            textAlign: 'center', color: T.ink55,
            fontSize: 12, fontFamily: T.mono, letterSpacing: '0.06em',
          }}>
            還沒載入資料夾
          </div>
        </aside>

        <EmptyShell
          icon="↓"
          title="貼上 Google Drive 資料夾連結"
          sub="把你想處理的照片資料夾連結貼到下方，就能開始評分與標注。"
          primary="載入資料夾"
          secondary="從最近開啟"
        >
          <div style={{
            width: 460, padding: 4, background: T.card, border: `1px solid ${T.border}`,
            display: 'flex', alignItems: 'center', gap: 6,
          }}>
            <span style={{
              padding: '6px 10px', fontFamily: T.mono, fontSize: 10,
              background: T.bg, color: T.ink55, letterSpacing: '0.08em',
            }}>URL</span>
            <input
              placeholder="https://drive.google.com/drive/folders/..."
              style={{
                flex: 1, border: 'none', background: 'transparent',
                color: T.ink, fontFamily: T.mono, fontSize: 12, padding: '8px 0',
                outline: 'none',
              }} />
          </div>

          <div style={{
            width: 460, marginTop: 12,
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
          }}>
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.12em' }}>
              最近 · RECENT
            </span>
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent }}>
              查看全部
            </span>
          </div>
          <div style={{ width: 460, display: 'flex', flexDirection: 'column', gap: 4, marginTop: 8 }}>
            {FOLDERS.slice(0, 4).map(f => (
              <div key={f.id} style={{
                padding: '8px 10px', background: T.card, border: `1px solid ${T.border}`,
                display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer',
              }}>
                <span style={{ fontSize: 13, color: T.ink55 }}>📁</span>
                <div style={{ flex: 1, textAlign: 'left' }}>
                  <div style={{ fontSize: 12 }}>{f.name}</div>
                  <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, marginTop: 1 }}>
                    {f.sub}
                  </div>
                </div>
                <span style={{ fontFamily: T.mono, fontSize: 11, color: T.ink55 }}>{f.n}</span>
              </div>
            ))}
          </div>
        </EmptyShell>
      </div>
    </div>
  );
}

// ─── Filtered, no results ──────────────────────────────────────────────
function BEmptyNoResults() {
  return (
    <div style={base}>
      <StHeader />
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '280px 1fr 360px', overflow: 'hidden' }}>
        <StLeftSidebar />
        <main style={{ overflow: 'auto', background: T.bg }}>
          <div style={{ padding: '22px 26px 0' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <div>
                <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.16em' }}>
                  FOLDER · 2026 / 08 / 海邊
                </div>
                <h1 style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', margin: '4px 0 0' }}>
                  海邊系列
                  <span style={{ fontFamily: T.mono, fontSize: 14, color: T.ink55, fontWeight: 400, marginLeft: 6 }}>
                    247
                  </span>
                </h1>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <StPillBtn active>★ 5</StPillBtn>
                <StPillBtn active>已標注</StPillBtn>
                <StPillBtn active>色標：紫</StPillBtn>
              </div>
            </div>
            <div style={{ marginTop: 10, fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.04em' }}>
              <span style={{ color: T.accent }}>已套用 3 個篩選</span> · 顯示 0 / 247
            </div>
          </div>

          <div style={{
            height: 'calc(100% - 110px)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            <div style={{
              maxWidth: 380, textAlign: 'center',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14,
            }}>
              <div style={{
                width: 64, height: 64, border: `1px solid ${T.border}`,
                background: T.surface, display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 28, color: T.ink55,
              }}>⌕</div>
              <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>沒有符合的照片</h2>
              <p style={{ fontSize: 13, color: T.ink70, margin: 0, lineHeight: 1.6 }}>
                你目前篩選了 <span style={{ color: T.accent }}>★ 5 + 已標注 + 紫色標</span>，但這個資料夾裡沒有同時符合所有條件的照片。
              </p>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <button style={{
                  padding: '8px 16px', background: T.accent, color: T.bg, border: 'none',
                  fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.1em',
                  cursor: 'pointer',
                }}>清除所有篩選</button>
                <StPillBtn>放寬條件（只保留 ★ 5）</StPillBtn>
              </div>
            </div>
          </div>
        </main>
        <StPreviewPane />
      </div>
    </div>
  );
}

// ─── Loading state ─────────────────────────────────────────────────────
function BLoading() {
  return (
    <div style={base}>
      <StHeader />
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '280px 1fr 360px', overflow: 'hidden' }}>
        <aside style={{
          background: T.surface, borderRight: `1px solid ${T.rule}`,
          padding: '18px 16px',
        }}>
          {[0,1,2,3].map(i => (
            <div key={i} style={{ marginBottom: 22 }}>
              <div style={{
                width: 60, height: 8, background: T.cardHi, marginBottom: 8, borderRadius: 1,
              }} />
              {[0,1,2].map(j => (
                <div key={j} style={{
                  display: 'flex', justifyContent: 'space-between',
                  padding: '6px 8px', marginBottom: 2,
                }}>
                  <div style={{ width: '60%', height: 11, background: T.card }} />
                  <div style={{ width: 22, height: 11, background: T.card }} />
                </div>
              ))}
            </div>
          ))}
        </aside>

        <main style={{ overflow: 'auto', padding: '22px 26px', background: T.bg }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ width: 200, height: 9, background: T.cardHi, marginBottom: 8 }} />
            <div style={{ width: 280, height: 26, background: T.card }} />
          </div>

          <div style={{
            padding: '10px 14px', background: T.card, border: `1px solid ${T.accent}`,
            display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18,
          }}>
            <div style={{
              width: 18, height: 18, borderRadius: '50%',
              border: `2px solid ${T.accent}`, borderTopColor: 'transparent',
              animation: 'spin 1s linear infinite',
            }} />
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.ink }}>
              載入中 · 從 Drive 抓取縮圖 · 142 / 247
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, fontWeight: 600 }}>
              57%
            </span>
          </div>

          <style>{`@keyframes spin { to { transform: rotate(360deg); } }
          @keyframes shimmer { 0%{opacity:.5} 50%{opacity:1} 100%{opacity:.5} }`}</style>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
            {Array.from({ length: 12 }).map((_, i) => (
              <div key={i} style={{
                background: T.card, padding: 6,
                border: `1px solid ${T.border}`,
              }}>
                <div style={{
                  width: '100%', height: 150,
                  background: `linear-gradient(110deg,${T.cardHi},${T.border},${T.cardHi})`,
                  backgroundSize: '200% 100%',
                  animation: `shimmer 1.4s ease-in-out ${i * 0.08}s infinite`,
                }} />
                <div style={{
                  marginTop: 7, display: 'flex', justifyContent: 'space-between',
                }}>
                  <div style={{ width: 80, height: 9, background: T.cardHi }} />
                  <div style={{ width: 50, height: 9, background: T.cardHi }} />
                </div>
              </div>
            ))}
          </div>
        </main>

        <aside style={{
          background: T.surface, borderLeft: `1px solid ${T.rule}`,
          padding: 18, display: 'flex', flexDirection: 'column', gap: 14,
        }}>
          <div style={{ width: 80, height: 8, background: T.cardHi }} />
          <div style={{ aspectRatio: '4/3', background: T.card, border: `1px solid ${T.border}` }}>
            <div style={{
              width: '100%', height: '100%',
              background: `linear-gradient(110deg,${T.card},${T.cardHi},${T.card})`,
              backgroundSize: '200% 100%',
              animation: 'shimmer 1.4s ease-in-out infinite',
            }} />
          </div>
          <div style={{ width: '70%', height: 14, background: T.card }} />
          <div style={{ width: '90%', height: 9, background: T.cardHi }} />
          {[0,1,2,3].map(i => (
            <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ width: 50, height: 8, background: T.cardHi }} />
              <div style={{ width: '100%', height: 24, background: T.card }} />
            </div>
          ))}
        </aside>
      </div>
    </div>
  );
}

Object.assign(window, {
  BEmptySignIn, BEmptyNoFolder, BEmptyNoResults, BLoading,
});
