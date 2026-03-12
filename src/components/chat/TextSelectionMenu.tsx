import { useState, useEffect, useRef, useCallback } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { getAPIProvider } from '../../services/api/provider.service';
import { useAppSelector } from '../../store';

interface MenuState {
  visible: boolean;
  x: number;
  y: number;
  selectedText: string;
}

type PopupMode = 'explain' | 'ask';

interface PopupState {
  visible: boolean;
  mode: PopupMode | null;
  anchorX: number;
  anchorY: number;
  selectedText: string;
  question: string;
  response: string;
  isLoading: boolean;
}

interface TextSelectionMenuProps {
  containerRef: React.RefObject<HTMLDivElement>;
}

export function TextSelectionMenu({ containerRef }: TextSelectionMenuProps) {
  const [menu, setMenu] = useState<MenuState>({
    visible: false,
    x: 0,
    y: 0,
    selectedText: '',
  });

  const [popup, setPopup] = useState<PopupState>({
    visible: false,
    mode: null,
    anchorX: 0,
    anchorY: 0,
    selectedText: '',
    question: '',
    response: '',
    isLoading: false,
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const questionInputRef = useRef<HTMLTextAreaElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);

  const apiConfig = useAppSelector((state) => state.settings.api);
  const selectedModel =
    (apiConfig as any).selectedModel ||
    (apiConfig as any).openwebui?.selectedModel ||
    (apiConfig as any).openrouter?.selectedModel ||
    '';

  const hideMenu = useCallback(() => {
    setMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  const hidePopup = useCallback(() => {
    abortControllerRef.current?.abort();
    setPopup({ visible: false, mode: null, anchorX: 0, anchorY: 0, selectedText: '', question: '', response: '', isLoading: false });
  }, []);

  // Derive popup position clamped to viewport
  const getPopupPosition = (anchorX: number, anchorY: number) => {
    const POPUP_WIDTH = 300;
    const MARGIN = 12;
    let x = anchorX - POPUP_WIDTH - MARGIN;
    if (x < MARGIN) {
      x = anchorX + MARGIN;
    }
    // Clamp horizontally
    x = Math.max(MARGIN, Math.min(x, window.innerWidth - POPUP_WIDTH - MARGIN));
    // Clamp vertically
    const y = Math.max(MARGIN, Math.min(anchorY, window.innerHeight - MARGIN));
    return { x, y };
  };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleMouseUp = () => {
      // Tiny delay to let browser finalize selection
      setTimeout(() => {
        const selection = window.getSelection();
        const text = selection?.toString().trim();

        if (!text || text.length < 2) {
          hideMenu();
          return;
        }

        if (!selection || selection.rangeCount === 0) {
          hideMenu();
          return;
        }

        const range = selection.getRangeAt(0);
        if (!container.contains(range.commonAncestorContainer)) {
          hideMenu();
          return;
        }

        savedRangeRef.current = range.cloneRange();

        const rect = range.getBoundingClientRect();
        setMenu({
          visible: true,
          x: rect.left + rect.width / 2,
          y: rect.top,
          selectedText: text,
        });
      }, 10);
    };

    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Element;
      if (!target.closest('[data-selection-menu]') && !target.closest('[data-selection-popup]')) {
        hideMenu();
      }
    };

    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('mousedown', handleMouseDown);

    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('mousedown', handleMouseDown);
    };
  }, [containerRef, hideMenu]);

  // Close popup on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (popup.visible) hidePopup();
        else hideMenu();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [popup.visible, hidePopup, hideMenu]);

  const getAnchorFromSavedRange = () => {
    if (savedRangeRef.current) {
      const rect = savedRangeRef.current.getBoundingClientRect();
      return { anchorX: rect.left + rect.width / 2, anchorY: rect.top };
    }
    return { anchorX: window.innerWidth / 2, anchorY: 120 };
  };

  const streamResponse = useCallback(
    async (prompt: string) => {
      const abortController = new AbortController();
      abortControllerRef.current = abortController;

      try {
        const provider = getAPIProvider();
        await provider.streamChatCompletion(
          {
            model: selectedModel,
            messages: [{ role: 'user', content: prompt }],
          },
          {
            onChunk: (chunk: string) => {
              setPopup((prev) => ({ ...prev, response: prev.response + chunk }));
            },
            onComplete: () => {
              setPopup((prev) => ({ ...prev, isLoading: false }));
            },
            onError: (error: Error) => {
              if (error.name !== 'AbortError') {
                setPopup((prev) => ({
                  ...prev,
                  isLoading: false,
                  response: prev.response || `Error: ${error.message}`,
                }));
              }
            },
          },
          abortController.signal
        );
      } catch (error: any) {
        if (error?.name !== 'AbortError') {
          setPopup((prev) => ({
            ...prev,
            isLoading: false,
            response: prev.response || `Error: ${error.message}`,
          }));
        }
      }
    },
    [selectedModel]
  );

  const handleExplain = useCallback(() => {
    const { selectedText } = menu;
    const { anchorX, anchorY } = getAnchorFromSavedRange();
    hideMenu();

    setPopup({
      visible: true,
      mode: 'explain',
      anchorX,
      anchorY,
      selectedText,
      question: '',
      response: '',
      isLoading: true,
    });

    streamResponse(`Explain the following text concisely and clearly:\n\n"${selectedText}"`);
  }, [menu, hideMenu, streamResponse]);

  const handleAsk = useCallback(() => {
    const { selectedText } = menu;
    const { anchorX, anchorY } = getAnchorFromSavedRange();
    hideMenu();

    setPopup({
      visible: true,
      mode: 'ask',
      anchorX,
      anchorY,
      selectedText,
      question: '',
      response: '',
      isLoading: false,
    });

    setTimeout(() => questionInputRef.current?.focus(), 50);
  }, [menu, hideMenu]);

  const handleSubmitQuestion = useCallback(async () => {
    const { selectedText, question } = popup;
    if (!question.trim()) return;

    setPopup((prev) => ({ ...prev, isLoading: true, response: '' }));

    const prompt = `I'm referring to this text: "${selectedText}"\n\nMy question: ${question}`;
    streamResponse(prompt);
  }, [popup, streamResponse]);

  const handleQuestionKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmitQuestion();
    }
  };

  if (!menu.visible && !popup.visible) return null;

  return (
    <>
      {/* Floating context menu toolbar */}
      {menu.visible && (
        <div
          data-selection-menu
          className="fixed z-50 flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-1 shadow-lg"
          style={{
            left: menu.x,
            top: menu.y,
            transform: 'translate(-50%, -110%)',
          }}
        >
          <button
            onClick={handleAsk}
            className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-text-secondary hover:bg-background hover:text-text-primary transition-colors"
            title="Ask a question about the selected text"
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" strokeWidth={2} />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3" />
              <circle cx="12" cy="17" r="0.5" fill="currentColor" />
            </svg>
            Ask
          </button>
          <div className="h-3 w-px bg-border" />
          <button
            onClick={handleExplain}
            className="flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-text-secondary hover:bg-background hover:text-text-primary transition-colors"
            title="Explain the selected text"
          >
            <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
            </svg>
            Explain
          </button>
        </div>
      )}

      {/* Response popup */}
      {popup.visible && (() => {
        const { x, y } = getPopupPosition(popup.anchorX, popup.anchorY);
        return (
          <div
            ref={popupRef}
            data-selection-popup
            className="fixed z-50 flex flex-col rounded-xl border border-border bg-surface shadow-xl"
            style={{ left: x, top: y, width: 300, maxHeight: 400 }}
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <span className="truncate text-xs font-medium text-text-secondary">
                &ldquo;{popup.selectedText.length > 40
                  ? popup.selectedText.slice(0, 40) + '…'
                  : popup.selectedText}&rdquo;
              </span>
              <button
                onClick={hidePopup}
                className="ml-2 flex-shrink-0 rounded p-0.5 text-text-secondary hover:bg-background hover:text-text-primary transition-colors"
              >
                <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Mode label */}
            <div className="px-3 pt-2 pb-0">
              <span className="text-xs font-semibold capitalize text-text-secondary">
                {popup.mode}
              </span>
            </div>

            {/* Ask mode: question input */}
            {popup.mode === 'ask' && !popup.response && !popup.isLoading && (
              <div className="flex items-center gap-2 px-3 py-2">
                <textarea
                  ref={questionInputRef}
                  value={popup.question}
                  onChange={(e) => setPopup((prev) => ({ ...prev, question: e.target.value }))}
                  onKeyDown={handleQuestionKeyDown}
                  placeholder="Ask a question..."
                  className="flex-1 resize-none rounded-full border border-border bg-background px-3 py-1.5 text-xs text-text-primary placeholder-text-secondary focus:outline-none focus:ring-1 focus:ring-accent"
                  rows={1}
                  style={{ minHeight: 32 }}
                />
                <button
                  onClick={handleSubmitQuestion}
                  disabled={!popup.question.trim()}
                  className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-accent text-white disabled:opacity-40 hover:opacity-90 transition-opacity"
                >
                  <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </button>
              </div>
            )}

            {/* Ask mode: show question submitted */}
            {popup.mode === 'ask' && (popup.response || popup.isLoading) && (
              <div className="border-b border-border px-3 py-1.5">
                <p className="text-xs text-text-secondary">{popup.question}</p>
              </div>
            )}

            {/* Response / loading */}
            {(popup.response || popup.isLoading) && (
              <div className="flex-1 overflow-y-auto px-3 py-2">
                {popup.response ? (
                  <div className="text-sm text-text-primary">
                    <MarkdownRenderer content={popup.response} isUser={false} />
                  </div>
                ) : (
                  <div className="flex items-center gap-2 py-2">
                    <div className="flex gap-1">
                      <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.3s]" />
                      <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent [animation-delay:-0.15s]" />
                      <div className="h-1.5 w-1.5 animate-bounce rounded-full bg-accent" />
                    </div>
                    <span className="text-xs text-text-secondary">Generating...</span>
                  </div>
                )}
                {popup.isLoading && popup.response && (
                  <span className="inline-block h-4 w-0.5 animate-pulse bg-accent align-middle ml-0.5" />
                )}
              </div>
            )}
          </div>
        );
      })()}
    </>
  );
}
