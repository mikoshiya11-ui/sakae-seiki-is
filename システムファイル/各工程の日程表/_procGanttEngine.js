/* ==== 工程日程表 共通エンジン ====
   各工程の日程表フォルダ内の全ファイル（DE/SU/支給/外注/OMI/OGS/GS/LA/MI/JG/EW/GC/EM/DR/WEL/3D/FIN/NCM/熱処理/ｶﾅｯｸ/ﾆｭｰｶﾅｯｸ/PN）で共有するロジック。
   各HTMLファイルは <script src="_procGanttEngine.js"></script> のあと ProcGantt.init({code, color, ...}) を呼ぶだけ。

   考え方：
   ・この日程表はデータを直接入力する場所ではなく、部品表（sakaeIS_buhinhyoMock_v1_＜品番＞）を横断的にスキャンして、
     指定した工程コードが付いたジョブ（部品×工程）を自動的に拾ってくる「ビュー」。
   ・社内No／客先／型式名／納期／品名／数量／工程は部品表の該当データをそのまま表示（このページでは編集不可）。
   ・前工程／次工程／工程完了期限は、その部品のprocesses[]を日付順に並べたときの「1つ前／1つ後」から自動算出する
     （工程完了期限＝次工程の予定日）。
   ・工数だけは部品表にまだ項目が無く、実績か見積か未確認のため、このページ内だけのローカル項目として仮に入力できるようにしてある。
   ・バーをドラッグすると、その工程の予定日（部品表のprocesses[].date/ampm）へ直接書き戻される（個別日程表・NC日程表と同じ方式）。
*/
window.ProcGantt = (function(){

  function esc(s){
    return (s==null?'':s).toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function init(config){
    const CODE = config.code;
    // ---- 画面に出す工程の呼び名。工程記号＋識別BOXを続けて書く（例：MI＋2オモテ → MI2オモテ）。
    // 分類そのものは工程記号だけで決まるので、この関数は表示専用。 ----
    function procLabel(job){ return (job && job.code ? job.code : '') + (job && job.ident ? job.ident : ''); }
    const COLOR = config.color || '#173a68';
    // ---- 個別日程表からダブルクリックで来た場合はその品番の個別日程表に戻れるようにする（URLの?productNoで判定） ----
    const ctxProductNo = (new URLSearchParams(location.search).get('productNo')||'').trim();
    const BACK_LINK = config.backLink || (ctxProductNo ? ('../個別日程表_モック.html?productNo='+encodeURIComponent(ctxProductNo)) : '../残品表_モック.html');
    const BACK_LABEL = config.backLabel || (ctxProductNo ? '← 個別日程表へ' : '← 工程別残品表へ');

    document.title = CODE + '日程表｜SAKAE SEIKI-iS';
    const brandEl = document.querySelector('.topbar .brand');
    if(brandEl) brandEl.innerHTML = '<span class="sakae">SAKAE SEIKI</span><span class="is">-iS</span>';
    const pageNameEl = document.getElementById('pageName');
    if(pageNameEl) pageNameEl.textContent = CODE + '日程表（工程ごとの日程表：共通エンジン／部品表とリンク）';
    const backLinkEl = document.getElementById('backLink');
    if(backLinkEl){ backLinkEl.href = BACK_LINK; backLinkEl.textContent = BACK_LABEL; }
    const noteBarEl = document.getElementById('noteBar');
    if(noteBarEl){
      noteBarEl.innerHTML =
        'これは「工程ごとの日程表」を全工程で使い回す共通エンジンによる '+esc(CODE)+' 用のページです。行は直接入力するのではなく、部品表（各品番）に登録された工程のうち「'+esc(CODE)+'」が付いているものを自動的に拾ってきます。<br>'
        + '社内No～数量・工程は部品表の内容をそのまま表示（このページでは編集不可）。前工程・次工程・工程完了期限はその部品の工程一覧を日付順に並べて自動算出しています（工程完了期限＝次工程の予定日）。工数だけはまだ部品表に項目が無いため、実績か見積か確認が取れるまでこのページだけの仮入力にしてあります。<br>'
        + 'バーの中央をドラッグすると日付が、両端をつまんで伸縮すると日数（作業期間）が変わります。いずれも部品表側に一緒に反映されます（🔗マーク付き）。日付未設定の工程は下の「未日程」欄から日付を決めてください。';
    }
    const legendEl = document.getElementById('legend');
    if(legendEl){
      legendEl.innerHTML =
        '<span class="lgItem"><span class="lgSwatch" style="background:'+COLOR+';"></span>'+esc(CODE)+'工程</span>'
        + '<span class="lgHint">行＝部品表と自動リンクしたジョブ（このページでは工数以外は編集不可）</span>';
    }
    // ---- 期限超過／期限間近のサマリーチップ（残品表_モック.htmlと同じ考え方）。薄いHTML側には無い要素なのでここで作って差し込む ----
    let summaryRowEl = document.getElementById('summaryRow');
    if(!summaryRowEl && legendEl){
      summaryRowEl = document.createElement('div');
      summaryRowEl.id = 'summaryRow';
      summaryRowEl.className = 'summaryRow';
      legendEl.insertAdjacentElement('afterend', summaryRowEl);
    }

    function uid(){ return Math.random().toString(36).slice(2,9); }

    // ---- メモの矢印（吹き出しの先端）。先端座標（tailX/tailY）が無い古いメモには、左下から斜め下に伸びたデフォルト位置を与える。
    // NC日程表_モック.htmlと同じ仕組み（根本はメモ本体の左下角、先端はドラッグで自由に伸縮・向き変更できる）。 ----
    function ensureMemoTail(memo){
      if(typeof memo.tailX === 'number' && typeof memo.tailY === 'number') return;
      memo.tailX = memo.x - 36;
      memo.tailY = memo.y + memo.h + 44;
    }
    const TAIL_ROOT_INSET_X = 12;
    const TAIL_ROOT_INSET_Y = 28;
    function memoTailGeom(memo){
      const ax = memo.x + TAIL_ROOT_INSET_X, ay = memo.y + memo.h - TAIL_ROOT_INSET_Y;
      const bx = memo.tailX, by = memo.tailY;
      const dx = bx-ax, dy = by-ay;
      const length = Math.max(1, Math.sqrt(dx*dx+dy*dy));
      const angle = Math.atan2(dy, dx) * 180/Math.PI;
      return { ax, ay, bx, by, length, angle };
    }
    function updateMemoTailVisual(memo){
      const g = memoTailGeom(memo);
      const lineEl = ganttInner.querySelector('.memoTailLine[data-memo-id="'+memo.id+'"]');
      const handleEl = ganttInner.querySelector('.memoTailHandle[data-memo-id="'+memo.id+'"]');
      if(lineEl){
        lineEl.style.left = g.ax+'px';
        lineEl.style.top = g.ay+'px';
        lineEl.style.width = g.length+'px';
        lineEl.style.transform = 'rotate('+g.angle+'deg)';
      }
      if(handleEl){
        handleEl.style.left = g.bx+'px';
        handleEl.style.top = g.by+'px';
        const arrowEl = handleEl.querySelector('.tailArrow');
        if(arrowEl) arrowEl.style.transform = 'rotate('+g.angle+'deg)';
      }
    }

    // ---- 自由配置メモ（吹き出し）の描画。render()のたびにganttInnerへ子要素として追加し直す（重複防止のため一旦全部消してから作り直す） ----
    function renderMemoLayer(){
      ganttInner.querySelectorAll('.memoNote, .memoTailLine, .memoTailHandle').forEach(el=> el.remove());
      memos.forEach(memo=>{
        ensureMemoTail(memo);
        const el = document.createElement('div');
        el.className = 'memoNote';
        el.dataset.memoId = memo.id;
        el.style.left = memo.x+'px';
        el.style.top = memo.y+'px';
        el.style.width = memo.w+'px';
        el.style.height = memo.h+'px';
        el.innerHTML = '<div class="memoNoteHandle" data-role="memoHandle" title="ドラッグで移動">・・・</div>'
          + '<textarea class="memoNoteBody" data-role="memoBody" placeholder="メモを入力">'+esc(memo.text||'')+'</textarea>'
          + '<div class="memoNoteResize" data-role="memoResize" title="ドラッグでサイズ変更"></div>';
        ganttInner.appendChild(el);

        const lineEl = document.createElement('div');
        lineEl.className = 'memoTailLine';
        lineEl.dataset.memoId = memo.id;
        ganttInner.appendChild(lineEl);

        const handleEl = document.createElement('div');
        handleEl.className = 'memoTailHandle';
        handleEl.dataset.memoId = memo.id;
        handleEl.dataset.role = 'tailHandle';
        handleEl.title = 'ドラッグで先端の位置・長さを変更';
        handleEl.innerHTML = '<div class="tailArrow"></div>';
        ganttInner.appendChild(handleEl);

        updateMemoTailVisual(memo);
      });
    }

    // ---- 項目定義（実物のMI日程表Excelの列に合わせてある。減らす場合は榮製機に確認してから） ----
    const COLS = [
      { key:'no', label:'社内No', width:92 },
      { key:'customer', label:'客先', width:64 },
      { key:'model', label:'型式名', width:150 },
      { key:'dueDate', label:'納期', width:54 },
      { key:'itemName', label:'品名', width:170 },
      { key:'qty', label:'数量', width:40 },
      { key:'process', label:'工程', width:52 },
      { key:'manHour', label:'工数', width:50, editable:true },
      { key:'completeDeadline', label:'工程完了期限', width:78 },
      { key:'prevProcess', label:'前工程', width:52 },
      { key:'completeSchedule', label:'完了予定', width:64 },
      { key:'nextProcess', label:'次工程', width:52 },
    ];
    const SIDE_W = COLS.reduce((a,c)=>a+c.width,0);

    // ---- 表示期間：1/2/3ヶ月表示トグルはやめて、開始日・終了日を自由に指定できるようにしてある。
    // 初期表示（および「初期表示に戻す」）は、このコード（CODE）の全バーの開始日（一番早い工程日から日数ぶん手前）～終了日（一番遅い工程日）に自動フィットする。
    // 該当データがまだ無ければ今日から1ヶ月を初期表示にする。
    // 工程日は「開始」ではなく「終了（納期）」を表すため、実際にバーが始まる位置は工程日から日数（コマ数）ぶん手前になる。
    // 万一の日付入力ミス等で表示期間が異常に広くならないよう、最大でも1年分（MAX_RANGE_DAYS）に収める。 ----
    const TODAY_DATE = new Date();
    function parseDateStr(s){
      if(!s) return null;
      const p = String(s).split('-').map(Number);
      if(p.length!==3 || !p[0] || !p[1] || !p[2]) return null;
      return new Date(p[0], p[1]-1, p[2]);
    }
    function fmtShort(dateStr, ampm){
      const d = parseDateStr(dateStr);
      if(!d) return '';
      return (d.getMonth()+1)+'/'+d.getDate() + (ampm ? (ampm==='PM'?'午後':'午前') : '');
    }
    // ---- 工程完了期限の遅れ判定（残品表_モック.htmlと同じ考え方：今日との差で期限超過／期限間近を出す） ----
    const TODAY_MID = new Date(TODAY_DATE.getFullYear(), TODAY_DATE.getMonth(), TODAY_DATE.getDate());
    function daysUntil(dateStr){
      const d = parseDateStr(dateStr);
      if(!d) return null;
      return Math.round((d - TODAY_MID)/86400000);
    }

    function fmtDateForInput(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
    const MAX_RANGE_DAYS = 365;
    function computeDefaultView(){
      let minDate = null, maxDate = null;
      scanJobs().forEach(j=>{
        const d = parseDateStr(j.date);
        if(!d) return;
        const halfSpan = Math.max(0, (j.days || 3) - 1);
        const effectiveStart = new Date(d);
        effectiveStart.setDate(effectiveStart.getDate() - Math.ceil(halfSpan / 2));
        if(!minDate || effectiveStart < minDate) minDate = effectiveStart;
        if(!maxDate || d > maxDate) maxDate = d;
      });
      if(!minDate || !maxDate){
        const start = new Date(TODAY_DATE.getFullYear(), TODAY_DATE.getMonth(), TODAY_DATE.getDate());
        const end = new Date(start);
        end.setMonth(end.getMonth()+1);
        end.setDate(end.getDate()-1);
        return { start, end };
      }
      const start = new Date(minDate);
      start.setDate(start.getDate()-3);
      let end = new Date(maxDate);
      end.setDate(end.getDate()+3);
      const maxEnd = new Date(start);
      maxEnd.setDate(maxEnd.getDate()+MAX_RANGE_DAYS-1);
      if(end > maxEnd) end = maxEnd;
      return { start, end };
    }
    const STORAGE_PREFIX = 'sakaeIS_procGanttMock_' + CODE + '_v1';
    // ---- ★この位置に置くこと。下の loadView() は（この日程表を初めて開いた時に）computeDefaultView()
    // → scanJobs() を呼び、scanJobs() は dateOverrides を読む。dateOverrides の宣言が loadView() より
    // 後ろにあると、その工程の予定が1件でも入っている場合にだけ
    // 「Cannot access 'dateOverrides' before initialization」で日程表が丸ごと真っ白になっていた
    // （工程の予定を入れた瞬間にその工程の日程表が開かなくなる、という形で現れる）。 ----
    // ---- この日程表（このコードのページ）だけの「表示上の日程」の上書き。現場でバーを動かしても
    // ここだけに保存され、作業票・個別日程表の日付（＝正式な計画日程）は変更しない。
    // 上書きが無い工程は、これまで通り作業票側の日付（proc.date）をそのまま使う。 ----
    const DATE_OVERRIDE_KEY = STORAGE_PREFIX + '_dateOverride';
    function loadDateOverrides(){
      try{ const raw = localStorage.getItem(DATE_OVERRIDE_KEY); if(raw) return JSON.parse(raw); }catch(e){}
      return {};
    }
    function saveDateOverrides(){ localStorage.setItem(DATE_OVERRIDE_KEY, JSON.stringify(dateOverrides)); }
    let dateOverrides = loadDateOverrides(); // { [procId]: { date, ampm, days } }

    const VIEW_KEY = STORAGE_PREFIX + '_view';
    function loadView(){
      try{
        const raw = localStorage.getItem(VIEW_KEY);
        if(raw){
          const v = JSON.parse(raw);
          const s = parseDateStr(v.start), e = parseDateStr(v.end);
          if(s && e && e>=s) return { start:s, end:e };
        }
      }catch(err){}
      return computeDefaultView();
    }
    function saveView(){ localStorage.setItem(VIEW_KEY, JSON.stringify({ start: fmtDateForInput(viewStart), end: fmtDateForInput(viewEnd) })); }
    let { start: viewStart, end: viewEnd } = loadView();
    let RANGE_START = viewStart;
    function idxForDate(date){ return Math.round((date - RANGE_START)/86400000) + 1; }
    function dateForIdx(idx){ const d = new Date(RANGE_START); d.setDate(RANGE_START.getDate() + (idx-1)); return d; }
    function todayIdx(){ return idxForDate(TODAY_DATE); }
    function halfIdxForDate(date, isPM){ return (idxForDate(date)-1)*2 + (isPM?2:1); }
    function dateForHalfIdx(hIdx){ const dayIdx = Math.floor((hIdx-1)/2)+1; return { date: dateForIdx(dayIdx), isPM: (hIdx-1)%2===1 }; }

    function getMonthSegments(){
      const segs = [];
      const total = currentUnitCount();
      let idx = 1;
      let cursorY = RANGE_START.getFullYear(), cursorM = RANGE_START.getMonth();
      let dayInMonthStart = RANGE_START.getDate();
      let remaining = total;
      while(remaining > 0){
        const daysInMonth = new Date(cursorY, cursorM+1, 0).getDate();
        const daysThisSeg = Math.min(remaining, daysInMonth - dayInMonthStart + 1);
        segs.push({ label:(cursorM+1)+'月', days:daysThisSeg, startIdx:idx });
        idx += daysThisSeg;
        remaining -= daysThisSeg;
        dayInMonthStart = 1;
        cursorM++;
        if(cursorM>11){ cursorM=0; cursorY++; }
      }
      return segs;
    }
    function currentUnitCount(){ return Math.max(1, Math.round((viewEnd - RANGE_START)/86400000) + 1); }

    // ---- 工数・メモなど、部品表にまだ項目が無いローカル追加情報（procId単位、全工程共通で1つの保存領域を共有） ----
    const EXTRA_KEY = 'sakaeIS_procGanttMock_extra_v1';
    function loadExtra(){
      try{ const raw = localStorage.getItem(EXTRA_KEY); if(raw) return JSON.parse(raw); }catch(e){}
      return {};
    }
    function saveExtra(){ localStorage.setItem(EXTRA_KEY, JSON.stringify(extra)); }
    let extra = loadExtra();

    // ---- 自由配置・自由サイズのメモ（吹き出し）。日付・工程・バーには一切紐付かず、ガント表内の好きな座標に置ける付箋（コードごとに保存） ----
    const MEMO_KEY = STORAGE_PREFIX + '_memos';
    function loadMemos(){
      try{ const raw = localStorage.getItem(MEMO_KEY); if(raw) return JSON.parse(raw); }catch(e){}
      return [];
    }
    function saveMemos(){ localStorage.setItem(MEMO_KEY, JSON.stringify(memos)); }
    let memos = loadMemos();

    // ---- 自由記述バー（部品表とは関係のない、このページだけで作るバー）。NC日程表_モック.htmlの「バーの設置」と同じ考え方。
    // 空いている場所を右クリック→「バーの設置」で作成。白／黄／緑の3色から選べる。コードごとに保存し、レーン（行）は＋／－で増減できる。 ----
    const NONLINK_COLORS = { white:'#ffffff', yellow:'#ffe066', green:'#92d050' };
    const NONLINK_COLOR_ORDER = ['white','yellow','green'];
    function nonlinkColorHex(name){ return NONLINK_COLORS[name] || NONLINK_COLORS.white; }
    const FREE_KEY = STORAGE_PREFIX + '_freeBars';
    const FREE_ROWCOUNT_KEY = STORAGE_PREFIX + '_freeRowCount';
    function loadFreeBars(){
      try{ const raw = localStorage.getItem(FREE_KEY); if(raw) return JSON.parse(raw); }catch(e){}
      return {};
    }
    function saveFreeBars(){ localStorage.setItem(FREE_KEY, JSON.stringify(freeBars)); }
    let freeBars = loadFreeBars();
    function loadFreeRowCount(){
      const v = Number(localStorage.getItem(FREE_ROWCOUNT_KEY));
      return (v>=1 && v<=12) ? v : 1;
    }
    function saveFreeRowCount(){ localStorage.setItem(FREE_ROWCOUNT_KEY, String(freeRowCount)); }
    let freeRowCount = loadFreeRowCount();

    // ---- 部品表を横断スキャンして、このコードが付いた工程をジョブとして集める ----
    function scanJobs(){
      const jobs = [];
      for(let i=0;i<localStorage.length;i++){
        const key = localStorage.key(i);
        if(!key || key.indexOf('sakaeIS_buhinhyoMock_v1_')!==0) continue;
        let bs;
        try{ bs = JSON.parse(localStorage.getItem(key)); }catch(e){ continue; }
        if(!bs || !bs.order) continue;
        (bs.parts||[]).forEach(part=>{
          const all = part.processes || [];
          const dated = all.filter(p=>p.date).slice().sort((a,b)=>{
            const ka = a.date + (a.ampm==='PM'?'_2':'_1');
            const kb = b.date + (b.ampm==='PM'?'_2':'_1');
            return ka.localeCompare(kb);
          });
          all.forEach(proc=>{
            if(proc.code !== CODE) return;
            let prevCode = '', nextCode = '', deadline = '';
            if(proc.date){
              const pos = dated.findIndex(p=>p.id===proc.id);
              if(pos > 0) prevCode = dated[pos-1].code;
              if(pos !== -1 && pos < dated.length-1){ nextCode = dated[pos+1].code; deadline = dated[pos+1].date; }
            }
            const ov = dateOverrides[proc.id];
            jobs.push({
              productNo: bs.order.productNo||'', orderNo: bs.order.orderNo||'', customer: bs.order.customer||'',
              model: bs.order.model||'', orderDueDate: bs.order.dueDate||'',
              partId: part.id, partName: part.name||'', qty: part.qty||'',
              // 分類（この日程表に出るかどうか）は上の proc.code === CODE だけで決まる。
              // ident は同じ工程記号の中で見分けるための文字で、表示にだけ使う（例：MI＋2オモテ → MI2オモテ）。
              procId: proc.id, code: proc.code, ident: proc.ident || '',
              // 工数の正本は作業票データの processes[].hours。この画面はそれを読むだけで、独自には持たない。
              hours: (proc.hours == null) ? '' : String(proc.hours),
              date: (ov ? ov.date : proc.date) || '',
              ampm: (ov ? ov.ampm : proc.ampm) || 'AM',
              days: (ov && ov.days != null) ? ov.days : (proc.days || 3),
              prevCode, nextCode, deadline
            });
          });
        });
      }
      return jobs;
    }
    // ---- 工程そのものを削除（日付をクリアするだけでなく、部品表からその工程を完全に取り除く）。
    // 受注連絡書から案件ごと削除された後などに「日付未設定」欄に残り続けてしまう工程を、ここから消せるようにする ----
    function deleteProcess(productNo, procId){
      if(!productNo) return null;
      const key = 'sakaeIS_buhinhyoMock_v1_' + productNo;
      let bs;
      try{ bs = JSON.parse(localStorage.getItem(key)); }catch(e){ return null; }
      if(!bs) return null;
      let removed = null;
      (bs.parts||[]).forEach(part=>{
        const idx = (part.processes||[]).findIndex(p=>p.id===procId);
        if(idx !== -1){
          removed = { productNo, partId: part.id, procIndex: idx, proc: JSON.parse(JSON.stringify(part.processes[idx])) };
          part.processes.splice(idx, 1);
        }
      });
      if(removed) localStorage.setItem(key, JSON.stringify(bs));
      return removed;
    }
    function restoreProcess(snapshot){
      if(!snapshot) return;
      const key = 'sakaeIS_buhinhyoMock_v1_' + snapshot.productNo;
      let bs;
      try{ bs = JSON.parse(localStorage.getItem(key)); }catch(e){ return; }
      if(!bs) return;
      const part = (bs.parts||[]).find(p=>p.id===snapshot.partId);
      if(!part) return;
      part.processes = part.processes || [];
      part.processes.splice(Math.min(snapshot.procIndex, part.processes.length), 0, snapshot.proc);
      localStorage.setItem(key, JSON.stringify(bs));
    }

    // ---- 🔴 ここにあった「日数(days)が1・2の工程を3へ底上げする一度だけの移行処理」は廃止した（2026-08-28）。
    // 実行済みフラグ(sakaeIS_daysUpgrade3_v1)が端末ごとだったため、まだ実行していない端末が画面を開くと、
    // 現場が意図して1〜2コマへ縮めたバーまで3コマへ戻し、その結果が同期で他の端末へも広がっていた。
    // 日数は現在ユーザーが自由に決める値であり、1・2 も正しい値である。
    // days が「無い」古いデータの補完は作業票_モック.html の migrateState が従来どおり担当する。
    // 既に立っている旧フラグは掃除していない（処理が無いので有無で挙動は変わらない）。 ----

    let jobs = scanJobs();
    function refreshJobs(){ jobs = scanJobs(); }

    // ---- レンダリング ----
    const ganttInner = document.getElementById('ganttInner');
    const ganttCard = document.querySelector('.ganttCard');
    const emptyState = document.getElementById('emptyState');
    let DAY_W = 30;
    const ZOOM_KEY = STORAGE_PREFIX + '_zoom';
    function loadZoom(){
      const v = Number(localStorage.getItem(ZOOM_KEY));
      return (v>=14 && v<=52) ? v : 30;
    }
    DAY_W = loadZoom();
    document.documentElement.style.setProperty('--day-w', DAY_W+'px');

    let weekendStyleEl = null;
    // ---- 月の区切り線：ヘッダーの月ラベル行と同じ濃さの縦線を、表の一番下の行まで伸ばして引く。
    // 日ごとの列は個別のDOM要素ではなくbackground-imageの縞模様で表現しているため、月境界も同じ仕組み（.trackへの2枚目の背景レイヤー）で描く。
    // 週末の縞は7日周期のrepeating-linear-gradientだが、月境界はカレンダー月ごとの不定間隔なので、表の全幅ぶんの通常のlinear-gradientを別レイヤーとして重ねる。 ----
    function buildMonthBoundaryStops(){
      const segs = getMonthSegments();
      const lineColor = '#8592a6';
      const lineW = 1.5;
      const stops = [];
      let cumulative = 0;
      segs.forEach((seg, i)=>{
        cumulative += seg.days;
        if(i === segs.length-1) return; // 表の右端（最後の区切り）には線を引かない
        const pos = cumulative*DAY_W;
        stops.push('transparent '+(pos-lineW)+'px', lineColor+' '+(pos-lineW)+'px', lineColor+' '+pos+'px', 'transparent '+pos+'px');
      });
      return stops;
    }
    function applyWeekendBackground(){
      const dow0 = RANGE_START.getDay();
      const stops = [];
      const half = DAY_W/2;
      const boundaryColor = 'rgba(20,35,70,.18)';
      const halfColor = 'rgba(20,35,70,.06)';
      for(let i=0;i<7;i++){
        const dow = (dow0+i)%7;
        const color = dow===0 ? 'rgba(220,38,38,.06)' : (dow===6 ? 'rgba(37,99,235,.06)' : 'transparent');
        const dayStart = i*DAY_W, mid = dayStart+half, dayEnd = (i+1)*DAY_W;
        stops.push(boundaryColor+' '+dayStart+'px', boundaryColor+' '+(dayStart+1)+'px');
        stops.push(color+' '+(dayStart+1)+'px', color+' '+(mid-0.5)+'px');
        stops.push(halfColor+' '+(mid-0.5)+'px', halfColor+' '+(mid+0.5)+'px');
        stops.push(color+' '+(mid+0.5)+'px', color+' '+dayEnd+'px');
      }
      const monthStops = buildMonthBoundaryStops();
      const hasMonthLine = monthStops.length > 0;
      const images = 'repeating-linear-gradient(to right,'+stops.join(',')+')'
        + (hasMonthLine ? ', linear-gradient(to right,'+monthStops.join(',')+')' : '');
      const repeats = 'repeat-x' + (hasMonthLine ? ', no-repeat' : '');
      const sizes = (7*DAY_W)+'px 100%' + (hasMonthLine ? ', 100% 100%' : '');
      if(!weekendStyleEl){
        weekendStyleEl = document.createElement('style');
        document.head.appendChild(weekendStyleEl);
      }
      weekendStyleEl.textContent = '.track{ background-image:'+images+'; background-repeat:'+repeats+'; background-size:'+sizes+'; }';
    }
    applyWeekendBackground();

    function setZoom(px){
      DAY_W = Math.max(14, Math.min(52, px));
      localStorage.setItem(ZOOM_KEY, String(DAY_W));
      document.documentElement.style.setProperty('--day-w', DAY_W+'px');
      const rb = document.getElementById('zoomResetBtn');
      if(rb) rb.textContent = Math.round(DAY_W/30*100)+'%';
      applyWeekendBackground();
      render();
    }
    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const zoomResetBtn = document.getElementById('zoomResetBtn');
    if(zoomInBtn) zoomInBtn.addEventListener('click', ()=> setZoom(DAY_W+4));
    if(zoomOutBtn) zoomOutBtn.addEventListener('click', ()=> setZoom(DAY_W-4));
    if(zoomResetBtn){
      zoomResetBtn.addEventListener('click', ()=> setZoom(30));
      zoomResetBtn.textContent = Math.round(DAY_W/30*100)+'%';
    }

    function buildHeader(){
      const segs = getMonthSegments();
      const total = segs.reduce((a,s)=>a+s.days,0);
      const todayIdxVal = todayIdx();

      let monthRow = '<div class="ganttMonthRow">';
      monthRow += '<div class="ganttSideHead" style="border-right:1.5px solid #222;width:'+SIDE_W+'px;"></div>';
      segs.forEach(seg=>{
        monthRow += '<div class="monthCell" style="width:'+(seg.days*DAY_W)+'px;flex:0 0 '+(seg.days*DAY_W)+'px;">'+esc(seg.label)+'</div>';
      });
      monthRow += '</div>';

      let dayRow = '<div class="ganttHeaderRow">';
      dayRow += '<div class="ganttSideHead" style="width:'+SIDE_W+'px;">'
        + COLS.map(c=>'<div class="colHead" style="width:'+c.width+'px;flex:0 0 '+c.width+'px;">'+esc(c.label)+'</div>').join('')
        + '</div>';
      for(let i=1;i<=total;i++){
        const date = dateForIdx(i);
        const dow = date.getDay();
        const cls = dow===0 ? ' sun' : (dow===6 ? ' sat' : '');
        const todayCls = (i===todayIdxVal) ? ' today' : '';
        dayRow += '<div class="ganttDayCell'+cls+todayCls+'">'+date.getDate()+'</div>';
      }
      dayRow += '</div>';
      return monthRow + dayRow;
    }

    function buildBarHtml(job){
      // 作業票の工程日は「終了（納期）」を表すため、バーの右端をjob.dateに合わせ、そこから日数ぶん手前を左端にする。
      const endHalf = halfIdxForDate(parseDateStr(job.date), job.ampm==='PM');
      const days = job.days || 3;
      const startHalf = Math.max(1, endHalf-(days-1));
      const HALF_W = DAY_W/2;
      const left = (startHalf-1)*HALF_W;
      const width = HALF_W*(endHalf-startHalf+1);
      const startHint = days>1 ? (fmtShort((function(){ const h=dateForHalfIdx(startHalf); const d=h.date; return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); })(), (dateForHalfIdx(startHalf).isPM?'PM':'AM'))+'　～　') : '';
      const ctxHint = '\n（右クリックで削除メニュー）';
      const dateHint = '\n'+startHint+fmtShort(job.date, job.ampm)+'（右端＝部品表の工程日付「終了・納期」とリンク中。ドラッグで移動、端をつまむと日数を変更できます）'+ctxHint;
      return '<div class="bar" data-range="'+job.procId+'" style="left:'+left+'px;width:'+width+'px;background:'+COLOR+';" title="'+esc((job.orderNo?job.orderNo+' ':'')+job.partName+'（'+procLabel(job)+'）')+dateHint+'">'
        + '<div class="handle left" data-role="handle-left"></div>'
        + '<span class="barLabel">🔗</span>'
        + '<div class="handle right" data-role="handle-right"></div>'
        + '</div>';
    }

    function colValHtml(job, col){
      if(col.editable){
        // ---- 工数は作業票データの processes[].hours が唯一の正本。
        // 以前はこのページだけの仮項目（extra[procId].manHour）を読み書きしていたが、
        // 個別日程表・残品表・作業票印刷と食い違うため正本へ一本化した。
        // extra の古い値は消していないが、業務表示ではもう参照しない。 ----
        return '<input data-field="manHour" data-procid="'+esc(job.procId)+'" data-productno="'+esc(job.productNo)+'"'
          + ' value="'+esc(job.hours||'')+'" placeholder="h" title="予定工数（H）。作業票の工程データに保存されます">';
      }
      if(col.key === 'completeDeadline'){
        if(!job.deadline){
          return '<div class="colVal muted">―</div>';
        }
        const dLeft = daysUntil(job.deadline);
        let cls = '', badge = '';
        if(dLeft !== null){
          if(dLeft < 0){ cls = ' due-over'; badge = '<span class="dueBadge over">期限超過</span>'; }
          else if(dLeft <= 2){ cls = ' due-soon'; badge = '<span class="dueBadge soon">あと'+dLeft+'日</span>'; }
        }
        return '<div class="colVal'+cls+'" title="'+esc(fmtShort(job.deadline))+'">'+esc(fmtShort(job.deadline))+badge+'</div>';
      }
      let v = '';
      switch(col.key){
        case 'no': v = job.orderNo; break;
        case 'customer': v = job.customer; break;
        case 'model': v = job.model; break;
        case 'dueDate': v = fmtShort(job.orderDueDate); break;
        case 'itemName': v = job.partName; break;
        case 'qty': v = job.qty; break;
        case 'process': v = procLabel(job); break;
        case 'prevProcess': v = job.prevCode; break;
        case 'completeSchedule': v = fmtShort(job.date, job.ampm); break;
        case 'nextProcess': v = job.nextCode; break;
      }
      const muted = v ? '' : ' muted';
      return '<div class="colVal'+muted+'" title="'+esc(v)+'">'+(esc(v)||'―')+'</div>';
    }

    function buildRows(scheduled){
      const unitCount = currentUnitCount();
      const totalDayWidth = unitCount * DAY_W;
      let html = '';
      scheduled.forEach(job=>{
        html += '<div class="jobRow" data-row="'+job.procId+'">';
        html += '<div class="jobSideCell" style="width:'+SIDE_W+'px;">'
          + COLS.map(c=>'<div class="colCell" style="width:'+c.width+'px;flex:0 0 '+c.width+'px;">'+colValHtml(job,c)+'</div>').join('')
          + '</div>';
        html += '<div class="track" data-role="track" data-procid="'+job.procId+'" data-unit-count="'+unitCount+'" style="width:'+totalDayWidth+'px;">';
        html += buildBarHtml(job);
        html += '</div>';
        html += '</div>';
      });
      return html;
    }

    // ---- 自由記述バー欄の描画。上のジョブ一覧とは別の小さなカード（freeBarCard）に、同じ日付の列幅で表示する。 ----
    const FREE_SIDE_W = 130;
    function buildFreeHeader(){
      const segs = getMonthSegments();
      const total = segs.reduce((a,s)=>a+s.days,0);
      const todayIdxVal = todayIdx();
      let monthRow = '<div class="ganttMonthRow">';
      monthRow += '<div class="ganttSideHead" style="border-right:1.5px solid #222;width:'+FREE_SIDE_W+'px;"></div>';
      segs.forEach(seg=>{
        monthRow += '<div class="monthCell" style="width:'+(seg.days*DAY_W)+'px;flex:0 0 '+(seg.days*DAY_W)+'px;">'+esc(seg.label)+'</div>';
      });
      monthRow += '</div>';
      let dayRow = '<div class="ganttHeaderRow">';
      dayRow += '<div class="ganttSideHead" style="width:'+FREE_SIDE_W+'px;"></div>';
      for(let i=1;i<=total;i++){
        const date = dateForIdx(i);
        const dow = date.getDay();
        const cls = dow===0 ? ' sun' : (dow===6 ? ' sat' : '');
        const todayCls = (i===todayIdxVal) ? ' today' : '';
        dayRow += '<div class="ganttDayCell'+cls+todayCls+'">'+date.getDate()+'</div>';
      }
      dayRow += '</div>';
      return monthRow + dayRow;
    }
    function buildFreeBarHtml(bar){
      const HALF_W = DAY_W/2;
      const left = (bar.start-1)*HALF_W;
      const width = HALF_W*(bar.end-bar.start+1);
      const color = nonlinkColorHex(bar.color||'white');
      const lightCls = (bar.color||'white')==='white' ? ' light' : '';
      const s = dateForHalfIdx(bar.start), e = dateForHalfIdx(bar.end);
      const fmtHalf = h => (h.date.getMonth()+1)+'/'+h.date.getDate()+(h.isPM?'午後':'午前');
      const dateHint = '\n'+fmtHalf(s)+'　～　'+fmtHalf(e)+'\n（右クリックで編集・削除メニュー）';
      return '<div class="bar'+lightCls+'" data-freebar="'+bar.id+'" style="left:'+left+'px;width:'+width+'px;background:'+color+';" title="'+esc(bar.label||'')+dateHint+'">'
        + '<div class="handle left" data-role="handle-left"></div>'
        + '<span class="barLabel">'+esc(bar.label||'')+'</span>'
        + '<div class="handle right" data-role="handle-right"></div>'
        + '</div>';
    }
    function buildFreeRows(){
      const unitCount = currentUnitCount();
      const totalDayWidth = unitCount * DAY_W;
      let html = '';
      for(let lane=0; lane<freeRowCount; lane++){
        const bars = freeBars[lane] || [];
        html += '<div class="jobRow" data-freelane="'+lane+'">';
        html += '<div class="jobSideCell freeSideCell" style="width:'+FREE_SIDE_W+'px;">'
          + '<span class="freeLaneLabel">自由記述'+(freeRowCount>1 ? (lane+1) : '')+'</span>'
          + (lane===freeRowCount-1
              ? ('<span class="freeRowBtns">'
                  + '<button type="button" class="rowStepBtn" data-role="freerowinc" title="行を追加">＋</button>'
                  + (freeRowCount>1 ? '<button type="button" class="rowStepBtn" data-role="freerowdec" title="最後の行を削除">－</button>' : '')
                  + '</span>')
              : '')
          + '</div>';
        html += '<div class="track" data-role="freetrack" data-lane="'+lane+'" data-unit-count="'+unitCount+'" style="width:'+totalDayWidth+'px;">';
        html += bars.map(b=>buildFreeBarHtml(b)).join('');
        html += '</div>';
        html += '</div>';
      }
      return html;
    }
    function renderFree(){
      if(!freeGanttInner) return;
      freeGanttInner.innerHTML = buildFreeHeader() + buildFreeRows();
    }

    function render(){
      refreshJobs();
      const scheduled = jobs.filter(j=>j.date).sort((a,b)=>{
        const ka = a.date + (a.ampm==='PM'?'_2':'_1');
        const kb = b.date + (b.ampm==='PM'?'_2':'_1');
        return ka.localeCompare(kb);
      });
      if(scheduled.length === 0){
        ganttCard.querySelector('.ganttScroll').style.display = 'none';
        emptyState.style.display = 'block';
        emptyState.textContent = '「'+CODE+'」の日程が入っている工程はまだありません（部品表で日付を入れると、または下の「未日程」欄から日付を決めるとここに表示されます）。';
      }else{
        ganttCard.querySelector('.ganttScroll').style.display = '';
        emptyState.style.display = 'none';
        ganttInner.innerHTML = buildHeader() + buildRows(scheduled);
      }
      renderMemoLayer();
      document.getElementById('footNote').innerHTML =
        '部品表（各品番）を横断的にスキャンして、工程コードが「'+esc(CODE)+'」のものを自動的に表示しています。社内No～次工程は部品表由来の表示のみ（工数を除き編集不可）。バーの位置は部品表に保存されます。';
      renderUnassigned();
      if(summaryRowEl){
        const overCount = scheduled.filter(j=>{ const d=daysUntil(j.deadline); return d!==null && d<0; }).length;
        const soonCount = scheduled.filter(j=>{ const d=daysUntil(j.deadline); return d!==null && d>=0 && d<=2; }).length;
        summaryRowEl.innerHTML =
          '<span class="sumChip">日程あり <b>'+scheduled.length+'</b>件</span>'
          + (soonCount ? '<span class="sumChip warn">期限間近 <b>'+soonCount+'</b>件</span>' : '')
          + (overCount ? '<span class="sumChip danger">期限超過 <b>'+overCount+'</b>件</span>' : '');
      }
      renderFree();
    }

    // ---- 日付未設定のジョブ一覧：ここから初めて日付を入れるとバーとして表示されるようになる ----
    function renderUnassigned(){
      const list = jobs.filter(j=>!j.date);
      const listEl = document.getElementById('unassignedList');
      const countEl = document.getElementById('unassignedCount');
      if(countEl) countEl.textContent = list.length ? '（'+list.length+'件）' : '';
      if(!listEl) return;
      if(!list.length){
        listEl.innerHTML = '<div class="unassignedEmpty">日付未設定の「'+esc(CODE)+'」工程はありません。</div>';
        return;
      }
      listEl.innerHTML = list.map(j=>{
        // 案件の識別は社内No.で出す（案件品番は社内No.と紛らわしいため画面には出さない）
        const info = (j.orderNo?'<b>'+esc(j.orderNo)+'</b> ':'')+esc(j.partName)+'（'+esc(procLabel(j))+'）'+(j.customer?'　'+esc(j.customer):'');
        return '<div class="unassignedItem">'
          + '<span class="uiInfo">'+info+'</span>'
          + '<span class="uiForm">'
          + '<input type="date" data-role="ui-date" data-procid="'+esc(j.procId)+'">'
          + '<select data-role="ui-ampm" data-procid="'+esc(j.procId)+'"><option value="AM">午前</option><option value="PM">午後</option></select>'
          + '<button type="button" class="uiAssignBtn" data-role="ui-assign" data-procid="'+esc(j.procId)+'" data-productno="'+esc(j.productNo)+'">日程を決める</button>'
          + '<button type="button" class="uiAssignBtn uiDeleteBtn" data-role="ui-delete" data-procid="'+esc(j.procId)+'" data-productno="'+esc(j.productNo)+'" title="この工程自体を削除します">削除</button>'
          + '</span>'
          + '</div>';
      }).join('');
    }
    document.getElementById('unassignedList') && document.getElementById('unassignedList').addEventListener('click', (e)=>{
      const assignBtn = e.target.closest('[data-role="ui-assign"]');
      if(assignBtn){
        const procId = assignBtn.dataset.procid;
        const productNo = assignBtn.dataset.productno;
        const row = assignBtn.closest('.unassignedItem');
        const dateInput = row.querySelector('[data-role="ui-date"]');
        const ampmSelect = row.querySelector('[data-role="ui-ampm"]');
        if(!dateInput.value){ alert('日付を選んでください。'); return; }
        // ここで決めた日程はこの日程表だけの表示（作業票・個別日程表の日程は変更しない）
        dateOverrides[procId] = { date: dateInput.value, ampm: ampmSelect.value };
        saveDateOverrides();
        render();
        return;
      }
      const deleteBtn = e.target.closest('[data-role="ui-delete"]');
      if(deleteBtn){
        const procId = deleteBtn.dataset.procid;
        const productNo = deleteBtn.dataset.productno;
        const job = jobs.find(j=>j.procId===procId);
        const label = job ? ((job.orderNo?job.orderNo+' ':'')+job.partName+'（'+esc(procLabel(job))+'）') : 'この工程';
        if(!window.confirm(label+'を削除します。作業票・個別日程表など他の画面からもこの工程が消えます（日程未設定に戻すのではなく完全に削除します）。よろしいですか？')) return;
        const snapshot = deleteProcess(productNo, procId);
        render();
        if(snapshot){
          showUndo(label+'を削除しました', ()=>{
            restoreProcess(snapshot);
            render();
          });
        }
        return;
      }
    });

    // ---- 表示期間の選択UI：旧・1/2/3ヶ月表示トグル（#monthToggle）を、開始日・終了日を自由指定できるピッカーに差し替える。
    // 静的HTML側は直していないので、ここで#monthToggleを見つけて置き換える（無ければtoolRowの先頭に追加）。 ----
    const toolRowEl = document.querySelector('.toolRow');
    let rangeToggleEl = document.getElementById('rangeToggle');
    if(!rangeToggleEl && toolRowEl){
      rangeToggleEl = document.createElement('div');
      rangeToggleEl.className = 'rangeToggle';
      rangeToggleEl.id = 'rangeToggle';
      rangeToggleEl.innerHTML =
        '表示期間'
        + '<input type="date" id="viewStartInput">'
        + '<span class="rangeTilde">～</span>'
        + '<input type="date" id="viewEndInput">'
        + '<button type="button" class="rangeResetBtn" id="rangeResetBtn" title="全バーの開始日～終了日（データが無ければ今日から1ヶ月）に戻す">初期表示に戻す</button>';
      const oldMonthToggleEl = document.getElementById('monthToggle');
      if(oldMonthToggleEl){
        oldMonthToggleEl.replaceWith(rangeToggleEl);
      }else{
        toolRowEl.insertBefore(rangeToggleEl, toolRowEl.firstChild);
      }
    }
    const viewStartInput = document.getElementById('viewStartInput');
    const viewEndInput = document.getElementById('viewEndInput');
    function updateRangeInputsUI(){
      if(!viewStartInput || !viewEndInput) return;
      viewStartInput.value = fmtDateForInput(viewStart);
      viewEndInput.value = fmtDateForInput(viewEnd);
    }
    function applyViewChange(newStart, newEnd){
      if(!newStart || !newEnd || newEnd < newStart){ updateRangeInputsUI(); return; }
      const maxEnd = new Date(newStart);
      maxEnd.setDate(maxEnd.getDate()+MAX_RANGE_DAYS-1);
      if(newEnd > maxEnd) newEnd = maxEnd;
      viewStart = newStart; viewEnd = newEnd;
      RANGE_START = viewStart;
      saveView();
      updateRangeInputsUI();
      applyWeekendBackground();
      render();
    }
    if(viewStartInput && viewEndInput){
      viewStartInput.addEventListener('change', ()=> applyViewChange(parseDateStr(viewStartInput.value), viewEnd));
      viewEndInput.addEventListener('change', ()=> applyViewChange(viewStart, parseDateStr(viewEndInput.value)));
    }
    const rangeResetBtn = document.getElementById('rangeResetBtn');
    if(rangeResetBtn){
      rangeResetBtn.addEventListener('click', ()=>{
        const def = computeDefaultView();
        viewStart = def.start; viewEnd = def.end;
        RANGE_START = viewStart;
        saveView();
        updateRangeInputsUI();
        applyWeekendBackground();
        render();
      });
    }
    updateRangeInputsUI();

    // ---- 自由配置メモ（吹き出し）の追加ボタン。静的HTML側には無いので、ここでtoolRowに追加する ----
    let addMemoBtn = document.getElementById('addMemoBtn');
    if(!addMemoBtn && toolRowEl){
      addMemoBtn = document.createElement('button');
      addMemoBtn.type = 'button';
      addMemoBtn.id = 'addMemoBtn';
      addMemoBtn.className = 'addMemoBtn';
      addMemoBtn.textContent = '＋ メモを追加';
      toolRowEl.appendChild(addMemoBtn);
    }
    if(addMemoBtn){
      addMemoBtn.addEventListener('click', ()=>{
        const scrollEl = ganttCard.querySelector('.ganttScroll');
        const id = uid();
        memos.push({ id, x: (scrollEl?scrollEl.scrollLeft:0)+24, y:24, w:180, h:92, text:'' });
        saveMemos();
        render();
        const bodyEl = ganttInner.querySelector('.memoNote[data-memo-id="'+id+'"] [data-role="memoBody"]');
        if(bodyEl) bodyEl.focus();
      });
    }

    // ---- 自由記述バー欄（freeBarCard）。静的HTML側には無いので、ジョブ一覧のカードのすぐ下にここで作って差し込む ----
    let freeBarCardEl = document.getElementById('freeBarCard');
    if(!freeBarCardEl){
      freeBarCardEl = document.createElement('div');
      freeBarCardEl.id = 'freeBarCard';
      freeBarCardEl.className = 'freeBarCard';
      freeBarCardEl.innerHTML =
        '<div class="freeBarHead">自由記述バー<span class="freeBarHint">（部品表とは関係のないバーを、空いている場所を右クリック→「バーの設置」で追加できます。色は白／黄／緑から選べます）</span></div>'
        + '<div class="ganttScroll" id="freeGanttScroll"><div class="ganttInner" id="freeGanttInner"></div></div>';
      ganttCard.insertAdjacentElement('afterend', freeBarCardEl);
    }
    const freeGanttInner = document.getElementById('freeGanttInner');

    // ---- 自由記述バーのラベル・色を編集するポップアップ（NC日程表_モック.htmlのlabelPickerと同じ考え方） ----
    let labelPickerEl = document.getElementById('procGanttLabelPicker');
    if(!labelPickerEl){
      labelPickerEl = document.createElement('div');
      labelPickerEl.id = 'procGanttLabelPicker';
      labelPickerEl.className = 'labelPicker';
      labelPickerEl.innerHTML =
        '<textarea id="procGanttLpInput" placeholder="バーの内容を入力"></textarea>'
        + '<div class="lpColorRow"><span class="lpColorLabel">バーの色：</span>'
        + '<button type="button" class="lpColorSwatch" data-color="white" style="background:#ffffff;" title="白"></button>'
        + '<button type="button" class="lpColorSwatch" data-color="yellow" style="background:#ffe066;" title="黄"></button>'
        + '<button type="button" class="lpColorSwatch" data-color="green" style="background:#92d050;" title="緑"></button>'
        + '</div>'
        + '<div class="lpFoot"><div class="lpFootLeft">'
        + '<button class="lpCancel" id="procGanttLpCancel" type="button">キャンセル</button>'
        + '<button class="lpClear" id="procGanttLpClear" type="button">クリア</button>'
        + '</div><button class="lpApply" id="procGanttLpApply" type="button">決定</button></div>';
      document.body.appendChild(labelPickerEl);
    }
    const lpInput = labelPickerEl.querySelector('#procGanttLpInput');
    const lpApplyBtn = labelPickerEl.querySelector('#procGanttLpApply');
    const lpClearBtn = labelPickerEl.querySelector('#procGanttLpClear');
    const lpCancelBtn = labelPickerEl.querySelector('#procGanttLpCancel');
    const lpColorBtns = Array.prototype.slice.call(labelPickerEl.querySelectorAll('.lpColorSwatch'));
    let lpTarget = null; // { lane, id, isNew, color }
    function setLpColor(name){
      if(!lpTarget) return;
      lpTarget.color = name;
      lpColorBtns.forEach(btn=> btn.classList.toggle('active', btn.dataset.color===name));
    }
    lpColorBtns.forEach(btn=> btn.addEventListener('click', ()=> setLpColor(btn.dataset.color)));
    function openLabelPicker(lane, id, currentLabel, anchorRect, isNew){
      const bar = (freeBars[lane]||[]).find(b=>b.id===id);
      lpTarget = { lane, id, isNew: !!isNew, color: (bar && bar.color) || 'white' };
      lpInput.value = currentLabel || '';
      setLpColor(lpTarget.color);
      const pickerW = 300;
      let left = anchorRect.left, top = anchorRect.bottom + 6;
      if(left + pickerW > window.innerWidth - 10) left = window.innerWidth - pickerW - 10;
      if(left < 10) left = 10;
      if(top + 220 > window.innerHeight){ top = anchorRect.top - 226; if(top < 10) top = 10; }
      labelPickerEl.style.left = left+'px';
      labelPickerEl.style.top = top+'px';
      labelPickerEl.classList.add('open');
      lpInput.focus();
      lpInput.select();
    }
    function closeLabelPicker(){
      labelPickerEl.classList.remove('open');
      lpTarget = null;
    }
    function cancelLabelPicker(){
      if(!lpTarget) return;
      const { lane, id, isNew } = lpTarget;
      if(isNew){
        freeBars[lane] = (freeBars[lane]||[]).filter(b=>b.id!==id);
        saveFreeBars();
        closeLabelPicker();
        renderFree();
        return;
      }
      closeLabelPicker();
    }
    function commitLabelPicker(newLabel){
      if(!lpTarget) return;
      const { lane, id, color } = lpTarget;
      const bar = (freeBars[lane]||[]).find(b=>b.id===id);
      if(bar){
        bar.label = (newLabel||'').trim();
        bar.color = color || 'white';
        saveFreeBars();
      }
      closeLabelPicker();
      renderFree();
    }
    lpApplyBtn.addEventListener('click', ()=> commitLabelPicker(lpInput.value));
    lpClearBtn.addEventListener('click', ()=> commitLabelPicker(''));
    lpCancelBtn.addEventListener('click', cancelLabelPicker);
    lpInput.addEventListener('keydown', (e)=>{ if(e.key==='Escape'){ e.preventDefault(); cancelLabelPicker(); } });
    document.addEventListener('mousedown', (e)=>{
      if(!labelPickerEl.classList.contains('open')) return;
      if(labelPickerEl.contains(e.target)) return;
      cancelLabelPicker();
    });

    // ---- 工数の直接編集：作業票データの processes[].hours（正本）へ書く ----
    // 打っている途中では保存しない（共有データを1文字ごとに書き換えないため）。欄から離れた時に1回だけ保存する。
    // 0以上の数だけを受け付け、負数や数値でないものは保存せず元の値へ戻す。空欄は「未入力」として保存する。
    function saveHoursToBuhin(productNo, procId, raw){
      if(!productNo || !procId) return false;
      const t = (raw==null ? '' : String(raw)).trim();
      if(t !== ''){
        const n = Number(t);
        if(!isFinite(n) || n < 0) return false;
      }
      const key = 'sakaeIS_buhinhyoMock_v1_' + productNo;
      let bs;
      try{ bs = JSON.parse(localStorage.getItem(key)); }catch(e){ return false; }
      if(!bs) return false;
      let hit = null;
      (bs.parts||[]).forEach(part=>{
        (part.processes||[]).forEach(pr=>{ if(pr && pr.id === procId) hit = pr; });
      });
      if(!hit) return false;
      hit.hours = t;                       // 打った通りの文字列のまま（小数の桁を丸めない）
      localStorage.setItem(key, JSON.stringify(bs));
      return true;
    }
    ganttInner.addEventListener('change', (e)=>{
      const field = e.target.dataset.field;
      if(field !== 'manHour') return;
      const procId = e.target.dataset.procid;
      const productNo = e.target.dataset.productno;
      const ok = saveHoursToBuhin(productNo, procId, e.target.value);
      if(!ok){
        window.alert('工数は0以上の数で入れてください（例：6、6.5、0）。空欄にすると未入力になります。');
        const job = jobs.find(j=>j.procId === procId);
        e.target.value = job ? (job.hours||'') : '';
        e.target.focus();
        return;
      }
      // 自分の操作の結果は、共有からの通知を待たずにその場で反映する
      refreshJobs();
      render();
    });

    render();

    // ---- ドラッグ操作：バーの移動のみ（幅は半日固定・伸縮なし。行をまたいだ移動も無し） ----
    let drag = null;
    function unitFromClientX(trackEl, clientX){
      const rect = trackEl.getBoundingClientRect();
      const dayCount = Number(trackEl.dataset.unitCount) || currentUnitCount();
      const halfCount = dayCount * 2;
      let idx = Math.floor((clientX - rect.left) / (DAY_W/2)) + 1;
      if(idx < 1) idx = 1;
      if(idx > halfCount) idx = halfCount;
      return idx;
    }
    function updateBarVisual(trackEl, procId, startHalf, endHalf){
      const barEl = trackEl.querySelector('[data-range="'+procId+'"]');
      if(!barEl) return;
      const HALF_W = DAY_W/2;
      barEl.style.left = ((startHalf-1)*HALF_W)+'px';
      barEl.style.width = ((endHalf-startHalf+1)*HALF_W)+'px';
    }

    // ---- バーの右クリックメニュー：削除（バー上に常時出る×は誤操作しやすかったため廃止）。
    // 「削除」は実際にはこの工程の日付をクリアして未日程に戻す処理で、部品表・個別日程表など他画面とデータを共有しているため、
    // それらの画面からもこの工程の日程が消えることを削除前に警告する。 ----
    let barCtxMenu = document.getElementById('procGanttBarCtxMenu');
    if(!barCtxMenu){
      barCtxMenu = document.createElement('div');
      barCtxMenu.id = 'procGanttBarCtxMenu';
      barCtxMenu.className = 'barCtxMenu';
      barCtxMenu.innerHTML = '<button type="button" class="danger" id="procGanttCtxDelete">削除</button>';
      document.body.appendChild(barCtxMenu);
    }
    const ctxDeleteBtn = barCtxMenu.querySelector('#procGanttCtxDelete');

    // ---- 直前の1操作だけ元に戻せる仕組み（削除など）。このページを開いている間だけ有効（保存はしない）。
    // 新しく別の操作をすると、前の「戻す」は上書きされて消える（複数段階は戻せない）。
    // 静的HTML側にトースト要素が無いので、ここで作って差し込む（右クリックメニューと同じやり方）。 ----
    let undoToastEl = document.getElementById('procGanttUndoToast');
    if(!undoToastEl){
      undoToastEl = document.createElement('div');
      undoToastEl.id = 'procGanttUndoToast';
      undoToastEl.className = 'undoToast';
      undoToastEl.innerHTML = '<span id="procGanttUndoToastText"></span><button type="button" id="procGanttUndoToastBtn">元に戻す</button>';
      document.body.appendChild(undoToastEl);
    }
    const undoToastTextEl = undoToastEl.querySelector('#procGanttUndoToastText');
    const undoToastBtn = undoToastEl.querySelector('#procGanttUndoToastBtn');
    let lastUndo = null;
    let undoToastTimer = null;
    function showUndo(message, undoFn){
      lastUndo = { undo: undoFn };
      undoToastTextEl.textContent = message;
      undoToastEl.classList.add('show');
      if(undoToastTimer) clearTimeout(undoToastTimer);
      undoToastTimer = setTimeout(()=>{ undoToastEl.classList.remove('show'); lastUndo = null; }, 8000);
    }
    if(!undoToastBtn.dataset.bound){
      undoToastBtn.dataset.bound = '1';
      undoToastBtn.addEventListener('click', ()=>{
        if(!lastUndo) return;
        const fn = lastUndo.undo;
        lastUndo = null;
        undoToastEl.classList.remove('show');
        if(undoToastTimer) clearTimeout(undoToastTimer);
        fn();
      });
    }
    if(!window.__procGanttUndoKeyBound){
      window.__procGanttUndoKeyBound = true;
      // Ctrl+Z／Cmd+Zでも同じ「元に戻す」を実行できるようにする（入力欄内では文字の入力取り消しを邪魔しないよう素通りさせる）
      document.addEventListener('keydown', (e)=>{
        if((e.key!=='z' && e.key!=='Z') || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
        const tag = document.activeElement && document.activeElement.tagName;
        if(tag==='INPUT' || tag==='TEXTAREA') return;
        if(!lastUndo) return;
        e.preventDefault();
        const fn = lastUndo.undo;
        lastUndo = null;
        undoToastEl.classList.remove('show');
        if(undoToastTimer) clearTimeout(undoToastTimer);
        fn();
      });
    }
    let ctxTargetProcId = null;
    function openBarCtxMenu(procId, x, y){
      ctxTargetProcId = procId;
      barCtxMenu.classList.add('open');
      const menuW = 150;
      let left = x, top = y;
      if(left + menuW > window.innerWidth - 10) left = window.innerWidth - menuW - 10;
      if(left < 10) left = 10;
      barCtxMenu.style.left = left+'px';
      barCtxMenu.style.top = top+'px';
    }
    function closeBarCtxMenu(){
      barCtxMenu.classList.remove('open');
      ctxTargetProcId = null;
    }
    ganttInner.addEventListener('contextmenu', (e)=>{
      const barEl = e.target.closest('[data-range]');
      if(!barEl) return;
      e.preventDefault();
      openBarCtxMenu(barEl.dataset.range, e.clientX, e.clientY);
    });
    document.addEventListener('click', (e)=>{
      if(!barCtxMenu.classList.contains('open')) return;
      if(barCtxMenu.contains(e.target)) return;
      closeBarCtxMenu();
    });
    window.addEventListener('scroll', closeBarCtxMenu, true);
    ctxDeleteBtn.addEventListener('click', ()=>{
      const procId = ctxTargetProcId;
      closeBarCtxMenu();
      if(!procId) return;
      const job = jobs.find(j=>j.procId===procId);
      if(!job) return;
      if(!window.confirm('この工程の日程（この日程表での表示位置）を削除します。作業票・個別日程表の日程は変わりません。よろしいですか？')) return;
      const snapshot = dateOverrides[procId] ? Object.assign({}, dateOverrides[procId]) : null;
      const productNo = job.productNo;
      dateOverrides[procId] = { date: '', ampm: 'AM' };
      saveDateOverrides();
      render();
      showUndo('工程の日程を削除しました', ()=>{
        if(snapshot) dateOverrides[procId] = snapshot;
        else delete dateOverrides[procId];
        saveDateOverrides();
        render();
      });
    });

    ganttInner.addEventListener('mousedown', (e)=>{
      const handleLeft = e.target.closest('[data-role="handle-left"]');
      const handleRight = e.target.closest('[data-role="handle-right"]');
      const barEl = e.target.closest('[data-range]');
      if(!barEl) return;
      e.preventDefault();
      const trackEl = barEl.closest('[data-role="track"]');
      const procId = trackEl.dataset.procid;
      const job = jobs.find(j=>j.procId===procId);
      if(!job) return;
      // 作業票の工程日は「終了（納期）」を表すため、endHalfをjob.dateに合わせ、そこから日数ぶん手前をstartHalfにする。
      const endHalf = halfIdxForDate(parseDateStr(job.date), job.ampm==='PM');
      const days = job.days || 3;
      const startHalf = Math.max(1, endHalf - (days - 1));
      const startUnit = unitFromClientX(trackEl, e.clientX);
      let mode = 'move';
      if(handleLeft) mode = 'resize-left';
      else if(handleRight) mode = 'resize-right';
      drag = { trackEl, procId, job, mode, startHalf, endHalf, startUnit, workingStart: startHalf, workingEnd: endHalf };
    });
    document.addEventListener('mousemove', (e)=>{
      if(!drag) return;
      const unit = unitFromClientX(drag.trackEl, e.clientX);
      const delta = unit - drag.startUnit;
      const unitCount = (Number(drag.trackEl.dataset.unitCount) || currentUnitCount()) * 2;
      if(drag.mode === 'move'){
        const span = drag.endHalf - drag.startHalf;
        let ns = drag.startHalf + delta;
        if(ns < 1) ns = 1;
        if(ns + span > unitCount) ns = unitCount - span;
        drag.workingStart = ns; drag.workingEnd = ns + span;
      }else if(drag.mode === 'resize-left'){
        let ns = drag.startHalf + delta;
        if(ns < 1) ns = 1;
        if(ns > drag.endHalf) ns = drag.endHalf;
        drag.workingStart = ns; drag.workingEnd = drag.endHalf;
      }else{
        let ne = drag.endHalf + delta;
        if(ne > unitCount) ne = unitCount;
        if(ne < drag.startHalf) ne = drag.startHalf;
        drag.workingStart = drag.startHalf; drag.workingEnd = ne;
      }
      updateBarVisual(drag.trackEl, drag.procId, drag.workingStart, drag.workingEnd);
    });
    document.addEventListener('mouseup', ()=>{
      if(!drag) return;
      if(drag.workingStart !== drag.startHalf || drag.workingEnd !== drag.endHalf){
        const h = dateForHalfIdx(drag.workingEnd);
        const dt = h.date;
        const dateStr = dt.getFullYear()+'-'+String(dt.getMonth()+1).padStart(2,'0')+'-'+String(dt.getDate()).padStart(2,'0');
        const days = drag.workingEnd - drag.workingStart + 1;
        dateOverrides[drag.procId] = { date: dateStr, ampm: h.isPM?'PM':'AM', days: days };
        saveDateOverrides();
        render();
      }
      drag = null;
    });

    // ---- 自由記述バー：バー上での右クリック＝編集／削除、何もない空きマスでの右クリック＝「バーの設置」（NC日程表_モック.htmlと同じ考え方） ----
    let freeCtxMenu = document.getElementById('procGanttFreeCtxMenu');
    if(!freeCtxMenu){
      freeCtxMenu = document.createElement('div');
      freeCtxMenu.id = 'procGanttFreeCtxMenu';
      freeCtxMenu.className = 'barCtxMenu';
      freeCtxMenu.innerHTML =
        '<button type="button" id="procGanttCtxPlaceBar">バーの設置</button>'
        + '<button type="button" id="procGanttCtxEditFreeBar">編集</button>'
        + '<button type="button" class="danger" id="procGanttCtxDeleteFreeBar">削除</button>';
      document.body.appendChild(freeCtxMenu);
    }
    const ctxPlaceBarBtn = freeCtxMenu.querySelector('#procGanttCtxPlaceBar');
    const ctxEditFreeBarBtn = freeCtxMenu.querySelector('#procGanttCtxEditFreeBar');
    const ctxDeleteFreeBarBtn = freeCtxMenu.querySelector('#procGanttCtxDeleteFreeBar');
    let ctxFreeBarTarget = null; // { lane, id, barEl }
    let ctxPlaceTarget = null; // { lane, startUnit }
    function openFreeCtxMenu(x, y){
      freeCtxMenu.classList.add('open');
      const menuW = 150;
      let left = x, top = y;
      if(left + menuW > window.innerWidth - 10) left = window.innerWidth - menuW - 10;
      if(left < 10) left = 10;
      freeCtxMenu.style.left = left+'px';
      freeCtxMenu.style.top = top+'px';
    }
    function closeFreeCtxMenu(){
      freeCtxMenu.classList.remove('open');
      ctxFreeBarTarget = null;
      ctxPlaceTarget = null;
    }
    if(freeGanttInner){
      freeGanttInner.addEventListener('contextmenu', (e)=>{
        const barEl = e.target.closest('[data-freebar]');
        if(barEl){
          e.preventDefault();
          const trackEl = barEl.closest('[data-role="freetrack"]');
          ctxFreeBarTarget = { lane: Number(trackEl.dataset.lane), id: barEl.dataset.freebar, barEl };
          ctxPlaceBarBtn.style.display = 'none';
          ctxEditFreeBarBtn.style.display = '';
          ctxDeleteFreeBarBtn.style.display = '';
          openFreeCtxMenu(e.clientX, e.clientY);
          return;
        }
        const trackEl = e.target.closest('[data-role="freetrack"]');
        if(!trackEl) return;
        e.preventDefault();
        const lane = Number(trackEl.dataset.lane);
        const startUnit = unitFromClientX(trackEl, e.clientX);
        ctxPlaceTarget = { lane, startUnit };
        ctxPlaceBarBtn.style.display = '';
        ctxEditFreeBarBtn.style.display = 'none';
        ctxDeleteFreeBarBtn.style.display = 'none';
        openFreeCtxMenu(e.clientX, e.clientY);
      });
    }
    document.addEventListener('click', (e)=>{
      if(!freeCtxMenu.classList.contains('open')) return;
      if(freeCtxMenu.contains(e.target)) return;
      closeFreeCtxMenu();
    });
    window.addEventListener('scroll', closeFreeCtxMenu, true);
    ctxPlaceBarBtn.addEventListener('click', ()=>{
      if(!ctxPlaceTarget) return;
      const { lane, startUnit } = ctxPlaceTarget;
      closeFreeCtxMenu();
      const newId = uid();
      const DEFAULT_WIDTH = 2; // 半日単位×2＝1日分
      freeBars[lane] = freeBars[lane] || [];
      freeBars[lane].push({ id:newId, start:startUnit, end:startUnit+DEFAULT_WIDTH-1, label:'', color:'white' });
      saveFreeBars();
      renderFree();
      const barEl = freeGanttInner.querySelector('[data-freebar="'+newId+'"]');
      if(barEl) openLabelPicker(lane, newId, '', barEl.getBoundingClientRect(), true);
    });
    ctxEditFreeBarBtn.addEventListener('click', ()=>{
      if(!ctxFreeBarTarget) return;
      const { lane, id, barEl } = ctxFreeBarTarget;
      const bar = (freeBars[lane]||[]).find(b=>b.id===id);
      closeFreeCtxMenu();
      if(bar) openLabelPicker(lane, id, bar.label, barEl.getBoundingClientRect(), false);
    });
    ctxDeleteFreeBarBtn.addEventListener('click', ()=>{
      if(!ctxFreeBarTarget) return;
      const { lane, id } = ctxFreeBarTarget;
      closeFreeCtxMenu();
      const bar = (freeBars[lane]||[]).find(b=>b.id===id);
      const snapshot = bar ? JSON.parse(JSON.stringify(bar)) : null;
      freeBars[lane] = (freeBars[lane]||[]).filter(b=>b.id!==id);
      saveFreeBars();
      renderFree();
      if(snapshot){
        showUndo((snapshot.label||'バー')+'を削除しました', ()=>{
          freeBars[lane] = freeBars[lane] || [];
          freeBars[lane].push(snapshot);
          saveFreeBars();
          renderFree();
        });
      }
    });

    if(freeGanttInner){
      freeGanttInner.addEventListener('dblclick', (e)=>{
        const barEl = e.target.closest('[data-freebar]');
        if(!barEl) return;
        const trackEl = barEl.closest('[data-role="freetrack"]');
        const lane = Number(trackEl.dataset.lane);
        const id = barEl.dataset.freebar;
        const bar = (freeBars[lane]||[]).find(b=>b.id===id);
        if(!bar) return;
        openLabelPicker(lane, id, bar.label, barEl.getBoundingClientRect(), false);
      });

      // ---- 行（レーン）の＋／－ ----
      freeGanttInner.addEventListener('click', (e)=>{
        const btn = e.target.closest('[data-role="freerowinc"], [data-role="freerowdec"]');
        if(!btn) return;
        if(btn.dataset.role === 'freerowinc'){
          freeRowCount = Math.min(12, freeRowCount+1);
          saveFreeRowCount();
          renderFree();
          return;
        }
        if(freeRowCount <= 1) return;
        const lastLane = freeRowCount-1;
        const bars = freeBars[lastLane] || [];
        if(bars.length && !window.confirm('この行のバーも消えます。よろしいですか？')) return;
        delete freeBars[lastLane];
        freeRowCount -= 1;
        saveFreeBars();
        saveFreeRowCount();
        renderFree();
      });

      // ---- 自由記述バーのドラッグ操作：移動・両端の伸縮（レーンをまたいだ移動は無し） ----
      let freeDrag = null;
      freeGanttInner.addEventListener('mousedown', (e)=>{
        const handleLeft = e.target.closest('[data-role="handle-left"]');
        const handleRight = e.target.closest('[data-role="handle-right"]');
        const barEl = e.target.closest('[data-freebar]');
        if(!barEl) return;
        e.preventDefault();
        const trackEl = barEl.closest('[data-role="freetrack"]');
        const lane = Number(trackEl.dataset.lane);
        const id = barEl.dataset.freebar;
        const bar = (freeBars[lane]||[]).find(b=>b.id===id);
        if(!bar) return;
        const startUnit = unitFromClientX(trackEl, e.clientX);
        let mode = 'move';
        if(handleLeft) mode = 'resize-left';
        else if(handleRight) mode = 'resize-right';
        freeDrag = { trackEl, lane, id, mode, orig:{ start:bar.start, end:bar.end }, working:{ start:bar.start, end:bar.end }, startUnit };
      });
      document.addEventListener('mousemove', (e)=>{
        if(!freeDrag) return;
        const unit = unitFromClientX(freeDrag.trackEl, e.clientX);
        const delta = unit - freeDrag.startUnit;
        const unitCount = (Number(freeDrag.trackEl.dataset.unitCount) || currentUnitCount()) * 2;
        if(freeDrag.mode === 'move'){
          const span = freeDrag.orig.end - freeDrag.orig.start;
          let ns = freeDrag.orig.start + delta;
          if(ns < 1) ns = 1;
          if(ns + span > unitCount) ns = unitCount - span;
          freeDrag.working = { start: ns, end: ns+span };
        }else if(freeDrag.mode === 'resize-left'){
          let ns = freeDrag.orig.start + delta;
          if(ns < 1) ns = 1;
          if(ns > freeDrag.orig.end) ns = freeDrag.orig.end;
          freeDrag.working = { start: ns, end: freeDrag.orig.end };
        }else{
          let ne = freeDrag.orig.end + delta;
          if(ne > unitCount) ne = unitCount;
          if(ne < freeDrag.orig.start) ne = freeDrag.orig.start;
          freeDrag.working = { start: freeDrag.orig.start, end: ne };
        }
        const barEl = freeDrag.trackEl.querySelector('[data-freebar="'+freeDrag.id+'"]');
        if(barEl){
          const HALF_W = DAY_W/2;
          barEl.style.left = ((freeDrag.working.start-1)*HALF_W)+'px';
          barEl.style.width = ((freeDrag.working.end-freeDrag.working.start+1)*HALF_W)+'px';
        }
      });
      document.addEventListener('mouseup', ()=>{
        if(!freeDrag) return;
        const { lane, id, working, orig } = freeDrag;
        freeDrag = null;
        if(working.start === orig.start && working.end === orig.end) return;
        const bar = (freeBars[lane]||[]).find(b=>b.id===id);
        if(!bar) return;
        bar.start = working.start; bar.end = working.end;
        saveFreeBars();
        renderFree();
        showUndo('バーを動かしました', ()=>{
          const b2 = (freeBars[lane]||[]).find(b=>b.id===id);
          if(b2){ b2.start = orig.start; b2.end = orig.end; saveFreeBars(); renderFree(); }
        });
      });
    }

    // ---- 自由配置メモ（吹き出し）：ドラッグ移動・リサイズ・テキスト編集・右クリック削除（元に戻す対応） ----
    let memoCtxMenu = document.getElementById('procGanttMemoCtxMenu');
    if(!memoCtxMenu){
      memoCtxMenu = document.createElement('div');
      memoCtxMenu.id = 'procGanttMemoCtxMenu';
      memoCtxMenu.className = 'barCtxMenu';
      memoCtxMenu.innerHTML = '<button type="button" class="danger" id="procGanttCtxDeleteMemo">削除</button>';
      document.body.appendChild(memoCtxMenu);
    }
    const ctxDeleteMemoBtn = memoCtxMenu.querySelector('#procGanttCtxDeleteMemo');
    let ctxMemoTarget = null;
    function openMemoCtxMenu(memoId, x, y){
      ctxMemoTarget = memoId;
      memoCtxMenu.classList.add('open');
      const menuW = 140;
      let left = x, top = y;
      if(left + menuW > window.innerWidth - 10) left = window.innerWidth - menuW - 10;
      if(left < 10) left = 10;
      memoCtxMenu.style.left = left+'px';
      memoCtxMenu.style.top = top+'px';
    }
    function closeMemoCtxMenu(){
      memoCtxMenu.classList.remove('open');
      ctxMemoTarget = null;
    }
    ganttInner.addEventListener('contextmenu', (e)=>{
      const noteEl = e.target.closest('.memoNote');
      if(!noteEl) return;
      e.preventDefault();
      openMemoCtxMenu(noteEl.dataset.memoId, e.clientX, e.clientY);
    });
    document.addEventListener('click', (e)=>{
      if(!memoCtxMenu.classList.contains('open')) return;
      if(memoCtxMenu.contains(e.target)) return;
      closeMemoCtxMenu();
    });
    window.addEventListener('scroll', closeMemoCtxMenu, true);
    if(ctxDeleteMemoBtn){
      ctxDeleteMemoBtn.addEventListener('click', ()=>{
        if(!ctxMemoTarget) return;
        const idx = memos.findIndex(m=>m.id===ctxMemoTarget);
        closeMemoCtxMenu();
        if(idx===-1) return;
        const snapshot = JSON.parse(JSON.stringify(memos[idx]));
        memos.splice(idx,1);
        saveMemos();
        render();
        showUndo('メモを削除しました', ()=>{
          memos.splice(Math.min(idx, memos.length), 0, snapshot);
          saveMemos();
          render();
        });
      });
    }

    let memoDrag = null; // { type:'move'|'resize'|'tail', id, startClientX, startClientY, orig:{x,y,w,h,tailX,tailY} }
    ganttInner.addEventListener('mousedown', (e)=>{
      const tailHandleEl = e.target.closest('[data-role="tailHandle"]');
      if(tailHandleEl){
        const memo = memos.find(m=>m.id===tailHandleEl.dataset.memoId);
        if(!memo) return;
        e.preventDefault();
        memoDrag = { type:'tail', id: memo.id, startClientX: e.clientX, startClientY: e.clientY, orig:{ tailX:memo.tailX, tailY:memo.tailY } };
        return;
      }
      const handleEl = e.target.closest('[data-role="memoHandle"]');
      const resizeEl = e.target.closest('[data-role="memoResize"]');
      if(!handleEl && !resizeEl) return;
      const noteEl = e.target.closest('.memoNote');
      if(!noteEl) return;
      const memo = memos.find(m=>m.id===noteEl.dataset.memoId);
      if(!memo) return;
      e.preventDefault();
      ensureMemoTail(memo);
      memoDrag = { type: handleEl ? 'move' : 'resize', id: memo.id, startClientX: e.clientX, startClientY: e.clientY, orig:{ x:memo.x, y:memo.y, w:memo.w, h:memo.h, tailX:memo.tailX, tailY:memo.tailY } };
    });
    document.addEventListener('mousemove', (e)=>{
      if(!memoDrag) return;
      const memo = memos.find(m=>m.id===memoDrag.id);
      if(!memo) return;
      const dx = e.clientX - memoDrag.startClientX;
      const dy = e.clientY - memoDrag.startClientY;
      const noteEl = ganttInner.querySelector('.memoNote[data-memo-id="'+memoDrag.id+'"]');
      if(memoDrag.type==='move'){
        memo.x = Math.max(0, memoDrag.orig.x + dx);
        memo.y = Math.max(0, memoDrag.orig.y + dy);
        // 先端（矢印の的）も本体と一緒に動かす。向き・長さは保ったまま平行移動する（先端だけ動かしたい時はtailHandleを直接つかむ）
        memo.tailX = memoDrag.orig.tailX + dx;
        memo.tailY = memoDrag.orig.tailY + dy;
        if(noteEl){ noteEl.style.left = memo.x+'px'; noteEl.style.top = memo.y+'px'; }
        updateMemoTailVisual(memo);
      }else if(memoDrag.type==='resize'){
        memo.w = Math.max(90, memoDrag.orig.w + dx);
        memo.h = Math.max(56, memoDrag.orig.h + dy);
        if(noteEl){ noteEl.style.width = memo.w+'px'; noteEl.style.height = memo.h+'px'; }
        updateMemoTailVisual(memo);
      }else if(memoDrag.type==='tail'){
        memo.tailX = memoDrag.orig.tailX + dx;
        memo.tailY = memoDrag.orig.tailY + dy;
        updateMemoTailVisual(memo);
      }
    });
    document.addEventListener('mouseup', ()=>{
      if(!memoDrag) return;
      memoDrag = null;
      saveMemos();
    });
    ganttInner.addEventListener('input', (e)=>{
      const bodyEl = e.target.closest('[data-role="memoBody"]');
      if(!bodyEl) return;
      const noteEl = bodyEl.closest('.memoNote');
      const memo = memos.find(m=>m.id===noteEl.dataset.memoId);
      if(memo){ memo.text = bodyEl.value; saveMemos(); }
    });

    // ---- 他のタブ（部品表・別の工程日程表タブ）での変更をリアルタイムに反映 ----
    window.addEventListener('storage', (e)=>{
      if(!e.key) return;
      if(e.key.indexOf('sakaeIS_buhinhyoMock_v1_')===0 || e.key===EXTRA_KEY){
        extra = loadExtra();
        render();
      }
      if(e.key===FREE_KEY || e.key===FREE_ROWCOUNT_KEY){
        freeBars = loadFreeBars();
        freeRowCount = loadFreeRowCount();
        renderFree();
      }
      if(e.key===DATE_OVERRIDE_KEY){
        dateOverrides = loadDateOverrides();
        render();
      }
    });
  }

  return { init: init };
})();
