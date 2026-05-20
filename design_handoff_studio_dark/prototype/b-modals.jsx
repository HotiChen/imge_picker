// B · Modals + Folder list — Shortcuts, Export, Sync, Settings, FolderList

function ModalShell({ width = 920, height, children, title, sub, badge }) {
  return (
    <div style={{
      ...base, padding: 0,
      background: 'rgba(10,8,5,.7)',
      alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width, maxHeight: height || '90%',
        background: T.surface, border: `1px solid ${T.border}`,
        boxShadow: '0 40px 100px rgba(0,0,0,.6)',
        padding: '22px 28px',
        display: 'flex', flexDirection: 'column', gap: 18,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
            {badge && (
              <span style={{
                padding: '4px 8px', background: T.accent, color: T.bg,
                fontFamily: T.mono, fontSize: 10, fontWeight: 700, letterSpacing: '0.16em',
              }}>{badge}</span>
            )}
            <h1 style={{ fontSize: 22, fontWeight: 600, letterSpacing: '-0.01em', margin: 0 }}>{title}</h1>
            {sub && <span style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.16em' }}>{sub}</span>}
          </div>
          <button style={{
            width: 28, height: 28, background: 'transparent',
            border: `1px solid ${T.border}`, color: T.ink,
            cursor: 'pointer', fontSize: 14,
          }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Shortcuts ─────────────────────────────────────────────────────────
function BShortcuts() {
  return (
    <ModalShell width={1020} title="快捷鍵" sub="KEYBOARD · AI · MANUAL" badge="?">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px 36px' }}>
        {SHORTCUTS.map(g => (
          <div key={g.title}>
            <div style={{
              fontFamily: T.mono, fontSize: 9, letterSpacing: '0.22em',
              color: T.accent, paddingBottom: 5,
              borderBottom: `1px solid ${T.rule}`, marginBottom: 8,
            }}>{g.title.toUpperCase()}</div>
            {g.items.map((it, i) => (
              <div key={i} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '5px 0',
              }}>
                <span style={{ fontSize: 12, color: T.ink70 }}>{it.desc}</span>
                <span style={{ display: 'flex', gap: 3 }}>
                  {it.keys.map((k, j) => <StKbd key={j}>{k}</StKbd>)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div style={{
        padding: '14px 18px',
        background: T.bg, border: `1px solid ${T.border}`,
        borderLeft: `3px solid ${T.accent}`,
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
          <span style={{
            fontFamily: T.mono, fontSize: 9, letterSpacing: '0.22em', color: T.accent,
          }}>● AI ASSISTANT</span>
          <span style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55 }}>
            已掃描 247 / 247 · 6.2s
          </span>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {AI_GROUPS.map(g => (
            <div key={g.id} style={{
              padding: 10, background: T.card, border: `1px solid ${T.border}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ fontFamily: T.mono, fontSize: 9, color: T.ink55, letterSpacing: '0.1em' }}>
                  {g.kind.toUpperCase()}
                </span>
                <span style={{ fontFamily: T.mono, fontSize: 10, color: T.accent, fontWeight: 600 }}>
                  {g.count}
                </span>
              </div>
              <div style={{ fontSize: 13, fontWeight: 500, marginTop: 4 }}>{g.label}</div>
              <div style={{ fontFamily: T.mono, fontSize: 9, color: T.ink55, marginTop: 4 }}>
                {g.kind === 'similar' ? '保留 1 張' : g.kind === 'blur' ? '建議捨棄' : 'AI 構圖最佳'}
              </div>
            </div>
          ))}
        </div>
      </div>
    </ModalShell>
  );
}

// ─── Export panel ──────────────────────────────────────────────────────
function BExport() {
  const [target, setTarget] = React.useState('zip');
  const [scope, setScope] = React.useState('pick');
  const [withAnno, setWithAnno] = React.useState(true);

  const targets = [
    { k: 'zip',    label: 'ZIP · 帶標注照片',  hint: '把所有已標注照片 + 圈圈打包成 .zip 寄給客戶' },
    { k: 'json',   label: 'JSON · 中繼資料',    hint: '評分 / 旗標 / 色標 / 備註 → JSON 檔案' },
    { k: 'sheets', label: 'Google Sheets',     hint: '同步到雲端表單，方便客戶在線上看' },
    { k: 'csv',    label: 'CSV',                hint: '相容 Excel / Numbers' },
  ];
  const scopes = [
    { k: 'all',     label: '全部 (247)',       n: 247 },
    { k: 'pick',    label: '只匯出 PICK (38)', n: 38  },
    { k: '5star',   label: '5 ★ 以上 (18)',    n: 18  },
    { k: 'sel',     label: '目前選取 (12)',    n: 12  },
    { k: 'anno',    label: '已標注 (24)',      n: 24  },
  ];

  return (
    <ModalShell width={780} title="匯出" sub="EXPORT" badge="⌘E">
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18 }}>
        <div>
          <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.16em', color: T.ink55, marginBottom: 8 }}>
            01 / 匯出目標
          </div>
          {targets.map(t => {
            const active = target === t.k;
            return (
              <div key={t.k} onClick={() => setTarget(t.k)} style={{
                padding: 12, marginBottom: 5, cursor: 'pointer',
                background: active ? T.cardHi : T.card,
                border: `1px solid ${active ? T.accent : T.border}`,
                display: 'flex', alignItems: 'flex-start', gap: 10,
              }}>
                <span style={{
                  width: 14, height: 14, borderRadius: '50%',
                  border: `2px solid ${active ? T.accent : T.border}`,
                  background: active ? T.accent : 'transparent',
                  flexShrink: 0, marginTop: 2,
                }} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 500 }}>{t.label}</div>
                  <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, marginTop: 3, lineHeight: 1.5 }}>
                    {t.hint}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div>
          <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.16em', color: T.ink55, marginBottom: 8 }}>
            02 / 匯出範圍
          </div>
          {scopes.map(s => {
            const active = scope === s.k;
            return (
              <div key={s.k} onClick={() => setScope(s.k)} style={{
                padding: '10px 12px', marginBottom: 4, cursor: 'pointer',
                background: active ? T.cardHi : 'transparent',
                borderLeft: `2px solid ${active ? T.accent : 'transparent'}`,
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                fontSize: 12, color: active ? T.ink : T.ink70,
              }}>
                <span>{s.label}</span>
                <span style={{ fontFamily: T.mono, fontSize: 10, color: active ? T.accent : T.ink55 }}>
                  {s.n}
                </span>
              </div>
            );
          })}

          <div style={{ fontFamily: T.mono, fontSize: 10, letterSpacing: '0.16em', color: T.ink55, margin: '18px 0 8px' }}>
            03 / 選項
          </div>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '8px 12px', background: T.card, border: `1px solid ${T.border}`, marginBottom: 4,
          }}>
            <span style={{ fontSize: 12 }}>包含畫圈標注</span>
            <button onClick={() => setWithAnno(!withAnno)} style={{
              width: 36, height: 20, borderRadius: 10, border: 'none', cursor: 'pointer',
              background: withAnno ? T.accent : T.border, position: 'relative',
              transition: 'background .12s',
            }}>
              <span style={{
                position: 'absolute', top: 2, left: withAnno ? 18 : 2,
                width: 16, height: 16, borderRadius: '50%', background: T.bg,
                transition: 'left .12s',
              }} />
            </button>
          </div>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '8px 12px', background: T.card, border: `1px solid ${T.border}`, marginBottom: 4,
          }}>
            <span style={{ fontSize: 12 }}>原始解析度</span>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent }}>6048 × 4032</span>
          </div>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '8px 12px', background: T.card, border: `1px solid ${T.border}`,
          }}>
            <span style={{ fontSize: 12 }}>檔案命名</span>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.ink70 }}>{'{rating}-{name}'}</span>
          </div>
        </div>
      </div>

      <div style={{
        padding: '12px 16px', background: T.bg, border: `1px solid ${T.border}`,
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <div>
          <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.1em' }}>
            預估
          </div>
          <div style={{ fontFamily: T.mono, fontSize: 13, color: T.ink, marginTop: 2 }}>
            38 張 · ~280 MB · 約 1 分 20 秒
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <StPillBtn>取消</StPillBtn>
          <button style={{
            padding: '10px 22px', background: T.accent, color: T.bg, border: 'none',
            fontFamily: T.mono, fontSize: 11, fontWeight: 700, letterSpacing: '0.12em',
            cursor: 'pointer',
          }}>開始匯出 ↗</button>
        </div>
      </div>
    </ModalShell>
  );
}

// ─── Sync progress ─────────────────────────────────────────────────────
function BSync() {
  const items = [
    { f: '2026 海邊系列', n: 247, status: 'done',    detail: '已上傳 247 / 247' },
    { f: '2026 阿橘',     n: 184, status: 'done',    detail: '已上傳 184 / 184' },
    { f: '2026 山行',     n: 96,  status: 'doing',   detail: '上傳中 67 / 96 ...' },
    { f: '2026 花',       n: 64,  status: 'pending', detail: '排隊中' },
    { f: '2026 聖誕',     n: 42,  status: 'pending', detail: '排隊中' },
  ];
  return (
    <ModalShell width={680} title="同步到 Google Sheets" sub="SYNC" badge="●">
      <div style={{ padding: '10px 0 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.ink70 }}>
            掃描中 · 第 3 / 5 個資料夾
          </span>
          <span style={{ fontFamily: T.mono, fontSize: 11, color: T.accent, fontWeight: 600 }}>
            498 / 633 frames · 78%
          </span>
        </div>
        <div style={{
          height: 8, background: T.card, border: `1px solid ${T.border}`, position: 'relative',
        }}>
          <div style={{
            position: 'absolute', inset: 0, width: '78%',
            background: `repeating-linear-gradient(45deg, ${T.accent}, ${T.accent} 8px, #c89236 8px, #c89236 16px)`,
          }} />
        </div>
      </div>

      <div style={{
        background: T.bg, border: `1px solid ${T.border}`,
        maxHeight: 260, overflow: 'auto',
      }}>
        {items.map((it, i) => (
          <div key={it.f} style={{
            display: 'flex', alignItems: 'center', gap: 12,
            padding: '11px 14px',
            borderBottom: i < items.length - 1 ? `1px solid ${T.rule}` : 'none',
          }}>
            <span style={{
              width: 18, height: 18,
              background: it.status === 'done' ? T.pick : it.status === 'doing' ? T.accent : T.card,
              border: it.status === 'pending' ? `1px solid ${T.border}` : 'none',
              color: T.bg, fontSize: 11, fontWeight: 700,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              {it.status === 'done' ? '✓' : it.status === 'doing' ? '⟳' : ''}
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, color: T.ink }}>{it.f}</div>
              <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, marginTop: 1 }}>
                {it.detail}
              </div>
            </div>
            <span style={{ fontFamily: T.mono, fontSize: 11, color: T.ink55 }}>{it.n}</span>
          </div>
        ))}
      </div>

      <div style={{
        padding: '11px 14px', background: T.card, border: `1px solid ${T.border}`,
        fontFamily: T.mono, fontSize: 10, color: T.ink55, lineHeight: 1.6,
      }}>
        <div style={{ color: T.ink70, marginBottom: 4 }}>● 即時日誌</div>
        <div>14:33:08 · 連線 Google Drive · OK</div>
        <div>14:33:09 · 掃描資料夾 · 5 個</div>
        <div>14:33:14 · 「2026 海邊系列」 · 247 frames · ✓</div>
        <div>14:33:48 · 「2026 阿橘」 · 184 frames · ✓</div>
        <div>14:34:02 · 「2026 山行」 · 上傳中...</div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <StPillBtn>背景執行</StPillBtn>
        <button style={{
          padding: '8px 18px', background: 'transparent', color: T.reject,
          border: `1px solid ${T.reject}`, fontFamily: T.mono, fontSize: 11,
          fontWeight: 600, letterSpacing: '0.1em', cursor: 'pointer',
        }}>取消同步</button>
      </div>
    </ModalShell>
  );
}

// ─── Settings ──────────────────────────────────────────────────────────
function BSettings() {
  const [tab, setTab] = React.useState('account');
  const tabs = [
    { k: 'account',   label: '帳號' },
    { k: 'storage',   label: '儲存與同步' },
    { k: 'shortcuts', label: '快捷鍵' },
    { k: 'appearance',label: '外觀' },
    { k: 'about',     label: '關於' },
  ];

  return (
    <ModalShell width={960} title="設定" sub="SETTINGS" badge="⌘,">
      <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', gap: 22, minHeight: 480 }}>
        <aside>
          {tabs.map(t => (
            <div key={t.k} onClick={() => setTab(t.k)} style={{
              padding: '10px 12px', cursor: 'pointer',
              background: tab === t.k ? T.cardHi : 'transparent',
              borderLeft: `2px solid ${tab === t.k ? T.accent : 'transparent'}`,
              fontSize: 13,
              color: tab === t.k ? T.ink : T.ink70,
            }}>{t.label}</div>
          ))}
        </aside>

        <div style={{ overflow: 'auto' }}>
          {tab === 'account' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <SectionTitle>登入帳號</SectionTitle>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 14,
                padding: 14, background: T.card, border: `1px solid ${T.border}`,
              }}>
                <div style={{
                  width: 48, height: 48, borderRadius: '50%',
                  background: 'linear-gradient(135deg,#c8a878,#8a6a44)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: T.bg, fontWeight: 700, fontSize: 18,
                }}>HC</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 15, fontWeight: 600 }}>洪欣怡</div>
                  <div style={{ fontFamily: T.mono, fontSize: 11, color: T.ink55, marginTop: 2 }}>
                    happy.cat@gmail.com
                  </div>
                </div>
                <StPillBtn>切換帳號</StPillBtn>
                <button style={{
                  padding: '6px 12px', background: 'transparent', color: T.reject,
                  border: `1px solid ${T.reject}`, fontFamily: T.mono, fontSize: 10,
                  cursor: 'pointer', letterSpacing: '0.1em',
                }}>登出</button>
              </div>

              <SectionTitle>權限</SectionTitle>
              {[
                ['Google Drive · 讀取', '允許'],
                ['Google Sheets · 寫入', '允許'],
                ['本機儲存 (Local Storage)', '12.4 MB'],
              ].map(([k, v]) => (
                <div key={k} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 14px', background: T.card, border: `1px solid ${T.border}`,
                }}>
                  <span style={{ fontSize: 12 }}>{k}</span>
                  <span style={{ fontFamily: T.mono, fontSize: 11, color: T.pick }}>{v}</span>
                </div>
              ))}
            </div>
          )}

          {tab === 'storage' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <SectionTitle>同步</SectionTitle>
              <SettingRow k="自動同步" v="每 15 分鐘" />
              <SettingRow k="同步目標 Google Sheets" v="2026 / 選圖紀錄" />
              <SettingRow k="同步時包含畫圈標注" v="開啟" />
              <SectionTitle>本機快取</SectionTitle>
              <SettingRow k="縮圖快取" v="247 張 · 124 MB" />
              <SettingRow k="清除快取" v="→" />
            </div>
          )}

          {tab === 'shortcuts' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <SectionTitle>自訂快捷鍵</SectionTitle>
              {SHORTCUTS[0].items.map((it, i) => (
                <div key={i} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 14px', background: T.card, border: `1px solid ${T.border}`,
                }}>
                  <span style={{ fontSize: 12 }}>{it.desc}</span>
                  <div style={{ display: 'flex', gap: 5 }}>
                    {it.keys.map((k, j) => <StKbd key={j}>{k}</StKbd>)}
                  </div>
                </div>
              ))}
              {SHORTCUTS[1].items.slice(0, 4).map((it, i) => (
                <div key={i + 'b'} style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '10px 14px', background: T.card, border: `1px solid ${T.border}`,
                }}>
                  <span style={{ fontSize: 12 }}>{it.desc}</span>
                  <div style={{ display: 'flex', gap: 5 }}>
                    {it.keys.map((k, j) => <StKbd key={j}>{k}</StKbd>)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'appearance' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <SectionTitle>主題</SectionTitle>
              <div style={{ display: 'flex', gap: 10 }}>
                {[
                  { l: 'STUDIO DARK', bg: '#15120d', accent: '#e5a448', active: true },
                  { l: 'STUDIO BLACK', bg: '#000', accent: '#e5a448' },
                  { l: 'STUDIO COOL', bg: '#0f1419', accent: '#5b8def' },
                ].map(t => (
                  <div key={t.l} style={{
                    flex: 1, padding: 16, cursor: 'pointer',
                    background: t.bg,
                    border: `2px solid ${t.active ? t.accent : T.border}`,
                  }}>
                    <div style={{
                      width: 22, height: 4, background: t.accent, marginBottom: 8,
                    }} />
                    <div style={{
                      fontFamily: T.mono, fontSize: 10, color: '#fff',
                      letterSpacing: '0.16em',
                    }}>{t.l}</div>
                  </div>
                ))}
              </div>
              <SectionTitle>縮圖密度</SectionTitle>
              <SettingRow k="預設密度" v="中（4 欄）" />
              <SettingRow k="顯示檔名" v="開啟" />
              <SettingRow k="顯示色標" v="開啟" />
            </div>
          )}

          {tab === 'about' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <SectionTitle>關於</SectionTitle>
              <div style={{
                padding: 16, background: T.card, border: `1px solid ${T.border}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{
                    width: 32, height: 32, background: T.accent, color: T.bg,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: T.mono, fontWeight: 700, fontSize: 18,
                  }}>選</div>
                  <div>
                    <div style={{ fontSize: 16, fontWeight: 600 }}>選圖工作室 Studio</div>
                    <div style={{ fontFamily: T.mono, fontSize: 11, color: T.ink55 }}>
                      version 2.0.0 · build 2026.05
                    </div>
                  </div>
                </div>
                <div style={{
                  marginTop: 12, fontSize: 12, color: T.ink70, lineHeight: 1.6,
                }}>
                  從 Google Drive 載入照片，做星級評分、色標、旗標和畫圈標注，再同步給客戶或同事審閱。
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </ModalShell>
  );
}
function SectionTitle({ children }) {
  return (
    <div style={{
      fontFamily: T.mono, fontSize: 10, letterSpacing: '0.2em',
      color: T.accent, textTransform: 'uppercase',
      padding: '4px 0', marginTop: 6,
    }}>{children}</div>
  );
}
function SettingRow({ k, v }) {
  return (
    <div style={{
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      padding: '10px 14px', background: T.card, border: `1px solid ${T.border}`,
    }}>
      <span style={{ fontSize: 12 }}>{k}</span>
      <span style={{ fontFamily: T.mono, fontSize: 11, color: T.ink70 }}>{v}</span>
    </div>
  );
}

// ─── Folder list / Project view ────────────────────────────────────────
function BFolders() {
  const folderId = useStore(s => s.folderId);
  return (
    <div style={base}>
      <StHeader crumbs={['Family','所有專案']} />
      <div style={{ flex: 1, display: 'grid', gridTemplateColumns: '320px 1fr', overflow: 'hidden' }}>
        <aside style={{
          background: T.surface, borderRight: `1px solid ${T.rule}`,
          padding: '18px 16px', overflow: 'auto',
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
            <StSideTitle label="所有資料夾" />
            <StPillBtn>+ 新增</StPillBtn>
          </div>

          <div style={{
            padding: '8px 10px', background: T.card, border: `1px solid ${T.border}`,
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14,
          }}>
            <span style={{ color: T.ink35, fontSize: 12 }}>⌕</span>
            <input placeholder="搜尋資料夾..." style={{
              flex: 1, border: 'none', background: 'transparent',
              color: T.ink, fontFamily: T.sans, fontSize: 12, outline: 'none',
            }} />
            <span style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55 }}>⌘K</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {FOLDERS.map(f => {
              const active = f.id === folderId;
              return (
                <div key={f.id} onClick={() => store.setFolder(f.id)} style={{
                  padding: '10px 12px', cursor: 'pointer',
                  background: active ? T.cardHi : T.card,
                  border: `1px solid ${active ? T.accent : T.border}`,
                  borderLeft: `3px solid ${active ? T.accent : T.border}`,
                  display: 'flex', alignItems: 'center', gap: 10,
                }}>
                  <span style={{ fontSize: 14, color: T.ink55 }}>📁</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13, fontWeight: active ? 600 : 400,
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    }}>{f.name}</div>
                    <div style={{
                      fontFamily: T.mono, fontSize: 10, color: T.ink55, marginTop: 1,
                    }}>{f.sub}</div>
                  </div>
                  <span style={{
                    fontFamily: T.mono, fontSize: 11, color: active ? T.accent : T.ink55,
                    padding: '2px 6px', background: active ? T.accentDim : 'transparent',
                  }}>{f.n}</span>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: 22 }}>
            <StSideTitle label="統計" />
            <div style={{ marginTop: 10, fontFamily: T.mono, fontSize: 11, color: T.ink70, lineHeight: 1.9 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>總照片</span><span style={{ color: T.ink }}>2,455</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>已評分</span><span style={{ color: T.ink }}>1,832</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>已標注</span><span style={{ color: T.ink }}>178</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>儲存空間</span><span style={{ color: T.ink }}>18.4 GB</span>
              </div>
            </div>
          </div>
        </aside>

        <main style={{ padding: '24px 28px', overflow: 'auto', background: T.bg }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'baseline',
            marginBottom: 16,
          }}>
            <div>
              <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, letterSpacing: '0.16em' }}>
                所有專案 · ALL PROJECTS
              </div>
              <h1 style={{ fontSize: 26, fontWeight: 600, margin: '4px 0 0', letterSpacing: '-0.02em' }}>
                Family 家庭照片
                <span style={{ fontFamily: T.mono, fontSize: 14, color: T.ink55, fontWeight: 400, marginLeft: 8 }}>
                  6 個資料夾 · 2,455 frames
                </span>
              </h1>
            </div>
            <StPillBtn active>＋ 從 Drive 載入新資料夾</StPillBtn>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
            {FOLDERS.map((f, i) => (
              <div key={f.id} style={{
                background: T.card, border: `1px solid ${f.active ? T.accent : T.border}`,
                position: 'relative',
              }}>
                <div style={{
                  height: 140, position: 'relative',
                  background: 'linear-gradient(135deg,#3a3024,#1c1a14)',
                  overflow: 'hidden',
                }}>
                  {/* photo collage */}
                  <div style={{ position: 'absolute', inset: 0, display: 'grid', gridTemplateColumns: '2fr 1fr', gridTemplateRows: '1fr 1fr', gap: 2 }}>
                    <div style={{
                      gridRow: '1 / 3',
                      background: `url(${PHOTOS[(i * 4) % PHOTOS.length].src}) center/cover`,
                    }} />
                    <div style={{ background: `url(${PHOTOS[(i * 4 + 1) % PHOTOS.length].src}) center/cover` }} />
                    <div style={{ background: `url(${PHOTOS[(i * 4 + 2) % PHOTOS.length].src}) center/cover` }} />
                  </div>
                  {f.active && (
                    <div style={{
                      position: 'absolute', top: 8, right: 8,
                      padding: '3px 8px', background: T.accent, color: T.bg,
                      fontFamily: T.mono, fontSize: 9, fontWeight: 700, letterSpacing: '0.12em',
                    }}>CURRENT</div>
                  )}
                </div>
                <div style={{ padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{f.name}</div>
                    <span style={{ fontFamily: T.mono, fontSize: 12, color: T.accent }}>{f.n}</span>
                  </div>
                  <div style={{ fontFamily: T.mono, fontSize: 10, color: T.ink55, marginTop: 4 }}>
                    {f.sub}
                  </div>
                  <div style={{
                    marginTop: 10, display: 'flex', gap: 4, alignItems: 'center',
                    fontFamily: T.mono, fontSize: 9, color: T.ink55, letterSpacing: '0.06em',
                  }}>
                    <span style={{ padding: '1px 5px', background: T.pick, color: T.bg, fontWeight: 700 }}>
                      ★ {Math.floor(f.n * 0.07)}
                    </span>
                    <span style={{ padding: '1px 5px', border: `1px solid ${T.border}` }}>
                      P {Math.floor(f.n * 0.15)}
                    </span>
                    <span style={{ padding: '1px 5px', border: `1px solid ${T.border}` }}>
                      ✎ {Math.floor(f.n * 0.05)}
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}

Object.assign(window, { BShortcuts, BExport, BSync, BSettings, BFolders });
