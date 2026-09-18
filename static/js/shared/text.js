/* ============================================================
   字符串小工具 —— 页面之间共用

   `trim` 放这里不是为了省几行，是为了断开 config ↔ util 那个环：
   config 只用到 trim 一个函数，却因此依赖 util，而 util 又要 config 的
   CLIP_UPPER_DEFAULT。搬出来之后两边都只依赖这里。
   ============================================================ */

/** null / undefined → 空串；其余转字符串去首尾空白。源表里空单元格是 null。 */
function trim(x){ return x==null ? '' : String(x).trim(); }

/**
 * 站点显示用的短写法：去协议头、去 www.、去尾斜杠。
 *
 * 67 个站点值里 58 个带 `https://`，占近 12% 的篇幅却没有信息量。
 * 收到这里是因为它已经有过三份：`load.js`（新表没有「商户名称」列时拿域名顶上）、
 * `broadcast.js`（群消息里省字数）、掉量卡片（判"商户名和站点是不是同一个"）。
 * 三份不会同时被改 —— 而第三份要是和第一份对不齐，卡片上就会出现
 * 「sackify.shop https://sackify.shop」这种把同一个东西写两遍的行。
 */
function shortSite(s){
  return String(s||'').replace(/^https?:\/\//,'').replace(/^www\./,'').replace(/\/$/,'');
}

export { shortSite, trim };
