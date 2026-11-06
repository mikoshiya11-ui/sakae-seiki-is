// ---- PT-0027：印刷する用紙サイズを、印刷する人がその都度選べるようにする共通部品。
// 印刷ボタンのすぐ前に「用紙」の選択欄を出す（紙には出さない）。初期値は各帳票の標準サイズ。
// 選んだ値は、この画面を開いている間だけ持つ（印刷後・印刷のキャンセル後もそのまま）。
// 画面を開き直す（再読み込み・戻る／進むでの再表示を含む）と標準サイズへ戻す。
// localStorage・共有KV・DB・URL には一切書かない（タブごとに別々で、ほかのタブにも影響しない）。
// 標準サイズの間は何も足さない（<html> に属性を付けず、@page も追加しない）ので、従来の印刷経路がそのまま通る。
// 標準以外を選んだ時だけ、<html data-print-paper="A3"> を付け、@page の size だけを後から追加する
// （余白は各帳票の @page の値を引き継ぐ）。拡大・縮小は、各帳票側の html[data-print-paper=…] の CSS が受け持つ。
window.sakaePrintPaper = (function(){
  const ORIENT_LABEL = { landscape:'横', portrait:'縦' };
  let mounted = false;

  function injectUiStyle(){
    const st = document.createElement('style');
    st.id = 'ppPaperUiStyle';
    st.textContent = '.ppPaper{ display:inline-flex; align-items:center; gap:6px; font-size:12.5px; font-weight:700; white-space:nowrap; }'
      + '.ppPaper select{ font:inherit; font-weight:700; padding:5px 8px; border:1.5px solid #b8c7d9; border-radius:6px; background:#fff; color:#1a2233; cursor:pointer; }'
      + '.ppPaperNote{ flex:0 1 auto; min-width:0; align-self:center; font-size:11px; font-weight:400; line-height:1.3; }'
      + '.controlBar .ppPaperNote, .screenBar > .ppPaperNote{ margin-left:auto; }'
      + '.controlBar .ppPaperNote{ flex:1 1 180px; text-align:right; }'
      + '.mFoot .ppPaperNote{ flex:1 1 0; min-width:150px; }'
      + '.ppPaperNote + .ppPaper{ margin-left:0 !important; }'
      + '@media print{ .ppPaper, .ppPaperNote{ display:none !important; } }';
    document.head.appendChild(st);
  }

  // opt: { button, standard:'A4', options:['A4','A3'], orientation:'landscape'|'portrait', relabel:true|false }
  //   relabel … 印刷ボタンの文字・説明に「A4横」などがあれば、選んだ用紙に合わせて書き換える
  //   relabelTargets … 任意。画面の用紙表記の要素の配列。文字の中の「A3横」などを、選んだ用紙に合わせて書き換える
  function mount(opt){
    if(mounted) throw new Error('sakaePrintPaper.mount は 1 画面に 1 回だけ');
    mounted = true;
    const root = document.documentElement;
    const btn = opt.button;
    const standard = opt.standard;
    const orient = opt.orientation;
    const label = (p)=> p + ORIENT_LABEL[orient];

    injectUiStyle();
    const pageStyle = document.createElement('style');
    pageStyle.id = 'ppPaperPageStyle';
    document.head.appendChild(pageStyle);

    const wrap = document.createElement('label');
    wrap.className = 'ppPaper';
    wrap.appendChild(document.createTextNode('用紙'));
    const sel = document.createElement('select');
    sel.id = 'ppPaperSelect';
    sel.setAttribute('autocomplete', 'off');   // 再読み込みでブラウザが前の選択を戻さないようにする
    opt.options.forEach(p=>{ sel.add(new Option(label(p) + (p === standard ? '（標準）' : ''), p)); });
    wrap.appendChild(sel);
    btn.parentNode.insertBefore(wrap, btn);
    // 画面の用紙選択だけでは、実機プリンターの用紙は切り替わらない（ページからは指定できない）ので、常に案内を出す（紙には出さない）
    const note = document.createElement('span');
    note.className = 'ppPaperNote';
    note.textContent = '印刷時は、印刷ダイアログの『用紙サイズ』も画面で選んだA4／A3に合わせてください。';
    btn.parentNode.insertBefore(note, wrap);

    const btnTexts = opt.relabel ? Array.from(btn.childNodes).filter(n=> n.nodeType === 3) : [];
    const btnTextOrig = btnTexts.map(n=> n.nodeValue);
    const titleOrig = btn.getAttribute('title');
    const targets = (opt.relabelTargets || []).map(el=> ({ el: el, text: el.textContent }));
    const swap = (s, p)=> s.replace(label(standard), label(p));

    function apply(p){
      if(opt.options.indexOf(p) < 0) p = standard;
      sel.value = p;
      if(p === standard){
        root.removeAttribute('data-print-paper');
        pageStyle.textContent = '';
      } else {
        root.setAttribute('data-print-paper', p);
        pageStyle.textContent = '@media print{ @page{ size:' + p + ' ' + orient + '; } }';
      }
      btnTexts.forEach((n, i)=>{ n.nodeValue = swap(btnTextOrig[i], p); });
      if(opt.relabel && titleOrig != null) btn.setAttribute('title', swap(titleOrig, p));
      targets.forEach(t=>{ t.el.textContent = swap(t.text, p); });
    }
    sel.addEventListener('change', ()=> apply(sel.value));
    // 戻る／進むで一時保存（bfcache）から再表示された時も「開き直し」として標準へ戻す
    window.addEventListener('pageshow', (e)=>{ if(e.persisted) apply(standard); });
    apply(standard);
    return { get value(){ return sel.value; }, select: apply };
  }

  return { mount: mount };
})();
