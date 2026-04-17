// Modal confirm dialog. Returns a Promise<boolean>.
//
// The <dialog> fires 'cancel' when the user hits Escape — we listen for that
// too so the promise resolves and the click listeners are cleaned up.

const $confirmDialog  = document.getElementById('confirm-dialog');
const $confirmMessage = document.getElementById('confirm-message');
const $confirmOk      = document.getElementById('confirm-ok');
const $confirmCancel  = document.getElementById('confirm-cancel');

export function confirm(message) {
  return new Promise((resolve) => {
    $confirmMessage.textContent = message;
    $confirmDialog.showModal();

    function cleanup() {
      $confirmOk.removeEventListener('click', onOk);
      $confirmCancel.removeEventListener('click', onCancel);
      $confirmDialog.removeEventListener('cancel', onDialogCancel);
      $confirmDialog.close();
    }
    function onOk() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    function onDialogCancel() { cleanup(); resolve(false); }

    $confirmOk.addEventListener('click', onOk);
    $confirmCancel.addEventListener('click', onCancel);
    $confirmDialog.addEventListener('cancel', onDialogCancel);
  });
}
