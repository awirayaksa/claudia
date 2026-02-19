import React, { useState, useRef, KeyboardEvent, forwardRef, useImperativeHandle, useEffect, useCallback, useMemo } from 'react';
import { useDropzone } from 'react-dropzone';
import { Button } from '../common/Button';
import { Attachment } from '../../types/message.types';
import { useFileUpload } from '../../hooks/useFileUpload';
import { CompactModelSelector } from './CompactModelSelector';
import MCPServerBadges from './MCPServerBadges';
import { FileMentionDropdown } from './FileMentionDropdown';
import { useFileMention } from '../../hooks/useFileMention';
import { useAppSelector } from '../../store';

interface ChatInputProps {
  onSend: (message: string, attachments?: Attachment[]) => void;
  onAbort?: () => void;
  disabled?: boolean;
  isGenerating?: boolean;
  placeholder?: string;
  selectedModel?: string;
  availableModels?: string[];
  onModelChange?: (model: string) => void;
  initialMessage?: string;
  initialAttachments?: Attachment[];
  onCancelEdit?: () => void;
  variant?: 'centered' | 'default';
}

export interface ChatInputRef {
  focus: () => void;
  addFiles: (files: File[]) => void;
}

async function expandFileMentions(message: string, baseDir: string): Promise<string> {
  const mentionRegex = /@([\w.\-\/]+)/g;
  const matches = [...message.matchAll(mentionRegex)];
  if (!matches.length) return message;

  const uniquePaths = [...new Set(matches.map((m) => m[1]))];
  const contentMap: Record<string, string> = {};

  // TODO: add file size guard in a future version
  await Promise.all(
    uniquePaths.map(async (relPath) => {
      const absPath = `${baseDir}/${relPath}`.replace(/\\/g, '/');
      try {
        const content = await window.electron.file.read(absPath);
        contentMap[relPath] = typeof content === 'string' ? content : String(content);
      } catch {
        // Silently skip — likely a directory mention, not a file
      }
    })
  );

  return message.replace(mentionRegex, (_match, relPath) =>
    contentMap[relPath] !== undefined
      ? `<file path="${relPath}">\n${contentMap[relPath]}\n</file>`
      : _match
  );
}

export const ChatInput = forwardRef<ChatInputRef, ChatInputProps>(({
  onSend,
  onAbort,
  disabled = false,
  isGenerating = false,
  placeholder = 'Type your message...',
  variant = 'default',
  selectedModel,
  availableModels,
  onModelChange,
  initialMessage,
  initialAttachments,
  onCancelEdit,
}, ref) => {
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { uploadFiles, uploading, progress, error: uploadError } = useFileUpload();

  // Redux selectors for filesystem mention feature
  const filesystemDirectory = useAppSelector((state) => state.chat.filesystemDirectory);
  const serverStates = useAppSelector((state) => state.mcp.serverStates);
  const isFilesystemReady = useMemo(
    () =>
      Object.values(serverStates).some(
        (s) => s.config.builtinId === 'builtin-filesystem-001' && s.status === 'ready'
      ),
    [serverStates]
  );

  const fileMention = useFileMention(filesystemDirectory, isFilesystemReady);

  // Expose methods to parent component
  useImperativeHandle(ref, () => ({
    focus: () => {
      textareaRef.current?.focus();
    },
    addFiles: (files: File[]) => {
      handleFilesSelected(files);
    },
  }));

  // Populate input when editing a message
  useEffect(() => {
    if (initialMessage !== undefined) {
      setMessage(initialMessage);
      // Auto-resize textarea for initial content
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
      }
    }
    if (initialAttachments) {
      setAttachments(initialAttachments);
    }
  }, [initialMessage, initialAttachments]);

  const handleSend = async () => {
    if ((message.trim() || attachments.length > 0) && !disabled && !uploading) {
      fileMention.close();
      const expandedMessage = filesystemDirectory
        ? await expandFileMentions(message, filesystemDirectory)
        : message;
      onSend(expandedMessage.trim(), attachments.length > 0 ? attachments : undefined);
      setMessage('');
      setAttachments([]);
      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
      // Clear editing state
      onCancelEdit?.();
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Intercept keyboard events for the mention dropdown first
    if (fileMention.isOpen) {
      const result = fileMention.handleKeyDown(e);
      if (result.consumed) {
        e.preventDefault();
        if (result.newValue !== undefined) {
          setMessage(result.newValue);
          requestAnimationFrame(() => {
            textareaRef.current?.setSelectionRange(result.newCursorPos!, result.newCursorPos!);
            if (result.keepOpen) {
              // Directory was selected — re-trigger to load subdirectory listing
              fileMention.handleChange(result.newValue!, result.newCursorPos!);
            }
          });
        }
        return;
      }
    }

    // Send on Enter, new line on Shift+Enter
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];

    // Extract files from clipboard
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    // If files were found, handle them
    if (files.length > 0) {
      e.preventDefault(); // Prevent default paste behavior for files
      await handleFilesSelected(files);
    }
    // Otherwise, allow normal text paste
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setMessage(value);

    // Auto-resize textarea
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;

    // Trigger mention detection
    fileMention.handleChange(value, e.target.selectionStart ?? value.length);
  };

  const handleMentionSelect = useCallback(
    (entry: { name: string; isDirectory: boolean }) => {
      const cursorPos = textareaRef.current?.selectionStart ?? message.length;
      const { newValue, newCursorPos, keepOpen } = fileMention.selectEntry(
        entry,
        message,
        cursorPos
      );
      setMessage(newValue);
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
        textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
        if (keepOpen) {
          // Directory selected — re-trigger handleChange to fetch subdirectory listing
          fileMention.handleChange(newValue, newCursorPos);
        }
      });
    },
    [message, fileMention]
  );

  const readFileAsBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  };

  const handleFilesSelected = async (files: File[]) => {
    if (files.length === 0) return;

    const imageFiles = files.filter((f) => f.type.startsWith('image/'));
    const otherFiles = files.filter((f) => !f.type.startsWith('image/'));

    // Read images as base64 locally (no server upload needed)
    const imageAttachments: Attachment[] = [];
    for (const file of imageFiles) {
      try {
        const data = await readFileAsBase64(file);
        imageAttachments.push({
          id: crypto.randomUUID(),
          type: 'image',
          name: file.name,
          size: file.size,
          mimeType: file.type,
          data,
        });
      } catch {
        console.error('Failed to read image file:', file.name);
      }
    }

    if (imageAttachments.length > 0) {
      setAttachments((prev) => [...prev, ...imageAttachments]);
    }

    // Upload non-image files to server
    if (otherFiles.length > 0) {
      const uploaded = await uploadFiles(otherFiles);
      if (uploaded.length > 0) {
        setAttachments((prev) => [...prev, ...uploaded]);
      }
    }
  };

  const onDrop = (acceptedFiles: File[]) => {
    handleFilesSelected(acceptedFiles);
  };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    noClick: true,
    noKeyboard: true,
    accept: {
      'image/*': ['.png', '.jpg', '.jpeg', '.gif', '.webp'],
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'text/plain': ['.txt'],
      'text/csv': ['.csv'],
    },
    maxSize: 10 * 1024 * 1024, // 10MB
  });

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((att) => att.id !== id));
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div
      {...getRootProps()}
      className={`p-4 ${variant === 'default' ? 'border-t border-border bg-surface' : ''} ${isDragActive ? 'bg-accent bg-opacity-10' : ''
        }`}
    >
      <input {...getInputProps()} />

      {/* File attachments preview */}
      {attachments.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-2">
          {attachments.map((attachment) => (
            <div
              key={attachment.id}
              className="flex items-center gap-2 rounded border border-border bg-background px-3 py-2"
            >
              {attachment.type === 'image' ? (
                <svg className="h-4 w-4 text-accent" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              ) : (
                <svg className="h-4 w-4 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
              )}
              <div className="flex-1 min-w-0">
                <p className="text-xs font-medium text-text-primary truncate max-w-[150px]">
                  {attachment.name}
                </p>
                <p className="text-xs text-text-secondary">
                  {formatFileSize(attachment.size)}
                </p>
              </div>
              <button
                onClick={() => removeAttachment(attachment.id)}
                className="text-text-secondary hover:text-error"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      {/* MCP Server Toggles */}
      <MCPServerBadges disabled={disabled || uploading} />

      {/* Upload progress */}
      {uploading && Object.keys(progress).length > 0 && (
        <div className="mb-3 text-xs text-text-secondary">
          Uploading files...
        </div>
      )}

      {/* Upload error */}
      {uploadError && (
        <div className="mb-3 text-xs text-error">
          {uploadError}
        </div>
      )}

      {/* Drag overlay */}
      {isDragActive && (
        <div className="mb-3 rounded border-2 border-dashed border-accent bg-accent bg-opacity-5 p-4 text-center">
          <p className="text-sm text-accent">Drop files here to attach</p>
        </div>
      )}

      <div className="flex gap-2">
        {/* File upload button */}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,.pdf,.docx,.txt,.csv"
          onChange={(e) => {
            if (e.target.files) {
              handleFilesSelected(Array.from(e.target.files));
              e.target.value = '';
            }
          }}
          className="hidden"
        />
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled || uploading}
          className="rounded p-2 text-text-secondary hover:bg-background hover:text-accent disabled:cursor-not-allowed disabled:opacity-50"
          title="Attach file"
        >
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
          </svg>
        </button>

        {/* Text input */}
        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => setTimeout(() => fileMention.close(), 150)}
          placeholder={placeholder}
          disabled={disabled || uploading}
          rows={1}
          className="flex-1 resize-none rounded border border-border bg-background px-3 py-2 text-sm text-text-primary placeholder-text-secondary focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          style={{ maxHeight: '200px' }}
        />

        {/* Model selector */}
        {selectedModel && availableModels && onModelChange && (
          <CompactModelSelector
            value={selectedModel}
            models={availableModels}
            onChange={onModelChange}
            disabled={disabled || uploading}
          />
        )}

        {/* Send/Stop button */}
        <Button
          onClick={isGenerating ? onAbort : handleSend}
          disabled={!isGenerating && (disabled || uploading || (!message.trim() && attachments.length === 0))}
          className={isGenerating ? 'bg-error hover:bg-error-dark' : ''}
          title={isGenerating ? 'Stop generating' : 'Send message'}
        >
          {isGenerating ? (
            // Stop icon
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          ) : (
            // Send icon
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
          )}
        </Button>
      </div>

      {/* File mention dropdown */}
      <FileMentionDropdown
        isOpen={fileMention.isOpen}
        entries={fileMention.filteredEntries}
        activeIndex={fileMention.activeIndex}
        anchorRef={textareaRef}
        onSelect={handleMentionSelect}
        onClose={fileMention.close}
      />

      <p className="mt-2 text-xs text-text-secondary">
        Press Enter to send, Shift+Enter for new line • Drag & drop, paste, or click 📎 to attach files
      </p>
    </div>
  );
});

ChatInput.displayName = 'ChatInput';
