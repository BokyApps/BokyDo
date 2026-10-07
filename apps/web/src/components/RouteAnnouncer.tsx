import { useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { pageTitle } from '../lib/page-title.js';

const heading = () =>
  document.querySelector('h1')?.textContent ?? document.querySelector('h2')?.textContent ?? null;

/**
 * A single-page app doesn't reload, so nothing tells a screen-reader user that the page changed.
 * On every navigation this sets the document title from the page's main heading (WCAG 2.4.2),
 * moves focus to the main region so keyboard users start at the top of the new page (2.4.3), and
 * announces the new page (4.1.3). The first load keeps focus where the browser put it.
 */
export function RouteAnnouncer() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const first = useRef(true);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => {
    const update = () => {
      document.title = pageTitle(heading());
    };
    // Headings often appear a moment later (the data loads), so keep the title in step briefly.
    const observer = new MutationObserver(update);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    const stop = setTimeout(() => observer.disconnect(), 3000);
    const settle = setTimeout(() => {
      update();
      if (first.current) {
        first.current = false;
        return;
      }
      const main = document.getElementById('main') ?? document.querySelector('main');
      if (main instanceof HTMLElement) {
        if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
        main.focus({ preventScroll: true });
      }
      setAnnouncement(pageTitle(heading()));
    }, 150);
    return () => {
      observer.disconnect();
      clearTimeout(stop);
      clearTimeout(settle);
    };
  }, [pathname]);

  return (
    <div role="status" aria-live="polite" className="sr-only">
      {announcement}
    </div>
  );
}
