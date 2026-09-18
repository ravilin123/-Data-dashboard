import { uniq } from '../broadcast.js';
import { stageLabel } from '../config.js';
import { orderedSources } from './overview.js';
import { state } from '../store.js';
import { $, esc } from '../../shared/dom.js';

/* ---------- 异常明细筛选 ---------- */
function fillDetailFilters(){
  const d=state.data;
  const all=[...d.alarmTotal,...d.alarmSite];
  const setOpts=(sel,vals,fmt)=>{
    const el=$(sel), keep=el.value;
    el.innerHTML='<option value="">'+(sel==='#fSrc'?'全部来源':'全部环节')+'</option>'+
      vals.map(v=>`<option value="${esc(v)}">${esc(fmt?fmt(v):v)}</option>`).join('');
    if(vals.includes(keep)) el.value=keep;
  };
  setOpts('#fSrc', orderedSources(d.stages).filter(s=>all.some(a=>a['来源']===s)));
  setOpts('#fStage', uniq(all.map(a=>a._stage).filter(x=>x&&x!=='-')).sort(),
          c=>`${c}. ${stageLabel(c)}`);
  applyDetailFilter();
}

function applyDetailFilter(){
  const src=$('#fSrc').value, stage=$('#fStage').value, role=$('#fRole').value,
        dim=$('#fDim').value, kw=$('#fKw').value.trim().toLowerCase();
  $('#detailTotalWrap').hidden = dim==='site';
  $('#detailSiteWrap').hidden  = dim==='total';

  let shownRows=0, shownBlocks=0;
  for(const wrap of [$('#detailTotalWrap'),$('#detailSiteWrap')]){
    if(wrap.hidden) continue;
    for(const sb of wrap.querySelectorAll('.src-block')){
      let blockVisible=0;
      for(const mb of sb.querySelectorAll('.metric-block')){
        const okMeta = (!src||mb.dataset.src===src) && (!stage||mb.dataset.stage===stage) &&
                       (!role||mb.dataset.role===role);
        let rows=0;
        for(const tr of mb.querySelectorAll('tbody tr')){
          const okRow = okMeta && (!kw || (tr.dataset.kw||'').includes(kw));
          tr.hidden=!okRow; if(okRow) rows++;
        }
        mb.hidden = rows===0;
        if(rows){ blockVisible++; shownBlocks++; shownRows+=rows; }
      }
      sb.hidden = blockVisible===0;
    }
  }
  const any = shownRows>0;
  $('#detailEmpty').hidden = any;
  $('#detailTotalWrap').hidden = $('#detailTotalWrap').hidden || !any;
  $('#detailSiteWrap').hidden  = $('#detailSiteWrap').hidden  || !any;
  $('#fCount').textContent = any ? `命中 ${shownBlocks} 个指标块 / ${shownRows} 行` : '';
}

['#fSrc','#fStage','#fRole','#fDim'].forEach(s=>$(s).addEventListener('change',applyDetailFilter));
$('#fKw').addEventListener('input',applyDetailFilter);
function resetDetailFilter(){
  ['#fSrc','#fStage','#fRole','#fDim'].forEach(s=>$(s).value='');
  $('#fKw').value=''; applyDetailFilter();
}
$('#fReset').addEventListener('click',resetDetailFilter);
$('#fReset2').addEventListener('click',resetDetailFilter);

/**
 * 点重点商户卡片 → 跳到明细并高亮该商户的行。
 *
 * ⚠ B6 之后这张榜是**扫全部商户**排出来的，里面有一批「场景级没触发阈值、
 *   所以异常明细里一行都没有」的商户（卡片上标了「明细未覆盖」）。
 *   那批跳过去只会看到一张空表 —— 改跳「链路精算」，那儿有它的完整漏斗，
 *   正好回答「这家掉在哪一环」。
 */
$('#topMerchants').addEventListener('click', e=>{
  const card=e.target.closest('.tm'); if(!card) return;
  const mid=card.dataset.mid;
  const uid=mid.split('|')[1] || '';           // 用户ID 作为关键词最精确

  if(card.dataset.indrill === '0'){
    const sel=$('#chainSel');
    // 选项的 label 里带着用户ID（renderChain 拼的），按它找
    const opt=sel && [...sel.options].find(o=>o.textContent.includes(`ID:${uid}`));
    if(opt && typeof window.showPanel === 'function'){
      window.showPanel('chain');
      sel.value=opt.value;
      sel.dispatchEvent(new Event('change'));
      return;
    }
    // 链路精算里也找不到（理论上不会）就退回老路径，至少把筛选条件填上
  }

  resetDetailFilter();
  $('#fKw').value = uid;
  applyDetailFilter();
  const first=document.querySelector(`#detailTotalWrap tr[data-mid="${CSS.escape(mid)}"]:not([hidden])`)
           || document.querySelector(`#detailSiteWrap tr[data-mid="${CSS.escape(mid)}"]:not([hidden])`);
  if(first){
    first.scrollIntoView({block:'center',behavior:'smooth'});
    document.querySelectorAll('tr.hl').forEach(x=>x.classList.remove('hl'));
    document.querySelectorAll(`tr[data-mid="${CSS.escape(mid)}"]`).forEach(x=>x.classList.add('hl'));
  }
});


export { fillDetailFilters };
