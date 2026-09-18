/* ============================================================
   文件下载 —— 两个工具页共用
   ============================================================ */

/** 把一段文本存成文件。用完就撤 objectURL，别把 blob 挂在内存里。 */
function download(name, text, type='text/plain;charset=utf-8'){
  const blob = new Blob([text], {type});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export { download };
