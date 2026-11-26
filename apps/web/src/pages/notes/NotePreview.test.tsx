// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { NotePreview } from './NotePreview.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('NotePreview', () => {
  it('shows headings and inline formatting, and never renders text as HTML', () => {
    const el = document.createElement('div');
    const root = createRoot(el);
    act(() =>
      root.render(
        <NotePreview
          blocks={[
            { kind: 'h1', runs: [{ text: 'Header' }] },
            {
              kind: 'paragraph',
              runs: [
                { text: 'plain ' },
                { text: 'bold', bold: true },
                { text: ' ' },
                { text: 'it', italic: true },
                { text: ' <img src=x onerror=alert(1)>' },
              ],
            },
            { kind: 'task', runs: [{ text: 'done' }], checked: true, depth: 0 },
          ]}
        />,
      ),
    );
    const heading = [...el.querySelectorAll('p')].find((p) => p.textContent === 'Header');
    expect(heading?.className).toContain('font-semibold');
    expect(el.querySelector('.font-semibold.text-fg:not(p)')?.textContent).toBe('bold');
    expect(el.querySelector('.italic')?.textContent).toBe('it');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(el.textContent).toContain('☑');
    act(() => root.unmount());
  });
});
