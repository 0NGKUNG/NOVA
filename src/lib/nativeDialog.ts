const NATIVE_DIALOG_STATE_EVENT = "nova:native-dialog-state";

export function setNativeDialogOpen(open: boolean): void {
  window.dispatchEvent(new CustomEvent(NATIVE_DIALOG_STATE_EVENT, { detail: { open } }));
}

export async function withNativeDialog<T>(showDialog: () => Promise<T>): Promise<T> {
  setNativeDialogOpen(true);
  try {
    return await showDialog();
  } finally {
    setNativeDialogOpen(false);
  }
}

export function listenForNativeDialogState(onChange: (open: boolean) => void): () => void {
  const handleState = (event: Event) => {
    onChange(Boolean((event as CustomEvent<{ open?: boolean }>).detail?.open));
  };
  window.addEventListener(NATIVE_DIALOG_STATE_EVENT, handleState);
  return () => window.removeEventListener(NATIVE_DIALOG_STATE_EVENT, handleState);
}
