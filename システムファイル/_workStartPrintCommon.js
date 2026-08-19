// ---- 作業開始印刷セット（作業票表紙・手配チェックシート・カンバン）で共通して使う読み込み・整形処理。
// 品番別作業票データ（sakaeIS_buhinhyoMock_v1_<品番>）を唯一の基準データとして読み込む。
// 作業票_モック.html側のARRANGEMENT_CHECK_ITEMS（現物「生産管理手配チェックシート」の12項目）と
// 同じキー・並び順・目安日数で保つこと（どちらかだけ直しても揃わなくなるため、変更時は両方に反映する）。
window.sakaeWorkStartPrint = (function(){
  const STORAGE_KEY_BASE = 'sakaeIS_buhinhyoMock_v1';
  function storageKeyFor(productNo){ return STORAGE_KEY_BASE + (productNo ? ('_' + productNo) : ''); }

  function esc(s){
    return (s==null?'':s).toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  const ARRANGEMENT_CHECK_ITEMS = [
    { key:'designDrawing',            label:'設計図面',             days:1  },
    { key:'suppliedMaterial',         label:'材料手配(支給材料)',   days:2  },
    { key:'purchasedMaterial',        label:'材料手配(購入材料)',   days:3  },
    { key:'scheduleCreation',         label:'日程表作成',           days:2  },
    { key:'workOrderCreation',        label:'作業票作成',           days:3  },
    { key:'drawingIssue',             label:'出図',                 days:3  },
    { key:'suppliedPartsRequest',     label:'支給品申請',           days:5  },
    { key:'purchasedPartsArrange',    label:'購入品手配',           days:5  },
    { key:'outsourcingArrange',       label:'加工外注手配',         days:6  },
    { key:'materialArrivalCheck',     label:'材料入荷チェック',     days:4  },
    { key:'purchasedArrivalCheck',    label:'購入品入荷チェック',   days:10 },
    { key:'outsourcingArrivalCheck',  label:'加工外注入荷チェック', days:null },
  ];

  function loadBs(productNo){
    if(!productNo) return null;
    try{
      const raw = localStorage.getItem(storageKeyFor(productNo));
      if(raw) return JSON.parse(raw);
    }catch(e){}
    return null;
  }
  function saveBs(productNo, bs){
    if(!productNo) return;
    localStorage.setItem(storageKeyFor(productNo), JSON.stringify(bs));
  }
  function ensureArrangementCheck(bs){
    bs.arrangementCheck = bs.arrangementCheck || { category:'新作', inputDate:'', items:{}, approvedBy:'', createdBy:'' };
    bs.arrangementCheck.items = bs.arrangementCheck.items || {};
    ARRANGEMENT_CHECK_ITEMS.forEach(def=>{
      if(!bs.arrangementCheck.items[def.key]) bs.arrangementCheck.items[def.key] = { deadline:'', completedDate:'', checkedBy:'', procedure:'' };
      // procedure（手順）は後から追加した項目。既存データには無いため、ここで補う（既存の値は触らない）
      if(bs.arrangementCheck.items[def.key].procedure == null) bs.arrangementCheck.items[def.key].procedure = '';
    });
    return bs.arrangementCheck;
  }

  // ---- 土日だけを除外する簡易営業日計算。現物Excel「生産管理手配チェックシート」の目安日時・期限の
  // 実データ（入力日2026-07-13(月)を起点に、目安5日→期限07-20(月)、目安10日→期限07-27(月)等）と
  // 突き合わせて一致することを確認済み。祝日は考慮しない簡易版（作業指示書8.6の方針どおり）。----
  function addBusinessDays(dateStr, days){
    if(!dateStr || days==null || days==='') return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
    if(!m) return '';
    const d = new Date(Number(m[1]), Number(m[2])-1, Number(m[3]));
    let added = 0;
    while(added < days){
      d.setDate(d.getDate()+1);
      const dow = d.getDay();
      if(dow!==0 && dow!==6) added++;
    }
    return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');
  }
  function fmtDateJp(s){
    if(!s) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if(!m) return s;
    return m[1]+'/'+m[2]+'/'+m[3];
  }

  // ---- 実働時間（実績）：工程の「見積工数」ではなく、実績入力_モック.html（sakaeIS_jissekiLog_v1）に
  // 実際に記録された段取／有人／無人／夜間の各時間を、この品番に一致する分だけ合計する。
  // 実績が1件も無ければnullを返す（呼び出し側は空欄表示にすること。0時間と実績無しを区別するため）。----
  const JISSEKI_LOG_KEY = 'sakaeIS_jissekiLog_v1';
  function sumActualHours(productNo){
    if(!productNo) return null;
    let list;
    try{
      const raw = localStorage.getItem(JISSEKI_LOG_KEY);
      list = raw ? JSON.parse(raw) : [];
    }catch(e){ return null; }
    const rows = (list||[]).filter(e=> e && e.productNo === productNo);
    if(!rows.length) return null;
    let sum = 0;
    rows.forEach(e=>{
      sum += (Number(e.setupHours)||0) + (Number(e.mannedHours)||0) + (Number(e.unmannedHours)||0) + (Number(e.nightHours)||0);
    });
    return sum;
  }

  return { storageKeyFor, esc, ARRANGEMENT_CHECK_ITEMS, loadBs, saveBs, ensureArrangementCheck, addBusinessDays, fmtDateJp, sumActualHours };
})();
