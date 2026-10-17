# Desktop smoke checklist

Run before each desktop release (`npm run dev`, then a packaged build). Automated
coverage lives in `npm test` (including `src/App.smoke.test.tsx`); this list covers
what needs a real window, real providers and real MCP servers.

## Chat
- [ ] Send a message with streaming on; text streams and the reply is saved.
- [ ] Reasoning shows when "Show reasoning" is on (a thinking model).
- [ ] Stop during streaming: the partial reply stays, no error banner.
- [ ] Effort selector and `/effort high` change the next request.
- [ ] A new conversation gets an AI title; renaming it right away keeps the new name
      (title race fix), and the messages are still there after a restart.
- [ ] Star / unstar and model change persist after a restart.

## Tools (MCP)
- [ ] Start and stop a built-in server from the badges above the input; the chat resets.
- [ ] A request that needs two tool rounds in a row completes (tools are re-offered each round).
- [ ] With opencode-go (Kimi), a tool round still works (tools only on the first request).
- [ ] Two servers exposing a tool with the same name: both work and each call goes to its own server.
- [ ] Press Stop while a slow tool runs: the tool result is kept and no further model request is sent.
- [ ] An MCP-UI tool renders its UI; an action button in it runs and updates the result.
- [ ] Filesystem server: reading a file outside the working directory, or through a
      symlink/junction pointing outside it, is refused.

## Attachments
- [ ] Image attachment reaches a vision model.
- [ ] PDF, DOCX, XLSX, PPTX and .txt attachments: the model can quote their content
      (custom / OpenRouter / opencode-go providers inline the text).
- [ ] With Open WebUI as provider, a PDF is uploaded and the model answers from it
      (file ids sent in `files`).

## Skills, plugins, profiles, settings
- [ ] `/summarize some text` runs the skill; creating/editing a skill in Settings updates the list.
- [ ] Enable / disable a plugin; its rendering applies.
- [ ] Switch profiles; settings reload.
- [ ] Theme, accent colour, app title and app icon changes apply.
- [ ] MCP server logs open and clear.

## Window and updates
- [ ] Minimize / maximize / close, tray, native menu (New conversation, Settings, About).
- [ ] Auto-update check URL saves and the check restarts.
- [ ] Opening and closing Settings many times doesn't multiply listeners
      (MCP status updates appear once; preload listener fix).
