import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { App } from './dashboard/App.tsx';
import { ReviewApp } from './review/ReviewApp.tsx';
import { LiveApp } from './live/LiveApp.tsx';
import { prepareRoute } from './shared/runtime-data.ts';

const APP_ROUTES = new Set(['/', '/review', '/live', '/trust']);

function Root() {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const navigate = (url, push) => {
      if (!APP_ROUTES.has(url.pathname)) return;
      if (push) window.history.pushState(null, '', `${url.pathname}${url.search}${url.hash}`);
      setPathname(url.pathname);
      // 乐观切换:不等数据,后台预热目标页请求;各页面组件挂载后会借 in-flight 去重复用同一请求并自行上屏
      prepareRoute(url.pathname).catch(() => {});
    };
    const onClick = event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest('a[href]');
      if (!link || link.target || link.hasAttribute('download')) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || !APP_ROUTES.has(url.pathname)) return;
      event.preventDefault();
      navigate(url, true);
    };
    const onPopState = () => {
      navigate(new URL(window.location.href), false);
    };
    document.addEventListener('click', onClick);
    window.addEventListener('popstate', onPopState);
    return () => {
      document.removeEventListener('click', onClick);
      window.removeEventListener('popstate', onPopState);
    };
  }, []);

  if (pathname === '/review') {
    document.title = 'ROI Review · Token Work ROI';
    return <ReviewApp />;
  }
  if (pathname === '/live') {
    document.title = 'Live Monitor · Token Work ROI';
    return <LiveApp />;
  }
  if (pathname === '/trust') {
    document.title = 'Local Trust · Token Work ROI';
    return <App routeMode="trust" />;
  }

  document.title = 'Token Work ROI';
  return <App />;
}

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root is missing.');
}

createRoot(rootElement).render(<Root />);
