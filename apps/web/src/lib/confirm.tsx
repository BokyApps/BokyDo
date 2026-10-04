import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Button, Dialog } from '../components/ui.js';

interface Ask {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}
const ConfirmContext = createContext<(a: Ask) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [ask, setAsk] = useState<Ask | null>(null);
  const resolver = useRef<(v: boolean) => void>(() => undefined);
  const confirm = useCallback(
    (a: Ask) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setAsk(a);
      }),
    [],
  );
  const finish = (v: boolean) => {
    setAsk(null);
    resolver.current(v);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={ask !== null} onClose={() => finish(false)} title={ask?.title ?? ''}>
        <div className="space-y-4">
          <div className="text-sm text-muted">{ask?.message}</div>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => finish(false)}>
              Cancel
            </Button>
            <Button
              variant={ask?.danger ? 'danger' : 'primary'}
              onClick={() => finish(true)}
              autoFocus
            >
              {ask?.confirmLabel ?? 'OK'}
            </Button>
          </div>
        </div>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

export const useConfirm = () => useContext(ConfirmContext);
