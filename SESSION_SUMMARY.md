# Session Summary - Server Reasoning Message Display

**Date:** 2025-12-20
**Project:** Claudia - Claude Desktop Clone (Electron App)

## Task Overview

Implemented display of AI reasoning/thinking tokens from Open WebUI API responses. Reasoning appears as a collapsible block (folded by default) before the main response content, similar to how tool calls are displayed.

## Problem Statement

User wanted to see the AI's reasoning process (thinking messages) that appear in Open WebUI responses but were not being displayed in Claudia. For example, when asking "explain quantum mechanics", Open WebUI shows thinking like: *"The user asks: 'explain quantum mechanic'. Likely they want an explanation of quantum mechanics. No tool needed. Provide a clear, accessible explanation"*

## Implementation

### Phase 1: Planning
- Explored existing tool call collapsible UI pattern in `ToolCallMessage.tsx`
- Analyzed message streaming architecture and Redux state management
- Identified that API field name needed discovery (initially assumed `extended_thinking`)

### Phase 2: Initial Implementation
**Files Modified:**
1. **Type Definitions**
   - `src/types/api.types.ts` - Added `extended_thinking?: string` to `ChatCompletionChunk.delta`
   - `src/types/message.types.ts` - Added `reasoning?: string` to `Message` interface

2. **Streaming Service** (`src/services/api/streaming.service.ts`)
   - Added `onReasoning` callback to `StreamCallbacks` interface
   - Parse and accumulate reasoning from API delta responses
   - Trigger callback with reasoning chunks during streaming

3. **Redux State Management** (`src/store/slices/chatSlice.ts`)
   - Added `streamingReasoning: string` to `ChatState`
   - Created `appendStreamingReasoning` action/reducer
   - Updated `completeStreaming`, `clearMessages`, `abortStreaming`, `startStreaming` to handle reasoning
   - Integrated reasoning callback into `sendStreamingMessageWithTools` thunk
   - Exported `appendStreamingReasoning` action

4. **UI Components**
   - **`src/components/chat/ReasoningMessage.tsx`** (NEW) - Collapsible reasoning display component
   - **`src/components/chat/ChatMessage.tsx`** - Integrated reasoning display before content
   - **`src/components/chat/StreamingMessage.tsx`** - Show reasoning during streaming with throttling
   - **`src/components/chat/ChatWindow.tsx`** - Pass streamingReasoning from Redux to StreamingMessage

### Phase 3: Bug Fix - Incorrect Field Name
**Issue:** Initial implementation used `extended_thinking` but Open WebUI actually uses `reasoning`

**Debug Process:**
1. Added console logging to see actual delta structure
2. User tested and shared log showing delta contains `reasoning` and `reasoning_details` fields
3. Updated field name from `extended_thinking` to `reasoning`
4. Removed debug logging

**Files Updated:**
- `src/types/api.types.ts` - Changed to `reasoning?: string`
- `src/services/api/streaming.service.ts` - Changed to `delta?.reasoning`

## UI Design

### ReasoningMessage Component
- **Icon:** 💭 (thought bubble emoji)
- **Label:** "Reasoning"
- **Default State:** Collapsed (folded)
- **Expand/Collapse:** ▶/▼ arrow toggle
- **Background:** Blue tint (`bg-blue-500 bg-opacity-10`) to distinguish from tool calls
- **Border:** Standard border color (`border-border`)
- **Content:** Monospace `<pre>` block with full reasoning text
- **Streaming Indicator:** Spinning icon + "Thinking..." label (blue theme)

### Rendering Order
Messages now display in this order:
1. Header (sender name, timestamp, copy/edit buttons)
2. **Reasoning block** (NEW - collapsible, before content)
3. Main content (markdown rendered)
4. Error display (if any)
5. Attachments (if any)
6. Tool calls (if any)

## Technical Details

### API Response Structure
Open WebUI sends reasoning in this format:
```json
{
  "choices": [{
    "delta": {
      "role": "assistant",
      "content": "",
      "reasoning": "We",
      "reasoning_details": [
        {
          "type": "reasoning.text",
          "text": "We",
          "format": "unknown",
          "index": 0
        }
      ]
    }
  }]
}
```

**Field Used:** `delta.reasoning` (simple string, accumulated across chunks)
**Field Ignored:** `delta.reasoning_details` (more complex structure, not needed)

### Streaming Flow
1. API streams delta chunks with `reasoning` field
2. `streaming.service.ts` extracts `delta?.reasoning`
3. Calls `onReasoning(reasoningContent)` callback
4. Redux dispatches `appendStreamingReasoning(reasoning)`
5. State updates trigger component re-render
6. `StreamingMessage` shows throttled reasoning (100ms updates)
7. On completion, reasoning saved to message in Redux
8. `ChatMessage` displays final reasoning in collapsible block

### State Management
```typescript
interface ChatState {
  // Existing fields...
  streamingReasoning: string;  // NEW: Accumulates reasoning during streaming
}
```

**Actions:**
- `appendStreamingReasoning(reasoning: string)` - Accumulate reasoning chunks
- `completeStreaming()` - Save reasoning to message object
- `clearMessages()` / `abortStreaming()` / `startStreaming()` - Clear reasoning state

## Files Changed

### Modified (7 files)
1. `src/components/chat/ChatMessage.tsx` - Integrated ReasoningMessage component
2. `src/components/chat/ChatWindow.tsx` - Pass streamingReasoning prop
3. `src/components/chat/StreamingMessage.tsx` - Display streaming reasoning
4. `src/services/api/streaming.service.ts` - Parse reasoning from delta
5. `src/store/slices/chatSlice.ts` - Redux state management for reasoning
6. `src/types/api.types.ts` - Add reasoning field to ChatCompletionChunk
7. `src/types/message.types.ts` - Add reasoning field to Message interface

### Created (1 file)
1. `src/components/chat/ReasoningMessage.tsx` - New collapsible reasoning component

**Total Changes:** 8 files, 108 insertions, 3 deletions

## Testing & Validation

### Type Safety
- ✅ TypeScript compilation passed (`npm run type-check`)
- ✅ All types properly defined
- ✅ No type errors

### Debugging
- ✅ Added temporary console logging to identify field name
- ✅ User tested with "explain quantum mechanics" query
- ✅ Confirmed `reasoning` field in delta response
- ✅ Removed debug logging after fix

### User Testing
- ✅ Reasoning appears before main content
- ✅ Collapsible UI works (default: folded)
- ✅ Streaming indicator shows "Thinking..." during generation
- ✅ Real-time updates with 100ms throttling
- ✅ Visual distinction from tool calls (blue theme)

## Key Decisions

### 1. Field Name: `reasoning` vs `extended_thinking`
**Decision:** Use `reasoning` (Open WebUI's actual field name)
**Rationale:** Discovered through debugging that Open WebUI uses `reasoning`, not `extended_thinking`

### 2. Which Field to Use: `reasoning` vs `reasoning_details`
**Decision:** Use simple `reasoning` string field
**Rationale:** Simpler to implement, already accumulated as string chunks, `reasoning_details` is more complex structured data

### 3. Display Order: Before or After Content
**Decision:** Display reasoning BEFORE main content
**Rationale:** User specifically requested "before main content" to match typical thinking → response flow

### 4. Default State: Expanded or Collapsed
**Decision:** Collapsed (folded) by default
**Rationale:** Matches tool call pattern, reduces visual clutter, user can expand when interested

### 5. UI Pattern: Reuse ToolCallMessage or Create New Component
**Decision:** Create new `ReasoningMessage` component
**Rationale:** Similar pattern but different styling (blue vs tool call colors), different data structure, cleaner separation of concerns

### 6. Streaming: Show During or After
**Decision:** Show during streaming with real-time updates
**Rationale:** User requested "show during streaming in real-time", provides better UX feedback

## Architecture Patterns

### Component Reuse
Followed existing `ToolCallMessage.tsx` pattern:
- `useState` for expand/collapse
- Header with icon, label, status, and arrow
- Conditional rendering of expanded content
- Consistent Tailwind styling

### Redux Integration
Followed streaming content pattern:
- Accumulator variable in streaming service
- Callback to dispatch Redux action
- State updates trigger component re-renders
- Cleanup in abort/clear/complete actions

### Performance Optimization
- **Throttling:** 100ms throttle for streaming reasoning (same as content)
- **Conditional Rendering:** Only render if reasoning exists
- **Memoization:** Components properly memoized to prevent unnecessary re-renders

## Future Enhancements

### Potential Improvements
- [ ] Support `reasoning_details` for richer structured display
- [ ] Add toggle to show/hide all reasoning blocks at once
- [ ] Persist expand/collapse state preference
- [ ] Add "Copy reasoning" button
- [ ] Syntax highlighting for reasoning content
- [ ] Count/display reasoning token usage separately

### Considerations
- Different providers (OpenRouter) may use different field names
- May need provider-specific field mapping in the future
- Consider adding settings toggle to enable/disable reasoning display

## Commit Information

**Commit:** `36c8767`
**Message:** "Add server reasoning message display with collapsible UI"

**Summary:**
- 8 files changed
- 108 insertions
- 3 deletions
- 1 new component created

## Commands Used

```bash
# Development
npm run dev              # Start dev server
npm run type-check       # Validate TypeScript

# Git
git status              # Check changes
git diff --stat         # View diff statistics
git add [files]         # Stage changes
git commit -m "..."     # Create commit
```

## Key Learnings

1. **Field Name Discovery:** Always verify API field names through debugging rather than assuming
2. **Console Logging:** Temporary logging is valuable for understanding API responses
3. **Pattern Reuse:** Following existing UI patterns (like ToolCallMessage) ensures consistency
4. **Incremental Implementation:** Build → Debug → Fix workflow worked well
5. **State Management:** Redux pattern for streaming data is consistent and scalable

## Session Status

✅ **Complete** - Feature implemented, tested, and committed

**Next Steps:**
- User to test with various queries
- Monitor for any edge cases
- Consider enhancements based on user feedback

---

**Previous Session:** Abort Message Streaming Implementation (message abort with immediate input recovery)
**Current Session:** Server Reasoning Message Display (collapsible thinking/reasoning blocks)
