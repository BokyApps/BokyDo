// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

import { CENSORING_ENABLED } from '../../lib/notes.js';
import { NoteEditor } from './NoteEditor.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA}}';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('editor without censoring (the shipped default)', () => {
  it('ships with censoring switched off', () => {
    expect(CENSORING_ENABLED).toBe(false);
  });

  it('offers no Censor action and shows existing tokens as a plain label', async () => {
    // What NoteDetail passes when CENSORING_ENABLED is false: no censor callbacks at all.
    await act(async () => {
      root.render(<NoteEditor markdown={`Before ${TOKEN} after`} onChange={() => undefined} />);
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    const labels = [...container.querySelectorAll('[aria-label]')].map((el) =>
      el.getAttribute('aria-label'),
    );
    expect(labels).not.toContain('Censor selection');
    const block = container.querySelector('.bk-censored-block');
    expect(block).not.toBeNull();
    expect(block?.tagName).toBe('SPAN');
    expect(block?.getAttribute('role')).toBe('img');
    expect(block?.textContent).toBe('█████');
    expect(container.textContent).not.toContain('Reveal');
    expect(container.textContent).not.toContain('Remove censor');
  });
});
