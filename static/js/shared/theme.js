/* ============================================================
   主题切换 —— 三处共用一个 key

   以前工具页存 crm_theme、外壳存 wb_theme，而工具是在外壳的 iframe 里开的，
   两边各存各的就会打架（外壳深色、工具浅色）。统一成 wb_theme，
   并把旧值迁过来 —— 别把用户已经选好的主题重置成 auto。
   （迁移原来只有 conversion 那份有，merchant 那份没有。）
   ============================================================ */
const KEY = 'wb_theme';
const OLD = 'crm_theme';

function readStored(){
  let cur = null;
  try{ cur = localStorage.getItem(KEY); }catch(e){}
  if(cur) return cur;
  try{
    const old = localStorage.getItem(OLD);
    if(old){ localStorage.setItem(KEY, old); localStorage.removeItem(OLD); return old; }
  }catch(e){}
  return null;
}

/**
 * @param onChange 切换后的页面副作用（merchant 要 recompute()），可不传
 * @returns 当前主题
 */
function initTheme({onChange}={}){
  const root = document.documentElement;
  const apply = m => {
    if(m === 'auto') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', m);
    document.querySelectorAll('.theme button').forEach(b =>
      b.setAttribute('aria-pressed', b.dataset.themeSet === m ? 'true' : 'false'));
  };
  let cur = readStored() || 'auto';
  apply(cur);
  document.querySelectorAll('.theme button').forEach(b => b.addEventListener('click', () => {
    cur = b.dataset.themeSet;
    try{ localStorage.setItem(KEY, cur); }catch(e){}
    apply(cur);
    if(typeof onChange === 'function') onChange(cur);
  }));
  return cur;
}

export { initTheme, KEY as THEME_KEY };
