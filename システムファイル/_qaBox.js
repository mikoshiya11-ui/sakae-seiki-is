// ============================================================================
// SAKAE 質問箱（SAKAE-QA-01・2026-11-12）
//   ・問題点対策表の右上の「💬 質問箱」（mountBox）と、一覧の画面 質問箱.html（mountPage）。
//   ・Supabase の入口（public.qa_*）だけを使う。表を直接読み書きしない。kv_store・localStorage の業務データ・_sakaeSync.js は使わない。
//   ・質問と回答の文字はすべてデータとして扱い、画面へは esc() してから出す（HTML として解釈させない）。
//   ・回答の表示：AI＝「ハンチョー（AI）の回答」／人＝答える人の表の名前（例：見越（ミコシヤ））／確認中＝「すみません、担当の見越に確認します。」
// ============================================================================
(function(){
  'use strict';
  const SUPABASE_UMD = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.118.0/dist/umd/supabase.js';
  const SUPABASE_UMD_SRI = 'sha384-TcHRA3zBbn+Lexh5n+Oil4guNPOS3rjNDpGRAN46u/s/mB2IZ50ceC6TYDU2yvgK';
  const LOGIN_PAGE = 'ログイン.html';
  const LIST_PAGE = '質問箱.html';
  const MAX_BODY = 1000, MAX_ANSWER = 2000;
  const POLL_MS = 20000;
  const ESCALATED_TEXT = 'すみません、担当の見越に確認します。';
  const AI_LABEL = 'ハンチョー（AI）の回答';
  const HUMAN_FALLBACK = '見越（ミコシヤ）';
  const STATUS_LABEL = { NEW:'受付', ANSWERED:'回答あり', ESCALATED:'確認中', CLOSED:'終了' };

  const $ = (id)=> document.getElementById(id);
  const esc = (s)=> String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (s)=>{ if(!s) return ''; const d = new Date(s); if(isNaN(d)) return ''; const p=(n)=>String(n).padStart(2,'0'); return d.getFullYear()+'/'+p(d.getMonth()+1)+'/'+p(d.getDate())+' '+p(d.getHours())+':'+p(d.getMinutes()); };
  const statusBadge = (st)=> '<span class="qaSt qaSt-'+esc(st)+'">'+esc(STATUS_LABEL[st] || st)+'</span>';
  const who = (kind, label)=> kind === 'AI' ? AI_LABEL : (label || HUMAN_FALLBACK);
  function loadScript(src, integrity){ return new Promise((ok,ng)=>{ const s=document.createElement('script'); s.src=src; if(integrity){ s.integrity=integrity; s.crossOrigin='anonymous'; } s.onload=ok; s.onerror=()=>ng(new Error('script load failed')); document.head.appendChild(s); }); }

  // 送れなかった理由を、利用者に分かる言葉にする（技術的な文言は出さない）
  function friendlyError(err){
    const m = String((err && (err.message || err.hint)) || err || '');
    const h = String((err && err.hint) || '');
    if(/RATE_MINUTE|3 per minute/.test(m+h)) return '続けて送れるのは 1 分に 3 件までです。少し待ってから送ってください。';
    if(/RATE_DAY|50 per day/.test(m+h)) return '今日送れる質問は 50 件までです。明日また送ってください。';
    if(/ESCALATED_HUMAN_ONLY/.test(m+h)) return '確認中の質問には、人が答えます（AI では答えられません）。';
    if(/HUMAN_ANSWERED/.test(m+h)) return '人が答えたあとの質問には、AI は追記できません。';
    if(/CLOSED_HUMAN_ONLY/.test(m+h)) return '終了した質問には、AI は答えられません。';
    if(/LOG_LIMIT/.test(m+h)) return 'この質問への回答・記録が上限に達しました。新しい質問として送ってください。';
    if(/body must be/.test(m)) return '質問は 1〜' + MAX_BODY + ' 字で書いてください。';
    if(/answer must be/.test(m)) return '回答は 1〜' + MAX_ANSWER + ' 字で書いてください。';
    if(/not allowed|42501|permission/.test(m)) return 'この操作をする権限がありません。';
    if(/already closed/.test(m)) return 'この質問はすでに終了しています。';
    return '送れませんでした。通信を確認して、もう一度お試しください。';
  }

  async function rpc(sb, fn, args){
    const r = await sb.rpc(fn, args || {});
    if(r.error) throw r.error;
    return r.data;
  }

  // ---- 回答の部分（ボックスと一覧で共通） ------------------------------------
  function answersHtml(q){
    const parts = [];
    const log = Array.isArray(q.answers) ? q.answers : [];
    const ans = log.filter(a=> a.action === 'ANSWER');
    ans.forEach((a, i)=>{
      const isLatest = i === ans.length - 1;
      parts.push('<div class="qaAns qaAns-'+esc(a.kind)+(isLatest?'':' qaAnsOld')+'">'
        + '<div class="qaAnsWho">'+esc(who(a.kind, a.label))+(i>0?'<span class="qaAnsFix">（追記）</span>':'')+'<span class="qaAnsAt">'+esc(fmt(a.at))+'</span></div>'
        + '<div class="qaAnsText">'+esc(a.text)+'</div></div>');
    });
    if(q.stored_status === 'ESCALATED' || (q.status === 'ESCALATED')){
      parts.push('<div class="qaAns qaAns-ESC"><div class="qaAnsText">'+esc(ESCALATED_TEXT)+'</div></div>');
    }
    return parts.join('');
  }

  // ============================================================================
  // ① 問題点対策表の右上の箱
  // ============================================================================
  function mountBox(sb, root){
    if(!root) return;
    let me = null, timer = null, busy = false;
    root.innerHTML =
        '<div class="qaBoxHead"><span class="qaBoxTitle">💬 質問箱</span><span class="qaBoxCount" id="qaBoxCount"></span></div>'
      + '<textarea id="qaBoxText" class="qaText" rows="2" maxlength="'+MAX_BODY+'" placeholder="使い方で分からないことを書いてください"></textarea>'
      + '<div class="qaBoxRow"><span class="qaBoxMsg" id="qaBoxMsg" role="status"></span><button class="qaBtn" id="qaBoxSend" type="button">送る</button></div>'
      + '<ul class="qaRecent" id="qaRecent"></ul>'
      + '<div class="qaBoxFoot"><a href="'+LIST_PAGE+'" class="qaAll">すべて見る →</a></div>';
    const msg = (t, bad)=>{ const el=$('qaBoxMsg'); el.textContent = t || ''; el.classList.toggle('bad', !!bad); };

    async function refresh(){
      let list;
      try{ list = await rpc(sb, 'qa_list', { p_mine:true, p_limit:3 }); }
      catch(e){ $('qaRecent').innerHTML = '<li class="qaNone">質問を読み込めませんでした</li>'; return; }
      const open = list.filter(q=> q.status === 'NEW').length;
      $('qaBoxCount').textContent = open ? ('回答待ち ' + open) : '';
      $('qaRecent').innerHTML = list.length ? list.map(q=>
        '<li><a href="'+LIST_PAGE+'#'+encodeURIComponent(q.qno)+'"><span class="qaNo">'+esc(q.qno)+'</span>'
        + '<span class="qaSnip">'+esc(q.body)+'</span>'+statusBadge(q.status)+'</a></li>').join('')
        : '<li class="qaNone">まだ質問はありません</li>';
      // 回答待ちがある間だけ、画面が見えているときに見直す（見えていない間は止め、見えたら再開する）
      clearTimeout(timer); timer = null; waiting = open > 0;
      if(waiting && document.visibilityState === 'visible') timer = setTimeout(refresh, POLL_MS);
    }
    let waiting = false;
    document.addEventListener('visibilitychange', ()=>{
      if(document.visibilityState === 'visible'){ if(waiting && !timer) refresh(); }
      else { clearTimeout(timer); timer = null; }
    });

    async function send(){
      if(busy) return;
      const t = $('qaBoxText').value.trim();
      if(!t){ msg('質問を書いてください。', true); return; }
      if(t.length > MAX_BODY){ msg('質問は ' + MAX_BODY + ' 字までです。', true); return; }
      busy = true; $('qaBoxSend').disabled = true; msg('送っています…');
      try{
        const q = await rpc(sb, 'qa_ask', { p_body: t, p_page: '問題点対策表' });
        $('qaBoxText').value = '';
        msg('受け付けました（' + q.qno + '）。回答までお待ちください。');
        await refresh();
      }catch(e){ msg(friendlyError(e), true); }
      finally{ busy = false; $('qaBoxSend').disabled = false; }
    }

    (async ()=>{
      try{ me = await rpc(sb, 'qa_me'); }catch(e){ root.style.display = 'none'; return; }
      if(!me || !me.can_ask){ root.style.display = 'none'; return; }
      root.style.display = '';
      $('qaBoxSend').addEventListener('click', send);
      $('qaBoxText').addEventListener('keydown', (e)=>{ if(e.key === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); send(); } });
      await refresh();
    })();
    return { refresh };
  }

  // ============================================================================
  // ② 一覧の画面（質問箱.html）
  // ============================================================================
  async function mountPage(){
    const main = $('qaMain');
    const block = (title, lines)=>{ main.innerHTML = '<div class="qaBlock"><h2>'+esc(title)+'</h2>'+(lines||[]).map(l=>'<p>'+esc(l)+'</p>').join('')+'</div>'; $('qaTools').style.display='none'; $('qaAskArea').style.display='none'; };
    let sb;
    try{
      if(!window.supabase) await loadScript(SUPABASE_UMD, SUPABASE_UMD_SRI);
      sb = window.supabase.createClient(window.SAKAE_SUPABASE_URL, window.SAKAE_SUPABASE_ANON_KEY);
    }catch(e){ block('共有に接続できません', ['ネットワークを確認して再読込してください。']); return; }
    let session = null;
    try{ session = (await sb.auth.getSession()).data.session; }catch(e){ block('共有に接続できません', ['再読込してください。']); return; }
    if(!session){ location.href = LOGIN_PAGE + '?next=' + encodeURIComponent(location.pathname + location.search); return; }
    $('whoAmI').textContent = (session.user && session.user.email) || '';
    let me;
    try{ me = await rpc(sb, 'qa_me'); }catch(e){ block('共有に接続できません', ['利用権限を確認できませんでした。再読込してください。']); return; }
    if(!me || (!me.can_ask && !me.answer_kind)){
      block('質問箱を使う権限がありません。管理者へ連絡してください。', ['ログイン中のアカウント：' + ((session.user && session.user.email) || '')]);
      return;
    }
    const canAnswer = !!me.answer_kind;
    if(!me.can_ask) $('qaAskArea').style.display = 'none';

    // drafts：書きかけの回答（質問番号ごと）。一覧を作り直しても消さない（イインチョー MEDIUM）
    const st = { status:'', mine:false, list:[], timer:null, drafts:{} };
    const setMsg = (id, t, bad)=>{ const el=$(id); if(!el) return; el.textContent = t || ''; el.classList.toggle('bad', !!bad); };

    function cardHtml(q){
      const canResolve = q.mine && (q.status === 'ANSWERED');
      let h = '<article class="qaCard" id="'+esc(q.qno)+'" data-qno="'+esc(q.qno)+'">'
        + '<header class="qaCardHead"><span class="qaNo">'+esc(q.qno)+'</span>'+statusBadge(q.status)
        + '<span class="qaMeta">'+esc(q.asker_name)+(q.mine?'（自分）':'')+'・'+esc(fmt(q.created_at))+(q.page?'・'+esc(q.page):'')+'</span></header>'
        + '<div class="qaBody">'+esc(q.body)+'</div>'
        + answersHtml(q);
      if(canResolve) h += '<div class="qaCardActions"><button class="qaBtn sub" type="button" data-act="resolve">解決した</button></div>';
      const ansLog = (q.answers || []).filter(a=> a.action === 'ANSWER');
      const lastAns = ansLog.length ? ansLog[ansLog.length - 1] : null;
      const aiBlocked = me.answer_kind === 'AI' && (q.stored_status === 'ESCALATED' || (lastAns && lastAns.kind === 'HUMAN'));
      if(canAnswer && q.status !== 'CLOSED' && !aiBlocked){
        h += '<div class="qaAnswerForm">'
          + '<textarea class="qaText" rows="3" maxlength="'+MAX_ANSWER+'" data-role="answer" placeholder="回答を書く（'+esc(who(me.answer_kind, null))+'として出ます）"></textarea>'
          + '<div class="qaBoxRow"><span class="qaBoxMsg" data-role="msg"></span>'
          + (q.stored_status !== 'ESCALATED' ? '<button class="qaBtn sub" type="button" data-act="escalate">確認中にする</button>' : '')
          + '<button class="qaBtn" type="button" data-act="answer">回答する</button></div></div>';
      }
      return h + '</article>';
    }

    // 書きかけの回答欄にフォーカスがある間は、自動の見直しで作り直さない
    const editing = ()=>{ const a = document.activeElement; return !!(a && a.matches && a.matches('#qaList textarea[data-role="answer"]')); };
    function schedule(){
      clearTimeout(st.timer); st.timer = null;
      if(document.visibilityState !== 'visible') return;
      if(st.list.some(q=> q.status === 'NEW')) st.timer = setTimeout(()=>{ if(editing()) schedule(); else load(); }, POLL_MS);
    }
    document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState === 'visible'){ if(!st.timer) schedule(); } else { clearTimeout(st.timer); st.timer = null; } });
    async function load(){
      let list;
      try{ list = await rpc(sb, 'qa_list', { p_status: st.status || null, p_mine: st.mine, p_limit: 200 }); }
      catch(e){ $('qaList').innerHTML = '<p class="qaNone">質問を読み込めませんでした。再読込してください。</p>'; return; }
      st.list = list;
      $('qaList').innerHTML = list.length ? list.map(cardHtml).join('') : '<p class="qaNone">該当する質問はありません。</p>';
      // 書きかけの回答を戻す
      $('qaList').querySelectorAll('textarea[data-role="answer"]').forEach(t=>{ const no = t.closest('.qaCard').getAttribute('data-qno'); if(st.drafts[no]) t.value = st.drafts[no]; });
      $('qaCount').textContent = list.length + ' 件';
      if(location.hash){
        let id = ''; try{ id = decodeURIComponent(location.hash.slice(1)); }catch(e){ id = ''; }
        const el = id ? document.getElementById(id) : null; if(el){ el.classList.add('qaFocus'); }
      }
      schedule();
    }

    // 絞り込み
    document.querySelectorAll('#qaTools [data-status]').forEach(b=> b.addEventListener('click', ()=>{
      st.status = b.getAttribute('data-status');
      document.querySelectorAll('#qaTools [data-status]').forEach(x=> x.classList.toggle('active', x === b));
      load();
    }));
    $('qaMine').addEventListener('change', ()=>{ st.mine = $('qaMine').checked; load(); });

    // 質問する
    $('qaAskSend').addEventListener('click', async ()=>{
      const t = $('qaAskText').value.trim();
      if(!t){ setMsg('qaAskMsg', '質問を書いてください。', true); return; }
      $('qaAskSend').disabled = true; setMsg('qaAskMsg', '送っています…');
      try{ const q = await rpc(sb, 'qa_ask', { p_body: t, p_page: '質問箱' }); $('qaAskText').value=''; setMsg('qaAskMsg', '受け付けました（' + q.qno + '）。回答までお待ちください。'); await load(); }
      catch(e){ setMsg('qaAskMsg', friendlyError(e), true); }
      finally{ $('qaAskSend').disabled = false; }
    });

    // 書きかけの回答を覚えておく
    $('qaList').addEventListener('input', (e)=>{
      const t = e.target; if(!t.matches('textarea[data-role="answer"]')) return;
      st.drafts[t.closest('.qaCard').getAttribute('data-qno')] = t.value;
    });
    // カードの操作（解決・回答・確認中）
    $('qaList').addEventListener('click', async (e)=>{
      const b = e.target.closest('button[data-act]'); if(!b) return;
      const card = b.closest('.qaCard'); const qno = card.getAttribute('data-qno');
      const m = card.querySelector('[data-role="msg"]');
      const say = (t, bad)=>{ if(m){ m.textContent = t; m.classList.toggle('bad', !!bad); } };
      const act = b.getAttribute('data-act');
      b.disabled = true;
      try{
        if(act === 'resolve'){
          if(!window.confirm(qno + ' を「解決」にします。よろしいですか？')){ b.disabled = false; return; }
          await rpc(sb, 'qa_resolve', { p_qno: qno });
        }else if(act === 'answer'){
          const t = card.querySelector('[data-role="answer"]').value.trim();
          if(!t){ say('回答を書いてください。', true); b.disabled = false; return; }
          await rpc(sb, 'qa_answer', { p_qno: qno, p_answer: t, p_kind: me.answer_kind });
          delete st.drafts[qno];
        }else if(act === 'escalate'){
          const why = window.prompt('確認中にする理由（答える人向けのメモ・画面には出ません）', '');
          if(why === null){ b.disabled = false; return; }
          await rpc(sb, 'qa_escalate', { p_qno: qno, p_reason: why });
        }
        await load();
      }catch(err){ say(friendlyError(err), true); b.disabled = false; }
    });

    $('qaTools').style.display = '';
    await load();
  }

  window.SakaeQA = Object.freeze({ mountBox, mountPage, _esc: esc });

  // 問題点対策表：対策表の利用権限が確認できたあとで箱を出す（_issueCountermeasures.js が 'sakae:authorized' を出す）
  document.addEventListener('sakae:authorized', (ev)=>{
    const root = $('qaBox');
    if(root && ev.detail && ev.detail.sb) mountBox(ev.detail.sb, root);
  });
})();
