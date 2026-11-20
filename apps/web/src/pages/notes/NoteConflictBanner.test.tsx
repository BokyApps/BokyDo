// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

import { NoteConflictBanner, type NoteConflictBannerProps } from './NoteConflictBanner.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function props(over: Partial<NoteConflictBannerProps> = {}): NoteConflictBannerProps {
  return {
    censorWarning: false,
    onLoadTheirs: vi.fn(),
    onRetryFetch: vi.fn(),
    onKeepMine: vi.fn(),
    ...over,
  };
}

function render(over: Partial<NoteConflictBannerProps> = {}): NoteConflictBannerProps {
  const p = props(over);
  act(() => root.render(<NoteConflictBanner {...p} />));
  return p;
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === label,
  );
}

async function click(label: string): Promise<void> {
  const button = buttonByText(label);
  if (!button) throw new Error(`no "${label}" button`);
  await act(async () => button.click());
}

describe('MED: the censor confirmation belongs to one saved revision', () => {
  it('drops the confirmation when a fresher revision arrives', async () => {
    render({ censorWarning: true, remoteRevision: 'R2' });
    await click('Keep mine');
    expect(container.textContent).toContain('This would bring back censored text');

    // A new 409 fetched R3: the question was about R2 and must be asked again.
    await act(async () => {
      root.render(<NoteConflictBanner {...props({ censorWarning: true, remoteRevision: 'R3' })} />);
    });
    expect(container.textContent).toContain('This note changed elsewhere');
    expect(container.textContent).not.toContain('This would bring back censored text');
  });

  it('keeps the confirmation for the same revision', async () => {
    render({ censorWarning: true, remoteRevision: 'R2' });
    await click('Keep mine');
    await act(async () => {
      root.render(<NoteConflictBanner {...props({ censorWarning: true, remoteRevision: 'R2' })} />);
    });
    expect(container.textContent).toContain('This would bring back censored text');
  });
});

describe('LOW: Back returns focus to Keep mine', () => {
  it('focuses Keep mine after leaving the censor confirmation', async () => {
    render({ censorWarning: true, remoteRevision: 'R2' });
    await click('Keep mine');
    expect(document.activeElement?.textContent?.trim()).toBe('Load their version');

    await click('Back');
    expect(document.activeElement?.textContent?.trim()).toBe('Keep mine');
  });
});

describe('MED: a failed saved-version fetch is its own banner state', () => {
  it('offers Retry fetch and never pretends a cached version is available', async () => {
    const p = render({ fetchFailed: true, remoteRevision: null });
    expect(container.textContent).toContain("couldn't be fetched");
    expect(buttonByText('Retry fetch')).toBeTruthy();
    expect(buttonByText('Load their version')).toBeUndefined();
    // No remote revision was ever fetched, so Keep mine has no premise.
    expect(buttonByText('Keep mine')).toBeUndefined();
    expect(buttonByText('Copy mine')).toBeUndefined();

    await click('Retry fetch');
    expect(p.onRetryFetch).toHaveBeenCalledOnce();
  });

  it('still offers no Keep mine even when an earlier revision was known', () => {
    const p = render({ fetchFailed: true, remoteRevision: 'R2' });
    expect(buttonByText('Retry fetch')).toBeTruthy();
    expect(buttonByText('Keep mine')).toBeUndefined();
    expect(buttonByText('Copy mine')).toBeUndefined();
    expect(p.onKeepMine).not.toHaveBeenCalled();
  });
});

describe('safe actions only: Copy mine is gone, Keep mine binds to a fetched revision', () => {
  it('Keep mine is disabled without a successfully fetched revision', () => {
    render({ remoteRevision: null });
    expect(buttonByText('Keep mine')?.disabled).toBe(true);
  });

  it('the censor confirmation passes the exact revision it was about', async () => {
    const p = render({ censorWarning: true, remoteRevision: 'R2' });
    await click('Keep mine');
    expect(p.onKeepMine).not.toHaveBeenCalled(); // opening the question sends nothing
    await click('Keep mine anyway');
    expect(p.onKeepMine).toHaveBeenCalledWith('R2');
  });
});
