// Root app — Studio Dark variant only, with design canvas layout + tweaks.
const { DesignCanvas, DCSection, DCArtboard, TweaksPanel, useTweaks, TweakRadio } = window;

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "medium"
}/*EDITMODE-END*/;

function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const density = t.density;

  return (
    <React.Fragment>
      <DesignCanvas>
        <DCSection
          id="flow"
          title="01 · 主流程"
          subtitle="Studio Dark · 點縮圖選圖、點星星評分、按 P / X / R 加旗標、← → 切照片 — 都會作用在所有面板上"
        >
          <DCArtboard id="grid"      label="主頁網格 · Lightroom 雙欄"          width={1440} height={900}>
            <BGrid density={density} />
          </DCArtboard>
          <DCArtboard id="detail"    label="詳細檢視 + 標注"                    width={1440} height={900}>
            <BDetail />
          </DCArtboard>
          <DCArtboard id="slide"     label="全螢幕幻燈片"                       width={1440} height={810}>
            <BSlideshow />
          </DCArtboard>
          <DCArtboard id="compare"   label="比較模式 · 並排 3 張"               width={1440} height={900}>
            <BCompare />
          </DCArtboard>
          <DCArtboard id="batch"     label="批次選取 · 全選 12 張的批次操作列"  width={1440} height={900}>
            <BGridBatch density={density} />
          </DCArtboard>
        </DCSection>

        <DCSection
          id="modals"
          title="02 · 模態與彈窗"
          subtitle="按 ? 開啟快捷鍵 · ⌘E 匯出 · 同步 / 設定面板"
        >
          <DCArtboard id="shortcuts" label="快捷鍵 + AI 智慧面板"    width={1100} height={760}>
            <BShortcuts />
          </DCArtboard>
          <DCArtboard id="export"    label="匯出面板 · ZIP / JSON / Sheets / CSV" width={860} height={720}>
            <BExport />
          </DCArtboard>
          <DCArtboard id="sync"      label="同步進度 · Sync Modal"       width={760} height={720}>
            <BSync />
          </DCArtboard>
          <DCArtboard id="settings"  label="設定面板 · 5 個分頁"         width={1040} height={680}>
            <BSettings />
          </DCArtboard>
        </DCSection>

        <DCSection
          id="states"
          title="03 · 空狀態 / 載入"
          subtitle="第一次使用、未登入、未載入資料夾、篩選無結果、載入中"
        >
          <DCArtboard id="signin"    label="未登入 · 第一次開啟"          width={1440} height={900}>
            <BEmptySignIn />
          </DCArtboard>
          <DCArtboard id="nofolder"  label="已登入但未載入資料夾"          width={1440} height={900}>
            <BEmptyNoFolder />
          </DCArtboard>
          <DCArtboard id="noresults" label="篩選後無結果"                 width={1440} height={900}>
            <BEmptyNoResults />
          </DCArtboard>
          <DCArtboard id="loading"   label="載入中 · Skeleton + 進度條"   width={1440} height={900}>
            <BLoading />
          </DCArtboard>
        </DCSection>

        <DCSection
          id="folders"
          title="04 · 專案 / 資料夾"
          subtitle="多資料夾管理、切換、總覽"
        >
          <DCArtboard id="folder-list" label="所有專案 · 6 個資料夾"     width={1440} height={900}>
            <BFolders />
          </DCArtboard>
        </DCSection>

        <DCSection
          id="designer"
          title="05 · 相簿排版工具 · Album Designer"
          subtitle="從選圖工具同步精選照片 → 拖到畫布上排版 → AI 生成背景 → 匯出 PNG / PDF"
        >
          <DCArtboard id="des-empty"  label="空畫布 · 背景頁籤"             width={1440} height={900}>
            <BDesignerEmpty />
          </DCArtboard>
          <DCArtboard id="des-layout" label="自動排版 · 4-grid + 圖層"      width={1440} height={900}>
            <BDesignerLayout />
          </DCArtboard>
          <DCArtboard id="des-ai"     label="AI 背景生成 · 4 個候選"       width={1440} height={900}>
            <BDesignerAI />
          </DCArtboard>
          <DCArtboard id="des-export" label="匯出彈窗 · PNG / JPG / PDF"   width={980} height={760}>
            <BDesignerExport />
          </DCArtboard>
        </DCSection>

        <DCSection
          id="mobile"
          title="06 · 手機版 · RWD"
          subtitle="iPhone 14 Pro · 390×844 · 跟桌面版共用同一個資料 store — 桌面改評分手機也會跟著動"
        >
          <DCArtboard id="m-grid"    label="行動 · 主頁 2 欄網格"        width={390} height={844}>
            <BMobileGrid />
          </DCArtboard>
          <DCArtboard id="m-detail"  label="行動 · 詳細檢視"              width={390} height={844}>
            <BMobileDetail />
          </DCArtboard>
          <DCArtboard id="m-filter"  label="行動 · 篩選 Bottom Sheet"    width={390} height={844}>
            <BMobileFilters />
          </DCArtboard>
        </DCSection>
      </DesignCanvas>

      <TweaksPanel title="Tweaks">
        <TweakRadio
          label="縮圖密度"
          help="會作用在主頁網格與批次選取畫面"
          value={t.density}
          onChange={(v) => setTweak('density', v)}
          options={[
            { value: 'dense',  label: '密 · 6 欄' },
            { value: 'medium', label: '中 · 4 欄' },
            { value: 'sparse', label: '疏 · 3 欄' },
          ]}
        />
      </TweaksPanel>
    </React.Fragment>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
