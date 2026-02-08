import { Attachment } from '../../types/message.types';

interface MessageAttachmentProps {
  attachment: Attachment;
}

export function MessageAttachment({ attachment }: MessageAttachmentProps) {
  const isImage = attachment.type === 'image';

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const imageSrc = attachment.data || attachment.url;

  if (isImage && imageSrc) {
    return (
      <div className="mt-2 rounded overflow-hidden border border-border">
        <img
          src={imageSrc}
          alt={attachment.name}
          className="max-w-full max-h-64 object-contain"
        />
        <div className="bg-surface px-2 py-1 text-xs text-text-secondary">
          {attachment.name} • {formatFileSize(attachment.size)}
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 flex items-center gap-2 rounded border border-border bg-surface px-3 py-2">
      <svg
        className="h-8 w-8 flex-shrink-0 text-text-secondary"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={1.5}
          d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
        />
      </svg>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary truncate">
          {attachment.name}
        </p>
        <p className="text-xs text-text-secondary">
          {formatFileSize(attachment.size)}
        </p>
      </div>
      {attachment.url && (
        <a
          href={attachment.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-accent hover:text-accent-hover"
        >
          <svg
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"
            />
          </svg>
        </a>
      )}
    </div>
  );
}
