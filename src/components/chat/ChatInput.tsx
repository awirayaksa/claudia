import React, { useState, useRef, KeyboardEvent, forwardRef, useImperativeHandle, useEffect, useCallback, useMemo, MouseEvent } from 'react';
import { useDropzone } from 'react-dropzone';
import { Button } from '../common/Button';
import { Attachment } from '../../types/message.types';
import { useFileUpload } from '../../hooks/useFileUpload';
import MCPServerBadges from './MCPServerBadges';
import { FileMentionDropdown } from './FileMentionDropdown';
import { SkillMentionDropdown } from './SkillMentionDropdown';
import { useFileMention } from '../../hooks/useFileMention';
import { useSkillMention } from '../../hooks/useSkillMention';
import { useAppSelector, useAppDispatch } from '../../store';
import { CompactModelSelector } from './CompactModelSelector';
import { EffortSelector } from './EffortSelector';
import { setEffortLevel } from '../../store/slices/composerSlice';
import { parseEffortDirective } from '../../utils/effort-utils';
import { getPlatform } from '../../platform';
import { useT } from '../../i18n';

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
  /** Called after the user starts or stops an MCP server from the badges above the input. */
  onMCPServerToggled?: (serverId: string, running: boolean) => void;
  /** More slash commands, listed after the skills (the web app's prompt library). */
  extraCommands?: import('../../types/skill.types').Skill[];
  /**
   * One of `extraCommands` was picked: its "/command" text is removed and the
   * host may put text in its place with `insert`.
   */
  onCommandPick?: (command: import('../../types/skill.types').Skill, insert: (text: string) => void) => void;
  /** Display name of a model id (defaults to the id). */
  modelLabel?: (model: string) => string;
  /**
   * A "#" menu (the web app: knowledge bases, chats, web pages). Picking an
   * item removes the typed "#query" and calls `onHashPick`.
   */
  hashCommands?: import('../../types/skill.types').Skill[];
  onHashPick?: (item: import('../../types/skill.types').Skill, insert: (text: string) => void) => void;
  hashEmptyLabel?: string;
  /** More buttons next to "attach" (the web app's microphone). */
  toolbarExtras?: React.ReactNode;
}

export interface ChatInputRef {
  focus: () => void;
  addFiles: (files: File[]) => void;
  setMessage: (text: string) => void;
  /** Add text at the end (with a space), e.g. dictated words. */
  appendText: (text: string) => void;
}

function expandFileMentions(message: string, baseDir: string): string {
  const mentionRegex = /@([\w.\-/\\]+)/g;
  return message.replace(mentionRegex, (_match, relPath) => {
    const absPath = `${baseDir}/${relPath}`.replace(/\\/g, '/');
    return absPath;
  });
}

export const ChatInput = forwardRef<ChatInputRef, ChatInputProps>(({
  onSend,
  onAbort,
  disabled = false,
  isGenerating = false,
  placeholder,
  variant = 'default',
  selectedModel,
  availableModels,
  onModelChange,
  initialMessage,
  initialAttachments,
  onCancelEdit,
  onMCPServerToggled,
  extraCommands,
  onCommandPick,
  modelLabel,
  hashCommands,
  onHashPick,
  hashEmptyLabel,
  toolbarExtras,
}, ref) => {
  const t = useT();
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const { uploadFiles, uploading, progress, error: uploadError } = useFileUpload();

  const dispatch = useAppDispatch();

  // Reasoning effort: session override, Preferences default, and any directive
  // present in the text being typed right now (applies to the next message only).
  const sessionEffort = useAppSelector((state) => state.composer.effortLevel);
  const preferredEffort = useAppSelector((state) => state.settings.preferences.reasoningEffort);
  const pendingEffort = useMemo(() => parseEffortDirective(message).effort, [message]);

  // Redux selectors for filesystem mention feature
  const filesystemDirectory = useAppSelector((state) => state.composer.filesystemDirectory);
  const serverStates = useAppSelector((state) => state.mcp.serverStates);
  // @file mentions browse the user's own disk, so only hosts with a local filesystem offer them
  const hasLocalFilesystem = getPlatform().capabilities.localFilesystem;
  const isFilesystemReady = useMemo(
    () =>
      hasLocalFilesystem &&
      Object.values(serverStates).some(
        (s) => s.config.builtinId === 'builtin-filesystem-001' && s.status === 'ready'
      ),
    [serverStates, hasLocalFilesystem]
  );

  const fileMention = useFileMention(filesystemDirectory, isFilesystemReady);

  // Skills mention feature
  const skills = useAppSelector((state) => state.skills.skills);
  const commands = useMemo(() => (extraCommands?.length ? [...skills, ...extraCommands] : skills), [skills, extraCommands]);
  const skillMention = useSkillMention(commands);
  const noHash = useMemo(() => [] as import('../../types/skill.types').Skill[], []);
  const hashMention = useSkillMention(hashCommands ?? noHash, '#');

  /**
   * Show a picked command. Skills stay as "/id " text; an extra command's
   * text is taken out again and handed to the host, which inserts its own.
   */
  const applyCommand = useCallback(
    (
      picked: import('../../types/skill.types').Skill | undefined,
      newValue: string,
      newCursorPos: number,
      trigger: '/' | '#' = '/'
    ) => {
      const extra = picked && (trigger === '#' ? onHashPick : extraCommands?.includes(picked) && onCommandPick);
      if (!extra) {
        setMessage(newValue);
        requestAnimationFrame(() => {
          textareaRef.current?.focus();
          textareaRef.current?.setSelectionRange(newCursorPos, newCursorPos);
        });
        return;
      }
      const start = newCursorPos - `${trigger}${picked.id} `.length;
      setMessage(newValue.slice(0, start) + newValue.slice(newCursorPos));
      extra(picked, (text) => {
        setMessage((m) => m.slice(0, start) + text + m.slice(start));
        requestAnimationFrame(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.style.height = 'auto';
          el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
          el.focus();
          el.setSelectionRange(start + text.length, start + text.length);
        });
      });
    },
    [extraCommands, onCommandPick, onHashPick]
  );

  // Expose methods to parent component
  useImperativeHandle(ref, () => ({
    focus: () => {
      textareaRef.current?.focus();
    },
    addFiles: (files: File[]) => {
      handleFilesSelected(files);
    },
    setMessage: (text: string) => {
      setMessage(text);
      // Auto-resize textarea after React state update
      requestAnimationFrame(() => {
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto';
          textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
        }
        textareaRef.current?.focus();
      });
    },
    appendText: (text: string) => {
      setMessage((m) => (m && !/\s$/.test(m) ? `${m} ${text}` : `${m}${text}`));
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
      });
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
      skillMention.close();
      hashMention.close();
      const expandedMessage = filesystemDirectory
        ? expandFileMentions(message, filesystemDirectory)
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
    // Intercept keyboard events for the skill mention dropdown first
    if (skillMention.isOpen) {
      const picked = skillMention.filteredSkills[skillMention.activeIndex];
      const result = skillMention.handleKeyDown(e);
      if (result.consumed) {
        e.preventDefault();
        if (result.newValue !== undefined) applyCommand(picked, result.newValue, result.newCursorPos!);
        return;
      }
    }
    if (hashMention.isOpen) {
      const picked = hashMention.filteredSkills[hashMention.activeIndex];
      const result = hashMention.handleKeyDown(e);
      if (result.consumed) {
        e.preventDefault();
        if (result.newValue !== undefined) applyCommand(picked, result.newValue, result.newCursorPos!, '#');
        return;
      }
    }

    // Intercept keyboard events for the file mention dropdown
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

  const handleContextMenu = (e: MouseEvent<HTMLTextAreaElement>) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const insertTextAtCursor = useCallback((text: string) => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const newValue = message.slice(0, start) + text + message.slice(end);
    setMessage(newValue);
    // Restore cursor position after the inserted text
    requestAnimationFrame(() => {
      textarea.selectionStart = textarea.selectionEnd = start + text.length;
      textarea.focus();
      // Trigger auto-resize
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    });
  }, [message]);

  const handleContextPaste = useCallback(async () => {
    closeContextMenu();
    try {
      const text = await navigator.clipboard.readText();
      insertTextAtCursor(text);
    } catch {
      // Fallback: focus textarea and let browser handle Ctrl+V
      textareaRef.current?.focus();
    }
  }, [closeContextMenu, insertTextAtCursor]);

  const handleContextPasteAsPlainText = useCallback(async () => {
    closeContextMenu();
    try {
      const text = await navigator.clipboard.readText();
      // Strip HTML tags and decode common HTML entities
      const stripped = text
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
      insertTextAtCursor(stripped);
    } catch {
      textareaRef.current?.focus();
    }
  }, [closeContextMenu, insertTextAtCursor]);

  // Close context menu on outside click or scroll
  useEffect(() => {
    if (!contextMenu) return;
    const handleClose = () => closeContextMenu();
    document.addEventListener('mousedown', handleClose);
    document.addEventListener('scroll', handleClose, true);
    return () => {
      document.removeEventListener('mousedown', handleClose);
      document.removeEventListener('scroll', handleClose, true);
    };
  }, [contextMenu, closeContextMenu]);

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setMessage(value);

    // Auto-resize textarea
    const textarea = e.target;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;

    // Trigger mention detection
    fileMention.handleChange(value, e.target.selectionStart ?? value.length);
    skillMention.handleChange(value, e.target.selectionStart ?? value.length);
    if (hashCommands?.length) hashMention.handleChange(value, e.target.selectionStart ?? value.length);
  };

  const handleHashSelect = useCallback(
    (item: import('../../types/skill.types').Skill) => {
      const cursorPos = textareaRef.current?.selectionStart ?? message.length;
      const { newValue, newCursorPos } = hashMention.selectSkill(item, message, cursorPos);
      applyCommand(item, newValue, newCursorPos, '#');
    },
    [message, hashMention, applyCommand]
  );

  const handleSkillSelect = useCallback(
    (skill: import('../../types/skill.types').Skill) => {
      const cursorPos = textareaRef.current?.selectionStart ?? message.length;
      const { newValue, newCursorPos } = skillMention.selectSkill(skill, message, cursorPos);
      applyCommand(skill, newValue, newCursorPos);
    },
    [message, skillMention, applyCommand]
  );

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

    // Hosts that keep attachments themselves (web) take images too
    const inlineImages = !getPlatform().files.handlesImages;
    const imageFiles = inlineImages ? files.filter((f) => f.type.startsWith('image/')) : [];
    const otherFiles = inlineImages ? files.filter((f) => !f.type.startsWith('image/')) : files;

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
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
      'application/json': ['.json'],
      'text/plain': ['.txt', '.log'],
      'text/markdown': ['.md'],
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
      className={`${variant === 'default' ? 'border-t border-border bg-surface' : ''} ${isDragActive ? 'bg-accent bg-opacity-10' : ''
        }`}
    >
      <div className={variant === 'default' ? 'px-4 pt-3 pb-2' : 'px-4 pt-3 pb-2'}>
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
                aria-label={t('chatInput.removeAttachment', 'Remove {{name}}', { name: attachment.name })}
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
      <MCPServerBadges disabled={disabled || uploading} onServerToggled={onMCPServerToggled} />

      {/* Upload progress */}
      {uploading && Object.keys(progress).length > 0 && (
        <div className="mb-3 text-xs text-text-secondary">
          {t('chatInput.uploading', 'Uploading files...')}
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
          <p className="text-sm text-accent">{t('chatInput.drop', 'Drop files here to attach')}</p>
        </div>
      )}

      {/* File upload input (hidden) */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*,.pdf,.docx,.xlsx,.pptx,.txt,.md,.csv,.json"
        onChange={(e) => {
          if (e.target.files) {
            handleFilesSelected(Array.from(e.target.files));
            e.target.value = '';
          }
        }}
        className="hidden"
      />

      {/* Input card — visually distinct from surrounding surface */}
      <div className="rounded-xl border border-border bg-background px-3 py-2.5 transition-colors focus-within:border-accent/60 focus-within:shadow-sm">
        {/* Text input — full width, 2-row minimum */}
        <textarea
          ref={textareaRef}
          value={message}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onContextMenu={handleContextMenu}
          onBlur={() => {
            setTimeout(() => fileMention.close(), 150);
            setTimeout(() => skillMention.close(), 150);
            setTimeout(() => hashMention.close(), 150);
          }}
          placeholder={placeholder ?? t('chatInput.placeholder', 'Type your message...')}
          disabled={disabled || uploading}
          rows={2}
          className="w-full resize-none bg-transparent px-0 py-0 text-sm text-text-primary placeholder-text-secondary focus:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          style={{ maxHeight: '200px' }}
        />

        {/* Bottom toolbar: attach left · model selector + send right */}
        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-1">
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={disabled || uploading}
            className="rounded p-1.5 text-text-secondary hover:bg-surface hover:text-accent disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
            title={t('chatInput.attach', 'Attach file')}
          >
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
            </svg>
          </button>
          {toolbarExtras}
          </div>

          <div className="flex items-center gap-2">
            {/* Reasoning effort selector */}
            <EffortSelector
              value={sessionEffort}
              fallback={preferredEffort}
              pending={pendingEffort}
              model={selectedModel}
              onChange={(effort) => dispatch(setEffortLevel(effort))}
              disabled={disabled || isGenerating}
            />

            {/* Model selector */}
            {selectedModel !== undefined && availableModels && availableModels.length > 0 && onModelChange && (
              <CompactModelSelector
                value={selectedModel}
                models={availableModels}
                onChange={onModelChange}
                disabled={disabled || isGenerating}
                label={modelLabel}
              />
            )}

            {/* Send/Stop button */}
            <Button
              onClick={isGenerating ? onAbort : handleSend}
              disabled={!isGenerating && (disabled || uploading || (!message.trim() && attachments.length === 0))}
              className={isGenerating ? 'bg-error hover:bg-error-dark' : ''}
              title={isGenerating ? t('chat.stop', 'Stop generating') : t('chatInput.send', 'Send message')}
            >
              {isGenerating ? (
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              ) : (
                <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
                </svg>
              )}
            </Button>
          </div>
        </div>
      </div>

      {/* "#" menu (references) */}
      <SkillMentionDropdown
        isOpen={hashMention.isOpen}
        skills={hashMention.filteredSkills}
        activeIndex={hashMention.activeIndex}
        anchorRef={textareaRef}
        onSelect={handleHashSelect}
        onClose={hashMention.close}
        emptyLabel={hashEmptyLabel}
        prefix="#"
      />

      {/* Skill mention dropdown */}
      <SkillMentionDropdown
        isOpen={skillMention.isOpen}
        skills={skillMention.filteredSkills}
        activeIndex={skillMention.activeIndex}
        anchorRef={textareaRef}
        onSelect={handleSkillSelect}
        onClose={skillMention.close}
      />

      {/* File mention dropdown */}
      <FileMentionDropdown
        isOpen={fileMention.isOpen}
        entries={fileMention.filteredEntries}
        activeIndex={fileMention.activeIndex}
        anchorRef={textareaRef}
        onSelect={handleMentionSelect}
        onClose={fileMention.close}
      />

      {/* Input context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[160px] overflow-hidden rounded-lg border border-border bg-surface shadow-lg py-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <button
            onClick={handleContextPaste}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-text-primary hover:bg-background transition-colors"
          >
            <svg className="h-4 w-4 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            {t('chatInput.paste', 'Paste')}
          </button>
          <button
            onClick={handleContextPasteAsPlainText}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-text-primary hover:bg-background transition-colors"
          >
            <svg className="h-4 w-4 text-text-secondary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2M12 12h.01M8 12h.01M16 12h.01" />
            </svg>
            {t('chatInput.pastePlain', 'Paste as plain text')}
          </button>
        </div>
      )}

      <p className="mt-2 text-xs text-text-secondary">
        {t('chatInput.hint', 'Enter to send · Shift+Enter for new line ·')} <code>--effort high</code>{' '}
        {t('chatInput.hintEffort', 'to set effort for one message')}
      </p>
    </div>
    </div>
  );
});

ChatInput.displayName = 'ChatInput';
