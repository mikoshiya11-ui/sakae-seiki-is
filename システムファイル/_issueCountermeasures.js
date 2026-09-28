// ============================================================================
// SAKAE 問題点対策表（SAKAE-ISSUE-01）共通ロジック
//
// ・接続先（本番／DEV）は読み込んだ _issueTarget*.js が固定する。この JS には
//   切替 UI も URL パラメータも設定項目も持たせない（裁定 c）。
// ・_sakaeSync.js は読み込まない。kv_store・localStorage の業務データには触れない。
//   localStorage に書くのは画面の絞り込み条件だけ（接頭辞 sakaeIssue_＝同期対象外）。
// ・起動は fail-closed：ログイン確認 → 利用権限 RPC → true のときだけ
//   一覧取得・登録・Realtime を開始する。権限が取れないときに「0 件」とは絶対に出さない。
// ============================================================================
(function(){
  'use strict';
  const T = window.SAKAE_ISSUE_TARGET;
  if(!T){ document.addEventListener('DOMContentLoaded', ()=>{ document.body.innerHTML = '<p style="padding:24px">接続先が設定されていません（_issueTarget*.js が読み込まれていません）。</p>'; }); return; }

  const SUPABASE_UMD = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
  const LOGIN_PAGE = 'ログイン.html';
  const PAGE_SIZE = 50;                       // 裁定 f：1 ページ 50 件（DB 側 range で取得）
  const PREF_KEY = 'sakaeIssue_filters_v1';   // 画面の絞り込み条件のみ（業務データではない）
  const STATUSES = ['未対応','調査中','対策中','確認待ち','完了','取消'];
  const PRIORITIES = ['高','中','低'];
  const RESULTS = ['OK','NG','再対策'];
  const PLACES = ['TOP／案件一覧','作業票','個別日程表','工程別残品表','実績入力','同期／共有','印刷','その他'];

  let sb = null;                 // Supabase クライアント（このページ専用）
  let me = { email:'', uid:'' };
  let state = {
    filters: { status:'', priority:'', reported_by:'', owner:'', location:'', from:'', to:'', q:'' },
    page: 1, total: 0, rows: [], counts: {}, current: null, editing: false, dirty: false
  };

  // ---- 小物 ----------------------------------------------------------------
  const $ = (id)=> document.getElementById(id);
  const esc = (s)=> String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const todayStr = ()=>{ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
  const fmtDate = (s)=> s ? String(s).slice(0,10).replace(/-/g,'/') : '—';
  const fmtDateTime = (s)=>{ if(!s) return '—'; const d=new Date(s); return isNaN(d) ? String(s) : (d.getFullYear()+'/'+String(d.getMonth()+1).padStart(2,'0')+'/'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0')); };
  const trim = (v)=> String(v==null?'':v).trim();
  function loadScript(src){ return new Promise((ok,ng)=>{ const s=document.createElement('script'); s.src=src; s.onload=ok; s.onerror=()=>ng(new Error('script load failed: '+src)); document.head.appendChild(s); }); }

  // ---- 起動時の全面ゲート（既存画面と同じ見え方） ---------------------------
  function gate(msg){
    let el = $('issueGate');
    if(!el){
      el = document.createElement('div'); el.id='issueGate';
      el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:#f4f6fa;display:flex;align-items:center;justify-content:center;color:#5b6b84;font-size:14px;';
      document.body.appendChild(el);
    }
    el.textContent = msg;
  }
  function ungate(){ const el=$('issueGate'); if(el) el.remove(); }

  // 権限なし／接続不可：一覧を取りに行かず、この画面で止める（「0 件」とは出さない）
  function blockScreen(title, lines){
    ungate();
    const main = $('mainArea');
    main.innerHTML = '<div class="blocker"><h2>'+esc(title)+'</h2>'+lines.map(l=>'<p>'+esc(l)+'</p>').join('')+'</div>';
    $('toolArea').style.display = 'none';
    $('summaryArea').style.display = 'none';
  }

  // ---- 起動 ---------------------------------------------------------------
  async function boot(){
    gate('ログイン状態を確認しています…');
    try{
      await loadScript(SUPABASE_UMD);
      sb = window.supabase.createClient(window.SAKAE_SUPABASE_URL, window.SAKAE_SUPABASE_ANON_KEY);
    }catch(e){
      blockScreen('共有に接続できません', ['Supabase の読み込みに失敗しました（'+e.message+'）。', 'ネットワークを確認して再読込してください。']);
      return;
    }

    let session = null;
    try{ session = (await sb.auth.getSession()).data.session; }
    catch(e){ blockScreen('共有に接続できません', ['ログイン状態を確認できませんでした（'+e.message+'）。','再読込してください。']); return; }
    if(!session){
      location.href = LOGIN_PAGE + '?next=' + encodeURIComponent(location.pathname + location.search);
      return;
    }
    me.email = (session.user && session.user.email) || '';
    me.uid = (session.user && session.user.id) || '';
    $('whoAmI').textContent = me.email;

    // ★利用権限の確認（true のときだけ画面を開始する）
    gate('利用権限を確認しています…');
    let authorized = null, rpcErr = null;
    try{
      const r = await sb.rpc(T.authFn);
      if(r.error) rpcErr = r.error; else authorized = (r.data === true);
    }catch(e){ rpcErr = e; }

    if(rpcErr){
      blockScreen('共有に接続できません', ['利用権限を確認できませんでした（'+(rpcErr.message||rpcErr)+'）。','再読込してください。','※ 問題が 0 件という意味ではありません。']);
      return;
    }
    if(authorized !== true){
      // 一覧取得・登録・Realtime のいずれも開始しない
      blockScreen('SAKAEの利用権限を確認できません。管理者へ連絡してください。', [
        'ログインはできていますが、このアカウントには SAKAE の共有データを扱う権限がありません。',
        '問題が 0 件なのではなく、権限が確認できないため表示していません。',
        'ログイン中のアカウント：' + me.email
      ]);
      return;
    }

    ungate();
    restorePrefs();
    bindUI();
    await reload();
    subscribeRealtime();
  }

  // ---- 絞り込み条件（画面設定のみ localStorage） ---------------------------
  function restorePrefs(){
    try{ const raw = localStorage.getItem(PREF_KEY); if(raw) Object.assign(state.filters, JSON.parse(raw)||{}); }catch(e){}
    const f = state.filters;
    $('fStatus').value=f.status; $('fPriority').value=f.priority; $('fReportedBy').value=f.reported_by;
    $('fOwner').value=f.owner; $('fLocation').value=f.location; $('fFrom').value=f.from; $('fTo').value=f.to; $('fQ').value=f.q;
  }
  function savePrefs(){ try{ localStorage.setItem(PREF_KEY, JSON.stringify(state.filters)); }catch(e){} }
  function readFilters(){
    state.filters = {
      status: $('fStatus').value, priority: $('fPriority').value, reported_by: trim($('fReportedBy').value),
      owner: trim($('fOwner').value), location: trim($('fLocation').value),
      from: $('fFrom').value, to: $('fTo').value, q: trim($('fQ').value)
    };
    savePrefs();
  }

  // ---- 問い合わせ（絞り込み・検索・並び・ページングはすべて DB 側） --------
  function applyFilters(query){
    const f = state.filters;
    if(f.status) query = query.eq('status', f.status);
    if(f.priority) query = query.eq('priority', f.priority);
    if(f.reported_by) query = query.ilike('reported_by', '%'+f.reported_by+'%');
    if(f.owner) query = query.ilike('owner', '%'+f.owner+'%');
    if(f.location) query = query.ilike('location', '%'+f.location+'%');
    if(f.from) query = query.gte('report_date', f.from);
    if(f.to) query = query.lte('report_date', f.to);
    if(f.q){
      const k = f.q.replace(/[,()]/g, ' ');
      query = query.or(['issue_no.ilike.%'+k+'%','description.ilike.%'+k+'%','cause.ilike.%'+k+'%','countermeasure.ilike.%'+k+'%','notes.ilike.%'+k+'%'].join(','));
    }
    return query;
  }
  function ordered(query){
    return query.order('status_rank', { ascending:true })
                .order('priority_rank', { ascending:true })
                .order('report_date', { ascending:false })
                .order('id', { ascending:false });   // 同順位の揺れを止める（ページ境界の安定）
  }
  async function fetchPage(){
    const from = (state.page-1)*PAGE_SIZE, to = from + PAGE_SIZE - 1;
    let q = sb.from(T.table).select('*', { count:'exact' });
    q = ordered(applyFilters(q)).range(from, to);
    const { data, count, error } = await q;
    if(error) throw error;
    return { rows: data||[], count: count==null ? (data||[]).length : count };
  }
  async function fetchCounts(){
    const out = {};
    await Promise.all(STATUSES.map(async (st)=>{
      let q = sb.from(T.table).select('id', { count:'exact', head:true });
      const keep = state.filters.status; state.filters.status = '';     // 状態以外の条件は効かせる
      q = applyFilters(q).eq('status', st);
      state.filters.status = keep;
      const { count, error } = await q;
      out[st] = error ? null : (count||0);
    }));
    return out;
  }

  async function reload(keepPage){
    if(!keepPage) state.page = 1;
    $('listNotice').textContent = '';
    try{
      const [page, counts] = await Promise.all([fetchPage(), fetchCounts()]);
      state.rows = page.rows; state.total = page.count; state.counts = counts;
      if(state.total > 0 && state.rows.length === 0 && state.page > 1){    // 端のページが消えたとき
        state.page = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
        const again = await fetchPage(); state.rows = again.rows; state.total = again.count;
      }
      renderSummary(); renderList(); renderPager();
    }catch(e){
      $('listNotice').innerHTML = '<div class="notice err">一覧を取得できませんでした（'+esc(e.message||e)+'）。再読込してください。※ 0 件という意味ではありません。</div>';
    }
  }

  // ---- 描画 ---------------------------------------------------------------
  function renderSummary(){
    const wrap = $('summaryArea');
    const all = Object.keys(state.counts).reduce((n,k)=> n + (state.counts[k]||0), 0);
    let html = '<button data-st="" class="'+(state.filters.status===''?'active':'')+'"><span class="n">'+all+'</span>すべて</button>';
    STATUSES.forEach(st=>{
      html += '<button data-st="'+esc(st)+'" class="'+(state.filters.status===st?'active':'')+'"><span class="n">'+(state.counts[st]==null?'—':state.counts[st])+'</span>'+esc(st)+'</button>';
    });
    wrap.innerHTML = html;
    wrap.querySelectorAll('button').forEach(b=> b.addEventListener('click', ()=>{
      $('fStatus').value = b.dataset.st; readFilters(); reload();
    }));
  }
  function renderList(){
    const tb = $('tbody');
    if(!state.rows.length){
      tb.innerHTML = '';
      $('emptyState').style.display = 'block';
      $('emptyState').textContent = '該当する問題はありません。';
      return;
    }
    $('emptyState').style.display = 'none';
    const today = todayStr();
    tb.innerHTML = state.rows.map(r=>{
      const over = r.due_date && r.due_date < today && r.status!=='完了' && r.status!=='取消';
      return '<tr data-id="'+r.id+'">'
        + '<td class="cardHead"><span class="no">'+esc(r.issue_no)+'</span>'
          + '<span class="badge pri-'+esc(r.priority)+'">'+esc(r.priority)+'</span>'
          + '<span class="badge st-'+esc(r.status)+'">'+esc(r.status)+'</span></td>'
        + '<td data-th="登録日">'+fmtDate(r.report_date)+'</td>'
        + '<td data-th="優先度" class="pcOnly"><span class="badge pri-'+esc(r.priority)+'">'+esc(r.priority)+'</span></td>'
        + '<td data-th="発生場所">'+esc(r.location)+'</td>'
        + '<td data-th="問題内容" class="desc">'+esc(r.description)+'</td>'
        + '<td data-th="担当者">'+esc(r.owner||'—')+'</td>'
        + '<td data-th="状態" class="pcOnly"><span class="badge st-'+esc(r.status)+'">'+esc(r.status)+'</span></td>'
        + '<td data-th="対策期限" class="'+(over?'over':'')+'">'+fmtDate(r.due_date)+(over?' ⚠':'')+'</td>'
        + '<td data-th="確認結果" class="'+(r.review_result?('result-'+esc(r.review_result)):'')+'">'+esc(r.review_result||'—')+'</td>'
        + '</tr>';
    }).join('');
    tb.querySelectorAll('tr').forEach(tr=> tr.addEventListener('click', ()=> openDetail(Number(tr.dataset.id))));
  }
  function renderPager(){
    const pages = Math.max(1, Math.ceil(state.total / PAGE_SIZE));
    const from = state.total ? (state.page-1)*PAGE_SIZE + 1 : 0;
    const to = Math.min(state.page*PAGE_SIZE, state.total);
    $('pagerInfo').textContent = state.total.toLocaleString()+' 件中 '+from+'–'+to+' 件（'+state.page+' / '+pages+' ページ）';
    $('prevBtn').disabled = state.page <= 1;
    $('nextBtn').disabled = state.page >= pages;
    const mismatch = state.rows.length > PAGE_SIZE;
    $('pagerWarn').textContent = mismatch ? '※ 取得件数が想定と異なります。再読込してください。' : '';
  }

  // ---- 詳細・履歴 ---------------------------------------------------------
  const FIELDS = [
    ['report_date','登録日','date'], ['reported_by','登録者','text'], ['location','発生場所','place'],
    ['description','問題内容','area'], ['priority','優先度','priority'], ['status','状態','status'],
    ['cause','原因','area'], ['temporary_action','暫定処置','area'], ['countermeasure','恒久対策','area'],
    ['owner','対策担当者','text'], ['due_date','対策期限','date'], ['action_date','対策日','date'],
    ['reviewer','確認者','text'], ['review_date','確認日','date'], ['review_result','確認結果','result'],
    ['is_recurrence','再発','recur'], ['parent_issue_id','元問題No.','parent'],
    ['evidence','証拠','area'], ['notes','備考','area']
  ];
  async function openDetail(id){
    const panel = $('detailOverlay');
    panel.style.display = 'flex';
    $('detailBody').innerHTML = '<p>読み込んでいます…</p>';
    $('detailNotice').innerHTML = '';
    state.editing = false;
    try{
      const { data, error } = await sb.from(T.table).select('*').eq('id', id).single();
      if(error) throw error;
      state.current = data;
      renderDetail();
      loadHistory(id);
    }catch(e){
      $('detailBody').innerHTML = '<div class="notice err">詳細を取得できませんでした（'+esc(e.message||e)+'）</div>';
    }
  }
  function renderDetail(){
    const r = state.current;
    $('detailTitle').textContent = r.issue_no + '　詳細';
    $('editBtn').style.display = '';
    $('saveBtn').style.display = 'none';
    $('cancelEditBtn').style.display = 'none';
    const rows = FIELDS.map(([k,label])=>{
      let v = r[k];
      if(k==='is_recurrence') v = r.is_recurrence ? '再発' : '初回';
      if(k==='parent_issue_id') v = r.parent_issue_id ? ('PT-'+String(r.parent_issue_id).padStart(4,'0')) : '—';
      if(/_date$/.test(k)) v = fmtDate(v);
      return '<div class="drow"><div class="dk">'+esc(label)+'</div><div class="dv">'+esc(v==null||v===''?'—':v)+'</div></div>';
    }).join('');
    $('detailBody').innerHTML = rows
      + '<div class="drow"><div class="dk">作成</div><div class="dv">'+fmtDateTime(r.created_at)+'</div></div>'
      + '<div class="drow"><div class="dk">更新</div><div class="dv">'+fmtDateTime(r.updated_at)+'</div></div>'
      + '<h3 style="font-size:13px;color:#173a68;margin:16px 0 6px">変更履歴</h3><div id="histBox">読み込んでいます…</div>';
  }
  async function loadHistory(id){
    try{
      const { data, error } = await sb.from(T.historyTable).select('*').eq('issue_id', id).order('changed_at', { ascending:false });
      if(error) throw error;
      const box = $('histBox'); if(!box) return;
      box.innerHTML = (data||[]).map(h=>{
        const diff = diffText(h.before_data, h.after_data);
        return '<div class="histRow"><div class="when">'+fmtDateTime(h.changed_at)+'</div><div class="act">'+esc(h.action)+'</div><div class="dv">'+esc(diff)+'</div></div>';
      }).join('') || '<p style="color:#5b6b84">履歴はありません。</p>';
    }catch(e){
      const box = $('histBox'); if(box) box.innerHTML = '<div class="notice err">履歴を取得できませんでした（'+esc(e.message||e)+'）</div>';
    }
  }
  function diffText(before, after){
    if(!before) return '新規登録';
    const labels = {}; FIELDS.forEach(([k,l])=> labels[k]=l);
    const out = [];
    Object.keys(labels).forEach(k=>{
      const a = before[k]==null?'':String(before[k]), b = after&&after[k]==null?'':String(after&&after[k]);
      if(a !== b) out.push(labels[k]+'：'+(a||'空')+' → '+(b||'空'));
    });
    return out.length ? out.join(' ／ ') : '変更なし';
  }

  // ---- 編集（詳細 → 編集 → 保存。一覧セルの直接編集はしない） -------------
  function fieldHtml(k, label, type, v){
    const req = ['report_date','reported_by','location','description','priority'].includes(k) ? ' <span class="req">*</span>' : '';
    const wide = type==='area' ? ' full' : '';
    let input;
    if(type==='area') input = '<textarea id="e_'+k+'">'+esc(v||'')+'</textarea>';
    else if(type==='date') input = '<input type="date" id="e_'+k+'" value="'+esc(v?String(v).slice(0,10):'')+'">';
    else if(type==='priority') input = '<select id="e_'+k+'">'+PRIORITIES.map(p=>'<option'+(v===p?' selected':'')+'>'+p+'</option>').join('')+'</select>';
    else if(type==='status') input = '<select id="e_'+k+'">'+STATUSES.map(s=>'<option'+(v===s?' selected':'')+'>'+s+'</option>').join('')+'</select>';
    else if(type==='result') input = '<select id="e_'+k+'"><option value=""'+(!v?' selected':'')+'>—</option>'+RESULTS.map(s=>'<option'+(v===s?' selected':'')+'>'+s+'</option>').join('')+'</select>';
    else if(type==='recur') input = '<select id="e_'+k+'"><option value="false"'+(!v?' selected':'')+'>初回</option><option value="true"'+(v?' selected':'')+'>再発</option></select>';
    else if(type==='parent') input = '<input type="text" id="e_'+k+'" placeholder="PT-0012 または 12" value="'+esc(v?('PT-'+String(v).padStart(4,'0')):'')+'">';
    else if(type==='place') input = '<input type="text" id="e_'+k+'" list="placeList" value="'+esc(v||'')+'">';
    else input = '<input type="text" id="e_'+k+'" value="'+esc(v||'')+'">';
    return '<div class="fld'+wide+'"><label>'+esc(label)+req+'</label>'+input+'</div>';
  }
  function startEdit(){
    const r = state.current;
    state.editing = true;
    state.baseline = {};                     // 開いた時点の値（差分だけ送るための基準）
    FIELDS.forEach(([k])=>{ state.baseline[k] = r[k]; });
    $('editBtn').style.display = 'none';
    $('saveBtn').style.display = '';
    $('cancelEditBtn').style.display = '';
    $('detailBody').innerHTML = '<div id="editNotice"></div><div class="formGrid">'
      + FIELDS.map(([k,l,t])=> fieldHtml(k,l,t, r[k])).join('') + '</div>'
      + '<p style="color:#5b6b84;font-size:12px">＊ は必須。完了にするには 恒久対策・対策日・確認者・確認日・確認結果＝OK が必要です。</p>';
    ['change','input'].forEach(ev=> $('detailBody').addEventListener(ev, ()=>{ state.dirty = true; }, { once:false }));
  }
  function collect(){
    const o = {};
    FIELDS.forEach(([k,,t])=>{
      const el = $('e_'+k); if(!el) return;
      let v = el.value;
      if(t==='recur') o[k] = (v === 'true');
      else if(t==='parent'){ const m = /^\s*(?:PT-)?0*(\d+)\s*$/i.exec(v||''); o[k] = m ? Number(m[1]) : null; }
      else o[k] = (trim(v) === '') ? null : (t==='area' ? v : trim(v));
    });
    return o;
  }
  function validate(o){
    const miss = [];
    if(!o.report_date) miss.push('登録日'); if(!o.reported_by) miss.push('登録者');
    if(!o.location) miss.push('発生場所'); if(!o.description) miss.push('問題内容'); if(!o.priority) miss.push('優先度');
    if(o.status === '完了'){
      if(!trim(o.countermeasure)) miss.push('恒久対策');
      if(!o.action_date) miss.push('対策日');
      if(!trim(o.reviewer)) miss.push('確認者');
      if(!o.review_date) miss.push('確認日');
      if(o.review_result !== 'OK') miss.push('確認結果（OK が必要）');
    }
    if(o.parent_issue_id && !o.is_recurrence) miss.push('再発＝再発（元問題を入れる場合）');
    return miss;
  }
  // 開いた時点から利用者が実際に変えた欄だけを返す。触っていない欄は送らない＝
  // 他の利用者がその欄を直していても、こちらの古い値で押し戻さない。
  function changedOnly(o){
    const base = state.baseline || {};
    const out = {};
    Object.keys(o).forEach(k=>{
      const a = base[k]==null ? '' : String(base[k]);
      const b = o[k]==null ? '' : String(o[k]);
      if(a !== b) out[k] = o[k];
    });
    return out;
  }
  async function save(){
    const o = collect();
    const miss = validate(o);
    const nb = $('editNotice');
    if(miss.length){ nb.innerHTML = '<div class="notice err">次の項目が必要です：'+esc(miss.join('、'))+'</div>'; return; }
    nb.innerHTML = '';
    try{
      // 楽観ロック：開いた時点の updated_at と一致する行だけ更新する
      const patch = changedOnly(o);
      if(Object.keys(patch).length === 0){ nb.innerHTML = '<div class="notice info">変更はありません。</div>'; return; }
      const { data, error } = await sb.from(T.table).update(patch)
        .eq('id', state.current.id).eq('updated_at', state.current.updated_at).select();
      if(error) throw error;
      if(!data || data.length === 0){
        // ★0 行は「成功」ではない。最新を取り直して stale update として扱う
        const latest = await sb.from(T.table).select('*').eq('id', state.current.id).single();
        const cur = latest.data;
        nb.innerHTML = '<div class="notice warn">他の利用者がこの問題を更新しました。最新内容を確認してから再度編集してください。</div>'
          + '<div class="notice info">最新：状態 '+esc(cur?cur.status:'—')+'／更新 '+esc(fmtDateTime(cur&&cur.updated_at))+'（'+esc(diffText(state.current, cur))+'）</div>';
        if(cur){
          const mine = changedOnly(o);                 // 自分が変えた欄
          state.current = cur;                         // 次の保存は最新世代に対して行う
          state.baseline = {}; FIELDS.forEach(([k])=>{ state.baseline[k] = cur[k]; });
          FIELDS.forEach(([k,,t])=>{                    // 最新値を入れ直し、自分の変更だけ上書きして残す
            const el = $('e_'+k); if(!el) return;
            if(Object.prototype.hasOwnProperty.call(mine, k)) return;   // 自分の入力は消さない
            const v = cur[k];
            if(t==='recur') el.value = v ? 'true' : 'false';
            else if(t==='parent') el.value = v ? ('PT-'+String(v).padStart(4,'0')) : '';
            else if(t==='date') el.value = v ? String(v).slice(0,10) : '';
            else el.value = (v==null ? '' : v);
          });
        }
        return;
      }
      state.current = data[0];
      state.dirty = false;
      renderDetail(); loadHistory(state.current.id);
      $('detailNotice').innerHTML = '<div class="notice info">保存しました。</div>';
      reload(true);
    }catch(e){
      nb.innerHTML = '<div class="notice err">保存できませんでした（'+esc(e.message||e)+'）。内容はそのまま残っています。</div>';
    }
  }

  // ---- 新規登録 -----------------------------------------------------------
  function openCreate(){
    $('createOverlay').style.display = 'flex';
    $('createNotice').innerHTML = '';
    $('createBody').innerHTML = '<div class="formGrid">'
      + fieldHtml('report_date','登録日','date', todayStr())
      + fieldHtml('reported_by','登録者','text', me.email)
      + fieldHtml('location','発生場所','place','')
      + fieldHtml('priority','優先度','priority','中')
      + fieldHtml('description','問題内容','area','')
      + '</div><p style="color:#5b6b84;font-size:12px">登録すると状態は「未対応」になり、No. は自動で決まります（PT-0001 形式）。原因・対策は後から追記できます。</p>';
  }
  async function create(){
    const o = {};
    ['report_date','reported_by','location','priority','description'].forEach(k=>{
      const el = $('e_'+k); o[k] = el ? (k==='description' ? el.value : trim(el.value)) : '';
    });
    const miss = [];
    if(!o.report_date) miss.push('登録日'); if(!o.reported_by) miss.push('登録者');
    if(!o.location) miss.push('発生場所'); if(!trim(o.description)) miss.push('問題内容'); if(!o.priority) miss.push('優先度');
    if(miss.length){ $('createNotice').innerHTML = '<div class="notice err">次の項目が必要です：'+esc(miss.join('、'))+'</div>'; return; }
    try{
      const { data, error } = await sb.from(T.table).insert(o).select().single();
      if(error) throw error;
      $('createOverlay').style.display = 'none';
      await reload();
      openDetail(data.id);
    }catch(e){
      $('createNotice').innerHTML = '<div class="notice err">登録できませんでした（'+esc(e.message||e)+'）</div>';
    }
  }

  // ---- CSV（現在の絞り込み結果の全件。ページに依らない） -------------------
  async function exportCsv(){
    const btn = $('csvBtn'); btn.disabled = true; btn.textContent = 'CSV 作成中…';
    try{
      const cols = [['issue_no','No.'],['report_date','登録日'],['reported_by','登録者'],['location','発生場所'],
        ['description','問題内容'],['priority','優先度'],['status','状態'],['cause','原因'],['countermeasure','恒久対策'],
        ['owner','担当者'],['due_date','対策期限'],['action_date','対策日'],['reviewer','確認者'],['review_date','確認日'],
        ['review_result','確認結果'],['is_recurrence','再発'],['parent_issue_id','元問題No.']];
      let all = [], from = 0;
      for(;;){
        let q = sb.from(T.table).select('*');
        q = ordered(applyFilters(q)).range(from, from + PAGE_SIZE - 1);
        const { data, error } = await q;
        if(error) throw error;
        all = all.concat(data||[]);
        if(!data || data.length < PAGE_SIZE) break;
        from += PAGE_SIZE;
        if(from > 20000) break;      // 安全弁
      }
      const cell = (v)=>{ const s = v==null?'':String(v); return /[",\r\n]/.test(s) ? '"'+s.replace(/"/g,'""')+'"' : s; };
      const lines = [cols.map(c=>cell(c[1])).join(',')];
      all.forEach(r=> lines.push(cols.map(([k])=>{
        if(k==='is_recurrence') return cell(r.is_recurrence ? '再発' : '初回');
        if(k==='parent_issue_id') return cell(r.parent_issue_id ? ('PT-'+String(r.parent_issue_id).padStart(4,'0')) : '');
        return cell(r[k]);
      }).join(',')));
      const blob = new Blob(['﻿' + lines.join('\r\n')], { type:'text/csv;charset=utf-8;' });
      const d = new Date();
      const name = 'SAKAE_問題点対策表_' + d.getFullYear() + String(d.getMonth()+1).padStart(2,'0') + String(d.getDate()).padStart(2,'0')
        + '_' + String(d.getHours()).padStart(2,'0') + String(d.getMinutes()).padStart(2,'0') + '.csv';
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(a.href);
    }catch(e){
      $('listNotice').innerHTML = '<div class="notice err">CSV を作成できませんでした（'+esc(e.message||e)+'）</div>';
    }finally{
      btn.disabled = false; btn.textContent = 'CSV出力';
    }
  }

  // ---- Realtime（一覧のみ。編集中のフォームは書き換えない） ---------------
  function subscribeRealtime(){
    try{
      sb.channel(T.channel)
        .on('postgres_changes', { event:'*', schema:'public', table:T.table }, (payload)=>{
          const changedId = (payload.new && payload.new.id) || (payload.old && payload.old.id);
          if(state.editing && state.current && changedId === state.current.id){
            const nb = $('editNotice');
            if(nb) nb.innerHTML = '<div class="notice warn">他の利用者が更新しました。保存時に最新内容と照合します（入力内容はそのままです）。</div>';
            return;   // 入力欄は触らない
          }
          if(!state.editing && state.current && changedId === state.current.id && payload.new){
            state.current = payload.new; renderDetail(); loadHistory(state.current.id);
          }
          reload(true);     // 一覧は現在のページ条件で取り直す（総件数も更新）
        })
        .subscribe();
    }catch(e){ /* Realtime が使えなくても一覧の手動再読込で運用できる */ }
  }

  // ---- UI 結線 -------------------------------------------------------------
  function bindUI(){
    $('applyBtn').addEventListener('click', ()=>{ readFilters(); reload(); });
    $('clearBtn').addEventListener('click', ()=>{
      ['fStatus','fPriority','fReportedBy','fOwner','fLocation','fFrom','fTo','fQ'].forEach(id=> $(id).value='');
      readFilters(); reload();
    });
    $('fQ').addEventListener('keydown', (e)=>{ if(e.key==='Enter'){ readFilters(); reload(); } });
    $('prevBtn').addEventListener('click', ()=>{ if(state.page>1){ state.page--; reload(true); } });
    $('nextBtn').addEventListener('click', ()=>{ const pages=Math.max(1,Math.ceil(state.total/PAGE_SIZE)); if(state.page<pages){ state.page++; reload(true); } });
    $('csvBtn').addEventListener('click', exportCsv);
    $('newBtn').addEventListener('click', openCreate);
    $('createSaveBtn').addEventListener('click', create);
    $('createCloseBtn').addEventListener('click', ()=>{ $('createOverlay').style.display='none'; });
    $('editBtn').addEventListener('click', startEdit);
    $('saveBtn').addEventListener('click', save);
    $('cancelEditBtn').addEventListener('click', ()=>{ state.editing=false; renderDetail(); loadHistory(state.current.id); });
    $('detailCloseBtn').addEventListener('click', ()=>{
      if(state.editing && state.dirty && !window.confirm('編集中の内容は保存されていません。閉じますか？')) return;
      $('detailOverlay').style.display='none'; state.editing=false; state.dirty=false; state.current=null;
    });
    $('placeList').innerHTML = PLACES.map(p=>'<option value="'+esc(p)+'">').join('');
    if(T.banner){ const b=$('devBanner'); b.textContent = T.banner; b.style.display=''; }
    document.title = (T.env==='DEV' ? '【DEV】' : '') + '問題点対策表｜SAKAE SEIKI-OS';
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
