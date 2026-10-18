import { Modal } from './Modal';
import { Button } from './Button';
import { useT } from '../../i18n';

interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  isDestructive?: boolean;
  isLoading?: boolean;
}

export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText,
  cancelText,
  isDestructive = false,
  isLoading = false,
}: ConfirmDialogProps) {
  const t = useT();
  const handleConfirm = () => {
    onConfirm();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <div className="flex justify-end gap-3">
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={isLoading}
          >
            {cancelText ?? t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            disabled={isLoading}
            className={isDestructive ? 'bg-error hover:bg-error-hover' : ''}
          >
            {isLoading ? t('confirm.busy', 'Deleting...') : (confirmText ?? t('common.confirm', 'Confirm'))}
          </Button>
        </div>
      }
    >
      <p className="text-text-primary">{message}</p>
    </Modal>
  );
}
