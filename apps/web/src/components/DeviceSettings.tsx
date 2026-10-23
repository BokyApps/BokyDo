import { useState } from 'react';
import { offlineEnabled, setOfflineEnabled } from '../lib/offline.js';
import { Card, Checkbox } from './ui.js';

/** Settings → This device: the per-device, off-by-default offline copy. */
export function DeviceSettings() {
  const [on, setOn] = useState(offlineEnabled());
  const [busy, setBusy] = useState(false);
  const toggle = async (next: boolean) => {
    setBusy(true);
    await setOfflineEnabled(next);
    setOn(next);
    setBusy(false);
  };
  return (
    <Card>
      <h2 className="mb-4 font-semibold">This device</h2>
      <Checkbox
        label="Keep a copy on this device for offline use"
        hint="Lets you read your tasks and keep making changes while offline. Your task data is stored in this browser, so leave it off on a shared computer. Turning it off, or signing out, deletes the copy."
        checked={on}
        disabled={busy}
        onChange={(e) => void toggle(e.target.checked)}
      />
    </Card>
  );
}
