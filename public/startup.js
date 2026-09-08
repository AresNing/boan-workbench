// This small, independent script still runs if the main application bundle fails.
(() => {
  let language='zh';try{const v=localStorage.getItem('workbench:language');language=v==='system'?(/^zh/i.test(navigator.language)?'zh':'en'):v || 'zh';}catch{}
  const english=language==='en';document.documentElement.lang=english?'en':'zh-CN';
  if(english){document.querySelector('[data-startup-message]').textContent='Opening workbench…';document.querySelector('[data-startup-retry]').textContent='Reload page';}
  const recover = () => {
    const message = document.querySelector('[data-startup-message]');
    const retry = document.querySelector('[data-startup-retry]');
    if (!message || !retry) return;
    message.textContent = english?'The page could not load. Tasks and sign-in are saved locally. Please reload.':'页面未能完成加载。任务与登录仍保存在本机，请重新加载。';
    retry.hidden = false;
  };
  document.querySelector('[data-startup-retry]')?.addEventListener('click', () => location.reload());
  window.addEventListener('error', recover, true);
  setTimeout(recover, 8000);
})();
